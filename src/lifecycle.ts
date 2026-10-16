import { parseTaskMetadata } from './flexible-contracts.js';
import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { requireConfigurationConfirmation, bindConfigurationToSession } from './config-confirmation.js';
import { assertCompatibilityAllowed, pinSessionCompatibility, resolveSourceCompatibility } from './source-compatibility.js';
import { IdSchema, ProductVersionSchema, TimestampSchema } from './contracts.js';
import type { Store } from './store.js';
import { interruptManagedRuns } from './managed-journal.js';
import { authorizeCandidateScope } from './nested-candidate.js';
import { revokeOtelProcesses } from './otel-journal.js';
import { recordInFlightWorkflowGaps, recordObservationGap } from './runtime-history.js';

export type TaskState = 'registered' | 'active' | 'paused' | 'finalized';
export type Outcome = 'success' | 'failed' | 'aborted';
export interface TaskRow {
  id: string; project_id: string; metadata: string; state: TaskState;
  registered_at: string; started_at: string | null; first_completed_at: string | null;
  finalized_at: string | null; first_success: number | null; generation: number;
  last_transition_at: string | null; first_assessed_at: string | null;
}
export type Clock = () => string;
export const utcNow: Clock = () => new Date().toISOString();

export class Lifecycle {
  constructor(private readonly store: Store, private readonly clock: Clock = utcNow) {}

  registerProject(id: string, root: string): void {
    IdSchema.parse(id);
    const localRoot = realpathSync(root);
    if (!statSync(localRoot).isDirectory()) throw new Error('invalid_project_root');
    this.store.immediateTransaction(() => {
      this.rejectDeleted('project', id);
      this.store.execute('INSERT INTO projects(id,local_root) VALUES (?,?)', [id, localRoot]);
    });
  }

  createTask(projectId: string, taskId: string, input: unknown): void {
    IdSchema.parse(projectId); IdSchema.parse(taskId);
    const metadata = parseTaskMetadata(input);
    const now = this.now();
    this.store.immediateTransaction(() => {
      this.rejectDeleted('task', taskId); this.rejectDeleted('project', projectId);
      if (!this.store.get('SELECT id FROM projects WHERE id = ?', [projectId])) throw new Error('unknown_project');
      this.store.execute('INSERT OR IGNORE INTO users(id) VALUES (?)', [metadata.assignee]);
      this.store.execute('INSERT INTO tasks(id,project_id,metadata,registered_at,last_transition_at) VALUES (?,?,?,?,?)',
        [taskId, projectId, JSON.stringify(metadata), now, now]);
    });
  }

  state(taskId: string): TaskState { return this.task(taskId).state; }

  task(taskId: string): TaskRow {
    const task = this.store.get<TaskRow>('SELECT * FROM tasks WHERE id = ?', [IdSchema.parse(taskId)]);
    if (!task) throw new Error('unknown_task');
    return task;
  }

  start(taskId: string): void { this.transition(taskId, 'registered', 'active'); }
  pause(taskId: string): void { this.transition(taskId, 'active', 'paused'); }
  resume(taskId: string): void { this.transition(taskId, 'paused', 'active'); }

  private transition(taskId: string, from: TaskState, to: TaskState): void {
    this.store.immediateTransaction(() => {
      const task = this.task(taskId);
      if (task.state !== from) throw new Error('invalid_transition');
      parseTaskMetadata(JSON.parse(task.metadata) as unknown);
      const now = this.now(task);
      if (to === 'active') requireConfigurationConfirmation(this.store, taskId, now);
      if (from === 'active') recordInFlightWorkflowGaps(this.store, taskId, now);
      this.store.execute('UPDATE tasks SET state = ?, started_at = COALESCE(started_at, ?), generation = generation + 1, last_transition_at = ? WHERE id = ?',
        [to, now, now, taskId]);
      if (to === 'active') {
        this.store.execute('INSERT INTO active_intervals(id,task_id,started_at) VALUES (?,?,?)', [randomUUID(), taskId, now]);
        if (from === 'registered') {
          this.store.execute('INSERT INTO attempts(id,task_id,kind,started_at) VALUES (?,?,?,?)', [randomUUID(), taskId, 'first', now]);
        }
      } else {
        interruptManagedRuns(this.store, taskId, 'pause', now);
        revokeOtelProcesses(this.store, taskId, 'pause', now);
        this.store.execute('UPDATE active_intervals SET ended_at = ? WHERE task_id = ? AND ended_at IS NULL', [now, taskId]);
      }
    });
  }

