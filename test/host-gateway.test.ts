import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { Readable } from 'node:stream';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { KeyObject } from 'node:crypto';
import {
  defaultDependencies, defaultTlsPrimitives, parseHostGatewayOptions, rawHeaderValues, readSuppliedFile, requestBody,
  runHostGateway, runHostGatewayCli, validateBridgeExecutable, validateTlsCredentials,
  type CertificateLike, type GatewayBridge, type GatewayDependencies, type GatewayServer, type ServerSettings,
  type SuppliedFile, type TlsPrimitives,
} from '../src/host-gateway.js';

// Fakes are in-memory. A few tests create harmless temp files (symlinks, a FIFO, a token-format string) and bounded
// `node` child processes to prove the real opener flags; no real credential, key, certificate, listener or helper is created.
const token = 'synthetic_gateway_token_1234567890_abcd';
const ARGS = ['--native-user-approved', '--host-bridge-user-approved', '--bridge', '/synthetic/bridge', '--config', '/synthetic/config.json',
  '--token-file', '/synthetic/token', '--cert-file', '/synthetic/cert.pem', '--key-file', '/synthetic/key.pem', '--port', '18443'];
const NOW = Date.parse('2026-06-01T00:00:00Z');
const OWNER = 501;

interface FakeFileInit { content?: Buffer; size?: number; uid?: number; mode?: number; regular?: boolean; chunk?: number; growBy?: number }

class FakeFile implements SuppliedFile {
  closed = false;
  readonly content: Buffer;
  constructor(private readonly init: FakeFileInit) { this.content = init.content ?? Buffer.alloc(0); }
  async stat() {
    const { init } = this;
    return { isFile: () => init.regular ?? true, size: init.size ?? this.content.length, uid: init.uid ?? OWNER, mode: init.mode ?? 0o600 };
  }
  async read(buffer: Buffer, offset: number, length: number, position: number) {
    const source = this.init.growBy ? Buffer.concat([this.content, Buffer.alloc(this.init.growBy, 0x61)]) : this.content;
    const bytesRead = Math.min(length, this.init.chunk ?? length, Math.max(0, source.length - position));
    source.copy(buffer, offset, position, position + bytesRead);
    return { bytesRead };
  }
  async close() { this.closed = true; }
}

const goodConfig = Buffer.from(JSON.stringify({ version: 1, mode: 'read-only', allowedAccessoryIds: ['demo-temperature'] }));
const goodFiles = (): Record<string, FakeFileInit> => ({
  '/synthetic/token': { content: Buffer.from(`${token}\n`) },
  '/synthetic/key.pem': { content: Buffer.from('synthetic key placeholder') },
  '/synthetic/cert.pem': { content: Buffer.from('synthetic cert placeholder'), mode: 0o644 },
  '/synthetic/config.json': { content: goodConfig },
  '/synthetic/bridge': { content: Buffer.from('x'), mode: 0o755 },
});

function goodCertificate(overrides: Partial<CertificateLike> = {}): CertificateLike {
  return {
    validFrom: 'Jan  1 00:00:00 2026 GMT', validTo: 'Dec 31 00:00:00 2026 GMT',
    checkHost: () => 'host.docker.internal', checkPrivateKey: () => true, ...overrides,
  };
}

function fakeTls(certificate: CertificateLike = goodCertificate(), failures: Partial<Record<'key' | 'context' | 'cert', true>> = {}): TlsPrimitives & { contexts: unknown[] } {
  const contexts: unknown[] = [];
  return {
    contexts,
    parseCertificate: () => { if (failures.cert) throw new Error('parser leaked /secret/path'); return certificate; },
    parsePrivateKey: () => { if (failures.key) throw new Error('key parser text'); return {} as KeyObject; },
    createSecureContext: options => { if (failures.context) throw new Error('context text'); contexts.push(options); return {}; },
  };
}

class FakeServer extends EventEmitter {
  maxConnections = 0; maxRequestsPerSocket: number | null = null; headersTimeout = 0; requestTimeout = 0; keepAliveTimeout = 0;
  listenCalls: unknown[] = []; closeCalls = 0; closeAllCalls = 0; timeout?: { ms: number; callback: (socket: { destroy(): void }) => void };
  constructor(private readonly outcome: 'listening' | 'error' | 'throw' = 'listening') { super(); }
  setTimeout(ms: number, callback: (socket: { destroy(): void }) => void) { this.timeout = { ms, callback }; return this; }
  listen(options: { host: string; port: number; exclusive: boolean }) {
    this.listenCalls.push(options);
    if (this.outcome === 'throw') throw new Error('synchronous listen failure');
    queueMicrotask(() => { if (this.outcome === 'error') this.emit('error', new Error('EADDRINUSE /secret')); else this.emit('listening'); });
    return this;
  }
  close() { this.closeCalls++; }
  closeAllConnections() { this.closeAllCalls++; }
}

