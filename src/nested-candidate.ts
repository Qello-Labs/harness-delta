import type { SourceCompatibility } from './contracts.js';
import { assertCompatibilityAllowed, resolveSourceCompatibility } from './source-compatibility.js';
import { codexBindingAdmission } from './codex-binding-admission.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { addTokens, IdSchema, ModelSchema, TimestampSchema, TokenSchema, type Reading } from './contracts.js';
import { CostCoverageEvidenceSchema, CostFactsSchema, EventV2Schema, RuntimeEvidenceSchema, type CostCoverageEvidence, type EventV2, type RuntimeEvidence } from './flexible-contracts.js';
import { putUsageWithEvidence, requireActiveScope } from './runtime-history.js';
import type { Store } from './store.js';
import { claudeProbeProductVersion, claudeWorkflowProductVersions, type ClaudeWorkflowProductVersion } from './claude-workflow-versions.js';

/** Internal OFFLINE candidate only. Inputs are predecoded metadata, never raw OTLP,
 * native rollout discovery or source authorization derived from session contents.
 * Codex source: openai/codex a956835d020762cb2b570053af06f643a11c0ecc,
 * protocol/src/protocol.rs TokenUsageRecord, SessionMeta and TurnContextItem;
 * core/src/session/mod.rs record_observed_response_completed (best effort).
 * Claude source: https://code.claude.com/docs/en/monitoring-usage (mutable).
 * Claude traces use the exact workflow versions in claude-workflow-versions.ts; only the
 * versions with a production registry entry are admitted (see validation docs).
 * This module is deliberately absent from index.ts and production defaults.
 */
/** Versions a Claude trace may carry: the pinned probe version plus the workflow list, read at call time. */
export type ClaudeTraceProductVersion = ClaudeWorkflowProductVersion;
export function claudeTraceProductVersions(): readonly ClaudeTraceProductVersion[] {
  return [...new Set<ClaudeTraceProductVersion>([claudeProbeProductVersion, ...claudeWorkflowProductVersions])];
}
export function isClaudeTraceProductVersion(value: unknown): value is ClaudeTraceProductVersion {
  return value === claudeProbeProductVersion || (claudeWorkflowProductVersions as readonly unknown[]).includes(value);
}
const mappingSchema = z.strictObject({
  sessionId: IdSchema, rootSessionId: IdSchema, parentSessionId: IdSchema.nullable(), sourceId: IdSchema,
  product: z.enum(['codex', 'claude_code']), nativeSessionId: IdSchema,
  processId: IdSchema.nullable(), agentId: IdSchema.nullable(),
});
const scopeSchema = z.strictObject({ projectId: IdSchema, taskId: IdSchema,
  allowedRootTurnIds: z.array(IdSchema).min(1).max(64), sessions: z.array(mappingSchema).min(1).max(32) });
export type CandidateScope = z.infer<typeof scopeSchema>;
type Mapping = CandidateScope['sessions'][number];
export type CandidateProjection = { kind: 'usage'; event: EventV2; runtime: RuntimeEvidence }
  | { kind: 'ignored'; reason: 'ancestor_copy' }
  | { kind: 'unattributed'; reason: 'missing_usage' | 'missing_runtime' | 'unsupported_history' | 'incomplete_request' | 'trace_identity_required' };