  declareFirst(taskId: string): void {
    this.store.immediateTransaction(() => {
      const task = this.task(taskId);
      if (task.state !== 'active' || task.first_completed_at) throw new Error('invalid_transition');
      const now = this.now(task);
      this.store.execute('UPDATE tasks SET first_completed_at = ?, last_transition_at = ? WHERE id = ?', [now, now, taskId]);
      this.store.execute('UPDATE attempts SET ended_at = ? WHERE task_id = ? AND ended_at IS NULL', [now, taskId]);
    });
  }

  assessFirst(taskId: string, successful: boolean): void {
    z.boolean().parse(successful);
    this.store.immediateTransaction(() => {
      const task = this.task(taskId);
      if (task.state === 'finalized' || !task.first_completed_at || task.first_success !== null) throw new Error('invalid_transition');
      const now = this.now(task);
      this.store.execute('UPDATE tasks SET first_success = ?, first_assessed_at = ?, last_transition_at = ? WHERE id = ?', [successful ? 1 : 0, now, now, taskId]);
    });
  }

  rework(taskId: string): void {
    this.store.immediateTransaction(() => {
      const task = this.task(taskId);
      if (task.state !== 'active' || !task.first_completed_at) throw new Error('invalid_transition');
      const now = this.now(task);
      this.store.execute('UPDATE attempts SET ended_at = ? WHERE task_id = ? AND ended_at IS NULL', [now, taskId]);
      this.store.execute('INSERT INTO attempts(id,task_id,kind,started_at) VALUES (?,?,?,?)', [randomUUID(), taskId, 'rework', now]);
      this.store.execute('UPDATE tasks SET last_transition_at = ? WHERE id = ?', [now, taskId]);
    });
  }

