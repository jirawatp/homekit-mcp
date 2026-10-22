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

// ---- Protocol, bounded-file and lifecycle coverage: in-memory request factory, no sockets or credentials ----
import type https from 'node:https';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHostRequester, readBounded, type BoundedFileAccess } from '../src/https-transport.js';

type Respond = (status: number, headers: Record<string, string>, chunks?: Array<Buffer | string>) => PassThrough;
interface Captured { url: unknown; options: Record<string, any>; body?: string | undefined; destroyed: boolean }

class FakeClientRequest extends EventEmitter {
  destroyed = false; body: string | undefined; onEnd: (() => void) | undefined;
  end(body: string) { this.body = body; this.onEnd?.(); }
  destroy() { this.destroyed = true; return this; }
}

function requestFactory(behavior: (context: { request: FakeClientRequest; respond: Respond }) => void): { factory: typeof https.request; captured: Captured[] } {
  const captured: Captured[] = [];
  const factory = ((url: unknown, options: Record<string, any>, callback: (response: PassThrough) => void) => {
    const request = new FakeClientRequest();
    const record: Captured = { url, options, destroyed: false };
    captured.push(record);
    (options.signal as AbortSignal | undefined)?.addEventListener('abort', () => request.emit('error', new Error('aborted /secret')));
    request.onEnd = () => {
      record.body = request.body;
      const respond: Respond = (statusCode, headers, chunks = []) => {
        const response = Object.assign(new PassThrough(), { statusCode, headers });
        callback(response);
        for (const chunk of chunks) response.write(chunk);
        return response;
      };
      behavior({ request, respond });
      record.destroyed = request.destroyed;
    };
    return request;
  }) as unknown as typeof https.request;
  return { factory, captured };
}
const JSON_TYPE = { 'content-type': 'application/json; charset=utf-8' };
const requestOptions = (signal = new AbortController().signal) => ({ url: new URL('https://host.docker.internal:18443/bridge'),
  ca: credentials.ca, token: credentials.token, body: '{"command":"status"}', signal });

test('TLS requester pins TLS 1.3, the private CA and certificate verification and sends the token only as a header', async () => {
  const { factory, captured } = requestFactory(({ respond }) => { respond(200, JSON_TYPE, ['{"ok":true,', '"result":1}']).end(); });
  assert.deepEqual(await createHostRequester(factory)(requestOptions()), { ok: true, result: 1 });
  const { options, body } = captured[0]!;
  assert.equal(options.method, 'POST');
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.minVersion, 'TLSv1.3');
  assert.equal(options.ca, credentials.ca);
  assert.equal(options.headers.authorization, `Bearer ${credentials.token}`);
  assert.equal(options.headers['content-length'], Buffer.byteLength('{"command":"status"}'));
  assert.equal(body, '{"command":"status"}');
  assert.equal(body?.includes(credentials.token), false);
});

test('TLS requester fails closed on bad status, media type, oversize, malformed, broken and truncated replies', async () => {
  const cases: Array<[string, RegExp, (respond: Respond) => void]> = [
    ['server error', /HOST_BRIDGE_REQUEST_REFUSED/, respond => { respond(500, JSON_TYPE, ['{}']); }],
    ['wrong media type', /HOST_BRIDGE_REQUEST_REFUSED/, respond => { respond(200, { 'content-type': 'text/html' }); }],
    ['missing media type', /HOST_BRIDGE_REQUEST_REFUSED/, respond => { respond(200, {}); }],
    ['oversize reply', /HOST_BRIDGE_FRAME_TOO_LARGE/, respond => {
      const response = respond(200, JSON_TYPE, [Buffer.alloc(600 * 1024), Buffer.alloc(600 * 1024)]); response.end(); }],
    ['malformed JSON', /HOST_BRIDGE_PROTOCOL_ERROR/, respond => { respond(200, JSON_TYPE, ['not json']).end(); }],
    ['response stream error', /HOST_BRIDGE_IO_ERROR/, respond => { respond(200, JSON_TYPE, ['{']).destroy(new Error('reset /secret')); }],
    ['connection closed before end', /HOST_BRIDGE_IO_ERROR/, respond => { respond(200, JSON_TYPE, ['{"ok"']).destroy(); }],
  ];
  for (const [label, expected, script] of cases) {
    const { factory } = requestFactory(({ respond }) => script(respond));
    await assert.rejects(createHostRequester(factory)(requestOptions()), error => {
      assert.match((error as Error).message, expected, label);
      assert.doesNotMatch((error as Error).message, /secret/);
      return true;
    });
  }
  const refused = requestFactory(({ respond }) => { respond(503, JSON_TYPE); });
  await assert.rejects(createHostRequester(refused.factory)(requestOptions()));
  assert.equal(refused.captured[0]!.destroyed, true, 'a refused request is destroyed immediately');
  const down = requestFactory(({ request }) => { request.emit('error', new Error('ECONNREFUSED 127.0.0.1:18443')); });
  await assert.rejects(createHostRequester(down.factory)(requestOptions()), error => {
    assert.equal((error as Error).message, 'HOST_BRIDGE_UNAVAILABLE');
    return true;
  });
});

