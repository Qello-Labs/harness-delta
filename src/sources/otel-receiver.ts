import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { utcNow, type Clock } from '../lifecycle.js';
import { admitOtelRequest, closeOtelProcess, ingestOtelLogs, otelNow, registerOtelProcess, type OtelLaunch } from '../otel-journal.js';
import { decodeLogsRequest, type OtelVersionProfile } from './otel-projection.js';
import type { Store } from '../store.js';

const tokenHeader = 'x-harness-delta-token';
const defaultMaxBodyBytes = 4 * 1024 * 1024;
// Rejected or undecoded bodies are discarded unbuffered up to this ceiling, so exporters receive a
// status instead of a reset connection; beyond it the socket is destroyed.
const drainCeilingBytes = 128 * 1024 * 1024;

/** Internal per-process OTLP http/json receiver. It is not exported from the package entry point,
 * starts no product process and enables no telemetry. It listens only on 127.0.0.1 with an
 * ephemeral port. The token is checked before any body byte is decoded; request headers and
 * bodies are never stored or logged.
 */
export class OtelReceiver {
  private closed = false;

  private constructor(
    private readonly store: Store,
    private readonly processId: string,
    private readonly profile: OtelVersionProfile,
    private readonly clock: Clock,
    private readonly maxBodyBytes: number,
    private readonly token: string,
    private readonly digest: Buffer,
    private readonly server: Server
  ) {}

  static async start(
    store: Store,
    launch: OtelLaunch,
    profile: OtelVersionProfile,
    options: { clock?: Clock; maxBodyBytes?: number } = {}
  ): Promise<OtelReceiver> {
    const clock = options.clock ?? utcNow;
    const maxBodyBytes = options.maxBodyBytes ?? defaultMaxBodyBytes;
    if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > 64 * 1024 * 1024) throw new Error('otel_invalid_limits');
    // Durable linkage precedes listening, and listening precedes any product launch.
    registerOtelProcess(store, launch, profile, otelNow(clock));
    const token = randomBytes(32).toString('base64url');
    const server = createServer();
    const receiver = new OtelReceiver(store, launch.processId, profile, clock, maxBodyBytes, token, digest(token), server);
    server.on('request', (request: IncomingMessage, response: ServerResponse) => receiver.handle(request, response));
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen({ port: 0, host: '127.0.0.1', exclusive: true }, () => {
          server.off('error', reject);
          resolve();
        });
      });
    } catch {
      // Never launched: revoke without claiming an unmeasured product lifetime.
      closeOtelProcess(store, launch.processId, clock, { launched: false });
      throw new Error('otel_listen_failed');
    }
    return receiver;
  }

  get endpoint(): string {
    const address = this.server.address() as AddressInfo;
    return `http://${address.address}:${address.port}`;
  }

  boundAddress(): string {
    return (this.server.address() as AddressInfo).address;
  }

  /** Exporter headers for the launched process's per-invocation settings. Never log them. */
  exporterHeaders(): Readonly<Record<string, string>> {
    return { [tokenHeader]: this.token };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      closeOtelProcess(this.store, this.processId, this.clock);
    } catch {
      /* The store may already be closed. */
    }
    await new Promise<void>(resolve => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    // Rejections drain bytes without buffering or parsing them, then reply.
    const reject = (status: number) => drain(request, () => reply(response, status));
    if (this.closed || !this.authenticated(request)) return reject(401);
    if (request.method !== 'POST') return reject(405);
    const path = request.url?.split('?')[0];
    if (path !== '/v1/logs' && path !== '/v1/metrics' && path !== '/v1/traces') return reject(404);
    let admitted: boolean;
    try {
      admitted = admitOtelRequest(this.store, this.processId, this.clock);
    } catch {
      return reject(503);
    }
    if (!admitted) return reject(403);
    if (path !== '/v1/logs') {
      // Metrics are never added to event totals and traces are configured off: acknowledge undecoded.
      drain(request, () => reply(response, 200, '{}'));
      return;
    }
    const type = request.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
    const encoding = request.headers['content-encoding']?.trim().toLowerCase();
    if (type !== 'application/json' || (encoding !== undefined && encoding !== 'identity')) return reject(415);
    const declared = Number(request.headers['content-length']);
    if (Number.isFinite(declared) && declared > this.maxBodyBytes) return reject(413);
    const chunks: Buffer[] = [];
    let size = 0;
    let oversized = false;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > this.maxBodyBytes) {
        oversized = true;
        chunks.length = 0;
      }
      if (size > drainCeilingBytes) request.destroy();
      if (!oversized) chunks.push(chunk);
    });
    request.on('error', () => {
      chunks.length = 0;
    });
    request.on('end', () => {
      if (oversized) return reply(response, 413);
      // Scope can be revoked while the body uploads; re-check before decoding a single byte.
      let admitted: boolean;
      try {
        admitted = admitOtelRequest(this.store, this.processId, this.clock);
      } catch {
        return reply(response, 503);
      }
      if (!admitted) {
        chunks.length = 0;
        return reply(response, 403);
      }
      let decoded;
      try {
        decoded = decodeLogsRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
      } catch {
        decoded = null;
      }
      chunks.length = 0;
      if (decoded === null) return reply(response, 400);
      let outcome;
      try {
        outcome = ingestOtelLogs(this.store, this.processId, decoded, this.profile, this.clock);
      } catch {
        return reply(response, 503);
      }
      if (outcome === 'committed') reply(response, 200, '{}');
      else reply(response, outcome === 'revoked' ? 403 : 400);
    });
  }

  private authenticated(request: IncomingMessage): boolean {
    const value = request.headers[tokenHeader];
    return typeof value === 'string' && timingSafeEqual(digest(value), this.digest);
  }
}

function drain(request: IncomingMessage, done: () => void): void {
  let size = 0;
  request.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > drainCeilingBytes) request.destroy();
  });
  request.on('end', done);
  request.resume();
}
function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}
function reply(response: ServerResponse, status: number, body = ''): void {
  if (response.headersSent) return;
  response.writeHead(status, body ? { 'content-type': 'application/json' } : {});
  response.end(body);
}