class FakeBridge implements GatewayBridge {
  calls: string[] = []; closeCalls = 0; failure: Error | undefined; closeFailure: Error | undefined;
  async status() {
    this.calls.push('status');
    if (this.failure) throw this.failure;
    return { protocolVersion: 1, platform: 'synthetic', authorization: 'not_requested', enabled: false, readOnly: true, allowlistedAccessoryCount: 1 } as never;
  }
  async listAccessories() { this.calls.push('list'); return { accessories: [], observedAt: '2026-01-01T00:00:00.000Z' } as never; }
  async readAccessory(id: string) { this.calls.push(`read:${id}`); return {} as never; }
  async close() { this.closeCalls++; if (this.closeFailure) throw this.closeFailure; }
}

interface Harness {
  deps: GatewayDependencies; server: FakeServer; bridge: FakeBridge; opened: string[]; files: Record<string, FakeFileInit>;
  tls: ReturnType<typeof fakeTls>; settings: ServerSettings[]; created: unknown[][]; signals: Map<string, () => void>;
  handler(): (request: IncomingMessage, response: ServerResponse) => void; handlers: Array<(request: IncomingMessage, response: ServerResponse) => void>;
  openedFiles: FakeFile[];
}

function harness(overrides: Partial<GatewayDependencies> = {}, options: { files?: Record<string, FakeFileInit>; server?: FakeServer; tls?: ReturnType<typeof fakeTls>; bridge?: FakeBridge } = {}): Harness {
  const files = options.files ?? goodFiles();
  const server = options.server ?? new FakeServer();
  const bridge = options.bridge ?? new FakeBridge();
  const tls = options.tls ?? fakeTls();
  const opened: string[] = [];
  const openedFiles: FakeFile[] = [];
  const settings: ServerSettings[] = [];
  const created: unknown[][] = [];
  const handlers: Harness['handlers'] = [];
  const signals = new Map<string, () => void>();
  const deps: GatewayDependencies = {
    platform: 'darwin', uid: OWNER, now: () => NOW, tls,
    openFile: async path => {
      opened.push(path);
      const init = files[path];
      if (!init) throw new Error(`ENOENT ${path}`);
      const file = new FakeFile(init); openedFiles.push(file); return file;
    },
    createHttpsServer: (serverSettings, handler) => { settings.push(serverSettings); handlers.push(handler); return server as unknown as GatewayServer; },
    createBridge: (...args) => { created.push(args); return bridge; },
    onSignal: (signal, handler) => { signals.set(signal, handler); },
    ...overrides,
  };
  return { deps, server, bridge, opened, files, tls, settings, created, signals, handlers, handler: () => handlers[0]!, openedFiles };
}

function fakeRequest(options: { method?: string; url?: string; headers?: string[]; body?: Array<Buffer | string>; streamError?: boolean } = {}) {
  const reads = { count: 0 };
  const body = options.body ?? [JSON.stringify({ command: 'status' })];
  const stream = new Readable({
    read() {
      reads.count++;
      if (options.streamError) { this.destroy(new Error('socket reset /secret')); return; }
      for (const chunk of body) this.push(chunk);
      this.push(null);
    },
  });
  const rawHeaders = options.headers ?? ['Authorization', `Bearer ${token}`, 'Content-Type', 'application/json'];
  const request = Object.assign(stream, { method: options.method ?? 'POST', url: options.url ?? '/bridge', rawHeaders }) as unknown as IncomingMessage;
  return { request, reads };
}

class FakeResponse extends EventEmitter {
  statusCode = 0; headers: Record<string, string> = {}; body = ''; destroyed = false; writableEnded = false;
  writeHead(statusCode: number, headers: Record<string, string>) { this.statusCode = statusCode; this.headers = headers; return this; }
  end(body: string) { this.writableEnded = true; this.body = body; this.emit('finish'); }
}

async function send(handler: Harness['handlers'][number], options: Parameters<typeof fakeRequest>[0] = {}) {
  const { request, reads } = fakeRequest(options);
  const response = new FakeResponse();
  const finished = once(response, 'finish');
  handler(request, response as unknown as ServerResponse);
  await finished;
  return { response, reads, request, json: JSON.parse(response.body) as Record<string, unknown> };
}

