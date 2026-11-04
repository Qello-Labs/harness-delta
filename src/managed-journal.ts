import { randomUUID } from 'node:crypto';
import { IdSchema, TaskMetadataSchema, TimestampSchema } from './contracts.js';
import { mergeCoverageFacts, type CoverageEvidence, type CoverageMetric, type EvidenceState } from './coverage.js';
import type { Clock, TaskRow } from './lifecycle.js';
import type { Store } from './store.js';
import { initialFacts, isOpen, ManagedFailure, type Facts, type RunInput, type RunRow, type StopReason, type UsageEnvelope } from './managed-protocol.js';

// Database JSON uses snake_case; B1's internal TypeScript fact names stay camelCase.
const factFields = {
  scopeBeforeAccess: 'scope_before_access',
  freshSession: 'fresh_session',
  readyBeforeFirstRequest: 'ready_before_first_request',
  continuousObservation: 'continuous_observation',
  fixedModel: 'fixed_model',
  boundedTopology: 'bounded_topology',
  requestUniverse: 'request_universe',
  terminalAccounting: 'terminal_accounting',
  immutableIdentity: 'immutable_identity',
  durableFlush: 'durable_flush',
  counterSemantics: 'counter_semantics'
} as const;
function encodeFacts(facts: Facts): string {
  return JSON.stringify(Object.fromEntries(Object.entries(factFields).map(([key, field]) => [field, facts[key as keyof Facts]])));
}
function decodeFacts(encoded: string): Facts {
  const stored = JSON.parse(encoded) as Record<string, EvidenceState>;
  const facts = Object.fromEntries(Object.entries(factFields).map(([key, field]) => [key, stored[field]])) as Facts;
  // Reuse B1's closed fact validation when crossing back into the internal model.
  return mergeCoverageFacts(facts, facts);
}

