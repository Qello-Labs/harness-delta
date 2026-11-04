import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { addTokens, IdSchema, ProductVersionSchema, TaskMetadataSchema, TimestampSchema } from './contracts.js';
import { observed, unavailable } from './adapters.js';
import { lockTask } from './managed-journal.js';
import { projectRecord, profileSchema, type DecodedRecord, type OtelVersionProfile, type ProjectedRecord, type UsageFields } from './otel-projection.js';
import type { Store } from './store.js';

/** Internal OTel receiver journal. It accepts only the injected profile's version and never
 * stores tokens, headers, raw attributes or undecodable bodies.
 */
export const otelLaunchSchema = z.strictObject({
  runId: IdSchema,
  processId: IdSchema,
  taskId: IdSchema,
  sessionId: IdSchema,
  productVersion: ProductVersionSchema
});
export type OtelLaunch = z.infer<typeof otelLaunchSchema>;
export class OtelFailure extends Error {
  constructor(readonly code: 'invalid_launch' | 'unsupported_version' | 'scope_revoked' | 'source_conflict' | 'clock_regressed') {
    super(`otel_${code}`);
  }
}
type UncertainReason = 'ordering_missing' | 'sequence_gap' | 'managed_override' | 'scope_mismatch' | 'identity_conflict' | 'invalid_record' | 'content_enabled';
type RevokeReason = 'pause' | 'finalize' | 'closed' | 'uncertain' | 'scope_revoked';
interface ProcessRow {
  id: string;
  run_id: string;
  project_id: string;
  task_id: string;
  launch_session_id: string;
  product: 'claude_code';
  product_version: string;
  profile_id: string;
  generation: number;
  state: 'listening' | 'revoked';
  ordering: 'pending' | 'ready' | 'uncertain';
  next_sequence: number | null;
  current_session_id: string | null;
  uncertain_reason: UncertainReason | null;
  uncertain_observation_id: string | null;
  revoke_reason: RevokeReason | null;
  started_at: string;
  updated_at: string;
}
interface RecordRow {
  event_type: string;
  record_key: string;
  session_id: string;
  occurred_at: string;
  payload: string;
}
class Conflict extends Error {}
class Uncertain extends Error {
  constructor(readonly reason: UncertainReason) {
    super(reason);
  }
}

export function otelNow(clock: () => string, row?: { updated_at: string }): string {
  const parsed = TimestampSchema.safeParse(clock());
  if (!parsed.success) throw new OtelFailure('clock_regressed');
  const now = new Date(parsed.data).toISOString();
  // Lifecycle timestamps may lag the receiver; never move a process clock backward.
  return row && now < row.updated_at ? row.updated_at : now;
}
const processRow = (store: Store, id: string) => store.get<ProcessRow>('SELECT * FROM otel_processes WHERE id=?', [id]);
const deleted = (store: Store, kind: string, id: string) => Boolean(store.get('SELECT id FROM tombstones WHERE kind=? AND id=?', [kind, id]));

export function registerOtelProcess(store: Store, input: OtelLaunch, profile: OtelVersionProfile, now: string): void {
  const launch = otelLaunchSchema.safeParse(input);
  if (!launch.success || !profileSchema.safeParse(profile).success) throw new OtelFailure('invalid_launch');
  if (profile.version !== launch.data.productVersion) throw new OtelFailure('unsupported_version');
  const { runId, processId, taskId, sessionId, productVersion } = launch.data;
  store.immediateTransaction(() => {
    lockTask(store, taskId);
    const task = store.get<{ project_id: string; state: string; generation: number; metadata: string; local_root: string | null }>(
      'SELECT t.project_id,t.state,t.generation,t.metadata,p.local_root FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=?',
      [taskId]
    );
    if (!task || task.state !== 'active' || task.local_root === null) throw new OtelFailure('scope_revoked');
    const metadata = TaskMetadataSchema.safeParse(JSON.parse(task.metadata) as unknown);
    if (!metadata.success || metadata.data.product !== 'claude_code') throw new OtelFailure('scope_revoked');
    if (deleted(store, 'task', taskId) || deleted(store, 'project', task.project_id) || deleted(store, 'session', sessionId))
      throw new OtelFailure('scope_revoked');
    // Reports sum a task's usage events; OTel and file adapter observations must never meet there.
    if (store.get('SELECT id FROM sessions WHERE task_id=? AND source_path IS NOT NULL', [taskId])) throw new OtelFailure('source_conflict');
    const existing = store.get<{ task_id: string; product: string | null; source_path: string | null; product_version: string | null }>(
      'SELECT task_id,product,source_path,product_version FROM sessions WHERE id=?',
      [sessionId]
    );
    // A resumed session may reuse its session only inside the same task and source family.
    if (
      existing &&
      (existing.task_id !== taskId || existing.product !== 'claude_code' || existing.source_path !== null || existing.product_version !== productVersion)
    )
      throw new OtelFailure('scope_revoked');
    if (!existing) {
      store.execute("INSERT INTO sessions(id,project_id,task_id,product,product_version) VALUES (?,?,?,'claude_code',?)", [
        sessionId,
        task.project_id,
        taskId,
        productVersion
      ]);
    }
    store.execute(
      `INSERT INTO otel_processes(id,run_id,project_id,task_id,launch_session_id,product,product_version,profile_id,generation,state,ordering,started_at,updated_at)
      VALUES (?,?,?,?,?,'claude_code',?,?,?,'listening','pending',?,?)`,
      [processId, runId, task.project_id, taskId, sessionId, productVersion, profile.id, task.generation, now, now]
    );
  });
}

