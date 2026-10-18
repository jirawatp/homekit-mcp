// Cross-language transport/policy check. Swift fixture imports Foundation, never HomeKit.
import { NativeTransport } from '../dist/src/native-transport.js';
import { HomeKitBridge } from '../dist/src/bridge.js';
import { configSchema } from '../dist/src/config.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const id = '11111111-1111-4111-8111-111111111111';
const config = configSchema.parse({ version: 1, mode: 'read-only', allowedAccessoryIds: [id] });
const directory = await mkdtemp(join(tmpdir(), 'homekit-cross-language-'));
const path = join(directory, 'synthetic.json');
await writeFile(path, JSON.stringify(config), { mode: 0o600 });
const bridge = new HomeKitBridge(new NativeTransport(resolve(root, 'native/.build/debug/BridgeFixture'), path), config);
try {
  assert.equal((await bridge.status()).platform, 'synthetic-fixture');
  const list = await bridge.listAccessories();
  assert.equal(list.accessories.length, 1);
  const reading = await bridge.readAccessory(id);
  assert.equal(reading.services[0].characteristics[0].value, 21.5);
  await assert.rejects(bridge.readAccessory('not-allowed'), /NOT_ALLOWLISTED/);
  console.log(JSON.stringify({ status: 'passed', bridge: 'TypeScript to Foundation-only Swift fixture',
    syntheticAccessories: 1, syntheticTemperature: 21.5, actualHomeKitAccess: false }, null, 2));
} finally { await bridge.close(); await rm(directory, { recursive: true, force: true }); }
