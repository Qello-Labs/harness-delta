import type { SourceCompatibility } from '../contracts.js';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { IdSchema, TimestampSchema } from '../contracts.js';
import {
  authorizeCandidateScope,
  checkedCandidateScope,
  ingestCandidateObservation,
  isClaudeTraceProductVersion,
  projectCandidateObservation,
  type CandidateScope,
  type ClaudeTraceProductVersion
} from '../nested-candidate.js';
import { toolVersionRecipe } from '../core/tool-version-profiles.js';
import { recordObservationGap, requireActiveScope, putUsageWithEvidence } from '../core/runtime-history.js';
import type { Store } from '../store.js';

const probeRecipe = toolVersionRecipe('claude-internal-probe-02188');
if (probeRecipe.kind !== 'claude_probe') throw new Error('claude_probe_recipe_mismatch');

/** Internal synthetic-qualified Claude OTLP bridge for the exact workflow versions. No shipped profile,
 * native file discovery, product launch or claim of complete trace delivery.
 * Format basis: https://code.claude.com/docs/en/monitoring-usage (mutable).
 */
export interface ClaudeTraceWindow {
  startedAt: string;
  receivedAt: string;
  generation: number;
  synthetic?: boolean | undefined;
  lossStartedAt?: string | undefined;
  /** The launched binary's version; every span must report it. Defaults to the pinned probe version. */
  productVersion?: ClaudeTraceProductVersion | undefined;
  compatibility?: SourceCompatibility | undefined;
}
export interface ClaudeTraceBatchResult {
  requests: number;
  inserted: number;
  excluded: number;
  unattributed: number;
}
const requestHash = (id: string | null) =>
  createHash('sha256')
    .update(JSON.stringify(['offline-nested-candidate-v1', 'synthetic', '1.0.0', id]))
    .digest('hex');
const runtimeHash = (key: string) =>
  createHash('sha256')
    .update(JSON.stringify(['runtime', key]))
    .digest('hex');
