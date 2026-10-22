import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import type { McpServer, McpServerFactory } from '@modelcontextprotocol/server';
import type { BridgeTransport } from '../src/bridge.js';
import type { Config } from '../src/config.js';
import { defaultRuntime, runCli, startServer, type Runtime } from '../src/index.js';

// A fake runtime proves approval/argument handling and lifecycle with no config file, helper, socket or stdio.
type Shutdown = Parameters<Runtime['onShutdown']>[0];
const config: Config = { version: 1, mode: 'read-only', allowedAccessoryIds: ['demo-temperature'] };

function fixture(options: { bridgeCloseFails?: boolean; serveCloseFails?: boolean; configFails?: boolean; serveThrows?: boolean; shutdownThrowsAt?: number } = {}) {
  const calls: string[] = [];
  const stderr: string[] = [];
  const shutdown = new Map<Shutdown, () => void>();
  const closes = { bridge: 0, serve: 0 };
  let factory: McpServerFactory | undefined;
  let onError: (() => void) | undefined;
  const transport = (label: string): BridgeTransport => ({
    request: async () => { throw new Error('not used'); },
    close: async () => { closes.bridge++; if (options.bridgeCloseFails) throw new Error('close failed /secret'); },
  });
  const runtime: Runtime = {
    loadConfig: async path => { calls.push(`config:${path}`); if (options.configFails) throw new Error('ENOENT /secret/config'); return config; },
    mockTransport: count => { calls.push(`mock:${count}`); return transport('mock'); },
    nativeTransport: (executable, configPath) => { calls.push(`native:${executable}:${configPath}`); return transport('native'); },
    hostTransport: async (url, ca, token) => { calls.push(`host:${url}:${ca}:${token}`); return transport('host'); },
    serve: (created, errorHandler) => {
      if (options.serveThrows) throw new Error('serve failed /secret/path');
      factory = created; onError = errorHandler;
      return { close: async () => { closes.serve++; if (options.serveCloseFails) throw new Error('serve close failed'); } };
    },
    onShutdown: (event, handler) => {
      if (options.shutdownThrowsAt === shutdown.size) throw new Error('signal registration failed /secret');
      shutdown.set(event, handler);
    },
    stderr: text => { stderr.push(text); },
  };
  return { runtime, calls, stderr, shutdown, closes, factory: () => factory!, onError: () => onError! };
}

const HOST = ['--mode', 'host', '--host-user-approved', '--config', '/abs/config.json', '--host-bridge-url', 'https://host.docker.internal:18443/bridge',
  '--host-bridge-ca', '/abs/ca.pem', '--host-bridge-token', '/abs/token'];
const NATIVE = ['--mode', 'native', '--native-user-approved', '--config', '/abs/config.json', '--bridge', '/abs/bridge'];

test('every unsafe or incomplete argument combination is refused before config, helper or credentials are touched', async () => {
  const withoutFlag = (args: string[], flag: string, hasValue = false): string[] => {
    const index = args.indexOf(flag);
    return args.filter((_, i) => i !== index && !(hasValue && i === index + 1));
  };
  const refusals: Array<[string, string[]]> = [
    ['unknown mode', ['--mode', 'cloud']],
    ['unknown option', ['--write-enabled']],
    ['positional argument', ['mock']],
    ['native without approval', withoutFlag(NATIVE, '--native-user-approved')],
    ['native without config', withoutFlag(NATIVE, '--config', true)],
    ['native without bridge', withoutFlag(NATIVE, '--bridge', true)],
    ['mock cannot launch a bridge', ['--bridge', '/abs/bridge']],
    ['host cannot launch a bridge', [...HOST, '--bridge', '/abs/bridge']],
    ['host without approval', withoutFlag(HOST, '--host-user-approved')],
    ['host without config', withoutFlag(HOST, '--config', true)],
    ['host without url', withoutFlag(HOST, '--host-bridge-url', true)],
    ['host without CA', withoutFlag(HOST, '--host-bridge-ca', true)],
    ['host without token', withoutFlag(HOST, '--host-bridge-token', true)],
  ];
  for (const [label, args] of refusals) {
    const f = fixture();
    await assert.rejects(startServer(args, f.runtime), label);
    assert.deepEqual(f.calls, [], `${label}: nothing was loaded or created`);
    assert.equal(f.shutdown.size, 0);
  }
});