test('default requester wiring uses the real https client only when called', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(createHostRequester()(requestOptions(controller.signal)), /HOST_BRIDGE_UNAVAILABLE/);
});

test('transport timeout aborts the in-flight request, frees the slot and reports a bounded error', async () => {
  const { factory } = requestFactory(() => {});
  const transport = new HttpsBridgeTransport(credentials, createHostRequester(factory), 20);
  await assert.rejects(transport.request('status'), /HOST_BRIDGE_UNAVAILABLE/);
  await assert.rejects(transport.request('list_accessories'), /HOST_BRIDGE_UNAVAILABLE/, 'a timed-out request does not leave the transport busy');
});

test('close aborts an in-flight read and concurrent reads are refused', async () => {
  const { factory } = requestFactory(() => {});
  const transport = new HttpsBridgeTransport(credentials, createHostRequester(factory), 5_000);
  const pending = transport.request('status');
  await assert.rejects(transport.request('status'), /BRIDGE_BUSY/);
  await transport.close();
  await assert.rejects(pending, /HOST_BRIDGE_UNAVAILABLE/);
  await assert.rejects(transport.request('status'), /BRIDGE_CLOSED/);
});

test('host transport validates ids and replies before exposing results', async () => {
  const replies: unknown[] = [null, 'text', 42, { ok: false }, { ok: 'true' }];
  for (const reply of replies) {
    const transport = new HttpsBridgeTransport(credentials, async () => reply);
    await assert.rejects(transport.request('status'), /HOST_BRIDGE_(PROTOCOL_ERROR|READ_FAILED)/, JSON.stringify(reply));
  }
  let calls = 0;
  const transport = new HttpsBridgeTransport(credentials, async () => { calls++; return { ok: true, result: 'fine' }; });
  await assert.rejects(transport.request('read_accessory'), 'a read needs an accessory id');
  await assert.rejects(transport.request('read_accessory', 'bad id with spaces'));
  await assert.rejects(transport.request('status', 'demo-temperature'), /HOST_BRIDGE_COMMAND_REFUSED/);
  assert.equal(calls, 0, 'invalid requests never leave the process');
  assert.equal(await transport.request('list_accessories'), 'fine');
  assert.throws(() => new HttpsBridgeTransport({ ...credentials, ca: 'not a certificate' }), /HOST_BRIDGE_CREDENTIALS_REQUIRED/);
});

function fileAccess(init: { size?: number; uid?: number; mode?: number; regular?: boolean; content?: Buffer; grow?: number; chunk?: number }, closes: { count: number }, uid = 501): BoundedFileAccess {
  const content = init.content ?? Buffer.from('abcd');
  return {
    uid,
    open: async () => ({
      stat: async () => ({ isFile: () => init.regular ?? true, size: init.size ?? content.length, uid: init.uid ?? uid, mode: init.mode ?? 0o600 }),
      read: async (buffer, offset, length, position) => {
        const source = init.grow ? Buffer.concat([content, Buffer.alloc(init.grow, 0x61)]) : content;
        const bytesRead = Math.min(length, init.chunk ?? length, Math.max(0, source.length - position));
        source.copy(buffer, offset, position, position + bytesRead);
        return { bytesRead };
      },
      close: async () => { closes.count++; },
    }),
  };
}

