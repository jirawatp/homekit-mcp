import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';
import type { BridgeCommand, BridgeTransport } from './bridge.js';
import { BridgeError } from './bridge.js';

interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
export class NativeTransport implements BridgeTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, Pending>();
  private readonly decoder = new StringDecoder('utf8');
  private readonly exited: Promise<void>;
  private buffer = '';
  private closed = false;
  private killTimer?: NodeJS.Timeout;

  constructor(executable: string, configPath: string, private readonly timeoutMs = 10_000) {
    if (!isAbsolute(executable) || !isAbsolute(configPath)) throw new BridgeError('ABSOLUTE_PATH_REQUIRED');
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', '__CF_USER_TEXT_ENCODING']) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    this.child = spawn(executable, ['--stdio', '--config', configPath], { env, stdio: 'pipe' });
    this.exited = new Promise(done => { this.child.once('exit', () => done()); this.child.once('error', () => done()); });
    this.child.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    // Never forward helper stderr; it may contain household names or OS diagnostics.
    this.child.stderr.on('data', () => {});
    this.child.stdin.on('error', () => this.fail('BRIDGE_IO_ERROR'));
    this.child.on('error', () => this.fail('BRIDGE_START_FAILED'));
    this.child.on('exit', () => { if (this.killTimer) clearTimeout(this.killTimer); this.fail('BRIDGE_EXITED'); });
  }

  private onData(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    if (Buffer.byteLength(this.buffer, 'utf8') > 1024 * 1024) { this.fail('BRIDGE_FRAME_TOO_LARGE'); return; }
    for (;;) {
      const end = this.buffer.indexOf('\n');
      if (end < 0) break;
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      try {
        const response: unknown = JSON.parse(line);
        if (!response || typeof response !== 'object') throw new Error();
        const record = response as Record<string, unknown>;
        if (typeof record.id !== 'string' || typeof record.ok !== 'boolean') throw new Error();
        const request = this.pending.get(record.id);
        if (!request) throw new Error();
        clearTimeout(request.timer);
        this.pending.delete(record.id);
        if (record.ok) request.resolve(record.result);
        else {
          const error = record.error as { code?: unknown } | undefined;
          const code = typeof error?.code === 'string' && ['access_disabled', 'homekit_unauthorized',
            'homekit_not_ready', 'accessory_not_allowed', 'accessory_unavailable', 'unsupported_command'].includes(error.code)
            ? error.code.toUpperCase() : 'NATIVE_REQUEST_FAILED';
          request.reject(new BridgeError(code));
        }
      } catch { this.fail('BRIDGE_PROTOCOL_ERROR'); return; }
    }
  }

  private fail(code: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new BridgeError(code)); }
    this.pending.clear();
    this.child.stdin.destroy(); this.child.stdout.destroy(); this.child.stderr.destroy();
    if (this.child.pid !== undefined && this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill('SIGTERM');
      this.killTimer = setTimeout(() => this.child.kill('SIGKILL'), 1000);
    }
  }

  request(command: BridgeCommand, accessoryId?: string): Promise<unknown> {
    if (this.closed) return Promise.reject(new BridgeError('BRIDGE_CLOSED'));
    if (this.pending.size >= 1) return Promise.reject(new BridgeError('BRIDGE_BUSY'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail('BRIDGE_TIMEOUT'), this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, command, ...(accessoryId ? { accessoryId } : {}) }) + '\n');
    });
  }

  async close(): Promise<void> { this.fail('BRIDGE_CLOSED'); await this.exited; }
}