function inScope(store: Store, row: ProcessRow): boolean {
  if (row.state !== 'listening') return false;
  const task = store.get<{ state: string; generation: number; metadata: string; local_root: string | null }>(
    'SELECT t.state,t.generation,t.metadata,p.local_root FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=? AND p.id=?',
    [row.task_id, row.project_id]
  );
  if (!task || task.state !== 'active' || task.generation !== row.generation || task.local_root === null) return false;
  const metadata = TaskMetadataSchema.safeParse(JSON.parse(task.metadata) as unknown);
  return (
    metadata.success &&
    metadata.data.product === 'claude_code' &&
    !deleted(store, 'task', row.task_id) &&
    !deleted(store, 'project', row.project_id) &&
    !deleted(store, 'session', row.launch_session_id)
  );
}
function revoke(store: Store, row: ProcessRow, reason: RevokeReason, now: string): void {
  store.execute("UPDATE otel_processes SET state='revoked',revoke_reason=?,updated_at=? WHERE id=? AND state='listening'", [reason, now, row.id]);
}

/** Checks scope without reading any request body. Admission is read-only; a process found
 * out of scope is revoked under the writer lock.
 */
export function admitOtelRequest(store: Store, processId: string, clock: () => string): boolean {
  const row = processRow(store, processId);
  if (!row || row.state !== 'listening') return false;
  if (inScope(store, row)) return true;
  store.immediateTransaction(() => {
    const current = processRow(store, processId);
    if (current && current.state === 'listening' && !inScope(store, current)) revoke(store, current, 'scope_revoked', otelNow(clock, current));
  });
  return false;
}

function markUncertain(store: Store, row: ProcessRow, reason: UncertainReason, now: string): void {
  const last =
    row.next_sequence === null
      ? undefined
      : store.get<{ occurred_at: string }>('SELECT occurred_at FROM otel_records WHERE process_id=? AND sequence=?', [row.id, row.next_sequence - 1]);
  const observation = randomUUID();
  // The interval after the last contiguous record is uncertain until the process is closed.
  store.execute("INSERT INTO observations(id,task_id,started_at,ended_at,status,reason) VALUES (?,?,?,NULL,'unmeasurable',?)", [
    observation,
    row.task_id,
    last?.occurred_at ?? row.started_at,
    reason === 'scope_mismatch' ? 'scope_mismatch' : reason === 'managed_override' || reason === 'content_enabled' ? 'unsupported' : 'incomplete'
  ]);
  store.execute(
    "UPDATE otel_processes SET ordering='uncertain',uncertain_reason=?,uncertain_observation_id=?,state='revoked',revoke_reason=COALESCE(revoke_reason,'uncertain'),updated_at=? WHERE id=?",
    [reason, observation, now, row.id]
  );
}