test('options parser requires both approvals, absolute paths, port 18443 and refuses duplicates or missing values', () => {
  assert.equal(parseHostGatewayOptions(ARGS).port, 18443);
  assert.throws(() => parseHostGatewayOptions(ARGS.filter(a => a !== '--native-user-approved')), /USER_APPROVAL_REQUIRED/);
  assert.throws(() => parseHostGatewayOptions([...ARGS, '--bridge', '/other']), /INVALID_ARGUMENTS/);
  assert.throws(() => parseHostGatewayOptions([...ARGS, '--unknown', 'x']), /INVALID_ARGUMENTS/);
  assert.throws(() => parseHostGatewayOptions([...ARGS.slice(0, -2), '--port']), /INVALID_ARGUMENTS/);
  assert.throws(() => parseHostGatewayOptions([...ARGS.slice(0, -2), '--port', '--bridge']), /INVALID_ARGUMENTS/);
  assert.throws(() => parseHostGatewayOptions(ARGS.map(a => (a === '/synthetic/bridge' ? 'relative/bridge' : a))), /ABSOLUTE_PATH_REQUIRED/);
  assert.throws(() => parseHostGatewayOptions(ARGS.filter((_, i) => i < 2)), /PORT_18443_REQUIRED|ABSOLUTE_PATH_REQUIRED/);
  assert.throws(() => parseHostGatewayOptions(ARGS.map(a => (a === '18443' ? '8080' : a))), /PORT_18443_REQUIRED/);
});

test('supplied-file reader enforces regular, non-empty, owned, private and bounded files and always closes', async () => {
  const cases: Array<[string, FakeFileInit, boolean, RegExp]> = [
    ['special file', { content: Buffer.from('abc'), regular: false }, true, /INVALID_SUPPLIED_FILE/],
    ['empty file', { content: Buffer.alloc(0) }, true, /INVALID_SUPPLIED_FILE/],
    ['oversize by stat', { content: Buffer.from('abcdef'), size: 100 }, true, /INVALID_SUPPLIED_FILE/],
    ['other owner', { content: Buffer.from('abc'), uid: 0 }, true, /PRIVATE_FILE_PERMISSIONS_REQUIRED/],
    ['group readable private file', { content: Buffer.from('abc'), mode: 0o640 }, true, /PRIVATE_FILE_PERMISSIONS_REQUIRED/],
    ['owner cannot read', { content: Buffer.from('abc'), mode: 0o200 }, true, /PRIVATE_FILE_PERMISSIONS_REQUIRED/],
    ['group-writable public file', { content: Buffer.from('abc'), mode: 0o664 }, false, /UNSAFE_PUBLIC_FILE_PERMISSIONS/],
    ['world-writable public file', { content: Buffer.from('abc'), mode: 0o646 }, false, /UNSAFE_PUBLIC_FILE_PERMISSIONS/],
    ['file grew after stat', { content: Buffer.from('abcd'), growBy: 20 }, true, /INVALID_SUPPLIED_FILE/],
    ['file emptied after stat', { content: Buffer.alloc(0), size: 4 }, true, /INVALID_SUPPLIED_FILE/],
  ];
  for (const [label, init, privateFile, expected] of cases) {
    const h = harness({}, { files: { '/f': init } });
    await assert.rejects(readSuppliedFile('/f', 8, privateFile, h.deps), expected, label);
    assert.equal(h.openedFiles[0]?.closed, true, `${label} closes its descriptor`);
  }
  // Short reads are accumulated and a public file may be group-readable but not writable.
  const h = harness({}, { files: { '/f': { content: Buffer.from('abcdef'), chunk: 2, mode: 0o644 } } });
  assert.equal((await readSuppliedFile('/f', 8, false, h.deps)).toString(), 'abcdef');
  const missing = harness();
  await assert.rejects(readSuppliedFile('/synthetic/absent', 8, true, missing.deps), /ENOENT/);
});

test('real descriptor opener refuses missing paths', async () => {
  await assert.rejects(readSuppliedFile('/nonexistent/synthetic-gateway-file', 8, true), /ENOENT/);
  await assert.rejects(validateBridgeExecutable('/nonexistent/synthetic-bridge'), /ENOENT/);
});

