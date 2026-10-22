/** Optional macOS-only gateway. Importing this module never opens a listener. */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createServer } from 'node:https';
import type { EventEmitter } from 'node:events';
import { createPrivateKey, X509Certificate, type KeyObject } from 'node:crypto';
import { createSecureContext } from 'node:tls';
import { isAbsolute } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { configSchema, type Config } from './config.js';
import { HomeKitBridge } from './bridge.js';
import { NativeTransport } from './native-transport.js';
import {
  handleHostRequest, hostError, validateHostEnvelope,
  MAX_HOST_REQUEST_BYTES, type HostBridge, type HostHeaders, type HostProtocolResponse,
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

/** The minimal descriptor surface this gateway needs; fakes make every branch testable in memory. */
export interface SuppliedFile {
  stat(): Promise<{ isFile(): boolean; size: number; uid: number; mode: number }>;
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export interface CertificateLike {
  validFrom: string;
  validTo: string;
  checkHost(name: string, options: { subject: 'never'; wildcards: false }): string | undefined;
  checkPrivateKey(key: KeyObject): boolean;
}

export interface TlsPrimitives {
  parseCertificate(pem: Buffer): CertificateLike;
  parsePrivateKey(pem: Buffer): KeyObject;
  createSecureContext(options: { key: Buffer; cert: Buffer; minVersion: 'TLSv1.3' }): unknown;
}

/** The subset of `https.Server` the gateway uses. */
export interface GatewayServer extends EventEmitter {
  maxConnections: number;
  maxRequestsPerSocket: number | null;
  headersTimeout: number;
  requestTimeout: number;
  keepAliveTimeout: number;
  setTimeout(ms: number, callback: (socket: { destroy(): void }) => void): unknown;
  listen(options: { host: string; port: number; exclusive: boolean }): unknown;
  close(): unknown;
  closeAllConnections(): void;
}

export interface GatewayBridge extends HostBridge {
  close(): Promise<void>;
}

export interface ServerSettings {
  key: Buffer;
  cert: Buffer;
  minVersion: 'TLSv1.3';
  maxHeaderSize: number;
  handshakeTimeout: number;
}

export interface GatewayDependencies {
  platform: NodeJS.Platform;
  uid: number | undefined;
  now(): number;
  openFile(path: string): Promise<SuppliedFile>;
  tls: TlsPrimitives;
  createHttpsServer(settings: ServerSettings, handler: (request: IncomingMessage, response: ServerResponse) => void): GatewayServer;
  createBridge(bridgePath: string, configPath: string, config: Config): GatewayBridge;
  onSignal(signal: 'SIGINT' | 'SIGTERM', handler: () => void): void;
}

export const defaultTlsPrimitives: TlsPrimitives = {
  parseCertificate: (pem) => new X509Certificate(pem),
  parsePrivateKey: (pem) => createPrivateKey(pem),
  createSecureContext: (options) => createSecureContext(options),
};

export const defaultDependencies: GatewayDependencies = {
  platform: process.platform,
  uid: process.getuid?.(),
  now: () => Date.now(),
  openFile: (path) => open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK),
  tls: defaultTlsPrimitives,
  createHttpsServer: (settings, handler) => createServer(settings, handler),
  createBridge: (bridgePath, configPath, config) => new HomeKitBridge(new NativeTransport(bridgePath, configPath), config),
  onSignal: (signal, handler) => { process.once(signal, handler); },
};

const GATEWAY_HOST = 'host.docker.internal';

/** Bounded descriptor reads reject symlinks and special files before reading. */
export async function readSuppliedFile(
  path: string, maxBytes: number, privateFile: boolean, deps: GatewayDependencies = defaultDependencies,
): Promise<Buffer> {
  const handle = await deps.openFile(path);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size === 0 || metadata.size > maxBytes) throw new Error('INVALID_SUPPLIED_FILE');
    if (privateFile && (metadata.uid !== deps.uid || (metadata.mode & 0o077) !== 0
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

export async function validateBridgeExecutable(path: string, deps: GatewayDependencies = defaultDependencies): Promise<void> {
  const handle = await deps.openFile(path);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > 128 * 1024 * 1024
      || metadata.uid !== deps.uid || (metadata.mode & 0o022) !== 0
      || (metadata.mode & 0o100) === 0) throw new Error('UNSAFE_BRIDGE_EXECUTABLE');
  } finally { await handle.close(); }
}

/** Certificate must match the key, carry the explicit DNS SAN, be currently valid and negotiate TLS 1.3. */
export function validateTlsCredentials(key: Buffer, cert: Buffer, nowMs: number, tls: TlsPrimitives = defaultTlsPrimitives): void {
  try {
    const certificate = tls.parseCertificate(cert);
    const validFrom = Date.parse(certificate.validFrom);
    const validTo = Date.parse(certificate.validTo);
    if (certificate.checkHost(GATEWAY_HOST, { subject: 'never', wildcards: false }) === undefined
      || !certificate.checkPrivateKey(tls.parsePrivateKey(key))
      || !Number.isFinite(validFrom) || !Number.isFinite(validTo) || nowMs < validFrom || nowMs >= validTo) {
      throw new Error('INVALID_TLS_CREDENTIALS');
    }
    tls.createSecureContext({ key, cert, minVersion: 'TLSv1.3' });
  } catch {
    // Never surface parser text, which could describe credential contents.
    throw new Error('INVALID_TLS_CREDENTIALS');
  }
}

function writeResponse(response: ServerResponse, reply: HostProtocolResponse): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(reply.statusCode, { ...reply.headers, 'content-length': String(Buffer.byteLength(reply.body, 'utf8')) });
  response.end(reply.body);
}

