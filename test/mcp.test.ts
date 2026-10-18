import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

async function withClient(allowMock: boolean, run: (client: Client) => Promise<void>) {
  const client = new Client({ name: 'homekit-local-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve('dist/src/index.js'), '--mode', 'mock', ...(allowMock ? ['--config', resolve('config/mock.json')] : [])],
    stderr: 'pipe', cwd: process.cwd() });
  try { await client.connect(transport); await run(client); }
  finally { await client.close(); }
}
function content(result: unknown): Record<string, any> {
  const blocks = (result as { content: { type: string; text: string }[] }).content;
  assert.equal(blocks[0]?.type, 'text');
  return JSON.parse(blocks[0]!.text);
}

test('actual MCP stdio handshake, tool schemas, safe reads and synthetic event search', async () => {
  await withClient(true, async client => {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 6);
    for (const tool of tools) {
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.annotations?.destructiveHint, false);
      assert.doesNotMatch(tool.name, /write|set_|unlock|garage|record|upload/);
    }
    const status = content(await client.callTool({ name: 'homekit_get_status', arguments: {} }));
    assert.equal(status.simulated, true);
    assert.equal(status.capabilities.recording, false);
    const list = content(await client.callTool({ name: 'homekit_list_accessories', arguments: {} }));
    assert.equal(list.accessories.length, 2);
    const read = content(await client.callTool({ name: 'homekit_read_accessory', arguments: { accessoryId: 'demo-temperature' } }));
    assert.equal(read.accessory.services[0].characteristics[0].value, 24.5);
    const events = content(await client.callTool({ name: 'homekit_search_camera_events', arguments: { types: ['motion'] } }));
    assert.equal(events.simulated, true);
    assert.equal(events.events.length, 1);
    assert.equal(events.mediaAccess, 'metadata-only');
    const occupancy = content(await client.callTool({ name: 'homekit_get_room_occupancy', arguments: { roomId: 'mock-room-living' } }));
    assert.equal(occupancy.status, 'occupied');
    assert.equal(occupancy.identifiesPeople, false);
    const person = content(await client.callTool({ name: 'homekit_locate_consented_person', arguments: { personId: 'test-person' } }));
    assert.equal(person.status, 'unavailable');
    assert.equal(person.reason, 'no_active_consent');
    const bad = await client.callTool({ name: 'homekit_read_accessory', arguments: { accessoryId: 'demo-temperature', value: true } });
    assert.equal(bad.isError, true);
  });
});

test('MCP default deny all refuses accessory access', async () => {
  await withClient(false, async client => {
    assert.deepEqual(content(await client.callTool({ name: 'homekit_list_accessories', arguments: {} })).accessories, []);
    const read = await client.callTool({ name: 'homekit_read_accessory', arguments: { accessoryId: 'demo-temperature' } });
    assert.equal(read.isError, true);
    assert.equal(content(read).code, 'NOT_ALLOWLISTED');
  });
});

test('native launch cannot happen without explicit native flag, config and executable', () => {
  const result = spawnSync(process.execPath, ['dist/src/index.js', '--mode', 'native'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /startup refused/);
});