test('mode selection chooses exactly one transport and resolves paths to absolute form', async () => {
  const mock = fixture();
  await startServer([], mock.runtime);
  assert.deepEqual(mock.calls, ['config:undefined', 'mock:1']);
  const relative = fixture();
  await startServer(['--config', 'config/mock.json'], relative.runtime);
  assert.deepEqual(relative.calls, [`config:${resolve('config/mock.json')}`, 'mock:1']);
  const native = fixture();
  await startServer(NATIVE, native.runtime);
  assert.deepEqual(native.calls, ['config:/abs/config.json', 'native:/abs/bridge:/abs/config.json']);
  const host = fixture();
  await startServer(HOST, host.runtime);
  assert.deepEqual(host.calls, ['config:/abs/config.json', 'host:https://host.docker.internal:18443/bridge:/abs/ca.pem:/abs/token']);
});

test('configuration or transport failures stop startup before serving', async () => {
  const f = fixture({ configFails: true });
  await assert.rejects(startServer([], f.runtime), /ENOENT/);
  assert.equal(f.shutdown.size, 0);
  assert.equal(f.calls.some(call => call.startsWith('mock')), false);
});

test('the served factory builds a labelled server and protocol errors never echo details', async () => {
  const f = fixture();
  await startServer([], f.runtime);
  const server = await f.factory()({} as Parameters<McpServerFactory>[0]) as McpServer;
  assert.equal(typeof server.connect, 'function');
  f.onError()();
  assert.deepEqual(f.stderr, ['homekit-mcp: protocol error\n']);
});

test('stdin end and both signals close the bridge and server exactly once even when closing fails', async () => {
  const f = fixture();
  await startServer([], f.runtime);
  assert.deepEqual([...f.shutdown.keys()].sort(), ['SIGINT', 'SIGTERM', 'stdin-end']);
  f.shutdown.get('stdin-end')!(); f.shutdown.get('SIGTERM')!(); f.shutdown.get('SIGINT')!();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.closes, { bridge: 1, serve: 1 });
  assert.deepEqual(f.stderr, []);
  const failing = fixture({ bridgeCloseFails: true, serveCloseFails: true });
  await startServer([], failing.runtime);
  failing.shutdown.get('SIGINT')!();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(failing.stderr, ['homekit-mcp: shutdown error\n', 'homekit-mcp: shutdown error\n']);
});

test('runCli returns 0 on success and a fixed refusal line, without arguments or paths, on any failure', async () => {
  const ok = fixture();
  assert.equal(await runCli([], ok.runtime), 0);
  assert.deepEqual(ok.stderr, []);
  const bad = fixture({ configFails: true });
  assert.equal(await runCli(['--config', '/secret/household.json'], bad.runtime), 1);
  assert.deepEqual(bad.stderr, ['homekit-mcp: startup refused; check arguments, approval and read-only configuration\n']);
  const refused = fixture();
  assert.equal(await runCli(NATIVE.slice(0, 2), refused.runtime), 1);
  assert.deepEqual(refused.stderr, bad.stderr, 'every refusal produces the identical fixed line');
  assert.doesNotMatch(bad.stderr.join(''), /secret|household/);
});

test('default runtime wiring is inert: it reads nothing and launches nothing until used', async () => {
  const mock = defaultRuntime.mockTransport(2);
  assert.equal(((await mock.request('status')) as { allowlistedAccessoryCount: number }).allowlistedAccessoryCount, 2);
  await mock.close();
  assert.throws(() => defaultRuntime.nativeTransport('relative/bridge', '/abs/config.json'), /ABSOLUTE_PATH_REQUIRED/, 'no helper is spawned for relative paths');
  await assert.rejects(defaultRuntime.hostTransport('https://host.docker.internal:18443/bridge', '/nonexistent/ca', '/nonexistent/token'));
  await assert.rejects(defaultRuntime.loadConfig('/nonexistent/synthetic-config.json'));
  const handler = (): void => {};
  defaultRuntime.onShutdown('SIGTERM', handler);
  assert.ok(process.listeners('SIGTERM').includes(handler));
  process.removeListener('SIGTERM', handler);
  defaultRuntime.onShutdown('stdin-end', handler);
  assert.ok(process.stdin.listeners('end').includes(handler));
  process.stdin.removeListener('end', handler);
  const writes: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((text: string) => { writes.push(text); return true; }) as typeof process.stderr.write;
  try { defaultRuntime.stderr('synthetic\n'); } finally { process.stderr.write = original; }
  assert.deepEqual(writes, ['synthetic\n']);
});

