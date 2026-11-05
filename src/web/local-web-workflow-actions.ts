import { z } from 'zod';
import type { CodexWorkflowExecutionSchema } from '../codex-workflow-adapter.js';
import { recoverCodexWorkflow } from '../codex-workflow-journal.js';
import { bindingCollectionControl, revokeBindingCollectionControl } from '../external-session-contract.js';
import {
  collectExternalTask,
  connectExternalTask,
  externalTaskState,
  issueExternalStartTicket,
  pauseExternalTask,
  recordExternalTaskOutcome,
  type ExternalTaskSetup
} from '../external-session-service.js';
import { releaseExternalWorkflow } from '../external-session-workflow.js';
import type { Lifecycle } from '../lifecycle.js';
import type { createLocalWebBindingSelection } from './local-web-binding-selection.js';
import type { Job } from './local-web-binding-observation.js';
import { bindingQualificationOwnerLive, revokeBindingQualification } from '../session-binding-qualification-lease.js';
import type { Store } from '../store.js';
import type { LocalWebDomainOptions } from './local-web-domain.js';
import type { createLocalWebMetadata, PrivateTask, Source } from './local-web-metadata-store.js';
import { localWebError, type LocalWebDomain } from './local-web-server.js';

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/);

export interface LocalWebTaskActionRequest {
  readonly id: string;
  readonly action: string;
  readonly input: Record<string, unknown>;
}
export interface LocalWebScopedTaskAction extends LocalWebTaskActionRequest {
  readonly record: PrivateTask;
  readonly setup: ExternalTaskSetup;
}
export interface LocalWebWorkflowActionDependencies {
  readonly store: Store;
  readonly metadata: ReturnType<typeof createLocalWebMetadata>;
  readonly options: LocalWebDomainOptions;
  readonly life: Lifecycle;
  readonly jobs: Map<string, Job>;
  readonly bindings: ReturnType<typeof createLocalWebBindingSelection>['bindings'];
  readonly taskDto: LocalWebDomain['task'];
  readonly sourceFor: (record: PrivateTask) => Source | null;
  readonly executionFor: (record: PrivateTask, operation: 'link' | 'collect', source: Source) => z.infer<typeof CodexWorkflowExecutionSchema>;
  readonly running: (id: string) => { id: string; stop_requested: number }[];
  readonly beginBindingObservation: (id: string) => void;
}

async function connectLegacySource(deps: LocalWebWorkflowActionDependencies, request: LocalWebScopedTaskAction) {
  const { id, input, record, setup } = request;
  const { store, metadata, executionFor, options } = deps;
  const stored = metadata.source(input.source_handle, id);
  if (!stored || record.startup === null) throw new Error('external_ticket_required');
  const source = JSON.parse(stored.payload) as Source;
  const execution = executionFor(record, 'link', source);
  const startup = JSON.parse(record.startup) as { ticket_id: string };
  await connectExternalTask(store, setup, execution, startup.ticket_id, options.adapterFactory?.(store, execution));
  metadata.connectSource(id, source);
  return deps.taskDto(id);
}

async function connectBinding(deps: LocalWebWorkflowActionDependencies, request: LocalWebTaskActionRequest) {
  const { id, input } = request;
  const { store, metadata, jobs, bindings, beginBindingObservation, taskDto, life } = deps;
  const product = z.enum(['codex', 'claude_code']).parse(input.product);
  const receipt = z.uuid().parse(input.receipt);
  const previous = jobs.get(id);
  if (previous) {
    previous.pauseRequested = true;
    await previous.promise;
  }
  let connection;
  try {
    connection = await bindings.connect(id, product, { receipt });
  } catch (error) {
    metadata.setReason(id, localWebError(error));
    // A rejected new receipt must not silently stop a previously authorized
    // live family. Failed baseline acquisition already pauses its scope.
    if (store.get<{ state: string }>('SELECT state FROM tasks WHERE id=?', [id])?.state === 'active' && bindings.status(id).roots > 0)
      beginBindingObservation(id);
    throw error;
  }
  metadata.setReason(id, null);
  beginBindingObservation(id);
  return {
    ...taskDto(id),
    connection: {
      ...connection,
      project_id: life.task(id).project_id,
      task_id: id,
      assigned_variant_id: externalTaskState(store, id).assigned_variant_id,
      identity_basis: 'native_metadata_receipt',
      evidence: 'server_verified_identity_source_and_relations',
      collection_active: true,
      cost_coverage: 'partial'
    }
  };
}

