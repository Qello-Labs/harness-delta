import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { claudeProbeHookEvents, ClaudeProbeHookFailure, type ClaudeProbeHookEvent } from './claude-probe-coordinator.js';
import type { AddressInfo } from 'node:net';

const failureCategories = [
  'claude_probe_child_limit',
  'claude_probe_child_scope',
  'claude_probe_configuration_changed',
  'claude_probe_content_enabled',
  'claude_probe_deadline',
  'claude_probe_hook_scope',
  'claude_probe_invalid_json',
  'claude_probe_invalid_logs',
  'claude_probe_invalid_traces',
  'claude_probe_log_conflict',
  'claude_probe_log_gap',
  'claude_probe_log_limit',
  'claude_probe_log_scope',
  'claude_probe_not_ready',
  'claude_probe_not_started',
  'claude_probe_policy_override',
  'claude_probe_request_boundary',
  'claude_probe_request_conflict',
  'claude_probe_reservation_failed',
  'claude_probe_restart',
  'claude_probe_revoked',
  'claude_probe_source_error',
  'claude_trace_scope_revoked'
] as const;
type ProbeRoute = 'hooks' | 'logs' | 'traces' | null;
export interface ClaudeProbeStopDiagnostic {
  readonly reason: 'deadline' | 'revoked' | 'metadata';
  readonly route: ProbeRoute;
  readonly category: (typeof failureCategories)[number] | 'invalid_json' | 'unknown';
  readonly hook_event?: ClaudeProbeHookEvent;
}
function failureCategory(error: unknown): ClaudeProbeStopDiagnostic['category'] {
  // Return static enum values only, never message/cause/body/unknown metadata.
  try {
    if (error instanceof SyntaxError) return 'invalid_json';
    return error instanceof Error ? (failureCategories.find(code => code === error.message) ?? 'unknown') : 'unknown';
  } catch {
    return 'unknown';
  }
}
function routeOf(path: string | undefined): ProbeRoute {
  return path === '/v1/hooks' ? 'hooks' : path === '/v1/logs' ? 'logs' : path === '/v1/traces' ? 'traces' : null;
}

export interface ClaudeProbeGatewayCoordinator {
  exporterHeaders(): Readonly<Record<string, string>>;
  authorizeRequest(token: string): void;
  authorizeTraceRequest(token: string): void;
  acceptHook(token: string, read: () => unknown): void;
  ingestLogs(token: string, read: () => unknown): unknown;
  ingestTraces(token: string, read: () => unknown): unknown;
  revoke(): void;
}
/** Candidate-only transport. Never launches a product, opens transcripts, or
 * registers an OTel usage owner. One coordinator owns hook binding and trace usage;
 * its log handler owns ordering/policy metadata only.
 */
