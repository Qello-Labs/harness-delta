import { createHash } from 'node:crypto';
import { OrdinaryWindowSelectionSchema } from '../core/ordinary-window-policy.js';
import { ordinaryWindowSelection } from '../core/ordinary-window-store.js';
import { aggregateOrdinaryWindowMetrics } from '../pricing/metrics-ordinary-window.js';
import { parseTaskMetadata } from '../flexible-contracts.js';
import type { Store } from '../store.js';
import { projectOrdinaryActions } from './local-web-task-actions-projection.js';
import type { Lifecycle } from '../core/lifecycle.js';
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
  if (OrdinaryWindowSelectionSchema.safeParse(JSON.parse(data.preparation.settings)).success) throw new Error('binding_window_unavailable');
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

export function projectClosedClaudeWindowTask(input: { readonly store: Store; readonly life: Lifecycle; readonly id: string; readonly record: PrivateTask }) {
  const { store, life, id, record } = input;
  const selection = ordinaryWindowSelection(store, id);
  if (!selection || selection.policy.product !== 'claude_code' || record.profile_id !== 'ordinary-claude-window-v1')
    throw new Error('binding_window_unavailable');
  const task = life.task(id);
  const summary = life.summary(id);
  const report = aggregateOrdinaryWindowMetrics(store, id, new Date().toISOString());
  const costs = [report.cost.verified, report.cost.compatibility_unverified, report.cost.legacy_unverified, report.cost.invalidated];
  const version =
    '"' +
    createHash('sha256')
      .update(JSON.stringify({ task, record, usage: report.usage, costs }))
      .digest('hex') +
    '"';
  return {
    id,
    mode: 'ordinary' as const,
    name: record.name,
    project_id: task.project_id,
    setup_id: record.profile_id,
    version,
    state: task.state,
    status: task.state === 'finalized' ? summary.outcome : 'waiting_for_session',
    ordinary_window: {
      product: 'claude_code' as const,
      policy_id: selection.policy.policyId,
      policy_revision: selection.policy.ruleRevision,
      evidence_mode: 'publisher_verified_local_pin' as const,
      collection_enabled: false as const,
      reason: 'binding_window_activation_required',
      usage_scope: 'root_only',
      root_ownership: 'unverified',
      possible_child_contribution: 'unknown',
      automatic_children: false
    },
    measurement: {
      state: task.state === 'finalized' ? 'measurement_ended' : 'waiting_connection',
      active_ms: null,
      requests: report.usage.event_count,
      window: { started_at: task.started_at, ends_at: task.finalized_at },
      end_condition: 'explicit_stop'
    },
    preparation: {
      state: 'prepared',
      configuration_evidence: 'task_snapshot_pinned',
      native_context_evidence: 'unverified',
      freshness_evidence: 'unverified',
      tool_use_evidence: 'unavailable'
    },
    outcome: summary.outcome === null ? null : { status: summary.outcome, assessed_at: task.finalized_at },
    attempt: summary.rework_count + 1,
    price: {
      partial_amount: report.cost.verified.partial_amount,
      currency: report.cost.currency,
      compatibility_unverified_partial_amount: report.cost.compatibility_unverified.partial_amount,
      legacy_unverified_partial_amount: report.cost.legacy_unverified.partial_amount,
      unpriced_events: costs.reduce((sum, value) => sum + value.unpriced_events, 0),
      basis: report.cost.price_table_hash
    },
    criteria: parseTaskMetadata(JSON.parse(task.metadata)).criterion_ids,
    actions: [],
    startup: null,
    source: null,
    reason: 'binding_window_activation_required'
  };
}
