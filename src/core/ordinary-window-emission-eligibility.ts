import type { Store } from '../store.js';
import {
  assertOrdinaryWindowPrepared,
  ordinaryWindowDecisionKeyForSelection,
  ordinaryWindowDecisionKeyValues,
  ordinaryWindowDecisionStatus,
  type OrdinaryWindowDecisionKey
} from './ordinary-window-decision.js';

export function ordinaryWindowEmissionEligible(store: Store, key: OrdinaryWindowDecisionKey, projectRoot: string, at: string): boolean {
  const status = ordinaryWindowDecisionStatus(store, key, at);
  if (status.state !== 'recorded' || !status.decision) return false;
  const decision = status.decision;
  if (decision.decision_kind === 'trial' && decision.trial_project_root !== projectRoot) return false;
  const tasks = store.all<{ id: string }>(
    `SELECT t.id FROM tasks t JOIN projects p ON p.id=t.project_id
    JOIN ordinary_tasks o ON o.task_id=t.id JOIN ordinary_window_selections w ON w.task_id=t.id
    WHERE t.project_id=? AND p.local_root=? AND t.state IN ('registered','active') AND o.revoked_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM tombstones d WHERE (d.kind='task' AND d.id=t.id) OR (d.kind='project' AND d.id=p.id))
    AND NOT EXISTS (SELECT 1 FROM comparison_assignments c WHERE c.task_id=t.id)`,
    [key.project_id, projectRoot]
  );
  return tasks.some(task => {
    if (decision.decision_kind === 'trial' && decision.trial_task_id !== task.id) return false;
    try {
      const selection = assertOrdinaryWindowPrepared(store, task.id);
      return (
        JSON.stringify(ordinaryWindowDecisionKeyValues(ordinaryWindowDecisionKeyForSelection(selection))) ===
        JSON.stringify(ordinaryWindowDecisionKeyValues(key))
      );
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return false;
    }
  });
}
