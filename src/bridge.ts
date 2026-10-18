import { z } from 'zod';
import { normalizeAccessoryId, type Config } from './config.js';

const timestamp = z.string().datetime({ offset: true });
const text = z.string().max(256);
export const SAFE_CHARACTERISTIC_TYPES = new Set([
  '11', '10', '71', '22', '6A', '68', '76', '69', '70', '6B', '95', '75', '25',
].map(id => `000000${id}-0000-1000-8000-0026BB765291`));
const BLOCKED_SERVICE_TYPES = new Set(['40', '41', '44', '7E', '110', '111', '112', '113', '121', '129'].map(id =>
  `${id.padStart(8, '0')}-0000-1000-8000-0026BB765291`));
const characteristicSchema = z.object({
  id: text, type: text, readable: z.boolean(),
  value: z.union([z.number().finite(), z.boolean(), z.null()]).optional(),
  observedAt: timestamp,
});
const accessorySchema = z.object({
  id: text, name: text, room: text.optional(), roomId: text.optional(), category: text.optional(),
  reachable: z.boolean(), observedAt: timestamp,
  services: z.array(z.object({ id: text, type: text, name: text.optional(),
    characteristics: z.array(characteristicSchema).max(128),
  })).max(64),
});
const statusSchema = z.object({
  protocolVersion: z.literal(1), platform: text,
  authorization: z.enum(['not_requested', 'authorized', 'denied', 'restricted', 'unknown']),
  enabled: z.boolean(), readOnly: z.literal(true),
  allowlistedAccessoryCount: z.number().int().min(0).max(256),
});
export type Accessory = z.infer<typeof accessorySchema>;
export type BridgeStatus = z.infer<typeof statusSchema>;
export type BridgeCommand = 'status' | 'list_accessories' | 'read_accessory';
export interface BridgeTransport {
  request(command: BridgeCommand, accessoryId?: string): Promise<unknown>;
  close(): Promise<void>;
}
export class BridgeError extends Error {
  constructor(public readonly code: string) { super(code); }
}

/** Defense in depth: the native boundary independently enforces the same policy. */
export class HomeKitBridge {
  constructor(private readonly transport: BridgeTransport, private readonly config: Config) {}

  async status(): Promise<BridgeStatus> {
    return statusSchema.parse(await this.transport.request('status'));
  }

  private sanitize(accessory: Accessory): Accessory {
    const id = normalizeAccessoryId(accessory.id);
    if (!this.config.allowedAccessoryIds.includes(id)) throw new BridgeError('NOT_ALLOWLISTED');
    return { ...accessory, id, services: accessory.services
      .filter(service => !BLOCKED_SERVICE_TYPES.has(service.type.toUpperCase()))
      .map(service => ({ ...service, characteristics: service.characteristics.filter(characteristic =>
        characteristic.readable && SAFE_CHARACTERISTIC_TYPES.has(characteristic.type.toUpperCase())) }))
      .filter(service => service.characteristics.length > 0) };
  }

  async listAccessories(): Promise<{ accessories: Accessory[]; observedAt: string }> {
    const result = z.object({ accessories: z.array(accessorySchema).max(256), observedAt: timestamp })
      .parse(await this.transport.request('list_accessories'));
    return { ...result, accessories: result.accessories
      .filter(a => this.config.allowedAccessoryIds.includes(normalizeAccessoryId(a.id))).map(a => this.sanitize(a)) };
  }

  async readAccessory(id: string): Promise<Accessory> {
    id = normalizeAccessoryId(id);
    if (!this.config.allowedAccessoryIds.includes(id)) throw new BridgeError('NOT_ALLOWLISTED');
    const result = accessorySchema.parse(await this.transport.request('read_accessory', id));
    if (normalizeAccessoryId(result.id) !== id) throw new BridgeError('BRIDGE_ID_MISMATCH');
    return this.sanitize(result);
  }

  close(): Promise<void> { return this.transport.close(); }
}
