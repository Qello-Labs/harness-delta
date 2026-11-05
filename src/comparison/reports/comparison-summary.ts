import { addTokens } from '../../contracts.js';
import type { Protocol } from '../../comparison-contracts.js';
import { codePointOrder, type ComparisonTask } from './comparison-task.js';
export type SummaryTask = Pick<
  ComparisonTask,
  | 'task_id'
  | 'assigned_at'
  | 'metadata'
  | 'environment_id'
  | 'block_id'
  | 'stratum_id'
  | 'original_variant_id'
  | 'deadline_status'
  | 'first_success'
  | 'current_outcome'
  | 'criteria_met'
  | 'rework_count'
  | 'actual_configuration'
> & {
  usage: Pick<ComparisonTask['usage'], 'status' | 'partial_tokens'> & {
    input_total: Pick<ComparisonTask['usage']['input_total'], 'observed_sum'>;
    output_total: Pick<ComparisonTask['usage']['output_total'], 'observed_sum'>;
  };
};
/** Shared arithmetic; legacy local block IDs remain unscoped for stored-byte compatibility. */
export function summarizeComparisonTasks(tasks: readonly SummaryTask[], protocol: Pick<Protocol, 'variant_ids' | 'block_size'>, scopedBlocks = false) {
  const rate = (numerator: number, denominator: number, reason: string | null = null) => ({
    numerator,
    denominator,
    value: reason || !denominator ? null : numerator / denominator,
    reason: reason ?? (denominator ? null : 'empty_denominator')
  });
  const hasPendingFollowup = tasks.some(row => row.deadline_status === 'pending_followup');
  const distribution = (values: number[]) => {
    const sorted = values.sort((a, b) => a - b);
    return {
      task_denominator: sorted.length,
      distribution: sorted,
      mean: sorted.length ? addTokens(sorted) / sorted.length : null,
      median: !sorted.length
        ? null
        : sorted.length % 2
          ? sorted[Math.floor(sorted.length / 2)]!
          : sorted[sorted.length / 2 - 1]! / 2 + sorted[sorted.length / 2]! / 2
    };
  };
  const summary = (rows: typeof tasks) => {
    const statuses = { success: 0, failed: 0, aborted: 0, not_started: 0, outcome_missing: 0, pending_followup: 0 };
    for (const row of rows) statuses[row.deadline_status]++;
    const partial = rows.flatMap(row => (row.usage.partial_tokens === null ? [] : [row.usage.partial_tokens])).sort((a, b) => a - b);
    const first = rows.filter(row => row.first_success !== null);
    const assessed = rows.filter(row => row.current_outcome !== null);
    const criterionCount = addTokens(assessed.map(row => row.metadata.criterion_ids.length));
    const missing = rows.filter(row => row.usage.status === 'missing').length;
    return {
      assigned_tasks: rows.length,
      deadline_counts: statuses,
      deadline_success: rate(statuses.success, rows.length, hasPendingFollowup ? 'pending_followup' : null),
      usage: {
        complete_tasks: 0,
        partial_tasks: rows.length - missing,
        missing_tasks: missing,
        missing_rate: rate(missing, rows.length),
        complete_tokens_mean: null,
        cost: null,
        change_rate: null,
        tokens_per_success: null,
        partial_tokens: distribution(partial),
        partial_input_total: distribution(rows.flatMap(row => (row.usage.input_total.observed_sum === null ? [] : [row.usage.input_total.observed_sum]))),
        partial_output_total: distribution(rows.flatMap(row => (row.usage.output_total.observed_sum === null ? [] : [row.usage.output_total.observed_sum])))
      },
      first_attempt: {
        assessed_tasks: first.length,
        unassessed_tasks: rows.length - first.length,
        success: rate(first.filter(row => row.first_success).length, first.length)
      },
      criteria: {
        assessed_tasks: assessed.length,
        unassessed_tasks: rows.length - assessed.length,
        fulfillment: rate(addTokens(assessed.map(row => row.criteria_met.length)), criterionCount)
      },
      rework: { task_rate: rate(rows.filter(row => row.rework_count > 0).length, rows.length), attempts: addTokens(rows.map(row => row.rework_count)) },
      outcome_missing_rate: rate(statuses.outcome_missing + statuses.not_started, rows.length)
    };
  };
  const dimensions = ['assignee', 'type', 'expected_size', 'expected_complexity', 'product', 'model', 'environment_id', 'assignment_day'] as const;
  const composition = dimensions.flatMap(dimension => {
    const groups = new Map<string, typeof tasks>();
    for (const task of tasks) {
      const value =
        dimension === 'environment_id'
          ? task.environment_id
          : dimension === 'assignment_day'
            ? task.assigned_at.slice(0, 10)
            : (task.metadata[dimension] ?? 'unspecified');
      groups.set(value, [...(groups.get(value) ?? []), task]);
    }
    return [...groups].sort(([a], [b]) => codePointOrder(a, b)).map(([value, rows]) => ({ dimension, value, ...summary(rows) }));
  });
  const blockGroups = new Map<string, typeof tasks>();
  for (const task of tasks) {
    const key = scopedBlocks ? JSON.stringify([task.stratum_id, task.block_id]) : task.block_id;
    blockGroups.set(key, [...(blockGroups.get(key) ?? []), task]);
  }
  const blocks = [...blockGroups]
    .sort(([a], [b]) => codePointOrder(a, b))
    .map(([, rows]) => {
      const first = rows[0]!;
      return {
        block_id: first.block_id,
        stratum_id: first.stratum_id,
        assigned_tasks: rows.length,
        a: rows.filter(row => row.original_variant_id === protocol.variant_ids[0]).length,
        b: rows.filter(row => row.original_variant_id === protocol.variant_ids[1]).length,
        planned_size: protocol.block_size,
        status: rows.length === protocol.block_size ? 'complete' : 'incomplete'
      };
    });
  return {
    total: summary(tasks),
    arms: protocol.variant_ids.map(variantId => ({ original_variant_id: variantId, ...summary(tasks.filter(row => row.original_variant_id === variantId)) })),
    composition,
    blocks,
    actual_configuration_summary: ['declared_a_only', 'declared_b_only', 'declared_other_only', 'mixed', 'unknown'].map(category => ({
      category,
      population: 'supplementary_declared_history',
      ...summary(tasks.filter(row => row.actual_configuration.category === category))
    }))
  };
}
