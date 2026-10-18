/** Optional macOS-only gateway. Importing this module never opens a listener. */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import { createPrivateKey, X509Certificate } from 'node:crypto';
import { createSecureContext } from 'node:tls';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { configSchema } from './config.js';
import { HomeKitBridge } from './bridge.js';
import { NativeTransport } from './native-transport.js';
import {
  handleHostRequest, hostError, validateHostEnvelope,
  MAX_HOST_REQUEST_BYTES, type HostHeaders, type HostProtocolResponse,
} from './host-protocol.js';

export interface HostGatewayOptions {
  bridgePath: string;
  configPath: string;
  tokenPath: string;
  certPath: string;
  keyPath: string;
  port: 18443;
}

/** Parsing grants no access. Both flags record separate user approvals. */
export function parseHostGatewayOptions(args: string[]): HostGatewayOptions {
  const requiredFlags = new Set(['--native-user-approved', '--host-bridge-user-approved']);
  const paths = new Map<string, string>();
  const names = new Set(['--bridge', '--config', '--token-file', '--cert-file', '--key-file', '--port']);
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (requiredFlags.has(argument)) { requiredFlags.delete(argument); continue; }
    if (!names.has(argument) || paths.has(argument)) throw new Error('INVALID_ARGUMENTS');
    const value = args[++index];
    if (value === undefined || value.startsWith('--')) throw new Error('INVALID_ARGUMENTS');
    paths.set(argument, value);
  }
  if (requiredFlags.size > 0) throw new Error('USER_APPROVAL_REQUIRED');
  const path = (name: string): string => {
    const value = paths.get(name);
    if (!value || !isAbsolute(value)) throw new Error('ABSOLUTE_PATH_REQUIRED');
    return value;
  };
  if (paths.get('--port') !== '18443') throw new Error('PORT_18443_REQUIRED');
  return {
    bridgePath: path('--bridge'), configPath: path('--config'), tokenPath: path('--token-file'),
    certPath: path('--cert-file'), keyPath: path('--key-file'), port: 18443,
  };
}

/** Bounded descriptor reads reject symlinks and special files before reading. */
async function readSuppliedFile(path: string, maxBytes: number, privateFile: boolean): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size === 0 || metadata.size > maxBytes) throw new Error('INVALID_SUPPLIED_FILE');
    if (privateFile && (metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0
      || (metadata.mode & 0o400) === 0)) throw new Error('PRIVATE_FILE_PERMISSIONS_REQUIRED');
    if (!privateFile && (metadata.mode & 0o022) !== 0) throw new Error('UNSAFE_PUBLIC_FILE_PERMISSIONS');
    const bytes = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await handle.read(bytes, size, bytes.length - size, size);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size === 0 || size > maxBytes) throw new Error('INVALID_SUPPLIED_FILE');
    return bytes.subarray(0, size);
  } finally { await handle.close(); }
}

async function validateBridgeExecutable(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > 128 * 1024 * 1024
      || metadata.uid !== process.getuid?.() || (metadata.mode & 0o022) !== 0
      || (metadata.mode & 0o100) === 0) throw new Error('UNSAFE_BRIDGE_EXECUTABLE');
  } finally { await handle.close(); }
}

function writeResponse(response: ServerResponse, reply: HostProtocolResponse): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(reply.statusCode, { ...reply.headers, 'content-length': String(Buffer.byteLength(reply.body, 'utf8')) });
  response.end(reply.body);
}

function rawHeaderValues(request: IncomingMessage): HostHeaders {
  const headers: Record<string, string | string[]> = Object.create(null) as Record<string, string | string[]>;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]!.toLowerCase();
    const value = request.rawHeaders[index + 1]!;
    const previous = headers[name];
    headers[name] = previous === undefined ? value : typeof previous === 'string' ? [previous, value] : [...previous, value];
  }
  return headers;
}

