import { projectBaseline } from './local-web-native.js';
import { randomUUID } from 'node:crypto';
import { buildExternalTaskSetup, createExternalTask, prepareExternalTask } from '../external-session-service.js';
import type { ExternalTaskSetup } from '../external-session-service.js';
import { createOrdinaryTask, ordinaryTaskSettings } from '../ordinary-observation.js';
import { registerBindingCollectionControl } from '../external-session-contract.js';
import { withLiveWebMetadataScope } from './local-web-metadata.js';
import { assertSharedTask } from './local-web-shared-guard.js';
import { localWebError } from './local-web-server.js';
import type { LocalWebDomain, LocalWebCreateTaskInput } from './local-web-server.js';
import type { createLocalWebMetadata } from './local-web-metadata-store.js';
import type { createSharedSetupManager } from './local-web-shared.js';
import type { LocalWebProfile } from './local-web-profile.js';
import type { LocalWebDomainOptions } from './local-web-domain.js';

type TaskCreationDependencies = {
  readonly profileFor: (id: string) => LocalWebProfile;
  readonly taskDto: LocalWebDomain['task'];
  readonly sharedSetups: ReturnType<typeof createSharedSetupManager>;
  readonly metadata: ReturnType<typeof createLocalWebMetadata>;
};
function createTask(input: LocalWebCreateTaskInput, options: LocalWebDomainOptions, dependencies: TaskCreationDependencies) {
  const store = options.store;
  const { profileFor, taskDto, sharedSetups, metadata } = dependencies;
  if (options.nativePilot) throw new Error('binding_pilot_control_only');
  if (options.qualificationLease) throw new Error('binding_qualification_control_only');
  if ('mode' in input) {
    const id = createOrdinaryTask(store, {
      project_id: input.project_id,
      criterion_ids: input.criterion_ids,
      ...(input.type ? { type: input.type } : {}),
      ...(input.size ? { expected_size: input.size } : {}),
      ...(input.assignee ? { assignee: input.assignee } : {})
    });
    withLiveWebMetadataScope(store, { taskId: id, projectId: input.project_id }, () => {
      metadata.insertTask({ id: id, name: input.name, profileId: 'ordinary-claude', setup: ordinaryTaskSettings(store, id), projectId: input.project_id });
    });
    return Promise.resolve(taskDto(id));
  }
  const profile = profileFor(input.setup_id);
  const existing = store.get<{ local_root: string }>('SELECT local_root FROM projects WHERE id=?', [input.project_id]);
  if (!existing || profile.setup.workflow.assignment.project_id !== input.project_id) throw new Error('unknown_project');
  const base = buildExternalTaskSetup(store, { id: profile.id, setup: profile.setup }, { projectId: input.project_id });
  const setup: ExternalTaskSetup = {
    ...base,
    workflow: {
      ...base.workflow,
      assignment: {
        ...base.workflow.assignment,
        code_base_commit: projectBaseline(existing.local_root),
        metadata: {
          ...base.workflow.assignment.metadata,
          ...(input.type ? { type: input.type } : {}),
          ...(input.size ? { expected_size: input.size } : {})
        }
      }
    }
  };
  if (profile.shared_binding) {
    sharedSetups.assertProfile(profile);
    const id = randomUUID();
    const reserved: ExternalTaskSetup = {
      ...setup,
      workflow: {
        ...setup.workflow,
        confirmation_id: randomUUID(),
        assignment: { ...setup.workflow.assignment, task_id: id, logical_task_id: randomUUID(), alias_ids: [randomUUID()] }
      }
    };
    const pins = sharedSetups.journalTask(profile, id)!;
    withLiveWebMetadataScope(store, { projectId: input.project_id }, () => {
      store.execute('INSERT INTO shared_configuration_tasks(task_id,project_id,settings_hash,setup_hash) VALUES(?,?,?,?)', [
        id,
        input.project_id,
        pins.settingsHash,
        pins.setupHash
      ]);
      metadata.insertTask({
        id: id,
        name: input.name,
        profileId: profile.id,
        setup: reserved,
        projectId: input.project_id,
        reason: 'shared_preparation_pending'
      });
    });
    try {
      prepareExternalTask(store, reserved, false);
      assertSharedTask(store, id, undefined, true);
      metadata.setReason(id, null);
      if (profile.session_binding) registerBindingCollectionControl(store, id);
    } catch (error) {
      metadata.setReason(id, localWebError(error));
    }
    return Promise.resolve(taskDto(id));
  }
  const created = createExternalTask(store, setup, false);
  const id = created.state.task_id;
  if (profile.session_binding) registerBindingCollectionControl(store, id);
  withLiveWebMetadataScope(store, { taskId: id, projectId: input.project_id }, () => {
    metadata.insertTask({ id: id, name: input.name, profileId: profile.id, setup: created.setup, projectId: input.project_id });
  });
  return Promise.resolve(taskDto(id));
}
export function createLocalWebTaskCreation(options: LocalWebDomainOptions, dependencies: TaskCreationDependencies): LocalWebDomain['createTask'] {
  return input => createTask(input, options, dependencies);
}