test('a failed start closes the already-created transport exactly once and redacts cleanup failures', async () => {
  for (const mode of [[], NATIVE, HOST]) {
    const f = fixture({ serveThrows: true });
    assert.equal(await runCli(mode, f.runtime), 1);
    assert.deepEqual(f.closes, { bridge: 1, serve: 0 }, 'the transport is closed; no server handle ever existed');
    assert.deepEqual(f.stderr, ['homekit-mcp: startup refused; check arguments, approval and read-only configuration\n']);
  }
  const noisy = fixture({ serveThrows: true, bridgeCloseFails: true });
  assert.equal(await runCli(NATIVE, noisy.runtime), 1);
  assert.deepEqual(noisy.stderr, ['homekit-mcp: shutdown error\n',
    'homekit-mcp: startup refused; check arguments, approval and read-only configuration\n']);
  assert.doesNotMatch(noisy.stderr.join(''), /secret|close failed/);
});

test('a failure while registering shutdown hooks closes the transport and server handle once, even if hooks fire later', async () => {
  for (const failAt of [0, 1, 2]) {
    const f = fixture({ shutdownThrowsAt: failAt });
    await assert.rejects(startServer(NATIVE, f.runtime), /signal registration failed/);
    assert.deepEqual(f.closes, { bridge: 1, serve: 1 }, `failure at hook ${failAt}`);
    for (const hook of f.shutdown.values()) hook();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.closes, { bridge: 1, serve: 1 }, 'hooks registered before the failure cannot close twice');
  }
  const failing = fixture({ shutdownThrowsAt: 1, bridgeCloseFails: true, serveCloseFails: true });
  await assert.rejects(startServer(NATIVE, failing.runtime));
  assert.deepEqual(failing.stderr, ['homekit-mcp: shutdown error\n', 'homekit-mcp: shutdown error\n']);
});

test('a configuration failure happens before any transport exists, so there is nothing to close', async () => {
  const f = fixture({ configFails: true });
  await assert.rejects(startServer(NATIVE, f.runtime));
  assert.deepEqual(f.closes, { bridge: 0, serve: 0 });
});

test('extensionless and symlinked launches still run the entry module and refuse unsafe arguments safely', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtemp, rm, symlink } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const refusal = 'homekit-mcp: startup refused; check arguments, approval and read-only configuration\n';
  const gatewayRefusal = 'HOMEKIT_HOST_GATEWAY_STARTUP_FAILED\n';
  const run = (args: string[]) => spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 5000 });
  // Every case below fails at argument validation, before any config, helper, credential or listener exists.
  for (const args of [['dist/src/index', '--bogus'], ['dist/src/index.js', '--bogus'], ['dist/src/index', '--mode', 'native'],
    ['dist/src/index', '--mode', 'host']]) {
    const result = run(args);
    assert.equal(result.status, 1, args.join(' '));
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, refusal, args.join(' '));
  }
  for (const args of [['dist/src/host-gateway'], ['dist/src/host-gateway.js', '--bogus']]) {
    const result = run(args);
    assert.equal(result.status, 1, args.join(' '));
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, gatewayRefusal);
  }
  const directory = await mkdtemp(join(tmpdir(), 'homekit-launch-test-'));
  try {
    const link = join(directory, 'launcher.js');
    await symlink(resolve('dist/src/index.js'), link);
    const result = run([link, '--bogus']);
    assert.equal(result.status, 1, 'a symlinked launcher is still the entry module');
    assert.equal(result.stderr, refusal);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
