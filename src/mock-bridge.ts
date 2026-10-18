import type { BridgeCommand, BridgeTransport, Accessory } from './bridge.js';
import { BridgeError } from './bridge.js';

export function mockAccessories(now: Date): Accessory[] {
  const observedAt = now.toISOString();
  return [
    { id: 'demo-temperature', name: 'Synthetic temperature sensor', room: 'Demo room A',
      category: 'sensor', reachable: true, observedAt,
      services: [{ id: 'demo-service-temp', type: '0000008A-0000-1000-8000-0026BB765291',
        characteristics: [{ id: 'demo-value-temp', type: '00000011-0000-1000-8000-0026BB765291',
          readable: true, value: 24.5, observedAt }] }] },
    { id: 'demo-occupancy', name: 'Synthetic occupancy sensor', room: 'Demo room B',
      category: 'sensor', reachable: true, observedAt,
      services: [{ id: 'demo-service-occupancy', type: '00000086-0000-1000-8000-0026BB765291',
        characteristics: [{ id: 'demo-value-occupancy', type: '00000071-0000-1000-8000-0026BB765291',
          readable: true, value: 1, observedAt }] }] },
  ];
}

export class MockBridgeTransport implements BridgeTransport {
  constructor(private readonly clock: () => Date = () => new Date(), private readonly allowedCount = 0) {}
  async request(command: BridgeCommand, id?: string): Promise<unknown> {
    const now = this.clock();
    if (command === 'status') return { protocolVersion: 1, platform: 'synthetic-mock',
      authorization: 'not_requested', enabled: true, readOnly: true, allowlistedAccessoryCount: this.allowedCount };
    const accessories = mockAccessories(now);
    if (command === 'list_accessories') return { accessories, observedAt: now.toISOString() };
    const accessory = accessories.find(a => a.id === id);
    if (!accessory) throw new BridgeError('ACCESSORY_UNAVAILABLE');
    return accessory;
  }
  async close(): Promise<void> {}
}