function recordKey(record: ProjectedRecord): string {
  const fields = record.eventType === 'api_request' || record.eventType === 'api_error' ? (record.fields as UsageFields) : undefined;
  if (fields?.request_id) return `request_id:${fields.request_id}`;
  if (fields?.client_request_id) return `client_request_id:${fields.client_request_id}`;
  return `sequence:${record.sequence}`;
}
function encode(record: ProjectedRecord): string {
  return JSON.stringify({
    product_version: record.productVersion,
    ...(record.fields ?? {}),
    ...(record.managedSources === null ? {} : { managed_sources: record.managedSources })
  });
}
function linkSession(store: Store, row: ProcessRow, sessionId: string): void {
  if (deleted(store, 'session', sessionId)) throw new Uncertain('scope_mismatch');
  const existing = store.get<{ task_id: string; project_id: string; product: string | null; source_path: string | null; product_version: string | null }>(
    'SELECT task_id,project_id,product,source_path,product_version FROM sessions WHERE id=?',
    [sessionId]
  );
  if (existing) {
    if (
      existing.task_id !== row.task_id ||
      existing.project_id !== row.project_id ||
      existing.product !== 'claude_code' ||
      existing.source_path !== null ||
      existing.product_version !== row.product_version
    )
      throw new Uncertain('scope_mismatch');
    return;
  }
  store.execute("INSERT INTO sessions(id,project_id,task_id,product,product_version) VALUES (?,?,?,'claude_code',?)", [
    sessionId,
    row.project_id,
    row.task_id,
    row.product_version
  ]);
}
function putRecord(store: Store, row: ProcessRow, record: ProjectedRecord): void {
  const key = recordKey(record);
  const payload = encode(record);
  if (store.get('SELECT sequence FROM otel_records WHERE process_id=? AND event_type=? AND record_key=?', [row.id, record.eventType, key]))
    throw new Conflict();
  let eventId: string | null = null;
  if (record.eventType === 'api_request') {
    const fields = record.fields as UsageFields;
    let input: number;
    try {
      input = addTokens([fields.input_tokens!, fields.cache_creation_tokens!, fields.cache_read_tokens!]);
    } catch {
      throw new Uncertain('invalid_record');
    }
    // Same component semantics as the Claude transcript adapter; reasoning is not separable.
    eventId = `otel-${createHash('sha256')
      .update(JSON.stringify(['claude_code', row.run_id, row.id, record.eventType, key]))
      .digest('hex')
      .slice(0, 48)}`;
    store.putEvent({
      id: eventId,
      source_key: eventId,
      project_id: row.project_id,
      task_id: row.task_id,
      session_id: record.sessionId,
      occurred_at: record.occurredAt,
      payload: {
        kind: 'usage',
        product: 'claude_code',
        product_version: row.product_version,
        model: fields.model,
        epoch: row.id,
        input_total: observed(input),
        cached_input: observed(fields.cache_read_tokens!),
        output_total: observed(fields.output_tokens!),
        reasoning_output: unavailable()
      }
    });
  }
  store.execute('INSERT INTO otel_records(process_id,sequence,event_type,record_key,session_id,occurred_at,event_id,payload) VALUES (?,?,?,?,?,?,?,?)', [
    row.id,
    record.sequence,
    record.eventType,
    key,
    record.sessionId,
    record.occurredAt,
    eventId,
    payload
  ]);
}

