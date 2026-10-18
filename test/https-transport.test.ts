import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpsBridgeTransport, loadHttpsBridgeTransport, validateHostBridgeUrl } from '../src/https-transport.js';
import { mkdtemp, writeFile, symlink, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Synthetic strings for an injected mock requester; not valid TLS credentials and no listener exists.
const credentials = { url: 'https://host.docker.internal:18443', ca: '-----BEGIN CERTIFICATE-----synthetic', token: 'synthetic_test_token_never_used_1234' };
test('Docker host URL rejects public endpoints, plaintext, credentials, query and alternate paths', () => {
  for (const url of ['http://host.docker.internal:18443', 'https://example.com/bridge',
    'https://user:password@localhost:18443/bridge', 'https://localhost/other', 'https://localhost/bridge?token=x',
    'https://localhost/bridge']) {
    assert.throws(() => validateHostBridgeUrl(url));
  }
  assert.equal(validateHostBridgeUrl(credentials.url).pathname, '/bridge');
});

test('supplied CA cannot be symlinked or writable by other users before any credential is read', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'homekit-ca-test-'));
  const ca = join(directory, 'synthetic-ca.txt');
  const link = join(directory, 'linked-ca.txt');
  try {
    await writeFile(ca, 'synthetic non-credential fixture', { mode: 0o600 });
    await symlink(ca, link);
    await assert.rejects(loadHttpsBridgeTransport(credentials.url, link, '/missing-token-not-read'));
    await chmod(ca, 0o666);
    await assert.rejects(loadHttpsBridgeTransport(credentials.url, ca, '/missing-token-not-read'), /HOST_BRIDGE_CA_FILE_PERMISSIONS/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('host transport uses fixed reads, private CA, TLS authorization and no credential in body', async () => {
  const transport = new HttpsBridgeTransport(credentials, async options => {
    assert.equal(options.url.hostname, 'host.docker.internal');
    assert.equal(options.url.pathname, '/bridge');
    assert.equal(options.ca, credentials.ca);
    assert.equal(options.token, credentials.token);
    assert.deepEqual(JSON.parse(options.body), { command: 'read_accessory', accessoryId: 'demo-temperature' });
    return { ok: true, result: { synthetic: true } };
  });
  assert.deepEqual(await transport.request('read_accessory', 'demo-temperature'), { synthetic: true });
  await transport.close();
  await assert.rejects(transport.request('status'), /BRIDGE_CLOSED/);
});

test('host client rejects writes and malformed/errors before state can be exposed', async () => {
  let calls = 0;
  const transport = new HttpsBridgeTransport(credentials, async () => { calls++; return { ok: false, error: { message: 'sensitive detail' } }; });
  await assert.rejects(transport.request('write' as 'status'), /HOST_BRIDGE_COMMAND_REFUSED/);
  assert.equal(calls, 0);
  await assert.rejects(transport.request('status'), /HOST_BRIDGE_READ_FAILED/);
  assert.equal(calls, 1);
  assert.throws(() => new HttpsBridgeTransport({ ...credentials, token: 'weak' }));
});
