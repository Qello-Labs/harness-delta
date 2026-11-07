import { randomUUID } from 'node:crypto';
import { CodexWorkflowExecutionSchema } from '../codex-workflow-adapter.js';
import { ExternalTaskSetupSchema } from '../workflow/external-session-service.js';
import type { Store } from '../store.js';
import type { createLocalWebMetadata, PrivateTask, Source } from './local-web-metadata-store.js';
import type { createSharedSetupManager } from './local-web-shared.js';

export function createLocalWebTaskRecords(
  store: Store,
  metadata: ReturnType<typeof createLocalWebMetadata>,
  sharedSetups: ReturnType<typeof createSharedSetupManager>
) {
  const profiles = metadata.profiles;
  const row = (id: string) => {
    const result = metadata.task(id);
    if (!result) throw new Error('unknown_task');
    if (store.get("SELECT 1 FROM tombstones WHERE kind='task' AND id=?", [id])) throw new Error('unknown_task');
    if (!store.get('SELECT id FROM tasks WHERE id=?', [id])) {
      const setup = ExternalTaskSetupSchema.parse(JSON.parse(result.setup) as unknown);
      if (!profileFor(result.profile_id).shared_binding || !store.get('SELECT id FROM projects WHERE id=?', [setup.workflow.assignment.project_id]))
        throw new Error('unknown_task');
    }
    return result;
  };
  const setupFor = (task: PrivateTask) => ExternalTaskSetupSchema.parse(JSON.parse(task.setup) as unknown);
  const profileFor = (id: string) => {
    const result = profiles().find(p => p.id === id);
    if (!result) throw new Error('unknown_setup');
    return result;
  };
  const sourceFor = (task: PrivateTask) => (task.source === null ? null : (JSON.parse(task.source) as Source));
  const executionFor = (task: PrivateTask, operation: 'link' | 'collect', source: Source) =>
    CodexWorkflowExecutionSchema.parse({
      ...profileFor(task.profile_id).execution,
      run_id: randomUUID(),
      operation,
      session_id: source.session_id,
      source_path: source.path
    });
  const running = (id: string) =>
    store.all<{ id: string; stop_requested: number }>("SELECT id,stop_requested FROM codex_workflow_runs WHERE task_id=? AND state='running'", [id]);
  for (const record of metadata.tasks()) {
    if (store.get("SELECT 1 FROM tombstones WHERE kind='task' AND id=?", [record.id])) continue;
    if (record.profile_id === 'ordinary-claude') continue;
    const profile = profileFor(record.profile_id);
    if (!profile.shared_binding) continue;
    try {
      const pins = sharedSetups.journalTask(profile, record.id, true)!;
      store.execute('INSERT OR IGNORE INTO shared_configuration_tasks(task_id,project_id,settings_hash,setup_hash) VALUES(?,?,?,?)', [
        record.id,
        setupFor(record).workflow.assignment.project_id,
        pins.settingsHash,
        pins.setupHash
      ]);
    } catch {
      metadata.setReason(record.id, 'shared_binding_changed');
    }
  }

  return { row, setupFor, profileFor, sourceFor, executionFor, running };
}
