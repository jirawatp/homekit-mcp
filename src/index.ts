#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import type { McpServerFactory } from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { loadConfig, type Config } from './config.js';
import { HomeKitBridge, type BridgeTransport } from './bridge.js';
import { MockBridgeTransport } from './mock-bridge.js';
import { NativeTransport } from './native-transport.js';
import { createServer } from './server.js';
import { loadHttpsBridgeTransport } from './https-transport.js';

export type ServerMode = 'mock' | 'native' | 'host';

/** Process-facing seams: nothing here launches a helper or opens a connection unless a real runtime is used. */
export interface Runtime {
  loadConfig(path?: string): Promise<Config>;
  mockTransport(allowedCount: number): BridgeTransport;
  nativeTransport(executable: string, configPath: string): BridgeTransport;
  hostTransport(url: string, caPath: string, tokenPath: string): Promise<BridgeTransport>;
  serve(factory: McpServerFactory, onError: () => void): { close(): Promise<void> };
  onShutdown(event: 'stdin-end' | 'SIGINT' | 'SIGTERM', handler: () => void): void;
  stderr(text: string): void;
}

export const defaultRuntime: Runtime = {
  loadConfig,
  mockTransport: allowedCount => new MockBridgeTransport(() => new Date(), allowedCount),
  nativeTransport: (executable, configPath) => new NativeTransport(executable, configPath),
  hostTransport: (url, caPath, tokenPath) => loadHttpsBridgeTransport(url, caPath, tokenPath),
  serve: (factory, onError) => serveStdio(factory, {
    transport: new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 1024 * 1024 }),
    onerror: onError,
  }),
  onShutdown: (event, handler) => {
    if (event === 'stdin-end') process.stdin.once('end', handler);
    else process.once(event, handler);
  },
  stderr: text => { process.stderr.write(text); },
};

/** Validates every approval/argument combination before any config, helper or credential is touched. */
export async function startServer(args: string[], runtime: Runtime = defaultRuntime): Promise<void> {
  const { values } = parseArgs({ args, options: {
    mode: { type: 'string', default: 'mock' }, config: { type: 'string' },
    bridge: { type: 'string' }, 'native-user-approved': { type: 'boolean', default: false },
    'host-user-approved': { type: 'boolean', default: false }, 'host-bridge-url': { type: 'string' },
    'host-bridge-ca': { type: 'string' }, 'host-bridge-token': { type: 'string' },
  }, strict: true, allowPositionals: false });
  if (values.mode !== 'mock' && values.mode !== 'native' && values.mode !== 'host') throw new Error('INVALID_MODE');
  const mode: ServerMode = values.mode;
  if (mode === 'native' && (!values['native-user-approved'] || !values.config || !values.bridge)) {
    throw new Error('NATIVE_APPROVAL_CONFIG_AND_BRIDGE_REQUIRED');
  }
  if (mode !== 'native' && values.bridge) throw new Error('MODE_CANNOT_LAUNCH_BRIDGE');
  if (mode === 'host' && (!values['host-user-approved'] || !values.config || !values['host-bridge-url']
    || !values['host-bridge-ca'] || !values['host-bridge-token'])) throw new Error('HOST_APPROVAL_AND_CREDENTIALS_REQUIRED');
  const config = await runtime.loadConfig(values.config ? resolve(values.config) : undefined);
  const transport = mode === 'mock' ? runtime.mockTransport(config.allowedAccessoryIds.length)
    : mode === 'host' ? await runtime.hostTransport(values['host-bridge-url']!,
      resolve(values['host-bridge-ca']!), resolve(values['host-bridge-token']!))
      : runtime.nativeTransport(resolve(values.bridge!), resolve(values.config!));
  const bridge = new HomeKitBridge(transport, config);
  let handle: { close(): Promise<void> } | undefined;
  let released = false;
  // Releases every resource created so far exactly once, for both shutdown and failed startup.
  // Cleanup errors are redacted to one fixed line and never become unhandled rejections.
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    const operations = [() => bridge.close(), () => handle?.close()];
    await Promise.all(operations.map(operation => Promise.resolve().then(operation)
      .catch(() => runtime.stderr('homekit-mcp: shutdown error\n'))));
  };
  try {
    handle = runtime.serve(() => createServer({ bridge, mode }), () => runtime.stderr('homekit-mcp: protocol error\n'));
    const close = (): void => { void release(); };
    runtime.onShutdown('stdin-end', close);
    runtime.onShutdown('SIGINT', close);
    runtime.onShutdown('SIGTERM', close);
  } catch (error) {
    // A helper process or TLS client may already exist; never leave it running after a refused start.
    await release();
    throw error;
  }
}

/** Returns the process exit code. Refusals use one fixed stderr line and never echo arguments or paths. */
export async function runCli(args: string[], runtime: Runtime = defaultRuntime): Promise<number> {
  try {
    await startServer(args, runtime);
    return 0;
  } catch {
    runtime.stderr('homekit-mcp: startup refused; check arguments, approval and read-only configuration\n');
    return 1;
  }
}

// import.meta.main is true only for the process entry module (also for extensionless or symlinked launches).
if (import.meta.main) {
  const code = await runCli(process.argv.slice(2));
  if (code !== 0) process.exitCode = code;
}