const invalid = (): never => {
  throw new Error('claude_trace_invalid_metadata');
};
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const attributes = z.array(z.looseObject({ key: z.string(), value: z.unknown() })).max(128);
const envelopeSchema = z.looseObject({
  resourceSpans: z
    .array(
      z.looseObject({
        resource: z.looseObject({ attributes: attributes.optional() }).optional(),
        scopeSpans: z
          .array(
            z.looseObject({
              spans: z
                .array(
                  z.looseObject({
                    name: z.string(),
                    traceId: z.unknown().optional(),
                    spanId: z.unknown().optional(),
                    startTimeUnixNano: z.unknown().optional(),
                    endTimeUnixNano: z.unknown().optional(),
                    attributes: attributes.optional(),
                    status: z.unknown().optional()
                  })
                )
                .max(512)
            })
          )
          .max(32)
      })
    )
    .max(32)
});
function map(input: { key: string; value: unknown }[] | undefined): Map<string, unknown> {
  const result = new Map<string, unknown>();
  for (const { key, value } of input ?? []) {
    if (result.has(key)) invalid();
    result.set(key, value);
  }
  return result;
}
const valueKinds = ['stringValue', 'boolValue', 'intValue', 'doubleValue', 'arrayValue', 'kvlistValue', 'bytesValue'];
function checkLeaf(value: Record<string, unknown>): void {
  if (valueKinds.filter(k => Object.hasOwn(value, k)).length !== 1) invalid();
}
function text(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!object(value) || typeof value.stringValue !== 'string') return invalid();
  checkLeaf(value);
  return value.stringValue;
}
function integer(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!object(value)) return invalid();
  checkLeaf(value);
  const raw = value.intValue ?? value.doubleValue;
  const n = typeof raw === 'string' && value.intValue !== undefined && /^[0-9]{1,20}$/.test(raw) ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) return invalid();
  return n;
}
function boolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (!object(value) || typeof value.boolValue !== 'boolean') return invalid();
  checkLeaf(value);
  return value.boolValue;
}
function id(value: unknown): string | undefined {
  const raw = text(value);
  if (raw !== undefined && !IdSchema.safeParse(raw).success) invalid();
  return raw;
}
function nanos(value: unknown): bigint {
  if (!(typeof value === 'string' && /^[0-9]{1,20}$/.test(value)) && !(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0))
    return invalid();
  const n = BigInt(value);
  if (n === 0n || n / 1000000n > BigInt(8640000000000000)) invalid();
  return n;
}
function agreed(record: Map<string, unknown>, resource: Map<string, unknown>, key: string): string | undefined {
  const a = id(record.get(key));
  const b = id(resource.get(key));
  if (a !== undefined && b !== undefined && a !== b) invalid();
  return a ?? b;
}
/** Authorization is reusable by a transport before buffering/decoding. */
export function authorizeClaudeTraceScope(
  store: Store,
  input: CandidateScope,
  generation: number,
  synthetic = false,
  compatibility?: SourceCompatibility
): CandidateScope {
  const scope = checkedCandidateScope(input);
  if (scope.sessions.some(s => s.product !== 'claude_code') || !Number.isSafeInteger(generation) || generation < 0) invalid();
  if (!synthetic) authorizeCandidateScope(store, scope, compatibility);
  else {
    if (!store.get('SELECT 1 FROM comparison_workspace_scope')) throw new Error('synthetic_store_required');
    for (const s of scope.sessions) {
      const active = requireActiveScope(store, scope.taskId, s.sessionId);
      const linked = store.get<{ parent_id: string | null; product_version: string }>('SELECT parent_id,product_version FROM sessions WHERE id=?', [
        s.sessionId
      ]);
      if (
        active.project_id !== scope.projectId ||
        active.product !== 'synthetic' ||
        linked?.product_version !== '1.0.0' ||
        linked.parent_id !== s.parentSessionId
      )
        throw new Error('candidate_scope_mismatch');
    }
    if (
      store.get(
        'SELECT 1 FROM observation_runs WHERE task_id=? UNION ALL SELECT 1 FROM otel_processes WHERE task_id=? UNION ALL SELECT 1 FROM sessions WHERE task_id=? AND source_path IS NOT NULL LIMIT 1',
        [scope.taskId, scope.taskId, scope.taskId]
      )
    )
      throw new Error('candidate_mixed_sources');
    for (const row of store.all<{ id: string; source_key: string; request_id: string | null; runtime_id: string | null }>(
      "SELECT e.id,e.source_key,json_extract(r.payload,'$.request_id') AS request_id,json_extract(e.payload,'$.runtime_evidence_id') AS runtime_id FROM events e LEFT JOIN runtime_evidence r ON r.id=json_extract(e.payload,'$.runtime_evidence_id') WHERE e.task_id=? AND json_extract(e.payload,'$.kind')='usage'",
      [scope.taskId]
    )) {
      const key = requestHash(row.request_id);
      if (row.request_id === null || row.id !== key || row.source_key !== key || row.runtime_id !== runtimeHash(key))
        throw new Error('candidate_mixed_sources');
    }
  }
  const task = store.get<{ generation: number }>('SELECT generation FROM tasks WHERE id=?', [scope.taskId]);
  if (task?.generation !== generation) throw new Error('claude_trace_scope_revoked');
  return scope;
}
/** The callback supplies already authorized local OTLP bytes/objects; native
 * logs are never opened. No trace/log usage is combined. Batch conflicts roll
 * back all insertions. Source continuity remains unknown even for an empty batch.
 */
