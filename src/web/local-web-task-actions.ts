import { applicationRequired } from '../harness-application.js';
import { registerBindingCollectionControl } from '../external-session-contract.js';
import { prepareExternalTask, type ExternalTaskSetup } from '../external-session-service.js';
import { ordinaryTask } from '../ordinary-observation.js';
import type { LocalWebProfile } from './local-web-profile.js';
import type { PrivateTask } from './local-web-metadata-store.js';
import type { createSharedSetupManager } from './local-web-shared.js';
import { assertSharedTask } from './local-web-shared-guard.js';
import { localWebError, type LocalWebDomain } from './local-web-server.js';
import { localWebApplicationAction, type LocalWebApplicationActionDependencies } from './local-web-application-actions.js';
import { localWebOrdinaryAction, type LocalWebOrdinaryActionDependencies } from './local-web-ordinary-actions.js';
import { localWebWorkflowAction, type LocalWebWorkflowActionDependencies, type LocalWebScopedTaskAction } from './local-web-workflow-actions.js';

export interface LocalWebTaskActionDependencies
  extends LocalWebWorkflowActionDependencies, LocalWebOrdinaryActionDependencies, LocalWebApplicationActionDependencies {
  readonly row: (id: string) => PrivateTask;
  readonly setupFor: (record: PrivateTask) => ExternalTaskSetup;
  readonly profileFor: (id: string) => LocalWebProfile;
  readonly sharedSetups: ReturnType<typeof createSharedSetupManager>;
}

function prepareTask(deps: LocalWebTaskActionDependencies, request: LocalWebScopedTaskAction) {
  const { id, action, record, setup } = request;
  const { store, metadata, sharedSetups, profileFor, taskDto } = deps;
  if (action === 'apply' && setup.workflow.application) throw new Error('application_required');
  if (applicationRequired(store, id)) {
    if (action === 'apply') throw new Error('application_required');
    assertSharedTask(store, id, undefined, true);
    return taskDto(id);
  }
  const profile = profileFor(record.profile_id);
  sharedSetups.assertProfile(profile);
  if (store.get('SELECT id FROM tasks WHERE id=?', [id])) assertSharedTask(store, id);
  if (profile.shared_binding) {
    const pins = sharedSetups.journalTask(profile, id, true)!;
    store.execute('INSERT OR IGNORE INTO shared_configuration_tasks(task_id,project_id,settings_hash,setup_hash) VALUES(?,?,?,?)', [
      id,
      setup.workflow.assignment.project_id,
      pins.settingsHash,
      pins.setupHash
    ]);
  }
  try {
    prepareExternalTask(store, setup, action === 'apply');
    assertSharedTask(store, id, undefined, !!setup.workflow.application);
    if (profile.session_binding) registerBindingCollectionControl(store, id);
    metadata.setReason(id, null);
  } catch (error) {
    metadata.setReason(id, localWebError(error));
    throw error;
  }
  return taskDto(id);
}

// This async declaration owns the comparison promise; removing it changes rejection delivery.
async function comparisonTaskAction(deps: LocalWebTaskActionDependencies, request: LocalWebScopedTaskAction) {
  const { action, record, id } = request;
  if (action === 'prepare' || action === 'apply') return prepareTask(deps, request);
  if (
    deps.profileFor(record.profile_id).shared_binding &&
    !['pause', 'release', 'finish-success', 'finish-failed', 'finish-abandoned', 'rework', 'recover', 'revoke-collection'].includes(action)
  )
    assertSharedTask(deps.store, id);
  return localWebWorkflowAction(deps, request);
}

export function createLocalWebTaskActions(deps: LocalWebTaskActionDependencies): LocalWebDomain['taskAction'] {
  const { options, store, row, setupFor } = deps;
  return (id, action, input) => {
    try {
      if (
        options.nativePilot &&
        (id !== options.nativePilot.taskId ||
          ![
            'prepare',
            'apply',
            'session-connect',
            'pause',
            'revoke-collection',
            'resume-binding',
            'finish-success',
            'finish-failed',
            'finish-abandoned',
            'release'
          ].includes(action))
      )
        throw new Error('binding_pilot_control_only');
      if (
        options.qualificationLease &&
        (id !== store.get<{ task_id: string }>('SELECT task_id FROM binding_qualification WHERE singleton=1')?.task_id ||
          !['session-connect', 'pause', 'resume-binding', 'emergency-stop'].includes(action))
      )
        throw new Error('binding_qualification_control_only');
      const record = row(id);
      if (ordinaryTask(store, id)) return localWebOrdinaryAction(deps, { id, action, input });
      const setup = setupFor(record);
      const request = { id, action, input, record, setup };
      if (['application-start', 'application-execute', 'application-permission-decide', 'application-recover', 'application-publish'].includes(action))
        throw new Error('application_managed_retired');
      if (
        [
          'application-prepare',
          'application-open',
          'application-checkpoint',
          'application-report',
          'application-identity',
          'application-cancel',
          'application-mode'
        ].includes(action)
      )
        return localWebApplicationAction(deps, request);
      return comparisonTaskAction(deps, request);
    } catch (error) {
      return new Promise(() => {
        throw error;
      });
    }
  };
}