test('default opener refuses symlinks (O_NOFOLLOW) even when the target would pass every other check', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'homekit-gateway-link-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const secret = join(directory, 'target-private.txt');
  const executable = join(directory, 'target-executable');
  await writeFile(secret, 'abcd', { mode: 0o600 });
  await writeFile(executable, 'x', { mode: 0o700 });
  await chmod(secret, 0o600);
  await chmod(executable, 0o700);
  // The targets themselves are accepted by the default dependencies, so a refusal below can only come from the link.
  assert.equal((await readSuppliedFile(secret, 8, true)).toString(), 'abcd');
  await validateBridgeExecutable(executable);
  const secretLink = join(directory, 'secret-link');
  const executableLink = join(directory, 'executable-link');
  await symlink(secret, secretLink);
  await symlink(executable, executableLink);
  await assert.rejects(readSuppliedFile(secretLink, 8, true), { code: 'ELOOP' });
  await assert.rejects(validateBridgeExecutable(executableLink), { code: 'ELOOP' });
});

test('default opener opens a FIFO without blocking (O_NONBLOCK) and then refuses it as a special file', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'homekit-gateway-fifo-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fifo = join(directory, 'pipe');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  const moduleUrl = pathToFileURL(resolve('dist/src/host-gateway.js')).href;
  // A child process with a hard timeout: if O_NONBLOCK were removed, open() would wait for a writer forever,
  // and this test would fail within seconds instead of hanging the suite.
  for (const [label, call, expected] of [
    ['readSuppliedFile', `readSuppliedFile(${JSON.stringify(fifo)}, 8, true)`, 'INVALID_SUPPLIED_FILE'],
    ['validateBridgeExecutable', `validateBridgeExecutable(${JSON.stringify(fifo)})`, 'UNSAFE_BRIDGE_EXECUTABLE'],
  ] as const) {
    const script = `import(${JSON.stringify(moduleUrl)}).then(async m => { try { await m.${call}; console.log('ACCEPTED'); }`
      + ` catch (error) { console.log(error.message); } process.exit(0); });`;
    const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL' });
    assert.equal(result.error, undefined, `${label} must not hang on a FIFO`);
    assert.equal(result.status, 0, label);
    assert.equal(result.stdout.trim(), expected, label);
  }
});

test('bridge executable must be an owned, non-writable, executable regular file of sane size', async () => {
  const cases: Array<[string, FakeFileInit]> = [
    ['special file', { content: Buffer.from('x'), regular: false, mode: 0o755 }],
    ['empty', { content: Buffer.alloc(0), mode: 0o755 }],
    ['huge', { content: Buffer.from('x'), size: 128 * 1024 * 1024 + 1, mode: 0o755 }],
    ['other owner', { content: Buffer.from('x'), uid: 0, mode: 0o755 }],
    ['group writable', { content: Buffer.from('x'), mode: 0o775 }],
    ['world writable', { content: Buffer.from('x'), mode: 0o757 }],
    ['not executable', { content: Buffer.from('x'), mode: 0o644 }],
  ];
  for (const [label, init] of cases) {
    const h = harness({}, { files: { '/b': init } });
    await assert.rejects(validateBridgeExecutable('/b', h.deps), /UNSAFE_BRIDGE_EXECUTABLE/, label);
    assert.equal(h.openedFiles[0]?.closed, true);
  }
  const ok = harness({}, { files: { '/b': { content: Buffer.from('x'), mode: 0o755 } } });
  await validateBridgeExecutable('/b', ok.deps);
});

test('TLS validation requires SAN, matching key, current validity and a successful TLS 1.3 context, hiding parser text', () => {
  const key = Buffer.from('k'); const cert = Buffer.from('c');
  const tls = fakeTls();
  validateTlsCredentials(key, cert, NOW, tls);
  assert.deepEqual(tls.contexts, [{ key, cert, minVersion: 'TLSv1.3' }]);
  const refused = (label: string, certificate: CertificateLike, failures: Parameters<typeof fakeTls>[1] = {}, now = NOW): void =>
    assert.throws(() => validateTlsCredentials(key, cert, now, fakeTls(certificate, failures)), error => {
      assert.equal((error as Error).message, 'INVALID_TLS_CREDENTIALS', label);
      return true;
    });
  refused('missing SAN', goodCertificate({ checkHost: () => undefined }));
  refused('key mismatch', goodCertificate({ checkPrivateKey: () => false }));
  refused('unparsable start date', goodCertificate({ validFrom: 'not a date' }));
  refused('unparsable end date', goodCertificate({ validTo: 'not a date' }));
  refused('not yet valid', goodCertificate(), {}, Date.parse('2025-12-31T00:00:00Z'));
  refused('expired', goodCertificate(), {}, Date.parse('2026-12-31T00:00:00Z'));
  refused('certificate parse error', goodCertificate(), { cert: true });
  refused('key parse error', goodCertificate(), { key: true });
  refused('TLS context rejected', goodCertificate(), { context: true });
  // Exactly the start instant is valid.
  validateTlsCredentials(key, cert, Date.parse('Jan  1 00:00:00 2026 GMT'), fakeTls());
  // Real parsers reject garbage without leaking its text and without creating credentials.
  assert.throws(() => validateTlsCredentials(Buffer.from('garbage'), Buffer.from('garbage'), NOW), /^Error: INVALID_TLS_CREDENTIALS$/);
  assert.throws(() => defaultTlsPrimitives.parsePrivateKey(Buffer.from('garbage')));
  assert.throws(() => defaultTlsPrimitives.parseCertificate(Buffer.from('garbage')));
  assert.throws(() => defaultTlsPrimitives.createSecureContext({ key: Buffer.from('g'), cert: Buffer.from('g'), minVersion: 'TLSv1.3' }));
});

