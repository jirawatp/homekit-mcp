import test from 'node:test';
import assert from 'node:assert/strict';
import {
  authorizeConnectorRequest, denyAllConnectorPolicy, DenyAllTokenVerifier, READ_TOOL_SCOPES,
  type ConnectorPolicy, type ConnectorRequest, type TokenVerifier, type VerifiedTokenClaims,
} from '../src/connector-policy.js';

const now = 1_800_000_000;
const accessory = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
const claims: VerifiedTokenClaims = {
  issuer: 'https://synthetic-issuer.invalid', audience: 'synthetic-homekit-connector',
  subject: 'synthetic-user', expiresAt: now + 60, scopes: ['homekit:accessories:read'],
};
const policy: ConnectorPolicy = {
  ...denyAllConnectorPolicy, enabled: true, issuer: claims.issuer, audience: claims.audience,
  allowedSubjects: [claims.subject], allowedTools: ['homekit_read_accessory'], allowedAccessoryIds: [accessory],
};
const request: ConnectorRequest = { tool: 'homekit_read_accessory', dataClass: 'synthetic', accessoryIds: [accessory] };
/** Fake verification is only for synthetic policy tests; it is never installed in runtime. */
const fake = (overrides: Partial<VerifiedTokenClaims> = {}): TokenVerifier => ({ verify: async () => ({ ...claims, ...overrides }) });
const check = (p = policy, v = fake(), r = request, token = 'synthetic-token') => authorizeConnectorRequest(p, v, token, r, now);
async function denies(reason: string, p = policy, v = fake(), r = request, token = 'synthetic-token') {
  assert.deepEqual(await check(p, v, r, token), { allowed: false, reason });
}

test('connector is disabled by default and the default verifier never grants access', async () => {
  let calls = 0;
  assert.deepEqual(await authorizeConnectorRequest(), { allowed: false, reason: 'disabled' });
  await denies('disabled', denyAllConnectorPolicy, { verify: async () => { calls++; return claims; } });
  assert.equal(calls, 0);
  await denies('token_invalid', policy, new DenyAllTokenVerifier());
});

test('an explicit narrow synthetic read succeeds with exact claims, scope and accessory', async () => {
  const result = await check(policy, fake(), { ...request, accessoryIds: [accessory.toLowerCase()] });
  assert.deepEqual(result, { allowed: true, tool: 'homekit_read_accessory', requiredScope: 'homekit:accessories:read',
    dataClass: 'synthetic', accessoryIds: [accessory] });
  assert.equal('token' in result, false);
  assert.equal('subject' in result, false);
});

test('expiry, issuer, audience, subject and scope deny independently', async () => {
  await denies('token_expired', policy, fake({ expiresAt: now }));
  await denies('token_expired', policy, fake({ expiresAt: now - 1 }));
  await denies('issuer_mismatch', policy, fake({ issuer: claims.issuer + '/different' }));
  await denies('audience_mismatch', policy, fake({ audience: claims.audience + '-different' }));
  await denies('subject_denied', policy, fake({ subject: 'other-user' }));
  for (const scopes of [[], ['homekit:*'], ['homekit:accessories:read-more']]) await denies('scope_denied', policy, fake({ scopes }));
});

test('tools, accessory sets and household sharing need their own explicit allowlists', async () => {
  await denies('tool_denied', { ...policy, allowedTools: [] });
  await denies('accessory_denied', { ...policy, allowedAccessoryIds: [] });
  await denies('accessory_denied', policy, fake(), { ...request, accessoryIds: ['other-accessory'] });
  await denies('invalid_request', policy, fake(), { ...request, accessoryIds: [accessory, 'other-accessory'] });
  await denies('accessory_denied', { ...policy, allowedTools: ['homekit_list_accessories'] }, fake(),
    { ...request, tool: 'homekit_list_accessories', accessoryIds: [accessory, 'other-accessory'] });
  await denies('data_class_denied', policy, fake(), { ...request, dataClass: 'household' });
  const approved: ConnectorPolicy = { ...policy, allowedDataClasses: ['synthetic', 'household'] };
  assert.equal((await check(approved, fake(), { ...request, dataClass: 'household' })).allowed, true);
  await denies('invalid_request', policy, fake(), { ...request, accessoryIds: [] });
});

