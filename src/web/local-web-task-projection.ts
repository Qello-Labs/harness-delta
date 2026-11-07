import type { PrivateTask } from './local-web-metadata-store.js';
export type { PrivateTask, Source } from './local-web-metadata-store.js';
import { createHash } from 'node:crypto';
import { projectExternalActions } from './local-web-task-actions-projection.js';
import type { TaskRow } from '../core/lifecycle.js';
import type { ApplicationCoordinator } from '../harness/harness-application.js';
import type { getApplicationLaunchCapability } from '../harness/harness-application-launch.js';
import type { bindingCollectionControl } from '../core/external-session-contract.js';
import type { ExternalTaskSetup, externalTaskState } from '../workflow/external-session-service.js';
import type { comparisonVariant } from '../core/protocol-store.js';
import type { readBlockedTask, readExternalTask, readOrdinaryTask } from './local-web-task-read.js';

export type ExternalTaskData = ReturnType<typeof readExternalTask>;
export type OrdinaryTaskData = ReturnType<typeof readOrdinaryTask>;
export type TaskApplication = ReturnType<ApplicationCoordinator['status']> & {
  readonly capabilities: ReturnType<typeof getApplicationLaunchCapability>[];
  readonly baseline: ExternalTaskSetup['workflow']['assignment']['code_base_commit'];
};
export type ProjectedTask = Pick<TaskRow, 'id' | 'project_id' | 'state'>;

export function projectTaskHarness(data: {
  readonly assignedIndex: number;
  readonly assignedVariant: string | null;
  readonly version: ReturnType<typeof comparisonVariant>['harness_version'] | null;
  readonly nativeApplication: boolean;
}) {
  return {
    arm: data.assignedIndex === 0 ? ('A' as const) : data.assignedIndex === 1 ? ('B' as const) : null,
    variant_id: data.assignedVariant,
    version: data.version,
    application_mode: data.nativeApplication ? ('agent_applied' as const) : ('selected_markdown_only' as const)
  };
}

export function externalTaskVersion(data: {
  readonly task: ProjectedTask;
  readonly application: TaskApplication | undefined;
  readonly state: ReturnType<typeof externalTaskState>;
  readonly record: PrivateTask;
  readonly collectionControl: ReturnType<typeof bindingCollectionControl>;
  readonly runs: { id: string; stop_requested: number }[];
  readonly ownJob: boolean;
}): string {
  const { task, application, state, record, collectionControl, runs, ownJob } = data;
  return (
    '"' +
    createHash('sha256')
      .update(
        JSON.stringify({
          task,
          application,
          control: { revision: state.revision, window: state.window, configuration_evidence: state.configuration_evidence },
          record,
          collectionControl,
          runs,
          ownJob
        })
      )
      .digest('hex') +
    '"'
  );
}

export function projectBlockedTask(data: ReturnType<typeof readBlockedTask>) {
  const { id, record, setup, task, supportDetails, recruitment, harness, assignment, capabilities } = data;
  const reason = record.reason ?? 'external_preparation_required';
  const nativeApplication = harness.application_mode === 'agent_applied';
  const blockedApplication = nativeApplication
    ? {
        state: 'blocked_configuration',
        jobId: null,
        epoch: 0,
        reason,
        workspace: null,
        launchState: 'not_requested',
        identity: 'unavailable',
        capabilities,
        baseline: setup.workflow.assignment.code_base_commit
      }
    : undefined;
  return {
    id,
    name: record.name,
    project_id: task.project_id,
    setup_id: record.profile_id,
    version: '"' + createHash('sha256').update(JSON.stringify({ task, record })).digest('hex') + '"',
    state: task.state,
    status: 'blocked_configuration',
    ...(blockedApplication ? { application: blockedApplication } : {}),
    support_details: supportDetails,
    recruitment,
    harness,
    measurement: { state: 'waiting_connection', active_ms: null, requests: null, window: { started_at: null, ends_at: null } },
    outcome: null,
    attempt: 1,
    preparation: {
      state: 'blocked_configuration',
      configuration_evidence: 'unverified',
      native_context_evidence: 'unverified',
      freshness_evidence: 'unverified',
      tool_use_evidence: 'unavailable',
      assigned_variant_id: assignment?.variant_id ?? null
    },
    price: { partial_amount: null, currency: 'USD', unpriced_events: 0, basis: null },
    criteria: setup.workflow.assignment.metadata.criterion_ids,
    startup: null,
    source: null,
    reason,
    actions: [
      { code: 'prepare', enabled: task.state !== 'finalized', reason: null },
      ...(!nativeApplication ? [{ code: 'apply', enabled: task.state !== 'finalized', reason: null }] : [])
    ]
  };
}