export async function startClaudeProbeGateway(
  coordinator: ClaudeProbeGatewayCoordinator,
  options: {
    maxBodyBytes?: number;
    durationMs?: number;
    onStop?: (reason: 'deadline' | 'revoked' | 'metadata', diagnostic: ClaudeProbeStopDiagnostic) => void;
  } = {}
) {
  const maxBodyBytes = options.maxBodyBytes ?? 4 * 1024 * 1024;
  const durationMs = options.durationMs ?? 120000;
  if (
    !Number.isSafeInteger(maxBodyBytes) ||
    maxBodyBytes < 1 ||
    maxBodyBytes > 4 * 1024 * 1024 ||
    !Number.isSafeInteger(durationMs) ||
    durationMs < 1 ||
    durationMs > 3600000
  )
    throw new Error('claude_probe_gateway_invalid_limits');
  const header = 'x-harness-delta-token';
  const initialToken = coordinator.exporterHeaders()[header];
  if (typeof initialToken !== 'string') throw new Error('claude_probe_gateway_invalid_token');
  coordinator.authorizeRequest(initialToken); // Scope precedes listening.
  let closed = false;
  let stopped = false;
  const stop = (reason: ClaudeProbeStopDiagnostic['reason'], route: ProbeRoute = null, error?: unknown) => {
    if (stopped) return;
    stopped = true;
    coordinator.revoke();
    const hookEvent = route === 'hooks' && error instanceof ClaudeProbeHookFailure ? claudeProbeHookEvents.find(name => name === error.hookEvent) : undefined;
    const diagnostic: ClaudeProbeStopDiagnostic = Object.freeze({
      reason,
      route,
      category: reason === 'deadline' ? 'claude_probe_deadline' : failureCategory(error),
      ...(hookEvent !== undefined ? { hook_event: hookEvent } : {})
    });
    try {
      options.onStop?.(reason, diagnostic);
    } catch {
      /* Never expose caller errors or raw paths. */
    }
  };
  const server = createServer();
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;
  const authorized = (token: string, route: ProbeRoute) => {
    if (closed) return false;
    try {
      coordinator.authorizeRequest(token);
      return true;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'claude_probe_unauthorized') stop('revoked', route, error);
      return false;
    }
  };
  const traceRejection = (token: string): number | null => {
    try {
      coordinator.authorizeTraceRequest(token);
      return null;
    } catch (error) {
      // Transient: the pinned native OTLP exporter retries 503 but silently drops a 409 batch.
      if (error instanceof Error && error.message === 'claude_probe_not_ready') return 503;
      if (error instanceof Error && error.message === 'claude_probe_unauthorized') return 401;
      stop('revoked', 'traces', error);
      return 403;
    }
  };
  server.on('request', (request: IncomingMessage, response: ServerResponse) => {
    const reply = (status: number, body = '') => {
      if (response.headersSent) return;
      response.writeHead(status, body ? { 'content-type': 'application/json' } : {});
      response.end(body);
    };
    const reject = (status: number) => {
      let discarded = 0;
      request.on('data', (chunk: Buffer) => {
        discarded += chunk.length;
        if (discarded > 8 * 1024 * 1024) request.destroy();
      });
      request.on('error', () => {
        /* Rejected content is never buffered or decoded. */
      });
      reply(status);
      request.resume();
    };
    const token = request.headers[header];
    if (typeof token !== 'string') return reject(401);
    // Coordinator authentication/active generation occurs before data listeners.
    try {
      coordinator.authorizeRequest(token);
    } catch (error) {
      const wrong = error instanceof Error && error.message === 'claude_probe_unauthorized';
      if (!wrong) stop('revoked', routeOf(request.url), error);
      return reject(wrong ? 401 : 403);
    }
    if (closed) return reject(403);
    if (request.method !== 'POST') return reject(405);
    const path = request.url;
    if (path !== '/v1/hooks' && path !== '/v1/logs' && path !== '/v1/traces') return reject(404);
    if (path === '/v1/traces') {
      const status = traceRejection(token);
      if (status !== null) return reject(status);
    }
    if (
      request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json' ||
      (request.headers['content-encoding'] !== undefined && request.headers['content-encoding'] !== 'identity')
    )
      return reject(415);
    const declared = Number(request.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBodyBytes) return reject(413);
    const chunks: Buffer[] = [];
    let size = 0;
    let oversized = false;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        oversized = true;
        chunks.length = 0;
      }
      if (!oversized) chunks.push(chunk);
      if (size > 8 * 1024 * 1024) request.destroy();
    });
    request.on('error', () => {
      chunks.length = 0;
    });
    request.on('end', () => {
      if (!authorized(token, routeOf(path))) {
        chunks.length = 0;
        reply(403);
        return;
      }
      if (path === '/v1/traces') {
        const status = traceRejection(token);
        if (status !== null) {
          chunks.length = 0;
          reply(status);
          return;
        }
      }
      if (oversized) {
        reply(413);
        return;
      }
      const read = () => JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
      try {
        if (path === '/v1/hooks') coordinator.acceptHook(token, read);
        else if (path === '/v1/logs') coordinator.ingestLogs(token, read);
        else coordinator.ingestTraces(token, read);
        if (!authorized(token, routeOf(path))) reply(403);
        else reply(200, '{}');
      } catch (error) {
        stop('metadata', routeOf(path), error);
        reply(400);
      } finally {
        chunks.length = 0;
      }
    });
  });
  const close = async () => {
    if (closed) return;
    closed = true;
    clearTimeout(deadline);
    coordinator.revoke();
    await new Promise<void>(resolve => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  };
  const deadline = setTimeout(() => {
    stop('deadline');
    void close();
  }, durationMs);
  deadline.unref();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ port: 0, host: '127.0.0.1', exclusive: true }, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch {
    clearTimeout(deadline);
    coordinator.revoke();
    throw new Error('claude_probe_gateway_listen_failed');
  }
  const address = server.address() as AddressInfo;
  return { endpoint: `http://127.0.0.1:${address.port}`, close };
}
