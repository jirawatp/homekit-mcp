import https from 'node:https';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { BridgeCommand, BridgeTransport } from './bridge.js';
import { BridgeError } from './bridge.js';
import { accessoryId as idSchema } from './config.js';

export interface HostRequestOptions { url: URL; ca: string; token: string; body: string; signal: AbortSignal }
export type HostRequester = (options: HostRequestOptions) => Promise<unknown>;

export function validateHostBridgeUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !['host.docker.internal', '127.0.0.1', 'localhost'].includes(url.hostname)
    || url.port !== '18443' || url.username || url.password || url.search || url.hash || !['/', '/bridge'].includes(url.pathname)) {
    throw new BridgeError('HOST_BRIDGE_URL_REFUSED');
  }
  url.pathname = '/bridge';
  return url;
}

async function readBounded(path: string, maxBytes: number, privateFile: boolean): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new BridgeError('HOST_BRIDGE_FILE_REFUSED');
    if (privateFile && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.() || (stat.mode & 0o400) === 0)) {
      throw new BridgeError('HOST_BRIDGE_PRIVATE_FILE_PERMISSIONS');
    }
    if (!privateFile && (stat.mode & 0o022) !== 0) throw new BridgeError('HOST_BRIDGE_CA_FILE_PERMISSIONS');
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > maxBytes) throw new BridgeError('HOST_BRIDGE_FILE_REFUSED');
    return buffer.subarray(0, size).toString('utf8');
  } finally { await handle.close(); }
}

export async function loadHttpsBridgeTransport(url: string, caPath: string, tokenPath: string): Promise<HttpsBridgeTransport> {
  // Validate destination before reading any supplied credential path.
  validateHostBridgeUrl(url);
  const ca = await readBounded(caPath, 128 * 1024, false);
  const token = (await readBounded(tokenPath, 256, true)).trim();
  return new HttpsBridgeTransport({ url, ca, token });
}

const performRequest: HostRequester = ({ url, ca, token, body, signal }) => new Promise((resolve, reject) => {
  const request = https.request(url, { method: 'POST', ca, rejectUnauthorized: true, minVersion: 'TLSv1.3', signal,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
      'content-length': Buffer.byteLength(body), connection: 'close' } }, response => {
    if (response.statusCode !== 200 || !response.headers['content-type']?.startsWith('application/json')) {
      response.destroy(); request.destroy(); reject(new BridgeError('HOST_BRIDGE_REQUEST_REFUSED')); return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    response.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) {
        response.destroy(); request.destroy(); reject(new BridgeError('HOST_BRIDGE_FRAME_TOO_LARGE')); return;
      }
      chunks.push(chunk);
    });
    response.on('error', () => reject(new BridgeError('HOST_BRIDGE_IO_ERROR')));
    response.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new BridgeError('HOST_BRIDGE_PROTOCOL_ERROR')); }
    });
  });
  request.on('error', () => reject(new BridgeError('HOST_BRIDGE_UNAVAILABLE')));
  request.end(body);
});

/** Optional local Docker-to-Mac client. No requests occur until a read is called. */
export class HttpsBridgeTransport implements BridgeTransport {
  private readonly url: URL;
  private active: AbortController | undefined;
  private closed = false;
  constructor(private readonly options: { url: string; ca: string; token: string },
    private readonly requester: HostRequester = performRequest, private readonly timeoutMs = 10_000) {
    this.url = validateHostBridgeUrl(options.url);
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(options.token) || !options.ca.includes('-----BEGIN CERTIFICATE-----')) {
      throw new BridgeError('HOST_BRIDGE_CREDENTIALS_REQUIRED');
    }
  }
  async request(command: BridgeCommand, accessoryId?: string): Promise<unknown> {
    if (this.closed) throw new BridgeError('BRIDGE_CLOSED');
    if (this.active) throw new BridgeError('BRIDGE_BUSY');
    if (!['status', 'list_accessories', 'read_accessory'].includes(command)) throw new BridgeError('HOST_BRIDGE_COMMAND_REFUSED');
    const id = command === 'read_accessory' ? idSchema.parse(accessoryId) : undefined;
    if (command !== 'read_accessory' && accessoryId !== undefined) throw new BridgeError('HOST_BRIDGE_COMMAND_REFUSED');
    const controller = new AbortController();
    this.active = controller;
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const value = await this.requester({ url: new URL(this.url), ca: this.options.ca, token: this.options.token,
        body: JSON.stringify({ command, ...(id ? { accessoryId: id } : {}) }), signal: controller.signal });
      if (!value || typeof value !== 'object') throw new BridgeError('HOST_BRIDGE_PROTOCOL_ERROR');
      const response = value as Record<string, unknown>;
      if (response.ok !== true) throw new BridgeError('HOST_BRIDGE_READ_FAILED');
      return response.result;
    } finally { clearTimeout(timer); this.active = undefined; }
  }
  async close(): Promise<void> { this.closed = true; this.active?.abort(); }
}
