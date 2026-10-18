/** Future connector policy only. No listener, token decoder, credentials or network I/O. */
export const READ_TOOL_SCOPES = Object.freeze({
  homekit_get_status: 'homekit:status:read',
  homekit_list_accessories: 'homekit:accessories:read',
  homekit_read_accessory: 'homekit:accessories:read',
  homekit_search_camera_events: 'homekit:events:read',
  homekit_get_room_occupancy: 'homekit:occupancy:read',
  homekit_locate_consented_person: 'homekit:presence:read',
} as const);
export type ReadTool = keyof typeof READ_TOOL_SCOPES;
export type ConnectorDataClass = 'synthetic' | 'household';

export interface VerifiedTokenClaims {
  issuer: string;
  audience: string;
  subject: string;
  /** OAuth expiry as integer Unix seconds. */
  expiresAt: number;
  scopes: readonly string[];
}

export interface TokenVerifier {
  /**
   * A production adapter must cryptographically validate the token using trusted
   * issuer keys, algorithms and relevant token/revocation rules before returning
   * claims. Decoding a token or trusting a `signatureVerified` field is insufficient.
   * This policy module provides no production OAuth verifier.
   */
  verify(token: string): Promise<VerifiedTokenClaims | null>;
}

export class DenyAllTokenVerifier implements TokenVerifier {
  async verify(_token: string): Promise<null> { return null; }
}

export interface ConnectorPolicy {
  readonly enabled: boolean;
  readonly issuer: string;
  readonly audience: string;
  readonly allowedSubjects: readonly string[];
  readonly allowedTools: readonly ReadTool[];
  readonly allowedAccessoryIds: readonly string[];
  /** Adding household requires explicit approval for that data transfer. */
  readonly allowedDataClasses: readonly ConnectorDataClass[];
}

export const denyAllConnectorPolicy: ConnectorPolicy = Object.freeze({
  enabled: false, issuer: '', audience: '',
  allowedSubjects: Object.freeze([]), allowedTools: Object.freeze([]),
  allowedAccessoryIds: Object.freeze([]),
  allowedDataClasses: Object.freeze(['synthetic'] as const),
});

export interface ConnectorRequest {
  readonly tool: string;
  /** Trusted server-side source classification, never a client-supplied assertion. */
  readonly dataClass: ConnectorDataClass;
  /**
   * Complete resolved target set from the trusted dispatcher, not unchecked MCP
   * arguments. Empty means no accessory disclosure. Recheck returned records
   * against this set before egress; list/room tools must not expand it.
   */
  readonly accessoryIds: readonly string[];
}

export type ConnectorDenial = 'disabled' | 'invalid_policy' | 'unsupported_tool'
  | 'invalid_request' | 'token_invalid' | 'issuer_mismatch' | 'audience_mismatch'
  | 'token_expired' | 'subject_denied' | 'scope_denied' | 'tool_denied'
  | 'accessory_denied' | 'data_class_denied';
export type ConnectorDecision = { allowed: false; reason: ConnectorDenial }
  | { allowed: true; tool: ReadTool; requiredScope: string;
    dataClass: ConnectorDataClass; accessoryIds: readonly string[] };

const boundedText = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 2048 && value !== '*';
const canonicalId = (id: string): string =>
  /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id) ? id.toUpperCase() : id;
const idsValid = (ids: unknown): ids is readonly string[] => Array.isArray(ids) && ids.length <= 256
  && ids.every((id: unknown) => typeof id === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(id))
  && new Set(ids.map(canonicalId)).size === ids.length;
const textList = (list: unknown): list is readonly string[] => Array.isArray(list)
  && list.length <= 256 && list.every(boundedText) && new Set(list).size === list.length;