test('raw headers keep duplicates separate and request bodies are bounded and accept binary chunks', async () => {
  const headers = rawHeaderValues({ rawHeaders: ['Content-Length', '1', 'content-length', '2', 'CONTENT-LENGTH', '3', 'Origin', 'x'] });
  assert.deepEqual({ ...headers }, { 'content-length': ['1', '2', '3'], origin: 'x' });
  assert.equal(Object.getPrototypeOf(headers), null);
  assert.equal((await requestBody(Readable.from([Buffer.from('ab'), new Uint8Array([99])]))).toString(), 'abc');
  await assert.rejects(requestBody(Readable.from([Buffer.alloc(40 * 1024), Buffer.alloc(40 * 1024)])), /REQUEST_TOO_LARGE/);
});

test('default dependencies are inert until invoked: no listener, and the helper refuses before any spawn', () => {
  assert.equal(defaultDependencies.platform, process.platform);
  assert.equal(defaultDependencies.now() > 0, true);
  const signal = 'SIGUSR2' as unknown as 'SIGINT';
  const before = process.listenerCount(signal);
  defaultDependencies.onSignal(signal, () => {});
  assert.equal(process.listenerCount(signal), before + 1);
  process.removeAllListeners(signal);
  // Invalid TLS material is rejected while building the server object, before anything could listen.
  assert.throws(() => defaultDependencies.createHttpsServer(
    { key: Buffer.from('garbage'), cert: Buffer.from('garbage'), minVersion: 'TLSv1.3', maxHeaderSize: 1024, handshakeTimeout: 1000 }, () => {}));
  // A relative path makes NativeTransport refuse before any spawn attempt, so no process is ever launched.
  assert.throws(() => defaultDependencies.createBridge('relative/not-launched', '/synthetic/config.json', { version: 1, mode: 'read-only', allowedAccessoryIds: [] }),
    /ABSOLUTE_PATH_REQUIRED/);
});

test('gateway refuses non-macOS, unknown uid and bad arguments before opening any file or creating anything', async () => {
  for (const overrides of [{ platform: 'linux' as const }, { uid: undefined }]) {
    const h = harness(overrides);
    await assert.rejects(runHostGateway(ARGS, h.deps), /MACOS_REQUIRED/);
    assert.deepEqual(h.opened, []);
    assert.equal(h.created.length + h.settings.length, 0);
  }
  const h = harness();
  await assert.rejects(runHostGateway(ARGS.slice(2), h.deps), /USER_APPROVAL_REQUIRED/);
  assert.deepEqual(h.opened, []);
});