export function ingestClaudeTraceBatch(store: Store, inputScope: CandidateScope, readBody: () => unknown, window: ClaudeTraceWindow): ClaudeTraceBatchResult {
  const expectedVersion = window.productVersion ?? probeRecipe.version;
  if (
    !TimestampSchema.safeParse(window.startedAt).success ||
    !TimestampSchema.safeParse(window.receivedAt).success ||
    Date.parse(window.receivedAt) < Date.parse(window.startedAt) ||
    !(window.compatibility
      ? window.compatibility.product === 'claude_code' &&
        window.compatibility.source === 'claude_workflow' &&
        expectedVersion === window.compatibility.product_version
      : isClaudeTraceProductVersion(expectedVersion))
  )
    invalid();
  const scope = authorizeClaudeTraceScope(store, inputScope, window.generation, window.synthetic, window.compatibility);
  const root = scope.sessions.find(s => s.parentSessionId === null)!;
  const from = BigInt(Date.parse(window.startedAt)) * 1000000n;
  const to = BigInt(Date.parse(window.receivedAt)) * 1000000n;
  return store.immediateTransaction(() => {
    authorizeClaudeTraceScope(store, scope, window.generation, window.synthetic, window.compatibility);
    let raw: unknown;
    try {
      raw = readBody();
    } catch {
      throw new Error('claude_trace_source_error');
    }
    authorizeClaudeTraceScope(store, scope, window.generation, window.synthetic, window.compatibility);
    const parsed = envelopeSchema.safeParse(raw);
    if (!parsed.success) return invalid();
    const result: ClaudeTraceBatchResult = { requests: 0, inserted: 0, excluded: 0, unattributed: 0 };
    const gap = (reason: 'not_available' | 'unknown_parent' | 'offline' | 'incomplete') =>
      recordObservationGap(
        store,
        scope.taskId,
        root.sessionId,
        reason === 'not_available' ? window.startedAt : (window.lossStartedAt ?? window.startedAt),
        window.receivedAt,
        reason,
        window.receivedAt
      );
    gap('not_available'); // No validated trace sequence or terminal watermark.
    let count = 0;
    for (const resourceSpans of parsed.data.resourceSpans) {
      const resource = map(resourceSpans.resource?.attributes);
      for (const scoped of resourceSpans.scopeSpans)
        for (const span of scoped.spans) {
          if (++count > 512) invalid(); // Native exporter default batch size.
          if (span.name !== 'claude_code.llm_request') continue;
          const record = map(span.attributes);
          const processId = agreed(record, resource, 'harness_delta.process_id');
          const nativeSessionId = agreed(record, resource, 'session.id');
          const version = text(record.get('app.version')) ?? text(resource.get('app.version'));
          const resourceVersion = text(resource.get('app.version'));
          if (
            version !== expectedVersion ||
            (resourceVersion !== undefined && resourceVersion !== version) ||
            processId !== root.processId ||
            nativeSessionId !== root.nativeSessionId
          )
            throw new Error('candidate_scope_mismatch');
          for (const [value, length] of [
            [span.traceId, 32],
            [span.spanId, 16]
          ] as const) {
            if (typeof value !== 'string' || value.length !== length || !/^[a-fA-F0-9]+$/.test(value) || /^0+$/.test(value)) invalid();
          }
          const start = nanos(span.startTimeUnixNano);
          if (span.endTimeUnixNano === undefined || span.endTimeUnixNano === '0' || span.endTimeUnixNano === 0) {
            result.unattributed++;
            gap('incomplete');
            continue;
          }
          const end = nanos(span.endTimeUnixNano);
          if (end <= start) invalid();
          if (start < from || end > to) {
            result.excluded++;
            gap('offline');
            continue;
          }
          const agentId = id(record.get('agent_id')) ?? null;
          const parentAgentId = id(record.get('parent_agent_id')) ?? null;
          const mapping = scope.sessions.find(s => s.agentId === agentId);
          if (!mapping) {
            result.unattributed++;
            gap('unknown_parent');
            continue;
          }
          const parent = scope.sessions.find(s => s.sessionId === mapping.parentSessionId);
          if (parentAgentId !== (parent?.agentId ?? null)) throw new Error('candidate_scope_mismatch');
          const success = boolean(record.get('success'));
          const attempt = integer(record.get('attempt'));
          const status = span.status;
          if (status !== undefined && (!object(status) || (status.code !== undefined && (typeof status.code !== 'number' || ![0, 1, 2].includes(status.code)))))
            return invalid();
          const failed = object(status) && status.code === 2;
          if (success !== true || attempt !== 1 || failed) {
            result.unattributed++;
            gap('incomplete');
            continue;
          }
          const requestId = id(record.get('request_id'));
          if (requestId === undefined) {
            result.unattributed++;
            gap('incomplete');
            continue;
          }
          const metadata = {
            kind: 'claude_trace',
            productVersion: version,
            processId,
            nativeSessionId,
            occurredAt: new Date(Number(end / 1000000n)).toISOString(),
            completed: true,
            span: {
              name: span.name,
              agent_id: agentId,
              parent_agent_id: parentAgentId,
              success,
              attempt,
              request_id: requestId,
              client_request_id: id(record.get('client_request_id')),
              model: text(record.get('model')),
              effort: id(record.get('effort')),
              input_tokens: integer(record.get('input_tokens')),
              output_tokens: integer(record.get('output_tokens')),
              cache_read_tokens: integer(record.get('cache_read_tokens')),
              cache_creation_tokens: integer(record.get('cache_creation_tokens'))
            }
          };
          const projected = window.synthetic
            ? projectCandidateObservation(scope, mapping.sourceId, metadata, window.receivedAt, window.compatibility)
            : ingestCandidateObservation(store, scope, mapping.sourceId, () => metadata, window.receivedAt, window.compatibility);
          let syntheticInserted = false;
          if (window.synthetic && projected.kind === 'usage') {
            const key = requestHash(projected.runtime.request_id);
            const runtimeId = runtimeHash(key);
            syntheticInserted = putUsageWithEvidence(
              store,
              {
                ...projected.event,
                id: key,
                source_key: key,
                payload: { ...projected.event.payload, product: 'synthetic', product_version: '1.0.0', runtime_evidence_id: runtimeId }
              },
              { ...projected.runtime, id: runtimeId, product: 'synthetic', product_version: '1.0.0' }
            );
          }
          if (projected.kind === 'usage') {
            result.requests++;
            if (syntheticInserted || ('inserted' in projected && projected.inserted)) result.inserted++;
          } else {
            result.unattributed++;
            gap('incomplete');
          }
        }
    }
    return result;
  });
}
