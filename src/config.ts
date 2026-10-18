import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { z } from 'zod';

export function normalizeAccessoryId(id: string): string {
  return /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id) ? id.toUpperCase() : id;
}
export const accessoryId = z.string().regex(/^[A-Za-z0-9-]{1,128}$/).transform(normalizeAccessoryId);
export const configSchema = z.object({
  version: z.literal(1),
  mode: z.literal('read-only'),
  allowedAccessoryIds: z.array(accessoryId).max(256)
    .refine(ids => new Set(ids).size === ids.length, 'Duplicate accessory ID'),
}).strict();
export type Config = z.infer<typeof configSchema>;
export const denyAllConfig: Config = { version: 1, mode: 'read-only', allowedAccessoryIds: [] };

export async function loadConfig(path?: string): Promise<Config> {
  if (!path) return { ...denyAllConfig, allowedAccessoryIds: [] };
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) throw new Error('CONFIG_NOT_REGULAR_FILE');
    const data = Buffer.alloc(64 * 1024 + 1);
    let size = 0;
    while (size < data.length) {
      const { bytesRead } = await handle.read(data, size, data.length - size, size);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > 64 * 1024) throw new Error('CONFIG_TOO_LARGE');
    return configSchema.parse(JSON.parse(data.subarray(0, size).toString('utf8')));
  } finally { await handle.close(); }
}
