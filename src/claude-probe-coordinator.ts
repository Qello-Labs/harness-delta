import { resolveSourceCompatibility, pinSessionCompatibility, invalidateCompatibility } from './source-compatibility.js';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { IdSchema, TimestampSchema } from './contracts.js';
import { authorizeClaudeTraceScope, ingestClaudeTraceBatch, type ClaudeTraceBatchResult } from './claude-trace-candidate.js';
import type { CandidateScope, ClaudeTraceProductVersion } from './nested-candidate.js';
import { claudeProbeProductVersion, claudeWorkflowChildProfileId, claudeWorkflowProfileId, isClaudeWorkflowProductVersion } from './claude-workflow-versions.js';
import { decodeLogsRequest, type DecodedRecord } from './otel-projection.js';
import { recordObservationGap } from './runtime-history.js';
import type { Clock } from './lifecycle.js';
import type { Store } from './store.js';

const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const hash = (v: string) => createHash('sha256').update(v).digest();
const fail = (code: string): never => { throw new Error(code); };
const contentKeys = ['prompt', 'prompt_text', 'response', 'user_prompt', 'new_context', 'system_reminders',
  'system_prompt_preview', 'user_system_prompt', 'response.model_output', 'tool_input', 'tool_parameters'];
function stringValue(v: unknown): string | undefined {
  return object(v) && typeof v.stringValue === 'string' ? v.stringValue : undefined;
}
function integer(v: unknown): number | undefined {
  if (!object(v)) return undefined;
  const raw = v.intValue ?? v.doubleValue;
  const n = typeof raw === 'string' && /^[0-9]{1,20}$/.test(raw) ? Number(raw) : raw;
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}
function containsContent(attributes: ReadonlyMap<string, unknown>): boolean {
  return contentKeys.some(k => attributes.has(k) && stringValue(attributes.get(k)) !== '<REDACTED>');
}
function joinedId(record: DecodedRecord, key: string): string | undefined {
  const a = stringValue(record.attributes.get(key)); const b = stringValue(record.resource.get(key));
  if (a !== undefined && b !== undefined && a !== b) return undefined;
  return a ?? b;
}
function validAttributes(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > 128) return false;
  const keys = new Set<string>();
  const kinds = ['stringValue', 'intValue', 'doubleValue', 'boolValue', 'arrayValue', 'kvlistValue', 'bytesValue'];
  for (const item of value) {
    if (!object(item) || typeof item.key !== 'string' || keys.has(item.key) || !object(item.value) ||
      kinds.filter(k => Object.hasOwn(item.value as Record<string, unknown>, k)).length !== 1) return false;
    keys.add(item.key);
  }
  return true;
}
function validLogs(input: unknown, batchLimit: number): boolean {
  if (!object(input) || !Array.isArray(input.resourceLogs) || input.resourceLogs.length > 32) return false;
  for (const resource of input.resourceLogs) {
    if (!object(resource) || resource.resource !== undefined && (!object(resource.resource) || !validAttributes(resource.resource.attributes)) ||
      !Array.isArray(resource.scopeLogs) || resource.scopeLogs.length > 32) return false;
    for (const scope of resource.scopeLogs) {
      if (!object(scope) || !Array.isArray(scope.logRecords) || scope.logRecords.length > batchLimit) return false;
      if (scope.logRecords.some(r => !object(r) || !validAttributes(r.attributes))) return false;
    }
  }
  return true;
}
export const claudeProbeHookEvents=Object.freeze(['SessionStart','PreToolUse','SubagentStart','SubagentStop','SessionEnd'] as const);
export type ClaudeProbeHookEvent=typeof claudeProbeHookEvents[number];
/** Only a fixed event enum survives a failed authenticated metadata transition. */
export class ClaudeProbeHookFailure extends Error {
  constructor(code:string,readonly hookEvent:ClaudeProbeHookEvent){super(code);}
}
export interface ClaudeProbeOptions {
  rootScope: CandidateScope; child: { sessionId: string; sourceId: string; agentType: string };
  generation: number; startedAt: string; model: string | null; effort: string | null; clock: Clock;
  /** The launched binary's exact version. Workflow mode: one of the workflow list. Probe mode:
   * the pinned probe version, which is also the default. */
  productVersion?: ClaudeTraceProductVersion;
  /** Internal workflow mode; public CLI cannot supply synthetic admission. */
  workflow?: { synthetic: boolean; childEnabled: boolean; childRuntime?: {model:string;effort:string}|undefined; requestLimit:number; durationMs:number; assertActive:()=>void; onChildBound:(sessionId:string)=>void;
    /** Trusted external candidate only: no usage before verified connection. */
    observationStartedAt?:()=>string|null;
    /** A resumed native session reports resume; every other run must report startup. */
    startSource?:'startup'|'resume' };
  /** Caller owns a durable one-use reservation; a failure must hold, never retry. */
  reserveChild: () => void;
}
/** Internal, synthetic-qualified coordinator. It starts no transport or product.
 * The caller must authenticate native hooks/logs/traces through one launched run,
 * with this process credential, before supplying callbacks. No transcripts opened.
 * Logs are ordering/policy only; only request traces can create usage.
 */