test('all six existing tools have explicit read scopes; every unknown or physical-control tool is denied', async () => {
  assert.equal(Object.keys(READ_TOOL_SCOPES).length, 6);
  for (const [tool, scope] of Object.entries(READ_TOOL_SCOPES)) {
    assert.match(scope, /^homekit:[a-z]+:read$/);
    assert.equal((await check({ ...policy, allowedTools: [tool as keyof typeof READ_TOOL_SCOPES] },
      fake({ scopes: [scope] }), { ...request, tool })).allowed, true);
  }
  for (const tool of ['write', 'homekit_set_characteristic', 'homekit_unlock', 'homekit_open_garage',
    'homekit_camera_snapshot', 'homekit_record', 'homekit_upload', 'toString', '__proto__']) {
    await denies('unsupported_tool', policy, fake(), { ...request, tool });
    const invalid = { ...policy, allowedTools: [tool] } as unknown as ConnectorPolicy;
    assert.equal((await check(invalid, fake(), { ...request, tool })).allowed, false);
  }
});

test('invalid verifier results, verifier failures and malformed policies/requests fail closed', async () => {
  await denies('token_invalid', policy, { verify: async () => null });
  await denies('token_invalid', policy, { verify: async () => { throw new Error('private verifier detail'); } });
  await denies('token_invalid', policy, fake(), request, '');
  await denies('token_invalid', policy, fake(), request, 'x'.repeat(16_385));
  for (const expiresAt of [NaN, Infinity, now + 0.5]) await denies('token_invalid', policy, fake({ expiresAt }));
  await denies('invalid_policy', { ...policy, allowedSubjects: ['*'] });
  await denies('invalid_policy', { ...policy, allowedAccessoryIds: [accessory, accessory.toLowerCase()] });
  await denies('invalid_request', policy, fake(), { ...request, dataClass: 'camera-media' as 'synthetic' });
  await denies('invalid_request', policy, fake(), { ...request, accessoryIds: ['*'] });
});

test('a disabled policy during verification denies the pending request', async () => {
  const changeable = { ...policy };
  const verifier: TokenVerifier = { verify: async () => { changeable.enabled = false; return claims; } };
  await denies('disabled', changeable, verifier);
});

test('policy revocation during verification is rechecked; the resolved request is snapshotted', async () => {
  for (const [field, reason] of [['allowedTools', 'tool_denied'], ['allowedAccessoryIds', 'accessory_denied'],
    ['allowedDataClasses', 'data_class_denied']] as const) {
    const changeable = { ...policy };
    await denies(reason, changeable, { verify: async () => { changeable[field] = []; return claims; } });
  }
  const mutableRequest = { ...request, accessoryIds: [...request.accessoryIds] };
  const result = await check(policy, { verify: async () => {
    mutableRequest.tool = 'homekit_unlock'; mutableRequest.dataClass = 'household';
    mutableRequest.accessoryIds.push('unapproved'); return claims;
  } }, mutableRequest);
  assert.deepEqual(result, { allowed: true, tool: request.tool, dataClass: 'synthetic',
    requiredScope: 'homekit:accessories:read', accessoryIds: [accessory] });
});

test('production expiry is evaluated after asynchronous verification', async () => {
  const originalNow = Date.now;
  let clock = now * 1000;
  Date.now = () => clock;
  try {
    const result = await authorizeConnectorRequest(policy, { verify: async () => {
      clock = claims.expiresAt * 1000; return claims;
    } }, 'synthetic-token', request);
    assert.deepEqual(result, { allowed: false, reason: 'token_expired' });
  } finally { Date.now = originalNow; }
});