export function rawHeaderValues(request: Pick<IncomingMessage, 'rawHeaders'>): HostHeaders {
  const headers: Record<string, string | string[]> = Object.create(null) as Record<string, string | string[]>;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]!.toLowerCase();
    const value = request.rawHeaders[index + 1]!;
    const previous = headers[name];
    headers[name] = previous === undefined ? value : typeof previous === 'string' ? [previous, value] : [...previous, value];
  }
  return headers;
}

export async function requestBody(request: AsyncIterable<unknown>): Promise<Buffer> {
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

async function listen(server: GatewayServer, port: number): Promise<void> {
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
export async function runHostGateway(args: string[], deps: GatewayDependencies = defaultDependencies): Promise<void> {
  const options = parseHostGatewayOptions(args);
  if (deps.platform !== 'darwin' || deps.uid === undefined) throw new Error('MACOS_REQUIRED');
  // Complete all credential/config/TLS checks before spawning the helper.
  const tokenBytes = await readSuppliedFile(options.tokenPath, 256, true, deps);
  const tokenMatch = new TextDecoder('utf-8', { fatal: true }).decode(tokenBytes).match(/^([A-Za-z0-9_-]{32,128})(?:\r?\n)?$/);
  if (!tokenMatch?.[1]) throw new Error('INVALID_TOKEN_FILE');
  const token = tokenMatch[1];
  const key = await readSuppliedFile(options.keyPath, 128 * 1024, true, deps);
  const cert = await readSuppliedFile(options.certPath, 128 * 1024, false, deps);
  const configBytes = await readSuppliedFile(options.configPath, 64 * 1024, true, deps);
  const config = configSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(configBytes)));
  await validateBridgeExecutable(options.bridgePath, deps);
  validateTlsCredentials(key, cert, deps.now(), deps.tls);

  // Closing is best effort; an error from the helper must never become an unhandled rejection.
  const closeBridge = async (target: GatewayBridge): Promise<void> => { try { await target.close(); } catch { /* helper already gone */ } };
  let bridge: GatewayBridge;
  try {
    bridge = deps.createBridge(options.bridgePath, options.configPath, config);
  } catch {
    throw new Error('GATEWAY_START_FAILED');
  }
  let server: GatewayServer | undefined;
  try {
    server = deps.createHttpsServer({ key, cert, minVersion: 'TLSv1.3', maxHeaderSize: 16 * 1024, handshakeTimeout: 10_000 }, (request, response) => {
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
          writeResponse(response, await handleHostRequest({ ...envelope, body }, bridge, token));
        } catch (error) {
          const tooLarge = error instanceof Error && error.message === 'REQUEST_TOO_LARGE';
          writeResponse(response, hostError(tooLarge ? 413 : 400, tooLarge ? 'REQUEST_TOO_LARGE' : 'INVALID_REQUEST'));
        }
      })();
    });
    server.maxConnections = 4;
    server.maxRequestsPerSocket = 1;
    server.headersTimeout = 10_000;
    server.requestTimeout = 15_000;
    server.keepAliveTimeout = 1_000;
    server.setTimeout(15_000, socket => socket.destroy());
    server.on('clientError', (_error: Error, socket: { destroy(): void }) => socket.destroy());
    server.on('tlsClientError', () => {});
    await listen(server, options.port);
  } catch {
    server?.close();
    await closeBridge(bridge);
    throw new Error('GATEWAY_START_FAILED');
  }
  const listening = server;
  let closing = false;
  const close = (): void => {
    if (closing) return;
    closing = true;
    listening.close();
    listening.closeAllConnections();
    void closeBridge(bridge);
  };
  try {
    deps.onSignal('SIGINT', close);
    deps.onSignal('SIGTERM', close);
    listening.on('error', close);
  } catch {
    // Already listening with a live helper: release both before reporting the fixed failure.
    close();
    throw new Error('GATEWAY_START_FAILED');
  }
}

export interface GatewayCliIo {
  stderr(text: string): void;
  setExitCode(code: number): void;
}

const defaultIo: GatewayCliIo = {
  stderr: (text) => { process.stderr.write(text); },
  setExitCode: (code) => { process.exitCode = code; },
};

/** Startup failure is reported with one fixed line: no paths, credential bytes, names or native text. */
export async function runHostGatewayCli(
  args: string[], io: GatewayCliIo = defaultIo, deps: GatewayDependencies = defaultDependencies,
): Promise<void> {
  try {
    await runHostGateway(args, deps);
  } catch {
    io.stderr('HOMEKIT_HOST_GATEWAY_STARTUP_FAILED\n');
    io.setExitCode(1);
  }
}

if (import.meta.main) await runHostGatewayCli(process.argv.slice(2));