export class ClaudeProbeCoordinator {
  private readonly token = randomBytes(32).toString('base64url');
  private readonly tokenDigest = hash(this.token);
  private scope: CandidateScope;
  private rootStarted = false;
  private childAgentId: string | null = null;
  private toolUseId: string | null = null;
  private lastSequence = -1;
  private sequenceKeys = new Map<number, string>();
  private revoked = false;
  private childStopped = false;
  private sessionEnded = false;
  private requestsInserted = 0;
  private rootRequests = 0;
  private childRequests = 0;
  private lastVerifiedAt: string | null = null;
  // A child-enabled run is pinned to the direct-child profile, which exists only as an exact admission:
  // a conditional version resolves to nothing and cannot start a child.
  private get compatibility(){return this.options.workflow&&!this.options.workflow.synthetic?resolveSourceCompatibility('claude_code',this.productVersion,'claude_workflow',this.options.workflow.childEnabled?claudeWorkflowChildProfileId:claudeWorkflowProfileId):null;}
  private get productVersion(): ClaudeTraceProductVersion { return this.options.productVersion ?? claudeProbeProductVersion; }
  constructor(private readonly store: Store, private readonly options: ClaudeProbeOptions) {
    if (options.rootScope.sessions.length !== 1 || !IdSchema.safeParse(options.child.sessionId).success ||
      !IdSchema.safeParse(options.child.sourceId).success || !IdSchema.safeParse(options.child.agentType).success ||
      (options.model !== null && !IdSchema.safeParse(options.model).success) ||
      (!options.workflow && (options.model === null || options.effort !== 'high')) ||
      (options.workflow && (options.effort !== null && !['low','medium','high','xhigh','max'].includes(options.effort) || !Number.isSafeInteger(options.workflow.requestLimit) || options.workflow.requestLimit < 1 || options.workflow.requestLimit > 1024 ||
        !Number.isSafeInteger(options.workflow.durationMs) || options.workflow.durationMs < 1 || options.workflow.durationMs > 3600000)) ||
      !TimestampSchema.safeParse(options.startedAt).success ||
      // A synthetic workflow (tests, the unadmitted external candidate) is no admission and may keep the pinned probe version.
      (options.workflow ? !(isClaudeWorkflowProductVersion(options.productVersion ?? claudeProbeProductVersion) || options.workflow.synthetic && (options.productVersion ?? claudeProbeProductVersion) === claudeProbeProductVersion)
        : (options.productVersion ?? claudeProbeProductVersion) !== claudeProbeProductVersion) ||
      options.child.sessionId === options.rootScope.sessions[0]?.sessionId ||
      options.child.sourceId === options.rootScope.sessions[0]?.sourceId ||
      store.get('SELECT 1 FROM sessions WHERE id=?', [options.child.sessionId])) fail('claude_probe_invalid_options');
    // A non-synthetic root session must already carry the launched binary's version.
    if (!options.workflow?.synthetic && store.get<{ product_version: string | null }>('SELECT product_version FROM sessions WHERE id=?',
      [options.rootScope.sessions[0]!.sessionId])?.product_version !== (options.productVersion ?? claudeProbeProductVersion)) fail('claude_probe_invalid_options');
    if(options.workflow&&!options.workflow.synthetic&&!this.compatibility)fail('claude_probe_invalid_options');
    if(this.compatibility){
      pinSessionCompatibility(store,options.rootScope.sessions[0]!.sessionId,this.compatibility);
    }
    this.scope = authorizeClaudeTraceScope(store, options.rootScope, options.generation, options.workflow?.synthetic,this.compatibility??undefined);
    this.options = { ...options, child: { ...options.child }, rootScope: this.scope, ...(options.workflow ? {workflow:{...options.workflow,...(options.workflow.childRuntime ? {childRuntime:{...options.workflow.childRuntime}} : {})}} : {}) };
  }
  exporterHeaders(): Readonly<Record<string, string>> { return { 'x-harness-delta-token': this.token }; }
  /** Transport checks this before buffering or decoding any request bytes. */
  authorizeRequest(token: string): void { this.authorize(token); }
  /** Reject early exports before transport buffers or any decoder reads bytes. */
  authorizeTraceRequest(token: string): void {
    this.authorize(token);
    if (!this.rootStarted || this.lastSequence < 0 || (!this.options.workflow && this.childAgentId === null)) fail('claude_probe_not_ready');
    if(this.options.workflow?.observationStartedAt&&this.options.workflow.observationStartedAt()===null)fail('claude_probe_not_ready');
  }
  state() { return { rootStarted: this.rootStarted, childBound: this.childAgentId !== null, childStopped: this.childStopped,
    sessionEnded: this.sessionEnded, lastSequence: this.lastSequence, requestsInserted: this.requestsInserted,
    rootRequests: this.rootRequests, childRequests: this.childRequests, revoked: this.revoked }; }
  revoke(): void { this.revoked = true; }
  private authorize(token: string): void {
    if (!timingSafeEqual(hash(token), this.tokenDigest)) fail('claude_probe_unauthorized');
    if (this.revoked) fail('claude_probe_revoked');
    try { this.options.workflow?.assertActive(); authorizeClaudeTraceScope(this.store, this.scope, this.options.generation, this.options.workflow?.synthetic,this.compatibility??undefined); }
    catch { this.revoked = true; fail('claude_trace_scope_revoked'); }
    const now = this.options.clock();
    if (!TimestampSchema.safeParse(now).success || Date.parse(now) < Date.parse(this.options.startedAt) ||
      Date.parse(now) - Date.parse(this.options.startedAt) > (this.options.workflow?.durationMs ?? 120000)) this.stop('claude_probe_deadline', 'incomplete');
  }
  private read(token: string, callback: () => unknown): unknown {
    this.authorize(token);
    let value: unknown;
    try { value = callback(); } catch (error) { this.stop(error instanceof SyntaxError?'claude_probe_invalid_json':'claude_probe_source_error', 'source_error'); }
    this.authorize(token); return value;
  }
  private stop(code: string, reason: 'source_error' | 'scope_mismatch' | 'unknown_parent' | 'incomplete' = 'scope_mismatch'): never {
    this.revoked = true;
    if(this.compatibility?.state==='compatibility_unverified'&&!['claude_probe_deadline','claude_probe_source_error','claude_probe_reservation_failed','claude_probe_request_boundary','claude_probe_log_limit','claude_probe_child_limit'].includes(code))invalidateCompatibility(this.store,this.compatibility,'contract_failed');
    try {
      const root = this.scope.sessions[0]!; const at = this.options.clock();
      recordObservationGap(this.store, this.scope.taskId, root.sessionId, this.options.workflow && this.lastVerifiedAt !== null ? new Date(Math.min(Date.parse(at),Date.parse(this.lastVerifiedAt)+1)).toISOString() : this.options.startedAt, at, reason, at);
    } catch { /* Revocation/deletion must never recreate rows. */ }
    return fail(code);
  }
  acceptHook(token: string, readMetadata: () => unknown): void {
    const raw = this.read(token, readMetadata);
    const event=object(raw)&&typeof raw.hook_event_name==='string'?claudeProbeHookEvents.find(name=>name===raw.hook_event_name):undefined;
    try { this.acceptHookMetadata(token,raw); }
    catch(error){
      if(event!==undefined&&error instanceof Error)throw new ClaudeProbeHookFailure(error.message,event);
      throw error;
    }
  }
  private acceptHookMetadata(token:string,raw:unknown):void {
    const root = this.scope.sessions[0]!;
    if (!object(raw) || raw.session_id !== root.nativeSessionId) this.stop('claude_probe_hook_scope');
    if (raw.hook_event_name === 'SessionStart') {
      if (this.sessionEnded) this.stop('claude_probe_restart', 'incomplete');
      // Native print-mode SessionStart may omit model; every request trace still enforces the requested runtime.
      if (raw.source !== (this.options.workflow?.startSource ?? 'startup') || this.options.model !== null && raw.model !== undefined && raw.model !== this.options.model) this.stop('claude_probe_configuration_changed');
      this.rootStarted = true; return;
    }
    if (!this.rootStarted) this.stop('claude_probe_not_started');
    if (raw.hook_event_name === 'PreToolUse') {
      const input = raw.tool_input;
      if (this.options.workflow?.childEnabled === false || this.sessionEnded || raw.tool_name !== 'Agent' || !IdSchema.safeParse(raw.tool_use_id).success || !object(input) ||
        input.subagent_type !== this.options.child.agentType || input.resume !== undefined || input.isolation !== undefined || input.run_in_background === true ||
        input.effort !== undefined && input.effort !== (this.options.workflow?.childRuntime?.effort ?? this.options.effort) ||
        input.model !== undefined && input.model !== (this.options.workflow?.childRuntime?.model ?? this.options.model)) this.stop('claude_probe_child_scope', 'unknown_parent');
      if (this.toolUseId === raw.tool_use_id) return;
      if (this.toolUseId !== null) this.stop('claude_probe_child_limit', 'unknown_parent');
      try { this.options.reserveChild(); } catch { this.stop('claude_probe_reservation_failed', 'incomplete'); }
      this.toolUseId = raw.tool_use_id as string; return;
    }
    if (raw.hook_event_name === 'SubagentStart') {
      if (this.toolUseId === null || this.childStopped || this.sessionEnded || raw.agent_type !== this.options.child.agentType ||
        !IdSchema.safeParse(raw.agent_id).success) this.stop('claude_probe_child_scope', 'unknown_parent');
      const agentId = raw.agent_id as string;
      if (this.childAgentId !== null) {
        if (agentId !== this.childAgentId) this.stop('claude_probe_child_limit', 'unknown_parent');
        return;
      }
      const child = this.options.child;
      if (this.store.get('SELECT 1 FROM tombstones WHERE kind=? AND id=?', ['session', child.sessionId]) ||
        this.store.get('SELECT 1 FROM sessions WHERE id=?', [child.sessionId])) this.stop('claude_probe_child_scope', 'unknown_parent');
      const next: CandidateScope = { ...this.scope, sessions: [...this.scope.sessions, { ...root, sessionId: child.sessionId,
        sourceId: child.sourceId, parentSessionId: root.sessionId, agentId }] };
      try {
        this.store.immediateTransaction(() => {
          this.authorize(token);
          this.store.execute('INSERT INTO sessions(id,project_id,task_id,parent_id,product,product_version) VALUES (?,?,?,?,?,?)',
            [child.sessionId, this.scope.projectId, this.scope.taskId, root.sessionId, this.options.workflow?.synthetic ? 'synthetic' : 'claude_code', this.options.workflow?.synthetic ? '1.0.0' : this.productVersion]);
          if(this.compatibility)pinSessionCompatibility(this.store,child.sessionId,this.compatibility);
          authorizeClaudeTraceScope(this.store, next, this.options.generation, this.options.workflow?.synthetic,this.compatibility??undefined);
          this.options.workflow?.onChildBound(child.sessionId);
        });
      } catch { this.stop('claude_probe_child_scope', 'unknown_parent'); }
      this.scope = next; this.childAgentId = agentId; return;
    }
    if (raw.hook_event_name === 'SubagentStop') {
      if (this.childAgentId === null || raw.agent_id !== this.childAgentId || raw.agent_type !== this.options.child.agentType) this.stop('claude_probe_child_scope', 'unknown_parent');
      this.childStopped = true; return;
    }
    if (raw.hook_event_name === 'SessionEnd') { this.sessionEnded = true; return; }
    this.stop('claude_probe_unsupported_hook');
  }
  ingestLogs(token: string, readBody: () => unknown): { accepted: number; replayed: number } {
    // The explicit run credential and linked scope authorize ordering-only logs.
    // SessionStart and log startup are independent prerequisites for usage; no
    // raw early trace is queued or admitted while either prerequisite is missing.
    const raw = this.read(token, readBody);
    // Workflow runs see native exporter batches (default 512) and keep every
    // sequence key for exact replay detection, bounded per invocation.
    const batchLimit = this.options.workflow ? 512 : 128; const keyLimit = this.options.workflow ? 65536 : 128;
    if (!validLogs(raw, batchLimit)) this.stop('claude_probe_invalid_logs', 'source_error');
    const records = decodeLogsRequest(raw);
    if (records === null || records.length === 0 || records.length > batchLimit) this.stop('claude_probe_invalid_logs', 'source_error');
    const root = this.scope.sessions[0]!; const keys = new Map(this.sequenceKeys); let sequence = this.lastSequence;
    let accepted = 0; let replayed = 0;
    for (const record of records) {
      const attrs = record.attributes; const number = integer(attrs.get('event.sequence'));
      const name = stringValue(attrs.get('event.name')); const timestamp = stringValue(attrs.get('event.timestamp'));
      if (number === undefined || name === undefined || !TimestampSchema.safeParse(timestamp).success ||
        joinedId(record, 'harness_delta.process_id') !== root.processId || joinedId(record, 'session.id') !== root.nativeSessionId ||
        joinedId(record, 'app.version') !== this.productVersion) this.stop('claude_probe_log_scope');
      if (['api_error', 'api_refusal'].includes(name)) this.stop('claude_probe_request_boundary', 'incomplete');
      if (containsContent(attrs) || ['api_request_body', 'api_response_body', 'system_prompt'].includes(name)) this.stop('claude_probe_content_enabled');
      const trigger = stringValue(attrs.get('managed_settings.trigger'));
      const sources = attrs.get('managed_settings.sources');
      const noPolicy = object(sources) && object(sources.arrayValue) && Array.isArray(sources.arrayValue.values) && sources.arrayValue.values.length === 0;
      if (name === 'managed_settings_resolved' && (!noPolicy || trigger !== 'startup')) this.stop('claude_probe_policy_override');
      const key = hash(JSON.stringify([number, name, timestamp, root.nativeSessionId, name === 'managed_settings_resolved' ? trigger : null])).toString('hex');
      const previous = keys.get(number);
      if (previous !== undefined) {
        if (previous !== key) this.stop('claude_probe_log_conflict'); replayed++; continue;
      }
      if (number !== sequence + 1 || sequence === -1 && (name !== 'managed_settings_resolved' || !noPolicy || trigger !== 'startup')) this.stop('claude_probe_log_gap', 'incomplete');
      if (keys.size >= keyLimit) this.stop('claude_probe_log_limit', 'incomplete');
      keys.set(number, key); sequence = number; accepted++;
    }
    this.authorize(token); this.sequenceKeys = keys; this.lastSequence = sequence; return { accepted, replayed };
  }
  ingestTraces(token: string, readBody: () => unknown): ClaudeTraceBatchResult {
    this.authorizeTraceRequest(token);
    const raw = this.read(token, readBody);
    // Validate requested config/content before the unchanged request projector can persist anything.
    if (!object(raw) || !Array.isArray(raw.resourceSpans)) this.stop('claude_probe_invalid_traces', 'source_error');
    let count = 0;
    for (const resource of raw.resourceSpans) {
      if (!object(resource) || !Array.isArray(resource.scopeSpans)) this.stop('claude_probe_invalid_traces', 'source_error');
      for (const scope of resource.scopeSpans) {
        if (!object(scope) || !Array.isArray(scope.spans)) this.stop('claude_probe_invalid_traces', 'source_error');
        for (const span of scope.spans) {
          if (++count > (this.options.workflow ? 512 : 128) || !object(span)) this.stop('claude_probe_invalid_traces', 'source_error');
          if (!Array.isArray(span.attributes)) this.stop('claude_probe_invalid_traces', 'source_error');
          const attrs = new Map<string, unknown>();
          for (const item of span.attributes) {
            if (!object(item) || typeof item.key !== 'string' || attrs.has(item.key)) this.stop('claude_probe_invalid_traces', 'source_error'); attrs.set(item.key, item.value);
          }
          if (containsContent(attrs)) this.stop('claude_probe_content_enabled');
          if (span.name === 'claude_code.llm_request') {
            const requested = stringValue(attrs.get('agent_id')) !== undefined
              ? this.options.workflow?.childRuntime ?? {model:this.options.model,effort:this.options.effort}
              : {model:this.options.model,effort:this.options.effort};
            if (requested.model !== null && stringValue(attrs.get('model')) !== requested.model ||
                requested.effort !== null && stringValue(attrs.get('effort')) !== requested.effort) this.stop('claude_probe_configuration_changed');
          }
        }
      }
    }
    this.authorize(token);
    let result: ClaudeTraceBatchResult;
    let inserted: { session_id: string }[];
    try {
      ({ result, inserted } = this.store.immediateTransaction(() => {
        const before = this.store.get<{ last: number }>('SELECT coalesce(max(rowid),0) AS last FROM events')!.last;
        const result = ingestClaudeTraceBatch(this.store, this.scope, () => raw, {
          startedAt: this.options.workflow?.observationStartedAt?.()??this.options.startedAt, receivedAt: this.options.clock(), generation: this.options.generation, synthetic:this.options.workflow?.synthetic, productVersion: this.productVersion, compatibility:this.compatibility??undefined,
          ...(this.options.workflow && this.lastVerifiedAt!==null ? {lossStartedAt:new Date(Math.min(Date.parse(this.options.clock()),Date.parse(this.lastVerifiedAt)+1)).toISOString()} : {}),
        });
        // Count only rows this batch actually inserted while holding the writer
        // lock. Exact replay and other sources cannot supply terminal evidence.
        const inserted = this.store.all<{ session_id: string }>("SELECT session_id FROM events WHERE rowid>? AND project_id=? AND task_id=? AND json_extract(payload,'$.kind')='usage'",
          [before, this.scope.projectId, this.scope.taskId]);
        if (inserted.length !== result.inserted) fail('claude_probe_request_boundary');
        return { result, inserted };
      }));
    } catch (error) {
      const code = error instanceof Error && error.message === 'candidate_conflict'
        ? 'claude_probe_request_conflict' : 'claude_probe_invalid_traces';
      this.stop(code, 'source_error');
    }
    this.requestsInserted += result.inserted;
    this.rootRequests += inserted.filter(row => row.session_id === this.scope.sessions[0]!.sessionId).length;
    this.childRequests += inserted.filter(row => row.session_id === this.options.child.sessionId).length;
    if (result.inserted > 0) this.lastVerifiedAt = this.options.clock();
    if (result.unattributed > 0 || result.excluded > 0 || this.requestsInserted > (this.options.workflow?.requestLimit ?? 3) ||
      (!this.options.workflow && (this.rootRequests > 2 || this.childRequests > 1))) this.stop('claude_probe_request_boundary', 'incomplete');
    return result;
  }
}
