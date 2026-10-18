import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { accessoryId } from './config.js';
import type { HomeKitBridge } from './bridge.js';

export const MAX_HOST_REQUEST_BYTES = 64 * 1024;
export const MAX_HOST_RESPONSE_BYTES = 1024 * 1024;
export type HostBridge = Pick<HomeKitBridge, 'status' | 'listAccessories' | 'readAccessory'>;
export type HostHeaders = Readonly<Record<string, string | readonly string[] | undefined>>;

export interface HostRequestEnvelope {
  method: string | undefined;
  path: string | undefined;
  headers: HostHeaders;
}

export interface HostProtocolRequest extends HostRequestEnvelope {
  body: Uint8Array;
}

export interface HostProtocolResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

const commandSchema = z.discriminatedUnion('command', [
  z.object({ command: z.literal('status') }).strict(),
  z.object({ command: z.literal('list_accessories') }).strict(),
  z.object({ command: z.literal('read_accessory'), accessoryId }).strict(),
]);
const tokenPattern = /^[A-Za-z0-9_-]{32,128}$/;

function response(statusCode: number, value: unknown): HostProtocolResponse {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      connection: 'close',
    },
    body: JSON.stringify(value),
  };
}

export function hostError(statusCode: number, code: string): HostProtocolResponse {
  return response(statusCode, { ok: false, error: { code } });
}

/** Duplicate or array-valued security headers are never combined. */
function oneHeader(headers: HostHeaders, name: string): string | undefined {
  const matches = Object.entries(headers).filter(([key, value]) => key.toLowerCase() === name && value !== undefined);
  if (matches.length !== 1 || typeof matches[0]?.[1] !== 'string') return undefined;
  return matches[0][1];
}

/** Pure preflight: no bridge, file, credential creation, or network side effects. */
export function validateHostEnvelope(request: HostRequestEnvelope, expectedToken: string): HostProtocolResponse | null {
  if (request.path !== '/bridge') return hostError(404, 'NOT_FOUND');
  if (request.method !== 'POST') return hostError(405, 'METHOD_NOT_ALLOWED');
  if (Object.entries(request.headers).some(([key, value]) => key.toLowerCase() === 'origin' && value !== undefined)) {
    return hostError(403, 'ORIGIN_NOT_ALLOWED');
  }
  if (!tokenPattern.test(expectedToken)) return hostError(503, 'GATEWAY_UNAVAILABLE');
  const authorization = oneHeader(request.headers, 'authorization');
  const supplied = authorization?.match(/^Bearer ([A-Za-z0-9_-]{32,128})$/)?.[1];
  if (supplied === undefined || supplied.length !== expectedToken.length
    || !timingSafeEqual(Buffer.from(supplied, 'ascii'), Buffer.from(expectedToken, 'ascii'))) {
    return hostError(401, 'UNAUTHORIZED');
  }
  const contentType = oneHeader(request.headers, 'content-type');
  if (contentType === undefined || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
    return hostError(415, 'UNSUPPORTED_MEDIA_TYPE');
  }
  if (Object.entries(request.headers).some(([key, value]) => key.toLowerCase() === 'content-encoding' && value !== undefined)) {
    return hostError(415, 'UNSUPPORTED_MEDIA_TYPE');
  }
  const lengths = Object.entries(request.headers).filter(([key, value]) => key.toLowerCase() === 'content-length' && value !== undefined);
  if (lengths.length > 0) {
    const length = oneHeader(request.headers, 'content-length');
    if (length === undefined || !/^\d{1,8}$/.test(length)) return hostError(400, 'INVALID_REQUEST');
    if (Number(length) > MAX_HOST_REQUEST_BYTES) return hostError(413, 'REQUEST_TOO_LARGE');
  }
  return null;
}

/** All request checks finish before this function invokes the read-only bridge. */
export async function handleHostRequest(
  request: HostProtocolRequest,
  bridge: HostBridge,
  expectedToken: string,
): Promise<HostProtocolResponse> {
  const envelopeError = validateHostEnvelope(request, expectedToken);
  if (envelopeError) return envelopeError;
  if (request.body.byteLength > MAX_HOST_REQUEST_BYTES) return hostError(413, 'REQUEST_TOO_LARGE');
  const declaredLength = oneHeader(request.headers, 'content-length');
  if (declaredLength !== undefined && Number(declaredLength) !== request.body.byteLength) return hostError(400, 'INVALID_REQUEST');
  let parsed: z.infer<typeof commandSchema>;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(request.body);
    parsed = commandSchema.parse(JSON.parse(text));
  } catch { return hostError(400, 'INVALID_REQUEST'); }
  try {
    const result = parsed.command === 'status' ? await bridge.status()
      : parsed.command === 'list_accessories' ? await bridge.listAccessories()
        : await bridge.readAccessory(parsed.accessoryId);
    const reply = response(200, { ok: true, result });
    return Buffer.byteLength(reply.body, 'utf8') <= MAX_HOST_RESPONSE_BYTES
      ? reply : hostError(502, 'INVALID_BRIDGE_RESPONSE');
  } catch {
    // Bridge errors may include names or OS messages. Never serialize their text.
    return hostError(503, 'BRIDGE_UNAVAILABLE');
  }
}
