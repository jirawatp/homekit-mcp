#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './config.js';
import { HomeKitBridge } from './bridge.js';
import { MockBridgeTransport } from './mock-bridge.js';
import { NativeTransport } from './native-transport.js';
import { createServer } from './server.js';
import { loadHttpsBridgeTransport } from './https-transport.js';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    mode: { type: 'string', default: 'mock' }, config: { type: 'string' },
    bridge: { type: 'string' }, 'native-user-approved': { type: 'boolean', default: false },
    'host-user-approved': { type: 'boolean', default: false }, 'host-bridge-url': { type: 'string' },
    'host-bridge-ca': { type: 'string' }, 'host-bridge-token': { type: 'string' },
  }, strict: true, allowPositionals: false });
  if (values.mode !== 'mock' && values.mode !== 'native' && values.mode !== 'host') throw new Error('INVALID_MODE');
  if (values.mode === 'native' && (!values['native-user-approved'] || !values.config || !values.bridge)) {
    throw new Error('NATIVE_APPROVAL_CONFIG_AND_BRIDGE_REQUIRED');
  }
  if (values.mode !== 'native' && values.bridge) throw new Error('MODE_CANNOT_LAUNCH_BRIDGE');
  if (values.mode === 'host' && (!values['host-user-approved'] || !values.config || !values['host-bridge-url']
    || !values['host-bridge-ca'] || !values['host-bridge-token'])) throw new Error('HOST_APPROVAL_AND_CREDENTIALS_REQUIRED');
  const config = await loadConfig(values.config ? resolve(values.config) : undefined);
  const transport = values.mode === 'mock' ? new MockBridgeTransport(() => new Date(), config.allowedAccessoryIds.length)
    : values.mode === 'host' ? await loadHttpsBridgeTransport(values['host-bridge-url']!,
      resolve(values['host-bridge-ca']!), resolve(values['host-bridge-token']!))
      : new NativeTransport(resolve(values.bridge!), resolve(values.config!));
  const bridge = new HomeKitBridge(transport, config);
  const handle = serveStdio(() => createServer({ bridge, mode: values.mode as 'mock' | 'native' | 'host' }), {
    transport: new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 1024 * 1024 }),
    onerror: () => process.stderr.write('homekit-mcp: protocol error\n'),
  });
  const close = () => { void bridge.close(); void handle.close(); };
  process.stdin.once('end', close);
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

main().catch(() => {
  process.stderr.write('homekit-mcp: startup refused; check arguments, approval and read-only configuration\n');
  process.exitCode = 1;
});
