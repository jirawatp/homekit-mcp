import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { HomeKitBridge, BridgeError, type Accessory, type BridgeTransport } from '../src/bridge.js';
import { createServer } from '../src/server.js';

// Synthetic accessories and an in-memory transport: no helper, HomeKit or network is involved.
const NOW = new Date('2026-06-01T12:00:00.000Z');
const OCCUPANCY = '00000071-0000-1000-8000-0026BB765291';
const MOTION = '00000022-0000-1000-8000-0026BB765291';
const TEMPERATURE = '00000011-0000-1000-8000-0026BB765291';
type Reading = [type: string, value: number | boolean | null | undefined];

function accessory(id: string, roomId: string | undefined, readings: Reading[], reachable = true): Accessory {
  return {
    id, name: `Synthetic ${id}`, ...(roomId ? { roomId } : {}), reachable, observedAt: NOW.toISOString(),
    services: [{ id: `${id}-service`, type: '00000086-0000-1000-8000-0026BB765291',
      characteristics: readings.map(([type, value], index) => ({
        id: `${id}-c${index}`, type, readable: true, ...(value === undefined ? {} : { value }), observedAt: NOW.toISOString() })) }],
  };
}

class FakeTransport implements BridgeTransport {
  constructor(public accessories: Accessory[], public failure?: Error) {}
  reads: string[] = [];
  async request(command: string, id?: string): Promise<unknown> {
    if (this.failure) throw this.failure;
    if (command === 'status') return { protocolVersion: 1, platform: 'synthetic-native', authorization: 'authorized', enabled: true, readOnly: true, allowlistedAccessoryCount: this.accessories.length };
    if (command === 'list_accessories') return { accessories: this.accessories, observedAt: NOW.toISOString() };
    this.reads.push(id!);
    return this.accessories.find(item => item.id === id);
  }
  async close() {}
}

async function connect(mode: 'native' | 'host', transport: FakeTransport, allowed = transport.accessories.map(item => item.id)) {
  const bridge = new HomeKitBridge(transport, { version: 1, mode: 'read-only', allowedAccessoryIds: allowed });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer({ bridge, mode, clock: () => NOW });
  await server.connect(serverTransport);
  const client = new Client({ name: 'homekit-nonmock-test', version: '1.0.0' });
  await client.connect(clientTransport);
  return {
    async call(name: string, args: Record<string, unknown> = {}) {
      const result = await client.callTool({ name, arguments: args });
      const block = (result.content as Array<{ type: string; text: string }>)[0]!;
      return { isError: result.isError === true, body: JSON.parse(block.text) as Record<string, any> };
    },
    async close() { await client.close(); await server.close(); },
  };
}

test('non-mock status labels the transport honestly and never claims synthetic camera history', async () => {
  for (const [mode, expected] of [['native', 'private-stdio'], ['host', 'approved-local-https']] as const) {
    const session = await connect(mode, new FakeTransport([]));
    try {
      const { body } = await session.call('homekit_get_status');
      assert.equal(body.simulated, false);
      assert.equal(body.bridgeTransport, expected);
      assert.equal(body.capabilities.cameraEvents, 'unavailable');
      assert.equal(body.capabilities.recording, false);
      const events = await session.call('homekit_search_camera_events', {});
      assert.equal(events.body.simulated, false);
      assert.notEqual(events.body.status, 'available');
      assert.equal(JSON.stringify(events.body).includes('mock-event'), false, 'no synthetic events appear as real history');
    } finally { await session.close(); }
  }
});

test('occupancy is derived only from fresh allowlisted occupancy and motion sensors in the requested room', async () => {
  const transport = new FakeTransport([
    accessory('occ-a', 'room-1', [[OCCUPANCY, 1]]),
    accessory('motion-b', 'room-1', [[MOTION, false], [TEMPERATURE, 21]]),
    accessory('other-room', 'room-2', [[OCCUPANCY, 0]]),
    accessory('no-room', undefined, [[OCCUPANCY, 1]]),
    accessory('offline', 'room-1', [[OCCUPANCY, 1]], false),
    accessory('temperature-only', 'room-1', [[TEMPERATURE, 20]]),
    accessory('not-allowed', 'room-1', [[OCCUPANCY, 1]]),
  ]);
  const session = await connect('native', transport, ['occ-a', 'motion-b', 'other-room', 'no-room', 'offline', 'temperature-only']);
  try {
    const { isError, body } = await session.call('homekit_get_room_occupancy', { roomId: 'room-1' });
    assert.equal(isError, false);
    assert.equal(body.simulated, false);
    assert.equal(body.status, 'occupied');
    assert.equal(body.identifiesPeople, false);
    assert.deepEqual(transport.reads.sort(), ['motion-b', 'occ-a', 'offline'], 'only matching room sensors are read; the unreachable one is skipped');
    const empty = await session.call('homekit_get_room_occupancy', { roomId: 'unknown-room' });
    assert.equal(empty.body.status, 'unknown');
    assert.equal(empty.body.reason, 'no_signals');
  } finally { await session.close(); }
});

test('occupancy readings map true/1 detected, false/0 not detected, other values unknown, and nullish values are ignored', async () => {
  const cases: Array<[Reading, string]> = [
    [[OCCUPANCY, true], 'occupied'], [[OCCUPANCY, 1], 'occupied'],
    [[OCCUPANCY, false], 'unoccupied'], [[OCCUPANCY, 0], 'unoccupied'],
    [[OCCUPANCY, 7], 'unknown'], [[OCCUPANCY, null], 'unknown'], [[OCCUPANCY, undefined], 'unknown'],
    [[MOTION, true], 'occupied'], [[MOTION, false], 'unknown'],
  ];
  for (const [reading, status] of cases) {
    const session = await connect('host', new FakeTransport([accessory('sensor', 'room-1', [reading])]));
    try {
      const { body } = await session.call('homekit_get_room_occupancy', { roomId: 'room-1' });
      assert.equal(body.status, status, JSON.stringify(reading));
    } finally { await session.close(); }
  }
});

test('a room with more than eight sensors is refused instead of fanning out reads', async () => {
  const sensors = Array.from({ length: 9 }, (_, index) => accessory(`sensor-${index}`, 'room-1', [[OCCUPANCY, 1]]));
  const transport = new FakeTransport(sensors);
  const session = await connect('native', transport);
  try {
    const { isError, body } = await session.call('homekit_get_room_occupancy', { roomId: 'room-1' });
    assert.equal(isError, true);
    assert.equal(body.code, 'ROOM_SENSOR_LIMIT');
    assert.deepEqual(transport.reads, []);
  } finally { await session.close(); }
});

test('bridge failures return bounded unavailable results without helper text', async () => {
  const typed = await connect('native', new FakeTransport([], new BridgeError('BRIDGE_TIMEOUT')));
  const plain = await connect('native', new FakeTransport([], new Error('household secret /home/example')));
  try {
    for (const tool of ['homekit_get_status', 'homekit_list_accessories', 'homekit_get_room_occupancy']) {
      const args = tool === 'homekit_get_room_occupancy' ? { roomId: 'room-1' } : {};
      const first = await typed.call(tool, args);
      assert.equal(first.isError, true);
      assert.equal(first.body.code, 'BRIDGE_TIMEOUT');
      const second = await plain.call(tool, args);
      assert.equal(second.body.code, 'READ_FAILED');
      assert.doesNotMatch(JSON.stringify(second.body), /secret|home/);
    }
  } finally { await typed.close(); await plain.close(); }
});