async function requestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += bytes.byteLength;
    if (size > MAX_HOST_REQUEST_BYTES) throw new Error('REQUEST_TOO_LARGE');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((done, failed) => {
    const onError = (error: Error): void => { server.off('listening', onListening); failed(error); };
    const onListening = (): void => { server.off('error', onError); done(); };
    server.once('error', onError);
    server.once('listening', onListening);
    // Never broaden this address for Docker reachability or remote clients.
    server.listen({ host: '127.0.0.1', port, exclusive: true });
  });
}

/** Only call after separate authorization to run the gateway and native helper. */
export async function runHostGateway(args: string[]): Promise<void> {
  const options = parseHostGatewayOptions(args);
  if (process.platform !== 'darwin' || process.getuid === undefined) throw new Error('MACOS_REQUIRED');
  // Complete all credential/config/TLS checks before spawning the helper.
  const tokenBytes = await readSuppliedFile(options.tokenPath, 256, true);
  const tokenMatch = new TextDecoder('utf-8', { fatal: true }).decode(tokenBytes).match(/^([A-Za-z0-9_-]{32,128})(?:\r?\n)?$/);
  if (!tokenMatch?.[1]) throw new Error('INVALID_TOKEN_FILE');
  const token = tokenMatch[1];
  const key = await readSuppliedFile(options.keyPath, 128 * 1024, true);
  const cert = await readSuppliedFile(options.certPath, 128 * 1024, false);
  const configBytes = await readSuppliedFile(options.configPath, 64 * 1024, true);
  const config = configSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(configBytes)));
  await validateBridgeExecutable(options.bridgePath);
  const certificate = new X509Certificate(cert);
  if (certificate.checkHost('host.docker.internal', { subject: 'never', wildcards: false }) === undefined
    || !certificate.checkPrivateKey(createPrivateKey(key))
    || Date.now() < Date.parse(certificate.validFrom) || Date.now() >= Date.parse(certificate.validTo)) {
    throw new Error('INVALID_TLS_CREDENTIALS');
  }
  createSecureContext({ key, cert, minVersion: 'TLSv1.3' });

  let bridge: HomeKitBridge | undefined;
  const server = createServer({ key, cert, minVersion: 'TLSv1.3', maxHeaderSize: 16 * 1024, handshakeTimeout: 10_000 }, (request, response) => {
    const envelope = { method: request.method, path: request.url, headers: rawHeaderValues(request) };
    const rejected = validateHostEnvelope(envelope, token);
    if (rejected) {
      response.once('finish', () => request.destroy());
      writeResponse(response, rejected);
      return;
    }
    void (async () => {
      try {
        const body = await requestBody(request);
        const reply = bridge === undefined ? hostError(503, 'BRIDGE_UNAVAILABLE')
          : await handleHostRequest({ ...envelope, body }, bridge, token);
        writeResponse(response, reply);
      } catch (error) {
        writeResponse(response, hostError(error instanceof Error && error.message === 'REQUEST_TOO_LARGE' ? 413 : 400,
          error instanceof Error && error.message === 'REQUEST_TOO_LARGE' ? 'REQUEST_TOO_LARGE' : 'INVALID_REQUEST'));
      }
    })();
  });
  server.maxConnections = 4;
  server.maxRequestsPerSocket = 1;
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 1_000;
  server.setTimeout(15_000, socket => socket.destroy());
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('tlsClientError', () => {});
  try {
    bridge = new HomeKitBridge(new NativeTransport(options.bridgePath, options.configPath), config);
    await listen(server, options.port);
  } catch {
    server.close();
    await bridge?.close();
    throw new Error('GATEWAY_START_FAILED');
  }
  let closing = false;
  const close = (): void => {
    if (closing) return;
    closing = true;
    server.close();
    server.closeAllConnections();
    void bridge?.close();
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  server.on('error', close);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runHostGateway(process.argv.slice(2)).catch(() => {
    // Never include paths, credential bytes, household names, or native diagnostics.
    process.stderr.write('HOMEKIT_HOST_GATEWAY_STARTUP_FAILED\n');
    process.exitCode = 1;
  });
}