  finalize(taskId: string, outcome: Outcome, criteriaMet: string[]): void {
    z.enum(['success', 'failed', 'aborted']).parse(outcome);
    z.array(IdSchema).refine(ids => new Set(ids).size === ids.length).parse(criteriaMet);
    this.store.immediateTransaction(() => {
      const task = this.task(taskId);
      const unstartedOrdinaryAbandon = task.state === 'registered' && outcome === 'aborted' &&
        this.store.get('SELECT task_id FROM ordinary_tasks WHERE task_id=?', [taskId]);
      if (task.state !== 'active' && task.state !== 'paused' && !unstartedOrdinaryAbandon) throw new Error('invalid_transition');
      const metadata = parseTaskMetadata(JSON.parse(task.metadata) as unknown);
      if (criteriaMet.some(id => !metadata.criterion_ids.includes(id)) ||
          (outcome === 'success' && criteriaMet.length !== metadata.criterion_ids.length)) throw new Error('invalid_criteria');
      const now = this.now(task);
      if (outcome === 'aborted' && this.store.get('SELECT id FROM comparison_assignments WHERE task_id = ?', [taskId])) {
        this.store.execute('INSERT INTO comparison_deviations(id,task_id,occurred_at,recorded_at,reason_code) VALUES (?,?,?,?,?)',
          [randomUUID(), taskId, now, now, 'cancellation']);
      }
      if (task.state === 'active') recordInFlightWorkflowGaps(this.store, taskId, now);
      const bindings = this.store.all<{ session_id: string; observed_since: string; gaps: string }>(
        `SELECT b.session_id,b.observed_since,b.gaps FROM session_bindings b
         JOIN binding_root_segments s ON s.root_session_id=b.root_id
         WHERE s.task_id=? AND s.state!='closed'`, [taskId]);
      for (const binding of bindings) {
        if (task.state === 'active') recordObservationGap(this.store, taskId, binding.session_id,
          binding.observed_since, now, 'incomplete', now);
        const gaps = z.array(z.string()).parse(JSON.parse(binding.gaps));
        this.store.execute("UPDATE session_bindings SET state='stopped',cursor=NULL,gaps=? WHERE session_id=?",
          [JSON.stringify([...new Set([...gaps, 'unobserved_interval'])]), binding.session_id]);
      }
      this.store.execute(`UPDATE binding_root_segments SET state='closed',revision=revision+1,
        observer_identity=NULL,closed_at=? WHERE task_id=? AND state!='closed'`, [now, taskId]);
      this.store.execute('UPDATE ordinary_tasks SET selected_root_id=NULL WHERE task_id=?', [taskId]);
      interruptManagedRuns(this.store, taskId, 'finalize', now);
      revokeOtelProcesses(this.store, taskId, 'finalize', now);
      this.store.execute('INSERT INTO outcomes(task_id,status,criteria_met,first_success,assessed_at) VALUES (?,?,?,?,?)',
        [taskId, outcome, JSON.stringify([...criteriaMet].sort()), task.first_success, now]);
      this.store.execute("UPDATE tasks SET state = 'finalized', finalized_at = ?, last_transition_at = ?, generation = generation + 1 WHERE id = ?", [now, now, taskId]);
      this.store.execute('UPDATE active_intervals SET ended_at = ? WHERE task_id = ? AND ended_at IS NULL', [now, taskId]);
      this.store.execute('UPDATE attempts SET ended_at = ? WHERE task_id = ? AND ended_at IS NULL', [now, taskId]);
    });
  }

  linkSession(taskId: string, sessionId: string, sourcePath: string, product: string, version: string, confirmationId?: string): void {
    IdSchema.parse(sessionId); z.enum(['codex', 'claude_code']).parse(product); ProductVersionSchema.parse(version);
    const compatibility = resolveSourceCompatibility(product, version, 'file');
    if (!compatibility) throw new Error('unsupported');
    const path = resolve(sourcePath);
    this.store.immediateTransaction(() => {
      const task = this.task(taskId);
      if (task.state === 'finalized') throw new Error('invalid_transition');
      this.rejectDeleted('session', sessionId);
      const metadata = parseTaskMetadata(JSON.parse(task.metadata) as unknown);
      if (metadata.product !== product) throw new Error('product_mismatch');
      if (this.store.get('SELECT id FROM comparison_assignments WHERE task_id = ?', [taskId]) && !confirmationId) throw new Error('configuration_confirmation_required');
      // OTel and file adapter observations must never be summed in one task report.
      if (this.store.get('SELECT id FROM otel_processes WHERE task_id = ?', [taskId])) throw new Error('source_conflict');
      assertCompatibilityAllowed(this.store, compatibility);
      if (compatibility.state !== 'verified' && this.store.get('SELECT id FROM comparison_assignments WHERE task_id=?', [taskId])) throw new Error('unsupported');
      this.store.execute('INSERT INTO sessions(id,project_id,task_id,source_path,product,product_version) VALUES (?,?,?,?,?,?)',
        [sessionId, task.project_id, taskId, path, product, version]);
      pinSessionCompatibility(this.store, sessionId, compatibility);
      if (confirmationId) bindConfigurationToSession(this.store, confirmationId, sessionId);
    });
  }

