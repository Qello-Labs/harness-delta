import { createHash } from 'node:crypto';
import { projectOrdinaryActions } from './local-web-task-actions-projection.js';
import type { Lifecycle } from '../lifecycle.js';
import type { ordinaryTask } from '../ordinary-observation.js';
import type { createOrdinarySessionBindingService } from '../ordinary-session-binding.js';
import type { PrivateTask, OrdinaryTaskData } from './local-web-task-projection.js';
export function ordinaryTaskVersion(data: {
  readonly task: ReturnType<Lifecycle['task']>;
  readonly record: PrivateTask;
  readonly preparation: NonNullable<ReturnType<typeof ordinaryTask>>;
  readonly binding: ReturnType<ReturnType<typeof createOrdinarySessionBindingService>['status']>;
}): string {
  const { task, record, preparation, binding } = data;
  return (
    '"' +
    createHash('sha256')
      .update(
        JSON.stringify({
          task,
          record,
          preparation,
          binding: { state: binding.state, selected_root_id: binding.selected_root_id, segment_state: binding.segment_state }
        })
      )
      .digest('hex') +
    '"'
  );
}

function projectOrdinaryMeasurement(data: OrdinaryTaskData) {
  const { finalized, active, connected, activeMs, binding, task } = data;
  return {
    state: finalized ? 'measurement_ended' : active ? 'active' : connected ? 'paused' : 'waiting_connection',
    active_ms: activeMs,
    requests: binding.requests,
    window: { started_at: task.started_at, ends_at: null },
    end_condition: 'explicit_stop' as const
  };
}

function projectOrdinaryPreparation(data: OrdinaryTaskData) {
  const { connected } = data;
  return {
    state: 'prepared',
    configuration_evidence: 'task_snapshot_pinned',
    native_context_evidence: connected ? 'native_metadata_receipt' : 'unverified',
    freshness_evidence: connected ? 'explicit_connection_baseline' : 'unverified',
    tool_use_evidence: 'unavailable'
  };
}

function projectOrdinaryPrice(data: OrdinaryTaskData) {
  const { binding } = data;
  return {
    partial_amount: binding.summary.partial_amount,
    currency: binding.summary.currency ?? 'USD',
    compatibility_unverified_partial_amount: binding.summary.compatibility_unverified_partial_amount,
    legacy_unverified_partial_amount: binding.summary.legacy_unverified_partial_amount,
    compatibility: binding.summary.compatibility,
    unpriced_events: binding.summary.unpriced_events,
    basis: binding.price_table_hash
  };
}

export function projectOrdinaryTask(data: OrdinaryTaskData) {
  const { id, record, task, version, finalized, summary, active, connected, skill, settings, revoked, metadata, binding, admission } = data;
  const actions = projectOrdinaryActions(data);
  return {
    id,
    mode: 'ordinary' as const,
    name: record.name,
    project_id: task.project_id,
    setup_id: record.profile_id,
    version,
    state: task.state,
    status: finalized ? summary.outcome : active ? 'active' : connected ? 'paused' : 'waiting_for_session',
    connection_readiness: {
      skill,
      configured_version: settings.product_version,
      installed_version: null,
      collection_revoked: revoked
    },
    measurement: projectOrdinaryMeasurement(data),
    outcome: summary.outcome === null ? null : { status: summary.outcome, assessed_at: task.finalized_at },
    attempt: summary.rework_count + 1,
    preparation: projectOrdinaryPreparation(data),
    price: projectOrdinaryPrice(data),
    criteria: metadata.criterion_ids,
    actions,
    startup: null,
    source: null,
    binding: {
      ...binding,
      product: 'claude_code' as const,
      product_version: settings.product_version,
      max_family_members: admission.maxFamilyMembers,
      supported_model_family: 'claude' as const,
      support: admission.admitted ? 'claude_family' : 'ordinary_qualification_pending'
    },
    reason: record.reason === 'measurement_paused' ? null : record.reason
  };
}
