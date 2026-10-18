import assert from 'node:assert/strict';
import test from 'node:test';
import { HomeKitBridge, type BridgeTransport } from '../src/bridge.js';
import { parseHostGatewayOptions } from '../src/host-gateway.js';
import {
  handleHostRequest, MAX_HOST_REQUEST_BYTES, MAX_HOST_RESPONSE_BYTES,
  type HostBridge, type HostProtocolRequest,
} from '../src/host-protocol.js';

// Synthetic protocol text only. These tests create no credential files or ports.
const token = 'synthetic_unit_test_token_1234567890';
const observedAt = '2026-01-01T12:00:00.000Z';

function fixtureBridge(): { bridge: HostBridge; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    bridge: {
      async status() {
        calls.push('status');
        return { protocolVersion: 1, platform: 'synthetic-test', authorization: 'not_requested',
          enabled: false, readOnly: true, allowlistedAccessoryCount: 0 };
      },
      async listAccessories() { calls.push('list_accessories'); return { accessories: [], observedAt }; },
      async readAccessory(id: string) {
        calls.push(`read_accessory:${id}`);
        return { id, name: 'Synthetic test sensor', reachable: true, observedAt, services: [] };
      },
    },
  };
}

function request(value: unknown = { command: 'status' }, overrides: Partial<HostProtocolRequest> = {}): HostProtocolRequest {
  return {
    method: 'POST', path: '/bridge',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify(value), 'utf8'), ...overrides,
  };
}

test('pure handler dispatches only the three read commands and envelopes results', async () => {
  const { bridge, calls } = fixtureBridge();
  for (const body of [{ command: 'status' }, { command: 'list_accessories' }, { command: 'read_accessory', accessoryId: 'synthetic-sensor' }]) {
    const reply = await handleHostRequest(request(body), bridge, token);
    assert.equal(reply.statusCode, 200);
    assert.equal(JSON.parse(reply.body).ok, true);
    assert.equal(reply.headers['cache-control'], 'no-store');
    assert.equal(reply.headers['x-content-type-options'], 'nosniff');
    assert.equal('access-control-allow-origin' in reply.headers, false);
  }
  assert.deepEqual(calls, ['status', 'list_accessories', 'read_accessory:synthetic-sensor']);
});

test('path and method failures never access the bridge', async () => {
  const { bridge, calls } = fixtureBridge();
  for (const [overrides, code] of [
    [{ path: '/bridge?command=status' }, 404], [{ path: '/other' }, 404],
    [{ method: 'GET' }, 405], [{ method: 'OPTIONS' }, 405], [{ method: 'post' }, 405],
  ] as const) {
    assert.equal((await handleHostRequest(request({}, overrides), bridge, token)).statusCode, code);
  }
  assert.deepEqual(calls, []);
});

test('missing, wrong, short, duplicate, or array bearer headers never access the bridge', async () => {
  const { bridge, calls } = fixtureBridge();
  for (const headers of [
    { 'content-type': 'application/json' },
    { authorization: `Bearer ${'x'.repeat(token.length)}`, 'content-type': 'application/json' },
    { authorization: 'Bearer too-short', 'content-type': 'application/json' },
    { authorization: `Basic ${token}`, 'content-type': 'application/json' },
    { authorization: [`Bearer ${token}`], 'content-type': 'application/json' },
    { authorization: `Bearer ${token}`, Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  ]) {
    const reply = await handleHostRequest(request({}, { headers }), bridge, token);
    assert.equal(reply.statusCode, 401);
    assert.deepEqual(JSON.parse(reply.body), { ok: false, error: { code: 'UNAUTHORIZED' } });
  }
  assert.deepEqual(calls, []);
});

test('any Origin, including empty or null-like Origin, is rejected without CORS', async () => {
  const { bridge, calls } = fixtureBridge();
  for (const origin of ['', 'null', 'https://example.invalid']) {
    const reply = await handleHostRequest(request({}, { headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json', Origin: origin,
    } }), bridge, token);
    assert.equal(reply.statusCode, 403);
    assert.equal('access-control-allow-origin' in reply.headers, false);
  }
  assert.deepEqual(calls, []);
});

test('JSON media type is mandatory and compressed or duplicate types are rejected', async () => {
  const { bridge, calls } = fixtureBridge();
  for (const extra of [
    { 'content-type': 'text/plain' }, { 'content-type': 'application/json; charset=latin1' },
    { 'content-type': ['application/json'] }, { 'content-type': 'application/json', 'Content-Type': 'application/json' },
    { 'content-type': 'application/json', 'content-encoding': 'gzip' },
  ]) {
    const reply = await handleHostRequest(request({}, { headers: { authorization: `Bearer ${token}`, ...extra } }), bridge, token);
    assert.equal(reply.statusCode, 415);
  }
  const accepted = await handleHostRequest(request({ command: 'status' }, { headers: {
    authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8',
  } }), bridge, token);
  assert.equal(accepted.statusCode, 200);
  assert.deepEqual(calls, ['status']);
});

test('oversized actual or declared bodies are rejected before bridge access', async () => {
  const { bridge, calls } = fixtureBridge();
  const large = await handleHostRequest(request({}, { body: Buffer.alloc(MAX_HOST_REQUEST_BYTES + 1) }), bridge, token);
  assert.equal(large.statusCode, 413);
  const declared = await handleHostRequest(request({}, { headers: {
    authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': String(MAX_HOST_REQUEST_BYTES + 1),
  } }), bridge, token);
  assert.equal(declared.statusCode, 413);
  assert.deepEqual(calls, []);
});