export function runRow(store: Store, id: string): RunRow | undefined {
  return store.get<RunRow>('SELECT * FROM observation_runs WHERE id=?', [id]);
}
export function lockTask(store: Store, taskId: string): void {
  store.execute('UPDATE tasks SET generation=generation WHERE id=?', [taskId]);
}
export function managedNow(clock: Clock, row?: RunRow): string {
  const parsed = TimestampSchema.safeParse(clock());
  if (!parsed.success) throw new ManagedFailure('clock_regressed');
  const now = new Date(parsed.data).toISOString();
  if (row && now < row.updated_at) throw new ManagedFailure('clock_regressed');
  return now;
}
export function assertScope(store: Store, row: RunRow): void {
  const scope = store.get<{ state: string; generation: number; metadata: string }>(
    `SELECT t.state,t.generation,t.metadata FROM tasks t
    JOIN projects p ON p.id=t.project_id JOIN sessions s ON s.task_id=t.id AND s.project_id=p.id
    WHERE t.id=? AND p.id=? AND p.local_root IS NOT NULL AND s.id=? AND s.parent_id IS NULL
    AND s.source_path IS NULL AND s.product='synthetic' AND s.product_version='1.0.0'`,
    [row.task_id, row.project_id, row.session_id]
  );
  if (!scope || scope.state !== 'active' || scope.generation !== row.generation || !isOpen(row)) throw new ManagedFailure('scope_revoked');
  for (const [kind, id] of [
    ['task', row.task_id],
    ['project', row.project_id],
    ['session', row.session_id]
  ]) {
    if (store.get('SELECT id FROM tombstones WHERE kind=? AND id=?', [kind, id])) throw new ManagedFailure('scope_revoked');
  }
  const metadata = TaskMetadataSchema.safeParse(JSON.parse(scope.metadata) as unknown);
  if (!metadata.success || metadata.data.product !== 'synthetic') throw new ManagedFailure('scope_revoked');
}
export function beginRun(store: Store, input: RunInput, now: string, model: string): RunRow {
  return store.transaction(() => {
    lockTask(store, input.taskId);
    const task = store.get<TaskRow>('SELECT * FROM tasks WHERE id=?', [input.taskId]);
    if (!task || task.state !== 'active') throw new ManagedFailure('scope_revoked');
    const metadata = TaskMetadataSchema.safeParse(JSON.parse(task.metadata) as unknown);
    if (!metadata.success || metadata.data.product !== 'synthetic' || metadata.data.model !== model) throw new ManagedFailure('scope_revoked');
    if (task.last_transition_at && Date.parse(now) < Date.parse(task.last_transition_at)) throw new ManagedFailure('clock_regressed');
    // An existing session is never adopted, even if it has no observed usage.
    const facts = encodeFacts(initialFacts());
    store.execute(`INSERT INTO sessions(id,project_id,task_id,product,product_version) VALUES (?,?,?,'synthetic','1.0.0')`, [
      input.sessionId,
      task.project_id,
      task.id
    ]);
    store.execute(
      `INSERT INTO observation_runs(id,project_id,task_id,session_id,generation,profile_id,state,started_at,updated_at,input_facts,output_facts)
      VALUES (?,?,?,?,?,'synthetic-managed-v1','preparing',?,?,?,?)`,
      [input.runId, task.project_id, task.id, input.sessionId, task.generation, now, now, facts, facts]
    );
    const row = runRow(store, input.runId)!;
    assertScope(store, row);
    return row;
  });
}
export function patchFacts(store: Store, row: RunRow, patch: Partial<Facts>): void {
  const input = { ...decodeFacts(row.input_facts), ...patch };
  const output = { ...decodeFacts(row.output_facts), ...patch };
  store.execute('UPDATE observation_runs SET input_facts=?,output_facts=? WHERE id=?', [encodeFacts(input), encodeFacts(output), row.id]);
}
/** Caller holds the task writer lock. Completed facts never change. */
export function interruptRun(store: Store, row: RunRow, reason: StopReason, now: string): void {
  if (!isOpen(row)) return;
  patchFacts(store, row, {
    continuousObservation: 'violated',
    ...(reason === 'identity_conflict' ? { immutableIdentity: 'violated' as const } : {}),
    ...(reason === 'storage_error' ? { durableFlush: 'violated' as const } : {})
  });
  store.execute("UPDATE observation_runs SET state='interrupted',stop_reason=?,updated_at=?,ended_at=? WHERE id=?", [reason, now, now, row.id]);
}
export function interruptManagedRuns(store: Store, taskId: string, reason: StopReason, now: string): void {
  for (const row of store.all<RunRow>("SELECT * FROM observation_runs WHERE task_id=? AND state NOT IN ('sealed','interrupted')", [taskId])) {
    // Human lifecycle timestamps may lag the observer. Never move its clock backward.
    interruptRun(store, row, reason, now < row.updated_at ? row.updated_at : now);
  }
}
/** Explicit fencing, not crash detection. A former owner must stop at its next operation. */
export function recoverManagedRuns(store: Store, taskId: string, clock: Clock): void {
  if (!IdSchema.safeParse(taskId).success) throw new ManagedFailure('scope_revoked');
  const now = managedNow(clock);
  store.transaction(() => {
    lockTask(store, taskId);
    interruptManagedRuns(store, taskId, 'restart', now);
  });
}
interface RecordRow {
  sequence: number;
  request_id: string;
  occurred_at: string;
  payload: string;
}
export function putUsage(store: Store, row: RunRow, usage: UsageEnvelope, now: string): void {
  const prior = store.all<RecordRow>('SELECT * FROM observation_records WHERE run_id=? AND (sequence=? OR request_id=?)', [
    row.id,
    usage.sequence,
    usage.request_id
  ]);
  const encoded = JSON.stringify(usage.payload);
  if (prior.length) {
    if (
      prior.length !== 1 ||
      prior[0]!.sequence !== usage.sequence ||
      prior[0]!.request_id !== usage.request_id ||
      prior[0]!.occurred_at !== usage.occurred_at ||
      prior[0]!.payload !== encoded
    )
      throw new ManagedFailure('identity_conflict');
    return;
  }
  const metadata = TaskMetadataSchema.parse(JSON.parse(store.get<TaskRow>('SELECT * FROM tasks WHERE id=?', [row.task_id])!.metadata) as unknown);
  const payload = usage.payload;
  if (
    payload.product !== 'synthetic' ||
    payload.product_version !== '1.0.0' ||
    payload.model !== metadata.model ||
    !row.submitted_at ||
    Date.parse(usage.occurred_at) < Date.parse(row.submitted_at) ||
    Date.parse(usage.occurred_at) > Date.parse(now)
  )
    throw new ManagedFailure('invalid_envelope');
  if (
    (payload.input_total.status === 'observed' && payload.cached_input.status === 'observed' && payload.cached_input.value > payload.input_total.value) ||
    (payload.output_total.status === 'observed' &&
      payload.reasoning_output.status === 'observed' &&
      payload.reasoning_output.value > payload.output_total.value)
  )
    throw new ManagedFailure('invalid_envelope');
  const eventId = randomUUID();
  store.putEvent({
    id: eventId,
    source_key: eventId,
    project_id: row.project_id,
    task_id: row.task_id,
    session_id: row.session_id,
    occurred_at: usage.occurred_at,
    payload
  });
  store.execute('INSERT INTO observation_records(run_id,sequence,request_id,occurred_at,event_id,payload) VALUES (?,?,?,?,?,?)', [
    row.id,
    usage.sequence,
    usage.request_id,
    usage.occurred_at,
    eventId,
    encoded
  ]);
}
export function runEvidence(store: Store, row: RunRow, metric: CoverageMetric): CoverageEvidence {
  const records = store.all<{ payload: string }>('SELECT payload FROM observation_records WHERE run_id=?', [row.id]);
  return {
    profileId: 'synthetic-coverage-v1',
    metric,
    facts: decodeFacts(metric === 'input_total' ? row.input_facts : row.output_facts),
    hasObservedValue: records.some(record => (JSON.parse(record.payload) as UsageEnvelope['payload'])[metric].status === 'observed')
  };
}
export function taskManagedEvidence(store: Store, taskId: string, metric: CoverageMetric): CoverageEvidence {
  const rows = store.all<RunRow>('SELECT * FROM observation_runs WHERE task_id=? ORDER BY started_at,id', [taskId]);
  const completed = rows.filter(row => !isOpen(row)).map(row => runEvidence(store, row, metric));
  const empty = Object.fromEntries(Object.keys(initialFacts()).map(key => [key, 'unknown'])) as Facts;
  const facts = completed.length ? completed.slice(1).reduce((acc, current) => mergeCoverageFacts(acc, current.facts), completed[0]!.facts) : empty;
  // In-flight snapshots are never merged into durable completed interval facts.
  // A task projection with an open interval cannot advertise terminal closure/flush.
  if (rows.some(isOpen)) {
    if (facts.terminalAccounting === 'verified') facts.terminalAccounting = 'unknown';
    if (facts.durableFlush === 'verified') facts.durableFlush = 'unknown';
  }
  return { profileId: 'synthetic-coverage-v1', metric, facts, hasObservedValue: rows.some(row => runEvidence(store, row, metric).hasObservedValue) };
}