function observeLegacySource(deps: LocalWebWorkflowActionDependencies, request: LocalWebScopedTaskAction) {
  const { id, record, setup } = request;
  const { store, metadata, jobs, running, bindings, sourceFor, executionFor, options } = deps;
  if (jobs.has(id) || running(id).length) throw new Error('workflow_run_active');
  if (bindings.status(id).roots > 0) throw new Error('binding_identity_unavailable');
  const source = sourceFor(record);
  if (!source) throw new Error('external_connection_required');
  const execution = executionFor(record, 'collect', source);
  // Foreground core collection runs asynchronously; the mutation queue remains free for pause.
  const job = { promise: Promise.resolve(), pauseRequested: false };
  jobs.set(id, job);
  job.promise = collectExternalTask(store, setup, execution, options.adapterFactory?.(store, execution))
    .then(() => {
      metadata.setReason(id, null);
    })
    .catch((error: unknown) => {
      const reason = job.pauseRequested && error instanceof Error && error.message === 'workflow_scope_revoked' ? 'measurement_paused' : localWebError(error);
      metadata.setReason(id, reason);
    })
    .finally(() => {
      jobs.delete(id);
    });
}

async function measurementControl(deps: LocalWebWorkflowActionDependencies, request: LocalWebTaskActionRequest) {
  const { id, action } = request;
  const { store, jobs, bindings, options, beginBindingObservation, running } = deps;
  if (action === 'pause') {
    const job = jobs.get(id);
    if (job) job.pauseRequested = true;
    if (bindings.status(id).roots > 0) bindings.pause(id);
    else pauseExternalTask(store, id);
    await job?.promise;
  } else if (action === 'revoke-collection') {
    if (options.qualificationLease) throw new Error('binding_qualification_control_only');
    const job = jobs.get(id);
    if (job) job.pauseRequested = true;
    revokeBindingCollectionControl(store, id);
    if (bindings.status(id).roots > 0) bindings.pause(id);
    await job?.promise;
  } else if (action === 'resume-binding') {
    await bindings.resume(id);
    beginBindingObservation(id);
  } else if (action === 'emergency-stop') {
    if (!options.qualificationLease) throw new Error('owned_native_inactive');
    revokeBindingQualification(options.qualificationLease);
    const job = jobs.get(id);
    if (job) job.pauseRequested = true;
    bindings.pause(id);
    await job?.promise;
  } else if (action === 'recover') {
    if (jobs.has(id)) throw new Error('workflow_run_active');
    for (const run of running(id)) recoverCodexWorkflow(store, run.id);
    pauseExternalTask(store, id);
  }
  return deps.taskDto(id);
}

async function recordOutcome(deps: LocalWebWorkflowActionDependencies, request: LocalWebScopedTaskAction) {
  const { id, action, input, setup } = request;
  const { store, jobs, bindings, options } = deps;
  const choice =
    action === 'rework'
      ? 'rework'
      : action === 'finish-success'
        ? 'success'
        : action === 'finish-failed'
          ? 'failed'
          : action === 'finish-abandoned'
            ? 'aborted'
            : null;
  if (choice === null) throw new Error('invalid_ui_request');
  if (action.startsWith('finish-') && bindingCollectionControl(store, id) && !options.qualificationLease && bindings.status(id).roots > 0) {
    const job = jobs.get(id);
    if (job) job.pauseRequested = true;
    bindings.pause(id);
    await job?.promise;
  }
  if (jobs.has(id) || bindingQualificationOwnerLive(options.qualificationLease)) throw new Error('workflow_run_active');
  recordExternalTaskOutcome(
    store,
    id,
    choice,
    choice === 'success' ? z.array(identifier).parse(input.criteria ?? setup.workflow.assignment.metadata.criterion_ids) : []
  );
  return deps.taskDto(id);
}

// Async leaves own the handoff; synchronous failures need the same rejected-promise boundary.
export function localWebWorkflowAction(deps: LocalWebWorkflowActionDependencies, request: LocalWebScopedTaskAction) {
  try {
    const { id, action, input, setup } = request;
    const { store, metadata, taskDto } = deps;
    if (action === 'ticket') {
      const ticket = issueExternalStartTicket(store, setup);
      metadata.setStartup(id, { ticket_id: ticket.ticket_id, start_command: ticket.start_command });
    } else if (action === 'connect') return connectLegacySource(deps, request);
    else if (action === 'session-connect') return connectBinding(deps, request);
    else if (action === 'observe') observeLegacySource(deps, request);
    else if (['pause', 'revoke-collection', 'resume-binding', 'emergency-stop', 'recover'].includes(action)) {
      return measurementControl(deps, request);
    } else if (action === 'release') releaseExternalWorkflow(store, id, input.external_session_stopped === true);
    else if (action === 'rework' || action.startsWith('finish-')) return recordOutcome(deps, request);
    else throw new Error('invalid_ui_request');
    return Promise.resolve(taskDto(id));
  } catch (error) {
    return new Promise(() => {
      throw error;
    });
  }
}