test('invalid UTF-8, malformed JSON, lengths, and nonobjects are rejected', async () => {
  const { bridge, calls } = fixtureBridge();
  for (const body of [Buffer.from([0xc3, 0x28]), Buffer.from('{'), Buffer.from('null'), Buffer.from('[]')]) {
    assert.equal((await handleHostRequest(request({}, { body }), bridge, token)).statusCode, 400);
  }
  for (const length of ['1', '-2', '1.5', '9999999999']) {
    assert.equal((await handleHostRequest(request({}, { headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': length,
    } }), bridge, token)).statusCode, 400);
  }
  assert.deepEqual(calls, []);
});

test('unknown fields, actuation, missing IDs, and malformed IDs are rejected', async () => {
  const { bridge, calls } = fixtureBridge();
  for (const body of [
    { command: 'write_accessory', accessoryId: 'synthetic-sensor', value: true },
    { command: 'unlock' }, { command: 'status', accessoryId: 'synthetic-sensor' },
    { command: 'list_accessories', debug: true }, { command: 'read_accessory' },
    { command: 'read_accessory', accessoryId: '../private' },
    { command: 'read_accessory', accessoryId: 'a'.repeat(129) },
  ]) assert.equal((await handleHostRequest(request(body), bridge, token)).statusCode, 400);
  assert.deepEqual(calls, []);
});

test('UUID IDs are normalized through the same configuration policy', async () => {
  const { bridge, calls } = fixtureBridge();
  const reply = await handleHostRequest(request({ command: 'read_accessory', accessoryId: 'abcdefab-1234-1234-1234-abcdefabcdef' }), bridge, token);
  assert.equal(reply.statusCode, 200);
  assert.deepEqual(calls, ['read_accessory:ABCDEFAB-1234-1234-1234-ABCDEFABCDEF']);
});

test('real wrapper denies IDs outside the allowlist before touching its transport', async () => {
  const calls: string[] = [];
  const transport: BridgeTransport = { async request(command) { calls.push(command); return {}; }, async close() {} };
  const bridge = new HomeKitBridge(transport, { version: 1, mode: 'read-only', allowedAccessoryIds: [] });
  const reply = await handleHostRequest(request({ command: 'read_accessory', accessoryId: 'synthetic-sensor' }), bridge, token);
  assert.equal(reply.statusCode, 503);
  assert.deepEqual(JSON.parse(reply.body), { ok: false, error: { code: 'BRIDGE_UNAVAILABLE' } });
  assert.deepEqual(calls, []);
});

test('bridge errors never return native messages, device names, or stack traces', async () => {
  const { bridge } = fixtureBridge();
  bridge.status = async () => { throw new Error('PRIVATE_HOUSEHOLD_NAME_AND_OS_MESSAGE'); };
  const reply = await handleHostRequest(request(), bridge, token);
  assert.equal(reply.statusCode, 503);
  assert.equal(reply.body.includes('PRIVATE_HOUSEHOLD'), false);
  assert.deepEqual(JSON.parse(reply.body), { ok: false, error: { code: 'BRIDGE_UNAVAILABLE' } });
});

test('oversized bridge output is withheld and replaced with a bounded generic error', async () => {
  const { bridge } = fixtureBridge();
  bridge.status = async () => ({ text: 'synthetic'.repeat(MAX_HOST_RESPONSE_BYTES) }) as never;
  const reply = await handleHostRequest(request(), bridge, token);
  assert.equal(reply.statusCode, 502);
  assert.equal(Buffer.byteLength(reply.body) < 1024, true);
  assert.deepEqual(JSON.parse(reply.body), { ok: false, error: { code: 'INVALID_BRIDGE_RESPONSE' } });
});

test('invalid configured token fails closed instead of accepting a short secret', async () => {
  const { bridge, calls } = fixtureBridge();
  assert.equal((await handleHostRequest(request(), bridge, 'short')).statusCode, 503);
  assert.deepEqual(calls, []);
});

test('CLI parsing requires both approval flags, absolute files, and the fixed port', () => {
  const args = [
    '--bridge', '/synthetic/bridge', '--config', '/synthetic/config.json',
    '--token-file', '/synthetic/token', '--cert-file', '/synthetic/cert.pem', '--key-file', '/synthetic/key.pem',
    '--port', '18443', '--native-user-approved', '--host-bridge-user-approved',
  ];
  assert.equal(parseHostGatewayOptions(args).port, 18443);
  assert.throws(() => parseHostGatewayOptions(args.filter(arg => arg !== '--native-user-approved')), /USER_APPROVAL_REQUIRED/);
  assert.throws(() => parseHostGatewayOptions(args.filter(arg => arg !== '--host-bridge-user-approved')), /USER_APPROVAL_REQUIRED/);
  assert.throws(() => parseHostGatewayOptions(args.map(arg => arg === '/synthetic/bridge' ? './bridge' : arg)), /ABSOLUTE_PATH_REQUIRED/);
  assert.throws(() => parseHostGatewayOptions(args.map(arg => arg === '18443' ? '443' : arg)), /PORT_18443_REQUIRED/);
  assert.throws(() => parseHostGatewayOptions([...args, '--host', '0.0.0.0']), /INVALID_ARGUMENTS/);
});
