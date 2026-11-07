import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { TimestampSchema } from '../contracts.js';
import { utcNow, type Clock } from '../core/lifecycle.js';
import { authorizeClaudeTraceScope, ingestClaudeTraceBatch } from './claude-trace-candidate.js';
import type { CandidateScope } from '../nested-candidate.js';
import type { Store } from '../store.js';

const tokenHeader = 'x-harness-delta-token';
const drainLimit = 128 * 1024 * 1024;
const digest = (s: string) => createHash('sha256').update(s).digest();
/** Internal candidate transport, verified only with synthetic HTTP. Not exported
 * or wired to a product launcher. No exporter/settings/authentication configuration
 * is read or changed. Token authentication establishes only this receiver boundary,
 * not native product identity or completeness. Production receiver remains separate.
 */
export class ClaudeTraceCandidateReceiver {
  private closed = false;
  private readonly token = randomBytes(32).toString('base64url');
  private readonly digest = digest(this.token);
  private constructor(
    private readonly store: Store,
    private readonly scope: CandidateScope,
    private readonly generation: number,
    private readonly startedAt: string,
    private readonly clock: Clock,
    private readonly maxBodyBytes: number,
    private readonly server: Server
  ) {}

  static async start(store: Store, input: CandidateScope, options: { clock?: Clock; maxBodyBytes?: number } = {}): Promise<ClaudeTraceCandidateReceiver> {
    const clock = options.clock ?? utcNow;
    const startedAt = TimestampSchema.parse(clock());
    const maxBodyBytes = options.maxBodyBytes ?? 4 * 1024 * 1024;
    if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > 4 * 1024 * 1024) throw new Error('claude_trace_invalid_limits');
    const generation = store.get<{ generation: number }>('SELECT generation FROM tasks WHERE id=?', [input.taskId])?.generation;
    if (generation === undefined) throw new Error('claude_trace_scope_revoked');
    const scope = authorizeClaudeTraceScope(store, input, generation);
    const server = createServer();
    server.requestTimeout = 10000;
    server.headersTimeout = 10000;
    const receiver = new ClaudeTraceCandidateReceiver(store, scope, generation, startedAt, clock, maxBodyBytes, server);
    server.on('request', (request, response) => receiver.handle(request, response));
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen({ port: 0, host: '127.0.0.1', exclusive: true }, () => {
          server.off('error', reject);
          resolve();
        });
      });
    } catch {
      throw new Error('claude_trace_listen_failed');
    }
    return receiver;
  }
  get endpoint(): string {
    const address = this.server.address() as AddressInfo;
    return `http://${address.address}:${address.port}`;
  }
  /** Internal per-process exporter token; never persist or log it. */
  exporterHeaders(): Readonly<Record<string, string>> {
    return { [tokenHeader]: this.token };
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await new Promise<void>(resolve => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }
  private authorized(): boolean {
    if (this.closed) return false;
    try {
      authorizeClaudeTraceScope(this.store, this.scope, this.generation);
      return true;
    } catch {
      return false;
    }
  }
  private handle(request: IncomingMessage, response: ServerResponse): void {
    const reject = (status: number) => drain(request, () => reply(response, status));
    const token = request.headers[tokenHeader];
    if (this.closed || typeof token !== 'string' || !timingSafeEqual(digest(token), this.digest)) return reject(401);
    if (!this.authorized()) return reject(403); // Before body buffering or JSON decoding.
    if (request.method !== 'POST') return reject(405);
    if (request.url !== '/v1/traces') return reject(404);
    if (
      request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json' ||
      (request.headers['content-encoding'] !== undefined && request.headers['content-encoding'] !== 'identity')
    )
      return reject(415);
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
      if (size > drainLimit) request.destroy();
      if (!oversized) chunks.push(chunk);
    });
    request.on('error', () => {
      chunks.length = 0;
    });
    request.on('end', () => {
      if (!this.authorized()) {
        chunks.length = 0;
        reply(response, 403);
        return;
      }
      if (oversized) {
        reply(response, 413);
        return;
      }
      try {
        ingestClaudeTraceBatch(this.store, this.scope, () => JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown, {
          startedAt: this.startedAt,
          receivedAt: this.clock(),
          generation: this.generation
        });
        reply(response, 200, '{}');
      } catch (error) {
        // Only fixed internal classifications escape. No SQLite/producer details.
        const code = error instanceof Error ? error.message : '';
        reply(response, code.startsWith('candidate_') || code.startsWith('claude_trace_') ? 400 : 503);
      } finally {
        chunks.length = 0;
      }
    });
  }
}
function drain(request: IncomingMessage, done: () => void): void {
  let size = 0;
  request.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > drainLimit) request.destroy();
  });
  request.on('end', done);
  request.resume();
}
function reply(response: ServerResponse, status: number, body = ''): void {
  if (response.headersSent) return;
  response.writeHead(status, body ? { 'content-type': 'application/json' } : {});
  response.end(body);
}