  /** Explicit candidate-only registration. Does not admit a production profile,
   * comparison assignment, native experiment or ordinary CLI collection. The
   * caller must authorize the exact fresh source before invoking this method. */
  linkCodexCandidateSession(taskId: string, projectId: string, sessionId: string, sourcePath: string,
    version: string, parentId: string | null): void {
    IdSchema.parse(sessionId); IdSchema.parse(projectId);
    if (version !== '0.160.0' || !sourcePath.startsWith('/') || resolve(sourcePath) !== sourcePath) throw new Error('candidate_scope_mismatch');
    if (parentId !== null) IdSchema.parse(parentId);
    this.store.immediateTransaction(() => {
      const task = this.task(taskId);
      if (task.state !== 'active' || task.project_id !== projectId) throw new Error('candidate_inactive_scope');
      for (const [kind, id] of [['project', projectId], ['task', taskId], ['session', sessionId]] as const) this.rejectDeleted(kind, id);
      const metadata = parseTaskMetadata(JSON.parse(task.metadata) as unknown);
      if (metadata.product !== 'codex' || ('schema_version' in metadata && metadata.schema_version === 2)) throw new Error('candidate_scope_mismatch');
      if (this.store.get(`SELECT 1 FROM comparison_assignments WHERE task_id=? UNION ALL SELECT 1 FROM otel_processes WHERE task_id=? UNION ALL SELECT 1 FROM observation_runs WHERE task_id=? UNION ALL SELECT 1 FROM events WHERE task_id=? AND json_extract(payload,'$.kind')!='usage' LIMIT 1`, [taskId, taskId, taskId, taskId])) throw new Error('candidate_mixed_sources');
      const links = this.store.all<{ id: string; parent_id: string | null; product: string; product_version: string }>('SELECT id,parent_id,product,product_version FROM sessions WHERE task_id=?', [taskId]);
      const roots = links.filter(link => link.parent_id === null);
      const parent = links.find(link => link.id === parentId);
      // Offline continuation is bounded to two independent roots, each with at
      // most one direct child. Existing single-family qualification is unchanged.
      if (links.some(link => link.product !== 'codex' || link.product_version !== version) || links.length >= 4 ||
        (parentId === null ? roots.length >= 2 : !parent || parent.parent_id !== null || links.some(link => link.parent_id === parentId)) ||
        this.store.get('SELECT 1 FROM sessions WHERE source_path=?', [sourcePath])) throw new Error('candidate_scope_mismatch');
      if (parentId !== null) this.rejectDeleted('session', parentId);
      authorizeCandidateScope(this.store, { projectId, taskId, allowedRootTurnIds: ['candidate-registration'], sessions: links.map(link => ({
        sessionId: link.id, rootSessionId: link.parent_id ?? link.id, parentSessionId: link.parent_id, sourceId: link.id,
        product: 'codex', nativeSessionId: link.id, processId: null, agentId: null,
      })) });
      this.store.execute('INSERT INTO sessions(id,project_id,task_id,parent_id,source_path,product,product_version) VALUES (?,?,?,?,?,?,?)',
        [sessionId, projectId, taskId, parentId, sourcePath, 'codex', version]);
    });
  }

  summary(taskId: string) {
    const task = this.task(taskId);
    const outcome = this.store.get<{ status: Outcome }>('SELECT status FROM outcomes WHERE task_id = ?', [taskId]);
    return { task_id: task.id, state: task.state, first_success: task.first_success === null ? null : Boolean(task.first_success),
      outcome: outcome?.status ?? null,
      rework_count: this.store.get<{ count: number }>("SELECT count(*) AS count FROM attempts WHERE task_id = ? AND kind = 'rework'", [taskId])?.count ?? 0 };
  }

  private rejectDeleted(kind: string, id: string): void {
    if (this.store.get('SELECT id FROM tombstones WHERE kind = ? AND id = ?', [kind, id])) throw new Error('deleted_identifier');
  }

  private now(task?: TaskRow): string {
    const now = new Date(TimestampSchema.parse(this.clock())).toISOString();
    if (task?.last_transition_at && Date.parse(now) < Date.parse(task.last_transition_at)) throw new Error('clock_regression');
    return now;
  }
}
