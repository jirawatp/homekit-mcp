// Ephemeral official MCP client -> Docker stdio -> synthetic server.
// Never starts Docker Desktop, builds/pulls an image, opens ports, mounts files,
// starts the native helper, or writes persistent client configuration.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const image = process.env.HOMEKIT_DOCKER_IMAGE ?? 'homekit-mcp:local';
const docker = (args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 5000,
  maxBuffer: 128 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
try {
  docker(['version', '--format', '{{.Server.Version}}']);
} catch {
  console.log(JSON.stringify({ status: 'blocked', reason: 'DOCKER_ENGINE_UNAVAILABLE',
    imageBuilt: false, containerStarted: false, actualHomeKitAccess: false }, null, 2));
  process.exit(2);
}
try {
  docker(['image', 'inspect', image, '--format', '{{.Id}}']);
} catch {
  console.log(JSON.stringify({ status: 'blocked', reason: 'LOCAL_IMAGE_REQUIRED',
    expectedImage: image, imageBuilt: false, containerStarted: false }, null, 2));
  process.exit(2);
}

const name = `homekit-mcp-smoke-${randomUUID()}`;
const client = new Client({ name: 'homekit-docker-smoke', version: '1.0.0' });
const transport = new StdioClientTransport({ command: 'docker', args: [
  'run', '--rm', '-i', '--name', name, '--pull=never', '--network=none',
  '--read-only', '--user=1000:1000', '--cap-drop=ALL',
  '--security-opt=no-new-privileges:true', '--memory=192m', '--memory-swap=192m',
  '--cpus=0.5', '--pids-limit=64', '--init', '--log-driver=none',
  '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777', image,
  '--mode', 'mock', '--config', '/app/config/mock.json',
], stderr: 'pipe' });
const parse = result => {
  assert.equal(result.content?.[0]?.type, 'text');
  return JSON.parse(result.content[0].text);
};
let deadline;
try {
  await Promise.race([(async () => {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 6);
    assert.ok(tools.every(tool => tool.annotations?.readOnlyHint === true));
    const status = parse(await client.callTool({ name: 'homekit_get_status', arguments: {} }));
    assert.equal(status.simulated, true);
    assert.equal(status.capabilities.recording, false);
    const list = parse(await client.callTool({ name: 'homekit_list_accessories', arguments: {} }));
    assert.equal(list.accessories.length, 2);
    const events = parse(await client.callTool({ name: 'homekit_search_camera_events', arguments: {} }));
    assert.equal(events.simulated, true);
    assert.equal(events.events.length, 2);
    const denied = await client.callTool({ name: 'homekit_read_accessory',
      arguments: { accessoryId: 'not-allowlisted' } });
    assert.equal(denied.isError, true);
    console.log(JSON.stringify({ status: 'passed', transport: 'docker-stdio',
      toolCount: tools.length, syntheticAccessories: list.accessories.length,
      syntheticEvents: events.events.length, network: 'none', mounts: [],
      persistentIntegration: false, actualHomeKitAccess: false,
      hostBridgeTested: false, dotVoiceConnected: false }, null, 2));
  })(), new Promise((_, reject) => {
    deadline = setTimeout(() => reject(new Error('DOCKER_SMOKE_DEADLINE')), 30_000);
  })]);
} finally {
  clearTimeout(deadline);
  await client.close().catch(() => {});
  // Only the uniquely named container created by this invocation may be removed.
  try { docker(['rm', '--force', name]); } catch { /* --rm normally removed it */ }
}
