import type { Lifecycle } from '../core/lifecycle.js';
import type { createOrdinarySessionBindingService } from '../ordinary-session-binding.js';
import type { LocalWebTaskReadContext } from './local-web-task-read.js';
import type { PrivateTask } from './local-web-task-projection.js';
import { ordinaryTask, ordinaryTaskSettings } from '../ordinary-observation.js';
import { parseTaskMetadata } from '../flexible-contracts.js';
import { getClaudeBindingAdmission } from '../claude-binding-admission.js';
import { inspectOrdinaryClaudeProjectSkill } from '../connect/claude-connect-readiness.js';
import { effectiveTaskWorkspace } from '../harness/harness-application.js';
import { ordinaryTaskVersion } from './local-web-task-projection.js';
import { localWebError } from './local-web-server.js';
import { assertOrdinaryWindowSurfaceClosed } from '../core/ordinary-window-store.js';
export function readOrdinaryTask(
  context: LocalWebTaskReadContext,
  id: string,
  record: PrivateTask
): {
  readonly id: string;
  readonly record: PrivateTask;
  readonly task: ReturnType<Lifecycle['task']>;
  readonly preparation: NonNullable<ReturnType<typeof ordinaryTask>>;
  readonly settings: ReturnType<typeof ordinaryTaskSettings>;
  readonly admission: NonNullable<ReturnType<typeof getClaudeBindingAdmission>>;
  readonly metadata: ReturnType<typeof parseTaskMetadata>;
  readonly binding: ReturnType<ReturnType<typeof createOrdinarySessionBindingService>['status']>;
  readonly summary: ReturnType<Lifecycle['summary']>;
  readonly activeMs: number | null;
  readonly finalized: boolean;
  readonly active: boolean;
  readonly connected: boolean;
  readonly revoked: boolean;
  readonly supported: boolean;
  readonly supportReason: string;
  readonly resumeAvailable: boolean;
  readonly version: string;
  readonly skill: ReturnType<typeof inspectOrdinaryClaudeProjectSkill>;
} {
  const { store, life, ordinaryBindings } = context;
  assertOrdinaryWindowSurfaceClosed(store, id);
  const task = life.task(id);
  const preparation: ReturnType<typeof ordinaryTask> = ordinaryTask(store, id);
  if (!preparation) throw new Error('ordinary_preparation_required');
  const settings = ordinaryTaskSettings(store, id);
  const admission = getClaudeBindingAdmission(settings.product_version);
  if (!admission) throw new Error('binding_source_unqualified');
  const metadata = parseTaskMetadata(JSON.parse(task.metadata));
  const binding = ordinaryBindings.status(id);
  const summary = life.summary(id);
  const end = Date.parse(task.finalized_at ?? new Date().toISOString());
  const activeMs =
    task.started_at === null
      ? null
      : store
          .all<{ started_at: string; ended_at: string | null }>('SELECT started_at,ended_at FROM active_intervals WHERE task_id=?', [id])
          .reduce(
            (total, interval) =>
              total + Math.max(0, Math.min(Date.parse(interval.ended_at ?? new Date(end).toISOString()), end) - Date.parse(interval.started_at)),
            0
          );
  const finalized = task.state === 'finalized';
  const active = binding.state === 'observing';
  const connected = binding.roots > 0;
  const revoked = preparation.revoked_at !== null;
  let supported = false;
  let supportReason = 'binding_source_unqualified';
  if (!finalized && !revoked) {
    try {
      supported = ordinaryBindings.sourceSupported(id, 'claude_code');
    } catch (error) {
      supportReason = localWebError(error);
    }
  }
  const resumeAvailable = !finalized && !revoked && task.state === 'paused' && ordinaryBindings.resumeAvailable(id);
  const version = ordinaryTaskVersion({ task, record, preparation, binding });
  const skill = inspectOrdinaryClaudeProjectSkill(effectiveTaskWorkspace(store, id));
  return {
    id,
    record,
    task,
    preparation,
    settings,
    admission,
    metadata,
    binding,
    summary,
    activeMs,
    finalized,
    active,
    connected,
    revoked,
    supported,
    supportReason,
    resumeAvailable,
    version,
    skill
  };
}
