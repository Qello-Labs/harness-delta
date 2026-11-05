import { createHash } from 'node:crypto';
import { IdSchema, ReasonSchema, TimestampSchema } from './contracts.js';
import { parseComparison } from './comparison-contracts.js';
import { RuntimeEvidenceSchema, type RuntimeEvidence, type UsageEvent } from './flexible-contracts.js';
import type { Store } from './store.js';
export function requireActiveScope(store: Store, taskId: string, sessionId: string) {
  const scope = store.get<{ project_id: string; metadata: string; product: string | null }>(
    "SELECT t.project_id,t.metadata,s.product FROM tasks t JOIN sessions s ON s.task_id=t.id AND s.project_id=t.project_id WHERE t.id=? AND s.id=? AND t.state='active' AND NOT EXISTS (SELECT 1 FROM tombstones x WHERE (x.kind='task' AND x.id=t.id) OR (x.kind='project' AND x.id=t.project_id) OR (x.kind='session' AND x.id=s.id))",
    [taskId, sessionId]
  );
  if (!scope) throw new Error('inactive_scope');
  return scope;
}
export function recordRuntimeEvidence(store: Store, input: RuntimeEvidence): void {
  const evidence = parseComparison(RuntimeEvidenceSchema, input, 'invalid_runtime');
  store.immediateTransaction(() => {
    const scope = requireActiveScope(store, evidence.task_id, evidence.session_id);
    if (scope.product && scope.product !== evidence.product) throw new Error('scope_mismatch');
    const existing = store.get<{ payload: string }>('SELECT payload FROM runtime_evidence WHERE id=?', [evidence.id]);
    if (existing) {
      const before = parseComparison(RuntimeEvidenceSchema, JSON.parse(existing.payload) as unknown, 'invalid_runtime');
      if (JSON.stringify({ ...before, recorded_at: evidence.recorded_at }) !== JSON.stringify(evidence)) throw new Error('runtime_conflict');
      return;
    }
    store.execute('INSERT INTO runtime_evidence(id,task_id,session_id,project_id,occurred_at,recorded_at,payload) VALUES (?,?,?,?,?,?,?)', [
      evidence.id,
      evidence.task_id,
      evidence.session_id,
      scope.project_id,
      evidence.occurred_at,
      evidence.recorded_at,
      JSON.stringify(evidence)
    ]);
  });
}
export function putUsageWithEvidence(store: Store, event: UsageEvent, evidence: RuntimeEvidence | null): boolean {
  return store.immediateTransaction(() => {
    const scope = requireActiveScope(store, event.task_id, event.session_id);
    if (scope.project_id !== event.project_id) throw new Error('scope_mismatch');
    if (evidence) {
      if (
        evidence.task_id !== event.task_id ||
        evidence.session_id !== event.session_id ||
        !('schema_version' in event.payload) ||
        evidence.id !== event.payload.runtime_evidence_id
      )
        throw new Error('scope_mismatch');
      recordRuntimeEvidence(store, evidence);
    }
    return store.putEvent(event);
  });
}
export function readRuntimeHistory(store: Store, taskId: string, cutoff: string): RuntimeEvidence[] {
  parseComparison(IdSchema, taskId);
  const end = Date.parse(parseComparison(TimestampSchema, cutoff));
  return store
    .all<{ payload: string }>('SELECT payload FROM runtime_evidence WHERE task_id=? ORDER BY occurred_at,id', [taskId])
    .map(row => parseComparison(RuntimeEvidenceSchema, JSON.parse(row.payload) as unknown, 'invalid_runtime'))
    .filter(row => Date.parse(row.occurred_at) < end);
}
/** Gap for a run whose process vanished: starts after the last retained usage
 * from that run's session (or at run start), never backfilling the interval.
 * Returns false when the scope is no longer active, which forbids measurement writes. */
export function recordAbandonedRunGap(store: Store, taskId: string, sessionId: string, runStartedAt: string, now: string): boolean {
  const last = store.get<{ at: string | null }>('SELECT max(occurred_at) AS at FROM events WHERE task_id=? AND session_id=? AND occurred_at>=?', [
    taskId,
    sessionId,
    runStartedAt
  ])?.at;
  const from = last ? new Date(Math.min(Date.parse(now), Date.parse(last) + 1)).toISOString() : runStartedAt;
  try {
    recordObservationGap(store, taskId, sessionId, from, now, 'incomplete', now);
    return true;
  } catch {
    return false;
  }
}
/** A pause or finish revokes scope while a workflow run may still have a request in
 * flight; its adapter can no longer write. Mark that interval while the task is active. */
export function recordInFlightWorkflowGaps(store: Store, taskId: string, now: string): void {
  const runs = [
    ...store
      .all<{ session_id: string; started_at: string }>("SELECT session_id,started_at FROM claude_workflow_runs WHERE task_id=? AND state='running'", [taskId])
      .map(run => ({
        started_at: run.started_at,
        sessions: [run.session_id, ...store.all<{ id: string }>('SELECT id FROM sessions WHERE parent_id=?', [run.session_id]).map(row => row.id)]
      })),
    ...store
      .all<{ id: string; session_id: string | null; started_at: string }>(
        "SELECT id,session_id,started_at FROM codex_workflow_runs WHERE task_id=? AND state='running'",
        [taskId]
      )
      .map(run => ({
        started_at: run.started_at,
        sessions: [
          run.session_id,
          ...store.all<{ session_id: string }>('SELECT session_id FROM codex_workflow_children WHERE run_id=?', [run.id]).map(row => row.session_id)
        ].filter((id): id is string => id !== null)
      }))
  ];
  for (const run of runs) for (const session of run.sessions) recordAbandonedRunGap(store, taskId, session, run.started_at, now);
}
export function recordObservationGap(
  store: Store,
  taskId: string,
  sessionId: string,
  start: string,
  end: string | null,
  reason: string,
  recordedAt: string = new Date().toISOString()
): void {
  const startedAt = parseComparison(TimestampSchema, start);
  const endedAt = end === null ? null : parseComparison(TimestampSchema, end);
  parseComparison(ReasonSchema, reason, 'invalid_gap');
  parseComparison(TimestampSchema, recordedAt);
  if (endedAt && Date.parse(endedAt) < Date.parse(startedAt)) throw new Error('invalid_gap');
  store.immediateTransaction(() => {
    const scope = requireActiveScope(store, taskId, sessionId);
    store.execute('INSERT OR IGNORE INTO observation_gaps(id,task_id,session_id,project_id,started_at,ended_at,recorded_at,reason) VALUES (?,?,?,?,?,?,?,?)', [
      createHash('sha256')
        .update(JSON.stringify([taskId, sessionId, startedAt, endedAt, reason]))
        .digest('hex'),
      taskId,
      sessionId,
      scope.project_id,
      startedAt,
      endedAt,
      recordedAt,
      reason
    ]);
  });
}
