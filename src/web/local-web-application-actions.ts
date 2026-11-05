import { z } from 'zod';
import {
  ApplicationSelectionSchema,
  ApplicationCheckpointSchema,
  ApplicationReportSchema,
  ApplicationIdentitySchema
} from '../harness/harness-application-contract.js';
import type { ApplicationCoordinator } from '../harness-application.js';
import type { SessionBindingProvider } from '../session-binding-contract.js';
import { convertTaskToAgentApplication } from './local-web-task-application.js';
import type { LocalWebWorkflowActionDependencies, LocalWebScopedTaskAction } from './local-web-workflow-actions.js';

export interface LocalWebApplicationActionDependencies extends Pick<LocalWebWorkflowActionDependencies, 'store' | 'jobs' | 'running' | 'taskDto'> {
  readonly applications: ApplicationCoordinator;
  readonly providers: Map<string, SessionBindingProvider[]>;
  readonly providersForTask: (id: string, deletedProjectRoot?: string) => SessionBindingProvider[];
}

export async function localWebApplicationAction(
  deps: LocalWebApplicationActionDependencies,
  request: Pick<LocalWebScopedTaskAction, 'id' | 'action' | 'input' | 'setup'>
) {
  const { id, action, input, setup } = request;
  const { store, applications, providers, providersForTask, jobs, running, taskDto } = deps;
  if (action === 'application-prepare') {
    providers.delete(id);
    applications.prepareHandoff(id, ApplicationSelectionSchema.parse(input));
    return taskDto(id);
  }
  if (action === 'application-open') {
    await applications.open(id, z.string().parse(input.origin));
    return taskDto(id);
  }
  if (action === 'application-checkpoint') return applications.checkpoint(id, ApplicationCheckpointSchema.parse(input));
  if (action === 'application-report') {
    applications.report(id, ApplicationReportSchema.parse(input));
    return taskDto(id);
  }
  if (action === 'application-identity') {
    const request = ApplicationIdentitySchema.parse(input);
    applications.context(id, request.attempt_id);
    const provider = providersForTask(id).find(p => p.product === request.product);
    if (!provider?.resolveApplicationIdentity || provider.capabilities().currentIdentity === 'unavailable') throw new Error('application_identity_unavailable');
    const identity = await provider.resolveApplicationIdentity({ receipt: request.receipt });
    return applications.registerIdentity(id, request.attempt_id, identity);
  }
  if (action === 'application-cancel') {
    applications.cancel(id);
    return taskDto(id);
  }
  if (action === 'application-mode') {
    z.strictObject({ mode: z.literal('agent_applied') }).parse(input);
    if (jobs.has(id) || running(id).length) throw new Error('workflow_run_active');
    convertTaskToAgentApplication(store, id, setup.preparation);
    providers.delete(id);
    return taskDto(id);
  }
  throw new Error('invalid_ui_request');
}