test('every credential, config, executable or TLS failure happens before the helper or the server exists', async () => {
  const mutate = (path: string, init: FakeFileInit | undefined): Record<string, FakeFileInit> => {
    const files = goodFiles();
    if (init) files[path] = init; else delete files[path];
    return files;
  };
  const cases: Array<[string, Record<string, FakeFileInit>, ReturnType<typeof fakeTls> | undefined, RegExp]> = [
    ['missing token', mutate('/synthetic/token', undefined), undefined, /ENOENT/],
    ['token group readable', mutate('/synthetic/token', { content: Buffer.from(token), mode: 0o640 }), undefined, /PRIVATE_FILE_PERMISSIONS_REQUIRED/],
    ['token too short', mutate('/synthetic/token', { content: Buffer.from('short') }), undefined, /INVALID_TOKEN_FILE/],
    ['token with extra line', mutate('/synthetic/token', { content: Buffer.from(`${token}\nextra`) }), undefined, /INVALID_TOKEN_FILE/],
    ['token not utf-8', mutate('/synthetic/token', { content: Buffer.from([0xff, 0xfe, 0xfd]) }), undefined, /encoded data|INVALID|TypeError/i],
    ['key readable by group', mutate('/synthetic/key.pem', { content: Buffer.from('k'), mode: 0o644 }), undefined, /PRIVATE_FILE_PERMISSIONS_REQUIRED/],
    ['certificate writable', mutate('/synthetic/cert.pem', { content: Buffer.from('c'), mode: 0o666 }), undefined, /UNSAFE_PUBLIC_FILE_PERMISSIONS/],
    ['config invalid JSON', mutate('/synthetic/config.json', { content: Buffer.from('{') }), undefined, /JSON|Unexpected/i],
    ['config violates schema', mutate('/synthetic/config.json', { content: Buffer.from(JSON.stringify({ version: 1, mode: 'read-only', allowedAccessoryIds: 'x' })) }), undefined, /./],
    ['config not private', mutate('/synthetic/config.json', { content: goodConfig, mode: 0o644 }), undefined, /PRIVATE_FILE_PERMISSIONS_REQUIRED/],
    ['bridge missing', mutate('/synthetic/bridge', undefined), undefined, /ENOENT/],
    ['bridge writable', mutate('/synthetic/bridge', { content: Buffer.from('x'), mode: 0o777 }), undefined, /UNSAFE_BRIDGE_EXECUTABLE/],
    ['certificate without SAN', goodFiles(), fakeTls(goodCertificate({ checkHost: () => undefined })), /INVALID_TLS_CREDENTIALS/],
  ];
  for (const [label, files, tls, expected] of cases) {
    const h = harness({}, { files, ...(tls ? { tls } : {}) });
    await assert.rejects(runHostGateway(ARGS, h.deps), expected, label);
    assert.equal(h.created.length, 0, `${label}: helper not created`);
    assert.equal(h.settings.length, 0, `${label}: server not created`);
    assert.equal(h.server.listenCalls.length, 0, `${label}: never listened`);
    assert.equal(h.openedFiles.every(file => file.closed), true, `${label}: every descriptor closed`);
  }
});

test('successful start binds loopback only with exclusive port, hardened limits and cleanup hooks', async () => {
  const h = harness();
  await runHostGateway(ARGS, h.deps);
  assert.deepEqual(h.server.listenCalls, [{ host: '127.0.0.1', port: 18443, exclusive: true }]);
  assert.equal(h.created.length, 1);
  assert.deepEqual(h.created[0]!.slice(0, 2), ['/synthetic/bridge', '/synthetic/config.json']);
  assert.deepEqual((h.created[0]![2] as { allowedAccessoryIds: string[] }).allowedAccessoryIds, ['demo-temperature']);
  assert.equal(h.settings[0]!.minVersion, 'TLSv1.3');
  assert.equal(h.settings[0]!.maxHeaderSize, 16 * 1024);
  assert.equal(h.settings[0]!.handshakeTimeout, 10_000);
  assert.deepEqual([h.server.maxConnections, h.server.maxRequestsPerSocket, h.server.headersTimeout, h.server.requestTimeout, h.server.keepAliveTimeout],
    [4, 1, 10_000, 15_000, 1_000]);
  assert.equal(h.server.timeout?.ms, 15_000);
  assert.deepEqual([...h.signals.keys()].sort(), ['SIGINT', 'SIGTERM']);
  // Socket-level errors destroy the socket and never reach stderr or the process.
  let destroyed = 0;
  h.server.timeout!.callback({ destroy: () => { destroyed++; } });
  h.server.emit('clientError', new Error('bad client'), { destroy: () => { destroyed++; } });
  h.server.emit('tlsClientError', new Error('bad handshake'));
  assert.equal(destroyed, 2);
});

