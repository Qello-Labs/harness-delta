import { projectComparisonTasks } from './comparison-task.js';
import { summarizeComparisonTasks } from './comparison-summary.js';
import { parseComparison } from '../comparison-contracts.js';
import { ComparisonSnapshotInputSchema } from './comparison-contracts.js';
import type { ComparisonSnapshotInput, SnapshotAssignment } from './comparison-contracts.js';

const ms = Date.parse;
export { codePointOrder } from './comparison-task.js';
export function projectComparison(input: ComparisonSnapshotInput) {
  const data = parseComparison(ComparisonSnapshotInputSchema, input, 'invalid_snapshot_input');
  if (ms(data.cutoff) > ms(data.evaluated_at) || data.protocol.purpose !== 'synthetic_validation') throw new Error('invalid_snapshot_input');
  const protocol = data.protocol;
  const tasks = projectComparisonTasks(data);
  const summaries = summarizeComparisonTasks(tasks, protocol);
  const registrations = data.registrations.filter(
    row => ms(row.registered_at) >= ms(protocol.recruitment_start) && ms(row.registered_at) < Math.min(ms(data.cutoff), ms(protocol.recruitment_end))
  );
  const assignedRegistrations = registrations.filter(row => row.assignment_at !== null && ms(row.assignment_at) < ms(data.cutoff));
  return {
    schema_version: 1 as const,
    descriptive_version: data.descriptive_version,
    report_id: data.report_id,
    mode: 'randomized_task',
    purpose: 'synthetic_validation',
    protocol_id: protocol.id,
    settings: protocol,
    variants: data.variants,
    cutoff: data.cutoff,
    evaluated_at: data.evaluated_at,
    data_revision: data.data_revision,
    snapshot_sequence: data.snapshot_sequence,
    revision_reason: data.revision_reason,
    supersedes_report_id: data.supersedes_report_id,
    validity_status: 'valid',
    provisional: ms(data.cutoff) < ms(protocol.recruitment_end) || tasks.some(row => row.deadline_status === 'pending_followup'),
    recruitment_context: {
      population: 'project_registration_activity',
      unassigned_eligibility: 'unknown',
      registered_tasks: registrations.length,
      assigned_this_protocol: assignedRegistrations.filter(row => row.assignment_protocol_id === protocol.id).length,
      assigned_other_protocol: assignedRegistrations.filter(row => row.assignment_protocol_id !== protocol.id).length,
      unassigned: registrations.length - assignedRegistrations.length
    },
    total: summaries.total,
    arms: summaries.arms,
    composition: summaries.composition,
    blocks: summaries.blocks,
    tasks,
    actual_configuration_summary: summaries.actual_configuration_summary,
    adoption: { status: 'inconclusive', reason: 'analysis_not_validated' },
    confidence_interval: null,
    p_value: null,
    limitations: [
      'partial_usage_is_not_a_task_total',
      'no_complete_cost_or_savings',
      'no_causal_or_adoption_conclusion',
      'current_evaluation_not_historical_knowledge',
      'elapsed_is_not_human_labor',
      'declared_configuration_does_not_prove_isolation'
    ]
  };
}
export type ComparisonReport = ReturnType<typeof projectComparison> & { snapshot_hash: string };
// Keep the stored contract independent of current DB state.
export type { SnapshotAssignment };