const isReadTool = (tool: unknown): tool is ReadTool => typeof tool === 'string' && Object.hasOwn(READ_TOOL_SCOPES, tool);
const isDataClass = (value: unknown): value is ConnectorDataClass => value === 'synthetic' || value === 'household';
const deny = (reason: ConnectorDenial): ConnectorDecision => ({ allowed: false, reason });
function policyValid(policy: ConnectorPolicy): boolean {
  return boundedText(policy.issuer) && boundedText(policy.audience)
    && textList(policy.allowedSubjects) && textList(policy.allowedTools)
    && policy.allowedTools.every(isReadTool) && idsValid(policy.allowedAccessoryIds)
    && Array.isArray(policy.allowedDataClasses) && policy.allowedDataClasses.length <= 2
    && policy.allowedDataClasses.every(isDataClass)
    && new Set(policy.allowedDataClasses).size === policy.allowedDataClasses.length;
}

/**
 * Unbound authorization contract for a future approved remote adapter. No grant
 * here enables HomeKit, recording, camera media, physical control or person
 * consent. Existing native allowlists and consent checks remain mandatory.
 * Reauthorize if policy changes or before delivering a delayed response.
 */
export async function authorizeConnectorRequest(
  policy: ConnectorPolicy = denyAllConnectorPolicy,
  verifier: TokenVerifier = new DenyAllTokenVerifier(),
  token: string = '',
  request: ConnectorRequest = { tool: '', dataClass: 'synthetic', accessoryIds: [] },
  /** Fixed evaluation time for deterministic tests; production uses time after verification. */
  nowSeconds?: number,
): Promise<ConnectorDecision> {
  if (policy?.enabled !== true) return deny('disabled');
  if (!policyValid(policy)) return deny('invalid_policy');
  // A closed tool map rejects writes/physical controls even if policy is misconfigured.
  if (!request || !isReadTool(request.tool)) return deny('unsupported_tool');
  if (!isDataClass(request.dataClass) || !idsValid(request.accessoryIds)
      || (request.tool === 'homekit_read_accessory' && request.accessoryIds.length !== 1)
      || (nowSeconds !== undefined && (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0))) return deny('invalid_request');
  // Snapshot the resolved request so an async verifier cannot substitute its targets/class/tool.
  const tool = request.tool;
  const dataClass = request.dataClass;
  if (!policy.allowedTools.includes(tool)) return deny('tool_denied');
  if (!policy.allowedDataClasses.includes(dataClass)) return deny('data_class_denied');
  const targets = request.accessoryIds.map(canonicalId);
  const approved = new Set(policy.allowedAccessoryIds.map(canonicalId));
  if (targets.some(id => !approved.has(id))) return deny('accessory_denied');
  if (typeof token !== 'string' || token.length === 0 || token.length > 16_384) return deny('token_invalid');
  let claims: VerifiedTokenClaims | null;
  try { claims = await verifier.verify(token); } catch { return deny('token_invalid'); }
  if (!claims || !boundedText(claims.issuer) || !boundedText(claims.audience)
      || !boundedText(claims.subject) || !textList(claims.scopes)
      || !Number.isSafeInteger(claims.expiresAt) || claims.expiresAt < 0) return deny('token_invalid');
  if (policy.enabled !== true) return deny('disabled');
  if (!policyValid(policy)) return deny('invalid_policy');
  if (!policy.allowedTools.includes(tool)) return deny('tool_denied');
  if (!policy.allowedDataClasses.includes(dataClass)) return deny('data_class_denied');
  const stillApproved = new Set(policy.allowedAccessoryIds.map(canonicalId));
  if (targets.some(id => !stillApproved.has(id))) return deny('accessory_denied');
  if (claims.issuer !== policy.issuer) return deny('issuer_mismatch');
  if (claims.audience !== policy.audience) return deny('audience_mismatch');
  const evaluatedNow = nowSeconds ?? Math.floor(Date.now() / 1000);
  if (claims.expiresAt <= evaluatedNow) return deny('token_expired');
  if (!policy.allowedSubjects.includes(claims.subject)) return deny('subject_denied');
  const requiredScope = READ_TOOL_SCOPES[tool];
  if (!claims.scopes.includes(requiredScope)) return deny('scope_denied');
  return { allowed: true, tool, requiredScope, dataClass, accessoryIds: targets };
}
