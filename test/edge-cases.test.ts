import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadConfig, denyAllConfig } from '../src/config.js';
import { MockBridgeTransport } from '../src/mock-bridge.js';
import { LocalMockCameraProvider, searchCameraEvents } from '../src/events.js';
import { getRoomOccupancy } from '../src/presence.js';
import { NativeTransport } from '../src/native-transport.js';
import { BridgeError, HomeKitBridge } from '../src/bridge.js';

// Synthetic fixtures only; temp files hold no credentials and no process or device is contacted.
async function withDirectory<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'homekit-edge-test-'));
  try { return await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('configuration loading is deny-all by default and rejects links, special files, oversize and invalid content', async () => {
  const empty = await loadConfig();
  assert.deepEqual(empty, denyAllConfig);
  empty.allowedAccessoryIds.push('mutated');
  assert.deepEqual(denyAllConfig.allowedAccessoryIds, [], 'callers cannot mutate the shared deny-all policy');
  await withDirectory(async directory => {
    const good = join(directory, 'config.json');
    await writeFile(good, JSON.stringify({ version: 1, mode: 'read-only', allowedAccessoryIds: ['demo-temperature'] }));
    assert.deepEqual((await loadConfig(good)).allowedAccessoryIds, ['demo-temperature']);
    const link = join(directory, 'link.json');
    await symlink(good, link);
    await assert.rejects(loadConfig(link), 'a symlinked config is refused');
    await assert.rejects(loadConfig(directory), 'a directory is not a config file');
    const big = join(directory, 'big.json');
    await writeFile(big, ' '.repeat(64 * 1024 + 1));
    await assert.rejects(loadConfig(big), /CONFIG_TOO_LARGE/);
    for (const [name, content] of [['write.json', { version: 1, mode: 'read-write', allowedAccessoryIds: [] }],
      ['extra.json', { version: 1, mode: 'read-only', allowedAccessoryIds: [], writable: true }],
      ['dup.json', { version: 1, mode: 'read-only', allowedAccessoryIds: ['a', 'a'] }],
      ['bad-id.json', { version: 1, mode: 'read-only', allowedAccessoryIds: ['has space'] }]] as const) {
      const path = join(directory, name);
      await writeFile(path, JSON.stringify(content));
      await assert.rejects(loadConfig(path), name);
    }
    const malformed = join(directory, 'malformed.json');
    await writeFile(malformed, '{');
    await assert.rejects(loadConfig(malformed));
  });
});

test('mock bridge exposes only synthetic read-only data and can be closed', async () => {
  const transport = new MockBridgeTransport(() => new Date('2026-06-01T00:00:00Z'), 3);
  assert.equal((await transport.request('status') as { allowlistedAccessoryCount: number }).allowlistedAccessoryCount, 3);
  assert.equal((await transport.request('list_accessories') as { accessories: unknown[] }).accessories.length, 2);
  await assert.rejects(transport.request('read_accessory', 'unknown-id'), /ACCESSORY_UNAVAILABLE/);
  await assert.rejects(transport.request('read_accessory'), /ACCESSORY_UNAVAILABLE/);
  await transport.close();
  const defaults = new MockBridgeTransport();
  assert.equal((await defaults.request('status') as { allowlistedAccessoryCount: number }).allowlistedAccessoryCount, 0, 'default clock and deny-all count');
});

test('bridge removes non-allowlisted accessories, blocked services and unsafe characteristics', async () => {
  const at = '2026-06-01T00:00:00.000Z';
  const characteristic = (type: string, readable = true) => ({ id: `c-${type}`, type, readable, value: 1, observedAt: at });
  const accessory = (id: string, services: Array<{ type: string; chars: ReturnType<typeof characteristic>[] }>) => ({
    id, name: id, reachable: true, observedAt: at,
    services: services.map((service, index) => ({ id: `s${index}`, type: service.type, characteristics: service.chars })),
  });
  const temperature = '00000011-0000-1000-8000-0026BB765291';
  const lockMechanism = '00000045-0000-1000-8000-0026BB765291';
  const camera = '00000110-0000-1000-8000-0026BB765291';
  const list = {
    accessories: [
      accessory('allowed', [
        { type: '0000008A-0000-1000-8000-0026BB765291', chars: [characteristic(temperature), characteristic(temperature, false), characteristic(lockMechanism)] },
        { type: camera, chars: [characteristic(temperature)] },
        { type: '0000008A-0000-1000-8000-0026BB765291', chars: [characteristic(lockMechanism)] },
      ]),
      accessory('hidden', [{ type: '0000008A-0000-1000-8000-0026BB765291', chars: [characteristic(temperature)] }]),
    ],
    observedAt: at,
  };
  const bridge = new HomeKitBridge({ request: async () => list, close: async () => {} }, { version: 1, mode: 'read-only', allowedAccessoryIds: ['allowed'] });
  const result = await bridge.listAccessories();
  assert.deepEqual(result.accessories.map(item => item.id), ['allowed']);
  assert.equal(result.accessories[0]!.services.length, 1, 'camera service and empty services are dropped');
  assert.deepEqual(result.accessories[0]!.services[0]!.characteristics.map(item => item.type), [temperature]);
  const mismatched = new HomeKitBridge({ request: async () => accessory('other', []), close: async () => {} },
    { version: 1, mode: 'read-only', allowedAccessoryIds: ['allowed', 'other'] });
  await assert.rejects(mismatched.readAccessory('allowed'), /BRIDGE_ID_MISMATCH/);
  await assert.rejects(mismatched.readAccessory('not-listed'), (error: unknown) => error instanceof BridgeError && error.code === 'NOT_ALLOWLISTED');
});

test('event and occupancy inputs reject blank identifiers and timezone-less timestamps', async () => {
  const provider = new LocalMockCameraProvider();
  const now = new Date('2026-01-01T12:00:00.000Z');
  await assert.rejects(searchCameraEvents(provider, { cameraId: '  ' }, { now }), /cameraId must be a nonempty identifier/);
  await assert.rejects(searchCameraEvents(provider, { roomId: '' }, { now }), /roomId must be a nonempty identifier/);
  await assert.rejects(searchCameraEvents(provider, { from: '2026-01-01T00:00:00' }, { now }), /timezone/);
  await assert.rejects(searchCameraEvents(provider, { from: '2026-13-45T00:00:00Z' }, { now }), /valid timestamp/);
  assert.throws(() => getRoomOccupancy('room', [{ signalId: 's', roomId: 'room', method: 'occupancy-sensor', state: 'detected',
    observedAt: '2026-01-01T12:00:00', simulated: true }], { now }), /timezone/);
  assert.throws(() => getRoomOccupancy('room', [{ signalId: 's', roomId: 'room', method: 'occupancy-sensor', state: 'detected',
    observedAt: '2026-99-99T12:00:00Z', simulated: true }], { now }), /Invalid signal/);
});

const nodeHelper = (code: string) => `#!${process.execPath}\nimport {createInterface} from 'node:readline';\nconst lines=createInterface({input:process.stdin});\n${code}`;
async function withHelper(code: string, run: (transport: NativeTransport) => Promise<void>, timeoutMs = 2000): Promise<void> {
  await withDirectory(async directory => {
    const executable = join(directory, 'helper.mjs');
    await writeFile(executable, nodeHelper(code), { mode: 0o700 });
    const transport = new NativeTransport(executable, join(directory, 'unused.json'), timeoutMs);
    try { await run(transport); } finally { await transport.close(); }
  });
}

test('helper replies that are not exactly correlated objects close the transport with a protocol error', async () => {
  for (const reply of ['null', '"text"', '{"ok":true}', '{"id":"x"}', '{"id":1,"ok":true}', '{"id":"unknown-id","ok":true,"result":1}']) {
    await withHelper(`lines.on('line',()=>process.stdout.write(${JSON.stringify(reply + '\n')}));`, async transport => {
      await assert.rejects(transport.request('status'), /BRIDGE_PROTOCOL_ERROR/, reply);
      await assert.rejects(transport.request('status'), /BRIDGE_CLOSED/);
    });
  }
});

test('unknown or missing native error codes are collapsed to a generic safe code', async () => {
  for (const error of ['{"code":"database_dump","message":"Kitchen"}', '{}', 'null', '"text"']) {
    await withHelper(`lines.on('line',line=>process.stdout.write(JSON.stringify({id:JSON.parse(line).id,ok:false,error:${error}})+'\\n'));`, async transport => {
      await assert.rejects(transport.request('status'), (failure: unknown) => failure instanceof BridgeError && failure.message === 'NATIVE_REQUEST_FAILED'
        , error);
    });
  }
  await withHelper(`lines.on('line',line=>process.stdout.write(JSON.stringify({id:JSON.parse(line).id,ok:false})+'\\n'));`, async transport => {
    await assert.rejects(transport.request('status'), /NATIVE_REQUEST_FAILED/);
  });
});

test('allowlisted read request carries its accessory id, and helper exit or missing executable are reported safely', async () => {
  await withHelper(`lines.on('line',line=>{const q=JSON.parse(line);process.stdout.write(JSON.stringify({id:q.id,ok:true,result:q})+'\\n');});`, async transport => {
    const echoed = await transport.request('read_accessory', 'demo-temperature') as { command: string; accessoryId: string };
    assert.deepEqual([echoed.command, echoed.accessoryId], ['read_accessory', 'demo-temperature']);
  });
  await withHelper(`lines.on('line',()=>process.exit(0));`, async transport => {
    await assert.rejects(transport.request('status'), /BRIDGE_EXITED/);
  });
  await withDirectory(async directory => {
    const transport = new NativeTransport(join(directory, 'missing-helper'), join(directory, 'config.json'), 500);
    await assert.rejects(transport.request('status'), /BRIDGE_START_FAILED|BRIDGE_IO_ERROR|BRIDGE_EXITED/);
    await transport.close();
  });
  assert.throws(() => new NativeTransport('relative/helper', '/abs/config.json'), /ABSOLUTE_PATH_REQUIRED/);
  assert.throws(() => new NativeTransport('/abs/helper', 'relative/config.json'), /ABSOLUTE_PATH_REQUIRED/);
});
