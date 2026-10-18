import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HomeKitBridge, type BridgeTransport } from '../src/bridge.js';
import { configSchema, denyAllConfig } from '../src/config.js';
import { mockAccessories, MockBridgeTransport } from '../src/mock-bridge.js';
import { loadConfig } from '../src/config.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const now = new Date('2026-10-18T12:00:00Z');
test('empty allowlist discloses no accessory and rejects read before contacting bridge', async () => {
  let reads = 0;
  const transport: BridgeTransport = {
    request: async command => { if (command === 'read_accessory') reads++; return { accessories: mockAccessories(now), observedAt: now.toISOString() }; },
    close: async () => {},
  };
  const bridge = new HomeKitBridge(transport, denyAllConfig);
  assert.deepEqual((await bridge.listAccessories()).accessories, []);
  await assert.rejects(bridge.readAccessory('demo-temperature'), /NOT_ALLOWLISTED/);
  assert.equal(reads, 0);
});

test('configuration rejects write mode, wildcard, duplicates and unknown keys', () => {
  for (const overrides of [ { mode: 'write' }, { allowedAccessoryIds: ['*'] },
    { allowedAccessoryIds: ['demo-temperature', 'demo-temperature'] }, { network: true } ]) {
    assert.throws(() => configSchema.parse({ ...denyAllConfig, ...overrides }));
  }
});

test('configuration input is bounded before parsing and file handles close on rejection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'homekit-config-test-'));
  const path = join(directory, 'oversized.json');
  try {
    await writeFile(path, Buffer.alloc(65_537, ' '));
    await assert.rejects(loadConfig(path), /CONFIG_TOO_LARGE/);
    await writeFile(path, JSON.stringify(denyAllConfig));
    assert.deepEqual(await loadConfig(path), denyAllConfig);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('UUID normalization agrees with native bridge and rejects case-folded duplicates', async () => {
  const lower = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const config = configSchema.parse({ ...denyAllConfig, allowedAccessoryIds: [lower] });
  const data = { ...mockAccessories(now)[0]!, id: lower.toUpperCase() };
  const bridge = new HomeKitBridge({ request: async command => command === 'list_accessories'
    ? { accessories: [data], observedAt: now.toISOString() } : data, close: async () => {} }, config);
  assert.equal((await bridge.listAccessories()).accessories[0]?.id, lower.toUpperCase());
  assert.equal((await bridge.readAccessory(lower)).id, lower.toUpperCase());
  assert.throws(() => configSchema.parse({ ...denyAllConfig, allowedAccessoryIds: [lower, lower.toUpperCase()] }));
});

test('wrapper removes unallowed devices and unsafe camera/lock/garage services and characteristics', async () => {
  const a = mockAccessories(now)[0]!;
  const safe = a.services[0]!;
  const characteristic = safe.characteristics[0]!;
  const poisoned = { ...a, services: [
    { ...safe, characteristics: [characteristic,
      { ...characteristic, id: 'secret', type: 'vendor-pairing-data', value: 123 },
      { ...characteristic, id: 'unreadable', readable: false }] },
    ...['00000040', '00000041', '00000044', '00000110', '00000111'].map(type =>
      ({ ...safe, type: `${type}-0000-1000-8000-0026BB765291` })),
  ] };
  const bridge = new HomeKitBridge({ request: async () => ({ accessories: [poisoned, mockAccessories(now)[1]],
    observedAt: now.toISOString() }), close: async () => {} }, { ...denyAllConfig, allowedAccessoryIds: [a.id] });
  const list = await bridge.listAccessories();
  assert.equal(list.accessories.length, 1);
  assert.equal(list.accessories[0]?.services.length, 1);
  assert.deepEqual(list.accessories[0]?.services[0]?.characteristics, [characteristic]);
});

test('wrong accessory identity fails closed and mock values carry observation time', async () => {
  const config = { ...denyAllConfig, allowedAccessoryIds: ['demo-temperature', 'demo-occupancy'] };
  const wrong = new HomeKitBridge({ request: async () => mockAccessories(now)[1], close: async () => {} }, config);
  await assert.rejects(wrong.readAccessory('demo-temperature'), /BRIDGE_ID_MISMATCH/);
  const mock = new HomeKitBridge(new MockBridgeTransport(() => now), config);
  const read = await mock.readAccessory('demo-temperature');
  assert.equal(read.services[0]?.characteristics[0]?.observedAt, now.toISOString());
  assert.equal(read.services[0]?.characteristics[0]?.value, 24.5);
});