test('shutdown closes the server, its connections and the helper exactly once, tolerating helper errors', async () => {
  const h = harness();
  h.bridge.closeFailure = new Error('helper exited /secret');
  await runHostGateway(ARGS, h.deps);
  h.signals.get('SIGTERM')!();
  h.signals.get('SIGINT')!();
  h.server.emit('error', new Error('late'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([h.server.closeCalls, h.server.closeAllCalls, h.bridge.closeCalls], [1, 1, 1]);
  const errored = harness();
  await runHostGateway(ARGS, errored.deps);
  errored.server.emit('error', new Error('runtime server error'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([errored.server.closeCalls, errored.bridge.closeCalls], [1, 1]);
});

test('startup failures close what was created and expose only a fixed error code', async () => {
  for (const outcome of ['error', 'throw'] as const) {
    const h = harness({}, { server: new FakeServer(outcome) });
    await assert.rejects(runHostGateway(ARGS, h.deps), error => {
      assert.equal((error as Error).message, 'GATEWAY_START_FAILED');
      return true;
    });
    assert.deepEqual([h.server.closeCalls, h.bridge.closeCalls], [1, 1], outcome);
    assert.equal(h.signals.size, 0, 'no signal handlers after a failed start');
  }
  const failingBridge = harness({}, { server: new FakeServer('error'), bridge: Object.assign(new FakeBridge(), { closeFailure: new Error('x') }) });
  await assert.rejects(runHostGateway(ARGS, failingBridge.deps), /GATEWAY_START_FAILED/);
  const noBridge = harness({ createBridge: () => { throw new Error('spawn /secret/path failed'); } });
  await assert.rejects(runHostGateway(ARGS, noBridge.deps), error => {
    assert.equal((error as Error).message, 'GATEWAY_START_FAILED');
    return true;
  });
  assert.equal(noBridge.settings.length, 0, 'the server is never created when the helper cannot start');
  const noServer = harness({ createHttpsServer: () => { throw new Error('bad TLS options'); } });
  await assert.rejects(runHostGateway(ARGS, noServer.deps), /GATEWAY_START_FAILED/);
  assert.equal(noServer.bridge.closeCalls, 1);
});

test('request handler rejects unauthenticated, wrong-route, cross-origin and oversized requests without reading the body', async () => {
  const h = harness();
  await runHostGateway(ARGS, h.deps);
  const handler = h.handler();
  const bad = Buffer.alloc(10);
  const cases: Array<[string, Parameters<typeof fakeRequest>[0], number, string]> = [
    ['no authorization', { headers: ['Content-Type', 'application/json'] }, 401, 'UNAUTHORIZED'],
    ['wrong token', { headers: ['Authorization', `Bearer ${'a'.repeat(40)}`, 'Content-Type', 'application/json'] }, 401, 'UNAUTHORIZED'],
    ['duplicate authorization', { headers: ['Authorization', `Bearer ${token}`, 'Authorization', `Bearer ${token}`, 'Content-Type', 'application/json'] }, 401, 'UNAUTHORIZED'],
    ['wrong path', { url: '/other' }, 404, 'NOT_FOUND'],
    ['wrong method', { method: 'GET' }, 405, 'METHOD_NOT_ALLOWED'],
    ['browser origin', { headers: ['Authorization', `Bearer ${token}`, 'Content-Type', 'application/json', 'Origin', 'https://evil.example'] }, 403, 'ORIGIN_NOT_ALLOWED'],
    ['wrong media type', { headers: ['Authorization', `Bearer ${token}`, 'Content-Type', 'text/plain'] }, 415, 'UNSUPPORTED_MEDIA_TYPE'],
    ['declared length too large', { headers: ['Authorization', `Bearer ${token}`, 'Content-Type', 'application/json', 'Content-Length', '999999'] }, 413, 'REQUEST_TOO_LARGE'],
  ];
  for (const [label, options, status, code] of cases) {
    const result = await send(handler, { ...options, body: [bad] });
    assert.equal(result.response.statusCode, status, label);
    assert.deepEqual(result.json, { ok: false, error: { code } }, label);
    assert.equal(result.reads.count, 0, `${label}: body never read`);
    assert.equal(result.request.destroyed, true, `${label}: request stream destroyed after the reply`);
    assert.equal(result.response.headers['content-length'], String(Buffer.byteLength(result.response.body)));
  }
  assert.deepEqual(h.bridge.calls, []);
});

test('authenticated requests reach only read-only bridge commands and return bounded JSON', async () => {
  const h = harness();
  await runHostGateway(ARGS, h.deps);
  const handler = h.handler();
  const ok = await send(handler, { body: [JSON.stringify({ command: 'status' })] });
  assert.equal(ok.response.statusCode, 200);
  assert.equal((ok.json as { ok: boolean }).ok, true);
  assert.equal(ok.response.headers['cache-control'], 'no-store');
  await send(handler, { body: [JSON.stringify({ command: 'list_accessories' })] });
  await send(handler, { body: ['{"command":"read_', 'accessory","accessoryId":"demo-temperature"}'] });
  assert.deepEqual(h.bridge.calls, ['status', 'list', 'read:demo-temperature']);
  const write = await send(handler, { body: [JSON.stringify({ command: 'write', accessoryId: 'demo-temperature', value: 1 })] });
  assert.equal(write.response.statusCode, 400);
  assert.deepEqual(h.bridge.calls.length, 3, 'unknown commands never reach the bridge');
});

test('body overflow, stream errors and bridge failures produce fixed errors without leaking text', async () => {
  const h = harness();
  await runHostGateway(ARGS, h.deps);
  const handler = h.handler();
  const big = await send(handler, { body: [Buffer.alloc(40 * 1024, 0x61), Buffer.alloc(40 * 1024, 0x61)] });
  assert.equal(big.response.statusCode, 413);
  assert.deepEqual(big.json, { ok: false, error: { code: 'REQUEST_TOO_LARGE' } });
  const broken = await send(handler, { streamError: true });
  assert.equal(broken.response.statusCode, 400);
  assert.deepEqual(broken.json, { ok: false, error: { code: 'INVALID_REQUEST' } });
  h.bridge.failure = new Error('HomeKit said: Kitchen Lamp /home/example');
  const unavailable = await send(handler);
  assert.equal(unavailable.response.statusCode, 503);
  assert.deepEqual(unavailable.json, { ok: false, error: { code: 'BRIDGE_UNAVAILABLE' } });
  assert.doesNotMatch(unavailable.response.body, /Kitchen|home|HomeKit/);
});

test('a reply is never written to a connection that was already destroyed or finished', async () => {
  const h = harness();
  await runHostGateway(ARGS, h.deps);
  for (const flag of ['destroyed', 'writableEnded'] as const) {
    const { request } = fakeRequest();
    const response = new FakeResponse();
    response[flag] = true;
    h.handler()(request, response as unknown as ServerResponse);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(response.statusCode, 0, `${flag} response is left untouched`);
    assert.equal(response.body, '');
  }
});

test('CLI wrapper reports one fixed line and exit code 1 for any refusal, and nothing on success', async () => {
  const output: string[] = []; const codes: number[] = [];
  const io = { stderr: (text: string) => { output.push(text); }, setExitCode: (code: number) => { codes.push(code); } };
  await runHostGatewayCli(ARGS.slice(2), io, harness().deps);
  await runHostGatewayCli(ARGS, io, harness({ platform: 'win32' }).deps);
  assert.deepEqual(output, ['HOMEKIT_HOST_GATEWAY_STARTUP_FAILED\n', 'HOMEKIT_HOST_GATEWAY_STARTUP_FAILED\n']);
  assert.deepEqual(codes, [1, 1]);
  output.length = 0; codes.length = 0;
  await runHostGatewayCli(ARGS, io, harness().deps);
  assert.deepEqual([output, codes], [[], []]);
  // The default io writes to the process; exercise it with the process hooks swapped out.
  const writes: string[] = [];
  const stderrWrite = process.stderr.write;
  const previousExit = process.exitCode;
  process.stderr.write = ((text: string) => { writes.push(text); return true; }) as typeof process.stderr.write;
  try { await runHostGatewayCli([], undefined, harness().deps); } finally { process.stderr.write = stderrWrite; }
  assert.equal(process.exitCode, 1);
  process.exitCode = previousExit;
  assert.deepEqual(writes, ['HOMEKIT_HOST_GATEWAY_STARTUP_FAILED\n']);
});

test('running the gateway module directly refuses to start without approvals and prints only the fixed line', () => {
  const result = spawnSync(process.execPath, ['dist/src/host-gateway.js'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'HOMEKIT_HOST_GATEWAY_STARTUP_FAILED\n');
});

test('importing the gateway module never starts it', async () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./dist/src/host-gateway.js'); await import('./dist/src/index.js');"],
    { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
});

test('a failure registering signal handlers after listening closes the server and helper once and reports a fixed error', async () => {
  for (const failAt of [0, 1]) {
    let registered = 0;
    const h = harness({ onSignal: () => { if (registered++ === failAt) throw new Error('signal failure /secret'); } });
    await assert.rejects(runHostGateway(ARGS, h.deps), error => {
      assert.equal((error as Error).message, 'GATEWAY_START_FAILED');
      return true;
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual([h.server.closeCalls, h.server.closeAllCalls, h.bridge.closeCalls], [1, 1, 1], `failure at handler ${failAt}`);
  }
});
