// Actual MCP SDK client <-> stdio server, synthetic data only, ephemeral process.
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import assert from 'node:assert/strict';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const client = new Client({ name: 'homekit-safe-smoke', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath,
  args: [resolve(root, 'dist/src/index.js'), '--mode', 'mock', '--config', resolve(root, 'config/mock.json')],
  stderr: 'pipe', cwd: root });
const parse = result => JSON.parse(result.content[0].text);
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 6);
  assert.ok(tools.every(tool => tool.annotations.readOnlyHint));
  const status = parse(await client.callTool({ name: 'homekit_get_status', arguments: {} }));
  assert.equal(status.simulated, true);
  const list = parse(await client.callTool({ name: 'homekit_list_accessories', arguments: {} }));
  assert.equal(list.accessories.length, 2);
  const events = parse(await client.callTool({ name: 'homekit_search_camera_events', arguments: {} }));
  assert.equal(events.simulated, true);
  assert.equal(events.events.length, 2);
  const denied = await client.callTool({ name: 'homekit_read_accessory', arguments: { accessoryId: 'not-allowed' } });
  assert.equal(denied.isError, true);
  console.log(JSON.stringify({ status: 'passed', transport: 'stdio', toolCount: tools.length,
    syntheticAccessories: list.accessories.length, syntheticEvents: events.events.length,
    defaultPolicy: 'read-only + explicit allowlist', persistentIntegration: false,
    actualHomeKitAccess: false, dotVoiceConnected: false }, null, 2));
} finally { await client.close(); }