function parse<T>(schema: z.ZodType<T>, input: unknown, reason = 'candidate_invalid_metadata'): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new Error(reason);
  return result.data;
}
export function checkedCandidateScope(input: CandidateScope): CandidateScope {
  const scope = parse(scopeSchema, input, 'candidate_invalid_mapping');
  const sessions = new Map(scope.sessions.map(s => [s.sessionId, s]));
  const sources = new Set(scope.sessions.map(s => s.sourceId));
  if (sessions.size !== scope.sessions.length || sources.size !== scope.sessions.length ||
    new Set(scope.allowedRootTurnIds).size !== scope.allowedRootTurnIds.length) throw new Error('candidate_invalid_mapping');
  const roots = scope.sessions.filter(s => s.parentSessionId === null);
  if (roots.length !== 1) throw new Error('candidate_invalid_mapping');
  const root = roots[0]!;
  const nativeIdentities = new Set<string>();
  for (const s of scope.sessions) {
    if (s.rootSessionId !== root.sessionId || s.product !== root.product ||
      (s.product === 'codex' && (s.processId !== null || s.agentId !== null)) ||
      (s.product === 'claude_code' && (s.processId === null || s.processId !== root.processId ||
        s.nativeSessionId !== root.nativeSessionId || (s.parentSessionId === null ? s.agentId !== null : s.agentId === null)))) {
      throw new Error('candidate_invalid_mapping');
    }
    const native = JSON.stringify([s.nativeSessionId, s.agentId]);
    if (nativeIdentities.has(native)) throw new Error('candidate_invalid_mapping');
    nativeIdentities.add(native);
    const seen = new Set<string>(); let current: Mapping | undefined = s;
    while (current?.parentSessionId !== null) {
      if (!current || seen.has(current.sessionId)) throw new Error('candidate_invalid_mapping');
      seen.add(current.sessionId); current = sessions.get(current.parentSessionId);
    }
    if (!current || current.sessionId !== root.sessionId) throw new Error('candidate_invalid_mapping');
  }
  return scope;
}
function sourceMapping(scope: CandidateScope, sourceId: string): Mapping {
  const mapping = scope.sessions.find(s => s.sourceId === sourceId);
  if (!mapping) throw new Error('candidate_scope_mismatch');
  return mapping;
}
const optionalId = IdSchema.nullish();
const tokensSchema = z.object({ input_tokens: TokenSchema, cached_input_tokens: TokenSchema,
  // Pinned 0.160 serde(default) only: absence is zero, null/malformed is invalid.
  cache_write_input_tokens: TokenSchema.default(0), output_tokens: TokenSchema,
  reasoning_output_tokens: TokenSchema, total_tokens: TokenSchema });
const codexSchema = z.object({ kind: z.literal('codex_response'), occurredAt: TimestampSchema,
  sessionMeta: z.object({ id: IdSchema, session_id: IdSchema, cli_version: z.string(),
    parent_thread_id: optionalId, source: z.union([z.enum(['cli', 'exec', 'vscode', 'mcp']),
      z.object({ subagent: z.object({ thread_spawn: z.object({ parent_thread_id: IdSchema, depth: z.number().int().positive() }) }) })]),
    forked_from_id: optionalId, forked_from_ordinal_exclusive: TokenSchema.nullish(), history_base: z.unknown().optional(),
    subagent_history_start_ordinal: TokenSchema.nullish(), history_mode: z.enum(['legacy', 'paginated']).optional() }),
  recordOrdinal: TokenSchema.optional(),
  turnContext: z.object({ turn_id: IdSchema, root_turn_id: optionalId, model: ModelSchema, effort: optionalId }).nullish(),
  record: z.object({ thread_id: IdSchema, turn_id: IdSchema, session_id: IdSchema, root_turn_id: IdSchema,
    response_id: IdSchema, usage: tokensSchema.nullish() }).nullish(),
});
const claudeUsageSchema = z.object({ model: ModelSchema, effort: optionalId, request_id: IdSchema,
  client_request_id: optionalId, input_tokens: TokenSchema.nullish(), cache_read_tokens: TokenSchema.nullish(),
  cache_creation_tokens: TokenSchema.nullish(), output_tokens: TokenSchema.nullish() });