test('bounded reader enforces file type, size, ownership and permissions and always closes', async () => {
  const cases: Array<[string, Parameters<typeof fileAccess>[0], boolean, RegExp]> = [
    ['special file', { regular: false }, true, /HOST_BRIDGE_FILE_REFUSED/],
    ['oversize by stat', { size: 100 }, true, /HOST_BRIDGE_FILE_REFUSED/],
    ['grew after stat', { grow: 50 }, true, /HOST_BRIDGE_FILE_REFUSED/],
    ['group-readable secret', { mode: 0o640 }, true, /HOST_BRIDGE_PRIVATE_FILE_PERMISSIONS/],
    ['other-owner secret', { uid: 0 }, true, /HOST_BRIDGE_PRIVATE_FILE_PERMISSIONS/],
    ['unreadable secret', { mode: 0o200 }, true, /HOST_BRIDGE_PRIVATE_FILE_PERMISSIONS/],
    ['writable CA', { mode: 0o664 }, false, /HOST_BRIDGE_CA_FILE_PERMISSIONS/],
  ];
  for (const [label, init, privateFile, expected] of cases) {
    const closes = { count: 0 };
    await assert.rejects(readBounded('/synthetic', 16, privateFile, fileAccess(init, closes)), expected, label);
    assert.equal(closes.count, 1, `${label} closes its descriptor`);
  }
  const closes = { count: 0 };
  assert.equal(await readBounded('/synthetic', 16, true, fileAccess({ chunk: 1 }, closes)), 'abcd', 'short reads are accumulated');
  assert.equal(await readBounded('/synthetic', 16, false, fileAccess({ mode: 0o644 }, closes)), 'abcd');
});

test('loading from real synthetic files accepts private token and CA, and refuses special files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'homekit-https-load-'));
  try {
    const ca = join(directory, 'ca.txt'); const tokenFile = join(directory, 'token.txt'); const fifo = join(directory, 'fifo');
    await writeFile(ca, '-----BEGIN CERTIFICATE-----\nsynthetic fixture, not a certificate\n', { mode: 0o644 });
    await writeFile(tokenFile, `${credentials.token}\n`, { mode: 0o600 });
    const transport = await loadHttpsBridgeTransport(credentials.url, ca, tokenFile);
    await transport.close();
    // A symlink to an otherwise valid CA and token must be refused by O_NOFOLLOW alone.
    await chmod(tokenFile, 0o600);
    const caLink = join(directory, 'ca-link.txt'); const tokenLink = join(directory, 'token-link.txt');
    await symlink(ca, caLink); await symlink(tokenFile, tokenLink);
    await assert.rejects(loadHttpsBridgeTransport(credentials.url, caLink, tokenFile), { code: 'ELOOP' });
    await assert.rejects(loadHttpsBridgeTransport(credentials.url, ca, tokenLink), { code: 'ELOOP' });
    await chmod(tokenFile, 0o644);
    await assert.rejects(loadHttpsBridgeTransport(credentials.url, ca, tokenFile), /HOST_BRIDGE_PRIVATE_FILE_PERMISSIONS/);
    await assert.rejects(loadHttpsBridgeTransport('https://example.com:18443/bridge', ca, tokenFile), /HOST_BRIDGE_URL_REFUSED/);
    assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
    // Child process with a hard timeout: removing O_NONBLOCK would block open() on the FIFO and fail fast here.
    const moduleUrl = pathToFileURL(resolve('dist/src/https-transport.js')).href;
    const script = `import(${JSON.stringify(moduleUrl)}).then(async m => { try { await m.loadHttpsBridgeTransport(${JSON.stringify(credentials.url)}, ${JSON.stringify(fifo)}, ${JSON.stringify(tokenFile)}); console.log('ACCEPTED'); }`
      + ` catch (error) { console.log(error.message); } process.exit(0); });`;
    const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL' });
    assert.equal(child.error, undefined, 'a FIFO must not hang the loader');
    assert.equal(child.stdout.trim(), 'HOST_BRIDGE_FILE_REFUSED');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
