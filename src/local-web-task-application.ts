import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { comparisonVariant } from './comparison.js';
import { bindingCollectionControl } from './external-session-contract.js';
import { applicationRequired, requireApplication } from './harness-application.js';
import { durablePrivateBytes } from './harness-application-files.js';
import { hashBytes, readRepositoryFile } from './harness-config.js';
import { verifyCommonArtifacts, type ExternalPreparationSpec } from './harness-managed-file.js';
import { assertSharedTask, sharedTaskPair } from './local-web-shared-guard.js';
import { utcNow, type Clock } from './lifecycle.js';
import type { Store } from './store.js';

const usedTables = ['sessions', 'events', 'active_intervals', 'attempts', 'observations', 'outcomes', 'session_bindings',
  'codex_workflow_runs', 'codex_workflow_children', 'claude_workflow_runs', 'external_start_tickets', 'observation_gaps', 'observation_runs',
  'otel_processes', 'runtime_evidence', 'comparison_deviations', 'session_binding_forgets', 'exchange_tasks'] as const;

function taskApplicationConversionBlocker(store: Store, taskId: string): string | null {
  const task = store.get<{ state: string; started_at: string | null }>('SELECT state,started_at FROM tasks WHERE id=?', [taskId]);
  if (!task) return 'unknown_task';
  if (!store.get('SELECT 1 FROM shared_configuration_tasks WHERE task_id=?', [taskId]) ||
      !store.get('SELECT 1 FROM comparison_assignments WHERE task_id=?', [taskId])) return 'application_mode_unsupported';
  if (task.state !== 'registered' || task.started_at ||
      usedTables.some(table => store.get(`SELECT 1 FROM ${table} WHERE task_id=?`, [taskId])) ||
      bindingCollectionControl(store, taskId)?.revoked_at ||
      store.get('SELECT 1 FROM external_preparations WHERE task_id=? AND first_connected_at IS NOT NULL', [taskId]) ||
      store.get('SELECT 1 FROM external_task_contracts WHERE task_id=? AND started_at IS NOT NULL', [taskId])) return 'application_mode_locked';
  return null;
}

/**
 * Adds agent-application authority to one unused shared task. The comparison file,
 * shared setup, frozen protocol and assignment keep their bytes; only this task's
 * application marker and preparation state change. No file is applied here.
 */
export function convertTaskToAgentApplication(store: Store, taskId: string, spec: ExternalPreparationSpec, clock: Clock = utcNow) {
  const replay = applicationRequired(store, taskId);
  if (!replay) {
    const blocker = taskApplicationConversionBlocker(store, taskId);
    if (blocker) throw new Error(blocker);
    // The instruction-only pins, including original tool files, must hold at the switch.
    assertSharedTask(store, taskId, clock, true);
  }
  const shared = sharedTaskPair(store, taskId, clock);
  if (!shared) throw new Error('application_mode_unsupported');
  const directory = `.harness-delta/applications/${taskId}`;
  const recordPath = `${directory}/mode-change.json`;
  const converted = shared.pair.descriptor.application === 'selected_markdown_only';
  const procedure = () => ({ origin: shared.root, bundlePath: shared.reference.path, bundleHash: shared.bundle.bundle_hash,
    common: spec.common_artifacts.map(file => { const path = relative(shared.root, file.path); return { path, hash: hashBytes(readRepositoryFile(shared.root, path)) }; }) });
  if (!replay) {
    verifyCommonArtifacts(spec);
    if (comparisonVariant(store, shared.variantId).instruction_manifest_hash !== shared.bundle.instruction_manifest_hash) throw new Error('application_input_changed');
    requireApplication(store, taskId, procedure());
  }
  const marker = store.get<{ input_hash: string; current_job: string | null; epoch: number }>('SELECT input_hash,current_job,epoch FROM harness_application_tasks WHERE task_id=?', [taskId]);
  // The marker commits before its private file: a repeat finishes an interrupted change from the pinned hash.
  if (replay && converted && marker && !existsSync(join(shared.root, `${directory}/procedure.json`))) {
    const bytes = Buffer.from(JSON.stringify(procedure()));
    if (hashBytes(bytes) !== marker.input_hash) throw new Error('application_input_changed');
    durablePrivateBytes(shared.root, `${directory}/procedure.json`, bytes);
  }
  if (!replay || converted && marker && !marker.current_job && marker.epoch === 0)
    store.execute("UPDATE external_preparations SET state='preparation_needed',reason_code=NULL WHERE task_id=?", [taskId]);
  if (converted && !existsSync(join(shared.root, recordPath))) durablePrivateBytes(shared.root, recordPath, Buffer.from(JSON.stringify({
    kind: 'harness-delta.task-application-mode', schema_version: 1, task_id: taskId,
    from: 'selected_markdown_only', to: 'agent_applied', recorded_at: clock(), variant_id: shared.variantId,
    bundle_path: shared.reference.path, bundle_hash: shared.bundle.bundle_hash,
    settings_hash: shared.marker.settings_hash, setup_hash: shared.marker.setup_hash,
  }) + '\n'));
  return { task_id: taskId, application_mode: 'agent_applied' as const, changed: !replay };
}