function projectMeasurementState(data: ExternalTaskData) {
  const { finalized, active, state, task, connected, ready, supportDetails } = data;
  const measurementState = finalized
    ? 'measurement_ended'
    : active
      ? state.state === 'measuring'
        ? 'active'
        : 'starting'
      : task.state === 'active'
        ? 'connected'
        : connected
          ? 'paused'
          : 'waiting_connection';
  const status =
    state.outcome ??
    (measurementState === 'waiting_connection'
      ? ready
        ? supportDetails.context === 'synthetic_validation_only'
          ? 'validation_ready'
          : 'waiting_for_session'
        : 'draft'
      : measurementState);
  return { measurementState, status };
}

function projectExternalPrice(data: ExternalTaskData) {
  const { result } = data;
  return {
    partial_amount: result.cost?.partial_amount ?? null,
    compatibility_unverified_partial_amount: result.cost?.compatibility_unverified_partial_amount ?? null,
    legacy_unverified_partial_amount: result.cost?.legacy_unverified_partial_amount ?? null,
    compatibility: result.cost?.compatibility ?? null,
    currency: result.cost?.currency ?? 'USD',
    unpriced_events: result.cost?.unpriced_events ?? 0,
    basis: result.cost?.price_table_hash ?? null
  };
}

function projectExternalPreparation(data: ExternalTaskData) {
  const { state } = data;
  return {
    state: state.state,
    configuration_evidence: state.configuration_evidence,
    native_context_evidence: state.native_context_evidence,
    freshness_evidence: state.freshness_evidence,
    tool_use_evidence: state.tool_use_evidence,
    assigned_variant_id: state.assigned_variant_id
  };
}

function projectExternalBinding(data: ExternalTaskData) {
  const { binding, supportDetails, id, nativePilotTaskId, humanPilot, qualification, bindingAvailable, ordinaryAvailable, bindingProduct } = data;
  return {
    ...binding,
    ...(supportDetails.context === 'synthetic_validation_only' ? {} : { product: bindingProduct }),
    support:
      supportDetails.context === 'synthetic_validation_only'
        ? 'synthetic_validation_only'
        : nativePilotTaskId !== undefined && id === nativePilotTaskId
          ? humanPilot
            ? 'native_unverified_pilot'
            : 'native_pilot_preparation_only'
          : qualification
            ? 'native_qualification_only'
            : bindingAvailable
              ? ordinaryAvailable
                ? supportDetails.family
                : 'qualification_required'
              : 'instrumentation_required'
  };
}

export function projectExternalTask(data: ExternalTaskData) {
  const { id, record, task, version, application, supportDetails, recruitment, harness, connectionReadiness, state, result, setup, startup, source } = data;
  const { measurementState, status } = projectMeasurementState(data);
  const actions = projectExternalActions(data);
  return {
    id,
    name: record.name,
    project_id: task.project_id,
    setup_id: record.profile_id,
    version,
    ...(application ? { application } : {}),
    state: task.state,
    status,
    support_details: supportDetails,
    recruitment,
    harness,
    ...(connectionReadiness ? { connection_readiness: connectionReadiness } : {}),
    measurement: {
      state: measurementState,
      active_ms: result.time.active_ms,
      requests: result.cost?.event_count ?? null,
      window: state.window,
      end_condition: state.collection_end_condition
    },
    outcome: state.outcome === null ? null : { status: state.outcome, assessed_at: result.outcome_at! },
    attempt: state.rework_count + 1,
    preparation: projectExternalPreparation(data),
    price: projectExternalPrice(data),
    criteria: setup.workflow.assignment.metadata.criterion_ids,
    actions,
    startup,
    source: source ? { handle: source.handle, label: source.label } : null,
    binding: projectExternalBinding(data),
    reason: record.reason === 'measurement_paused' ? null : (record.reason ?? state.reason_code)
  };
}

export { ordinaryTaskVersion, projectOrdinaryTask } from './local-web-task-projection-ordinary.js';