const claudeSchema = z.object({ kind: z.literal('claude_trace'), productVersion: z.string(),
  processId: IdSchema, nativeSessionId: IdSchema, occurredAt: TimestampSchema, completed: z.boolean(),
  span: claudeUsageSchema.extend({ name: z.literal('claude_code.llm_request'), agent_id: optionalId, parent_agent_id: optionalId,
    success: z.boolean(), attempt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }),
  // Logs have no documented agent_id. Correlation uses the mapped trace identity.
  correlatedLog: claudeUsageSchema.extend({ eventName: z.literal('claude_code.api_request') }).optional(),
});
const kindSchema = z.object({ kind: z.enum(['codex_response', 'claude_trace', 'claude_api_log']) });
const hash = (parts: readonly unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const observed = (value: number): Reading => ({ status: 'observed', value, reason: null });
const missing = (): Reading => ({ status: 'missing', value: null, reason: 'not_available' });
function checkedSum(values: readonly number[]): number {
  try { return addTokens(values); } catch { throw new Error('candidate_invalid_metadata'); }
}
function usageProjection(scope: CandidateScope, mapping: Mapping, version: string, at: string, recordedAt: string,
  requestId: string, turnId: string | null, model: string, effort: string | null,
  boundaryIdentity: readonly unknown[], readings: { input: Reading; cache: Reading; output: Reading; reasoning: Reading },
  components: EventV2['payload']['billing_components']): CandidateProjection {
  // Provider response/request IDs are globally keyed per product/version, deliberately
  // WITHOUT local task/session/source prefixes. Cross-thread collisions fail closed; the
  // same Claude request ID under another workflow version is refused in ingestCandidateObservation.
  const key = hash(['offline-nested-candidate-v1', mapping.product, version, requestId]);
  const runtime = parse(RuntimeEvidenceSchema, { id: hash(['runtime', key]), task_id: scope.taskId,
    session_id: mapping.sessionId, turn_id: turnId, request_id: requestId, model, effort,
    product: mapping.product, product_version: version, source: 'product_log', occurred_at: at,
    recorded_at: recordedAt, boundary: 'request' });
  const event = parse(EventV2Schema, { id: key, source_key: key, project_id: scope.projectId,
    task_id: scope.taskId, session_id: mapping.sessionId, occurred_at: at, payload: {
      schema_version: 2, kind: 'usage', input_total: readings.input, cached_input: readings.cache,
      output_total: readings.output, reasoning_output: readings.reasoning, product: mapping.product,
      product_version: version, model, epoch: hash(boundaryIdentity), runtime_evidence_id: runtime.id,
      attribution: 'verified', billing_components: components } });
  return { kind: 'usage', event, runtime };
}
function projectCodex(scope: CandidateScope, mapping: Mapping, input: unknown, recordedAt: string, compatibility?: SourceCompatibility): CandidateProjection {
  const data = parse(codexSchema, input); const meta = data.sessionMeta;
  if(meta.cli_version!==(compatibility?.product_version??'0.160.0'))throw new Error('candidate_invalid_metadata');
  const root = scope.sessions.find(s => s.sessionId === mapping.rootSessionId)!;
  const parent = scope.sessions.find(s => s.sessionId === mapping.parentSessionId);
  if (meta.id !== mapping.nativeSessionId || meta.session_id !== root.nativeSessionId ||
    (meta.parent_thread_id ?? null) !== (parent?.nativeSessionId ?? null) ||
    (parent ? typeof meta.source === 'string' || meta.source.subagent.thread_spawn.parent_thread_id !== parent.nativeSessionId
      : typeof meta.source !== 'string')) throw new Error('candidate_scope_mismatch');
  if (parent && typeof meta.source !== 'string') {
    let depth = 0; let ancestor: Mapping | undefined = mapping;
    while (ancestor?.parentSessionId != null) { depth++; ancestor = scope.sessions.find(s => s.sessionId === ancestor?.parentSessionId); }
    if (meta.source.subagent.thread_spawn.depth !== depth) throw new Error('candidate_scope_mismatch');
  }
  if (meta.forked_from_id != null || meta.forked_from_ordinal_exclusive != null || meta.history_base != null ||
    meta.subagent_history_start_ordinal != null) {
    // Only an explicit paginated direct-child suffix is qualified. Keep native
    // markers intact: caller must supply the real record ordinal, not strip history.
    const base = z.object({ thread_id: IdSchema, end_ordinal_exclusive: TokenSchema, end_byte_offset: TokenSchema }).safeParse(meta.history_base);
    if (!parent || parent.parentSessionId !== null || meta.history_mode !== 'paginated' ||
      meta.forked_from_id !== parent.nativeSessionId || meta.forked_from_ordinal_exclusive == null ||
      meta.subagent_history_start_ordinal == null || data.recordOrdinal == null ||
      data.recordOrdinal < meta.subagent_history_start_ordinal ||
      meta.subagent_history_start_ordinal < meta.forked_from_ordinal_exclusive ||
      !base.success || base.data.thread_id !== parent.nativeSessionId ||
      base.data.end_ordinal_exclusive !== meta.forked_from_ordinal_exclusive) {
      return { kind: 'unattributed', reason: 'unsupported_history' };
    }
  }
  const record = data.record;
  if (!record) return { kind: 'unattributed', reason: 'missing_usage' };
  if (record.session_id !== root.nativeSessionId || !scope.allowedRootTurnIds.includes(record.root_turn_id)) throw new Error('candidate_scope_mismatch');
  if (record.thread_id !== mapping.nativeSessionId) {
    let ancestor = parent;
    while (ancestor) {
      if (ancestor.nativeSessionId === record.thread_id) return { kind: 'ignored', reason: 'ancestor_copy' };
      ancestor = scope.sessions.find(s => s.sessionId === ancestor?.parentSessionId);
    }
    throw new Error('candidate_scope_mismatch');
  }
  const turn = data.turnContext;
  if (!turn) return { kind: 'unattributed', reason: 'missing_runtime' };
  if (turn.turn_id !== record.turn_id || (parent ? turn.root_turn_id !== record.root_turn_id
    : record.root_turn_id !== record.turn_id || turn.root_turn_id != null && turn.root_turn_id !== record.root_turn_id)) throw new Error('candidate_scope_mismatch');
  const usage = record.usage;
  if (!usage) return { kind: 'unattributed', reason: 'missing_usage' };
  const cached = checkedSum([usage.cached_input_tokens, usage.cache_write_input_tokens]);
  if (cached > usage.input_tokens || usage.reasoning_output_tokens > usage.output_tokens ||
    checkedSum([usage.input_tokens, usage.output_tokens]) !== usage.total_tokens) throw new Error('candidate_invalid_metadata');
  return usageProjection(scope, mapping, meta.cli_version, data.occurredAt, recordedAt, record.response_id, record.turn_id,
    turn.model, turn.effort ?? null, [record.session_id, record.turn_id, record.root_turn_id],
    { input: observed(usage.input_tokens), cache: observed(usage.cached_input_tokens), output: observed(usage.output_tokens), reasoning: observed(usage.reasoning_output_tokens) },
    [{ kind: 'ordinary_input', reading: observed(usage.input_tokens - cached) }, { kind: 'cache_read', reading: observed(usage.cached_input_tokens) },
      { kind: 'cache_write', reading: observed(usage.cache_write_input_tokens) }, { kind: 'output', reading: observed(usage.output_tokens) }]);
}
function projectClaude(scope: CandidateScope, mapping: Mapping, input: unknown, recordedAt: string, compatibility?: SourceCompatibility): CandidateProjection {
  const data = parse(claudeSchema, input); const span = data.span;
  if(compatibility?data.productVersion!==compatibility.product_version:!isClaudeTraceProductVersion(data.productVersion))throw new Error('candidate_invalid_metadata');
  const parent = scope.sessions.find(s => s.sessionId === mapping.parentSessionId);
  if (data.processId !== mapping.processId || data.nativeSessionId !== mapping.nativeSessionId ||
    (span.agent_id ?? null) !== mapping.agentId || (span.parent_agent_id ?? null) !== (parent?.agentId ?? null)) throw new Error('candidate_scope_mismatch');
  if (!data.completed || !span.success || span.attempt !== 1) return { kind: 'unattributed', reason: 'incomplete_request' };
  if (data.correlatedLog) {
    const log = data.correlatedLog;
    for (const key of ['model', 'request_id', 'client_request_id', 'input_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'output_tokens'] as const) {
      if (key === 'client_request_id' && (log[key] == null || span[key] == null)) continue;
      if ((log[key] ?? null) !== (span[key] ?? null)) throw new Error('candidate_conflict');
    }
    if (log.effort != null && log.effort !== span.effort) throw new Error('candidate_conflict');
  }
  const inputs = [span.input_tokens, span.cache_read_tokens, span.cache_creation_tokens];
  const inputReading = inputs.every((v): v is number => v != null) ? observed(checkedSum(inputs)) : missing();
  const reading = (value: number | null | undefined) => value == null ? missing() : observed(value);
  return usageProjection(scope, mapping, data.productVersion, data.occurredAt, recordedAt, span.request_id, null,
    span.model, span.effort ?? null, [data.processId, data.nativeSessionId, span.client_request_id],
    { input: inputReading, cache: reading(span.cache_read_tokens), output: reading(span.output_tokens), reasoning: missing() },
    [{ kind: 'ordinary_input', reading: reading(span.input_tokens) }, { kind: 'cache_read', reading: reading(span.cache_read_tokens) },
      { kind: 'cache_write', reading: reading(span.cache_creation_tokens) }, { kind: 'output', reading: reading(span.output_tokens) }]);
}
export function projectCandidateObservation(inputScope: CandidateScope, sourceId: string, metadata: unknown, recordedAt: string, compatibility?: SourceCompatibility): CandidateProjection {
  const scope = checkedCandidateScope(inputScope); const mapping = sourceMapping(scope, sourceId);
  if(compatibility)checkWorkflowCompatibility(scope,compatibility);
  parse(TimestampSchema, recordedAt);
  const kind = parse(kindSchema, metadata).kind;
  if (kind === 'claude_api_log' && mapping.product === 'claude_code') return { kind: 'unattributed', reason: 'trace_identity_required' };
  if (kind === 'codex_response' && mapping.product === 'codex') return projectCodex(scope, mapping, metadata, recordedAt,compatibility);
  if (kind === 'claude_trace' && mapping.product === 'claude_code') return projectClaude(scope, mapping, metadata, recordedAt,compatibility);
  throw new Error('candidate_scope_mismatch');
}
function checkWorkflowCompatibility(scope:CandidateScope,compatibility:SourceCompatibility):void {
  const source=compatibility.source==='codex_binding'?'codex_binding':scope.sessions[0]?.product==='codex'?'codex_workflow':'claude_workflow';
  const resolved=resolveSourceCompatibility(compatibility.product,compatibility.product_version,source,compatibility.profile_id);
  if(!resolved||JSON.stringify(resolved)!==JSON.stringify(compatibility)||scope.sessions.some(s=>s.product!==compatibility.product)||
    source==='codex_binding'&&(scope.sessions.length>codexBindingAdmission.maxFamilyMembers||scope.sessions.some(s=>s.parentSessionId!==null&&s.parentSessionId!==s.rootSessionId))||
    compatibility.state==='compatibility_unverified'&&(source==='claude_workflow'?scope.sessions.length!==1:scope.sessions.length>2||scope.sessions.some(s=>s.parentSessionId!==null&&s.parentSessionId!==s.rootSessionId)))throw new Error('candidate_scope_mismatch');
}
export function authorizeCandidateScope(store: Store, scope: CandidateScope, compatibility?:SourceCompatibility): void {
  if(compatibility){checkWorkflowCompatibility(scope,compatibility);assertCompatibilityAllowed(store,compatibility);}
  for (const s of scope.sessions) {
    let active;
    try { active = requireActiveScope(store, scope.taskId, s.sessionId); }
    catch { throw new Error('candidate_inactive_scope'); }
    const linked = store.get<{ parent_id: string | null; product_version: string | null }>('SELECT parent_id,product_version FROM sessions WHERE id=?', [s.sessionId]);
    if (active.project_id !== scope.projectId || active.product !== s.product || linked?.parent_id !== s.parentSessionId ||
      (compatibility?linked.product_version!==compatibility.product_version:s.product === 'codex' ? linked.product_version !== '0.160.0' : !isClaudeTraceProductVersion(linked.product_version))) throw new Error('candidate_scope_mismatch');
  }
  // A candidate task cannot share usage accounting with production channels.
  // No new registration/migration is introduced for this offline-only guard.
  if (store.get('SELECT 1 FROM observation_runs WHERE task_id=? UNION ALL SELECT 1 FROM otel_processes WHERE task_id=? LIMIT 1', [scope.taskId, scope.taskId])) throw new Error('candidate_mixed_sources');
  const existing = store.all<{ id: string; source_key: string; payload: string; runtime_payload: string | null }>(
    "SELECT e.id,e.source_key,e.payload,r.payload AS runtime_payload FROM events e LEFT JOIN runtime_evidence r ON r.id=json_extract(e.payload,'$.runtime_evidence_id') WHERE e.task_id=? AND json_extract(e.payload,'$.kind')='usage'", [scope.taskId]);
  for (const row of existing) {
    const usage = parse(EventV2Schema.shape.payload, JSON.parse(row.payload) as unknown, 'candidate_mixed_sources');
    const runtime = parse(RuntimeEvidenceSchema, row.runtime_payload === null ? null : JSON.parse(row.runtime_payload) as unknown, 'candidate_mixed_sources');
    const key = hash(['offline-nested-candidate-v1', usage.product, usage.product_version, runtime.request_id]);
    if (runtime.request_id === null || row.id !== key || row.source_key !== key || usage.runtime_evidence_id !== hash(['runtime', key])) throw new Error('candidate_mixed_sources');
  }
}
/** Test-only orchestration: caller owns explicit source permission and predecoding.
 * Mapping validation + active database scope happen BEFORE requesting metadata.
 * This callback does not grant permission to read a native source or its contents.
 */
export function ingestCandidateObservation(store: Store, inputScope: CandidateScope, sourceId: string,
  readMetadata: () => unknown, recordedAt: string, compatibility?:SourceCompatibility): CandidateProjection & { inserted?: boolean } {
  const scope = checkedCandidateScope(inputScope); sourceMapping(scope, sourceId); parse(TimestampSchema, recordedAt);
  return store.immediateTransaction(() => {
    authorizeCandidateScope(store, scope,compatibility);
    let metadata: unknown;
    try { metadata = readMetadata(); } catch { throw new Error('candidate_source_error'); }
    authorizeCandidateScope(store, scope,compatibility);
    const projection = projectCandidateObservation(scope, sourceId, metadata, recordedAt,compatibility);
    if (projection.kind !== 'usage') return projection;
    // Usage carries the version its source reported; it must be the linked session's version.
    if (store.get<{ product_version: string | null }>('SELECT product_version FROM sessions WHERE id=?', [projection.event.session_id])?.product_version !==
      projection.event.payload.product_version) throw new Error('candidate_scope_mismatch');
    // The key includes the version, so one native request must not also exist under another
    // accepted version label. Primary-key lookups over the current trace versions only.
    if (projection.event.payload.product === 'claude_code' && store.get("SELECT 1 FROM runtime_evidence WHERE json_extract(payload,'$.product')='claude_code' AND json_extract(payload,'$.request_id')=? AND json_extract(payload,'$.product_version')!=? LIMIT 1",[projection.runtime.request_id,projection.event.payload.product_version])) throw new Error('candidate_conflict');
    let failure: string;
    try { return { ...projection, inserted: putUsageWithEvidence(store, projection.event, projection.runtime) }; }
    catch (error) {
      // Classify only fixed error codes; raw SQLite/producer details never escape.
      failure = error instanceof Error && (error.message === 'runtime_conflict' || error.message === 'event_conflict')
        ? 'candidate_conflict' : 'candidate_storage_error';
    }
    throw new Error(failure);
  });
}
/** A manifest bounds intended topology, not observed children or request coverage. */
export function candidateCostCoverage(inputScope: CandidateScope, start: string, end: string, observedValue: boolean): CostCoverageEvidence {
  const scope = checkedCandidateScope(inputScope);
  return parse(CostCoverageEvidenceSchema, { profile_id: 'offline-nested-candidate-v1', task_id: scope.taskId,
    window_start: start, window_end: end, has_observed_value: observedValue,
    facts: Object.fromEntries(Object.keys(CostFactsSchema.shape).map(key => [key, 'unknown'])) });
}