export type IngestOutcome = 'committed' | 'revoked' | 'conflict';
/** Stores one decoded logs request atomically. The caller acknowledges only after this returns. */
export function ingestOtelLogs(
  store: Store,
  processId: string,
  records: readonly DecodedRecord[],
  profile: OtelVersionProfile,
  clock: () => string
): IngestOutcome {
  try {
    return store.immediateTransaction(() => {
      const row = processRow(store, processId);
      if (!row || row.state !== 'listening') return 'revoked';
      lockTask(store, row.task_id);
      const now = otelNow(clock, row);
      if (!inScope(store, row) || row.profile_id !== profile.id || row.product_version !== profile.version) {
        revoke(store, row, 'scope_revoked', now);
        return 'revoked';
      }
      let ordering = row.ordering;
      let next = row.next_sequence;
      let session = row.current_session_id;
      let uncertain: UncertainReason | undefined;
      try {
        const projected = records.map(record => projectRecord(record, profile));
        // A failed projection (an invalid record without a trustworthy position, or content exposure)
        // rejects the whole batch. Content exposure is reported first, so an invalid record cannot hide it.
        const failed = projected.find(item => !item.ok && item.reason === 'content_enabled') ?? projected.find(item => !item.ok);
        if (failed && !failed.ok) throw new Uncertain(failed.reason);
        const ordered = projected.flatMap(item => (item.ok ? [item.record] : [])).sort((a, b) => a.sequence - b.sequence);
        for (const record of ordered) {
          const prior = store.get<RecordRow>(
            'SELECT event_type,record_key,session_id,occurred_at,payload FROM otel_records WHERE process_id=? AND sequence=?',
            [row.id, record.sequence]
          );
          if (prior || (next !== null && record.sequence < next)) {
            if (
              !prior ||
              prior.event_type !== record.eventType ||
              prior.record_key !== recordKey(record) ||
              prior.session_id !== record.sessionId ||
              prior.occurred_at !== record.occurredAt ||
              prior.payload !== encode(record)
            )
              throw new Conflict();
            continue;
          }
          // Registration precedes launch, so an earlier or future time cannot belong to this
          // process; it could otherwise land in an excluded, paused interval.
          if (record.occurredAt < row.started_at || record.occurredAt > now) throw new Uncertain('invalid_record');
          if (ordering === 'pending') {
            const start =
              record.eventType === 'managed_settings_resolved' &&
              record.fields !== null &&
              'trigger' in record.fields &&
              record.fields.trigger === 'startup' &&
              record.sequence === profile.sessionStartSequence;
            if (!start) throw new Uncertain('ordering_missing');
            if (record.sessionId !== row.launch_session_id) throw new Uncertain('scope_mismatch');
          } else if (record.sequence !== next) throw new Uncertain('sequence_gap');
          if (record.productVersion !== row.product_version || record.processAttribute !== row.id) throw new Uncertain('scope_mismatch');
          if (record.managedSources === true) throw new Uncertain('managed_override');
          if (session !== null && record.sessionId !== session) linkSession(store, row, record.sessionId);
          putRecord(store, row, record);
          ordering = 'ready';
          next = record.sequence + 1;
          session = record.sessionId;
        }
      } catch (error) {
        if (!(error instanceof Uncertain)) throw error;
        uncertain = error.reason;
      }
      store.execute('UPDATE otel_processes SET ordering=?,next_sequence=?,current_session_id=?,updated_at=? WHERE id=?', [
        ordering,
        next,
        session,
        now,
        row.id
      ]);
      // Contiguous records before the failure stay partial; nothing after it is measured.
      if (uncertain) markUncertain(store, processRow(store, row.id)!, uncertain, now);
      return 'committed';
    });
  } catch (error) {
    if (!(error instanceof Conflict)) throw error;
    store.immediateTransaction(() => {
      const row = processRow(store, processId);
      if (row && row.ordering !== 'uncertain') {
        lockTask(store, row.task_id);
        markUncertain(store, row, 'identity_conflict', otelNow(clock, row));
      }
    });
    return 'conflict';
  }
}

/** Ends one process. A process that never proved readiness recorded nothing measurable, so its
 * whole lifetime becomes an unmeasurable window instead of silently disappearing.
 */
function endProcess(store: Store, row: ProcessRow, reason: RevokeReason, now: string, launched = true): void {
  revoke(store, row, reason, now);
  if (launched && row.ordering === 'pending') markUncertain(store, processRow(store, row.id)!, 'ordering_missing', now);
  const current = processRow(store, row.id)!;
  if (current.uncertain_observation_id)
    store.execute('UPDATE observations SET ended_at=? WHERE id=? AND ended_at IS NULL', [now, current.uncertain_observation_id]);
}
/** Caller holds the task writer lock. Revocation is permanent; a resumed task needs a new process. */
export function revokeOtelProcesses(store: Store, taskId: string, reason: 'pause' | 'finalize', now: string): void {
  for (const row of store.all<ProcessRow>('SELECT * FROM otel_processes WHERE task_id=?', [taskId])) {
    endProcess(store, row, reason, now < row.updated_at ? row.updated_at : now);
  }
}
export function closeOtelProcess(store: Store, processId: string, clock: () => string, options: { launched: boolean } = { launched: true }): void {
  store.immediateTransaction(() => {
    const row = processRow(store, processId);
    if (!row) return;
    lockTask(store, row.task_id);
    endProcess(store, row, 'closed', otelNow(clock, row), options.launched);
  });
}
