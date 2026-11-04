import { addTokens } from '../contracts.js';
import type { ComparisonSnapshotInput } from './comparison-contracts.js';
const ms = Date.parse;
export const codePointOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
export function projectComparisonTasks(data: ComparisonSnapshotInput) {
  const protocol = data.protocol;
  const cohort = data.assignments.filter(
    row => ms(row.assigned_at) >= ms(protocol.recruitment_start) && ms(row.assigned_at) < ms(protocol.recruitment_end) && ms(row.assigned_at) < ms(data.cutoff)
  );
  return cohort
    .sort((a, b) => codePointOrder(a.task_id, b.task_id))
    .map(row => {
      const end = new Date(Math.min(ms(data.cutoff), ms(row.followup_ends_at))).toISOString();
      const inWindow = (at: string) => ms(at) >= ms(row.assigned_at) && ms(at) < ms(end);
      const started = row.started_at !== null && inWindow(row.started_at);
      const outcome = row.outcome && inWindow(row.outcome.assessed_at) ? row.outcome : null;
      const deadlineStatus =
        ms(data.cutoff) < ms(row.followup_ends_at)
          ? ('pending_followup' as const)
          : (outcome?.status ?? (started ? ('outcome_missing' as const) : ('not_started' as const)));
      const usages = row.usages.filter(event => inWindow(event.occurred_at) && (event.recorded_at === null || ms(event.recorded_at) <= ms(data.evaluated_at)));
      const reading = (field: 'input_total' | 'output_total' | 'cached_input' | 'reasoning_output') => {
        const counts = { observed: 0, missing: 0, error: 0, excluded: 0, unmeasurable: 0 };
        const reasons: Record<string, number> = {};
        const values: number[] = [];
        for (const event of usages) {
          const item = event.payload[field];
          counts[item.status]++;
          if (item.status === 'observed') values.push(item.value);
          else reasons[item.reason] = (reasons[item.reason] ?? 0) + 1;
        }
        return { observed_sum: values.length ? addTokens(values) : null, observed_events: values.length, status_counts: counts, reason_counts: reasons };
      };
      const inputTotal = reading('input_total');
      const outputTotal = reading('output_total');
      const confirmations = row.confirmations.filter(record => inWindow(record.occurred_at) && ms(record.recorded_at) <= ms(data.evaluated_at));
      const known = [...new Set(confirmations.flatMap(record => (record.actual_variant_id === null ? [] : [record.actual_variant_id])))].sort(codePointOrder);
      const category =
        known.length > 1
          ? 'mixed'
          : known[0] === protocol.variant_ids[0]
            ? 'declared_a_only'
            : known[0] === protocol.variant_ids[1]
              ? 'declared_b_only'
              : known.length
                ? 'declared_other_only'
                : 'unknown';
      const clip = (interval: { started_at: string; ended_at: string | null }) => ({
        started_at: new Date(Math.max(ms(interval.started_at), ms(row.assigned_at))).toISOString(),
        ended_at: new Date(Math.min(ms(interval.ended_at ?? end), ms(end))).toISOString()
      });
      const overlaps = (interval: { started_at: string; ended_at: string | null }) =>
        ms(interval.started_at) < ms(end) && ms(interval.ended_at ?? end) > ms(row.assigned_at);
      const intervals = row.active_intervals
        .filter(overlaps)
        .map(clip)
        .sort((a, b) => codePointOrder(a.started_at, b.started_at));
      let activeMs = 0;
      let previousEnd = ms(row.assigned_at);
      for (const interval of intervals) {
        const a = Math.max(previousEnd, ms(interval.started_at));
        const b = ms(interval.ended_at);
        if (b > a) {
          activeMs = addTokens([activeMs, b - a]);
          previousEnd = b;
        }
      }
      return {
        task_id: row.task_id,
        assignment_id: row.assignment_id,
        original_variant_id: row.variant_id,
        assigned_at: row.assigned_at,
        followup_ends_at: row.followup_ends_at,
        endpoint_end: end,
        stratum_id: row.stratum_id,
        block_id: row.block_id,
        metadata: row.metadata,
        environment_id: row.environment_id,
        started,
        first_completed_at: row.first_completed_at && inWindow(row.first_completed_at) ? row.first_completed_at : null,
        first_assessed_at: row.first_assessed_at && inWindow(row.first_assessed_at) ? row.first_assessed_at : null,
        first_success: row.first_assessed_at && inWindow(row.first_assessed_at) ? row.first_success : null,
        finalized_at: row.finalized_at && inWindow(row.finalized_at) ? row.finalized_at : null,
        deadline_status: deadlineStatus,
        current_outcome: outcome?.status ?? null,
        criteria_met: outcome?.criteria_met ?? [],
        rework_count: row.rework_starts.filter(inWindow).length,
        usage: {
          status: usages.length ? ('partial' as const) : ('missing' as const),
          complete_tokens: null,
          partial_tokens:
            inputTotal.observed_sum !== null && outputTotal.observed_sum !== null ? addTokens([inputTotal.observed_sum, outputTotal.observed_sum]) : null,
          input_total: inputTotal,
          output_total: outputTotal,
          cached_input: reading('cached_input'),
          reasoning_output: reading('reasoning_output'),
          known_late_arrivals: usages.filter(event => event.recorded_at !== null && ms(event.recorded_at) >= ms(end)).length,
          legacy_receipt_unknown: usages.filter(event => event.recorded_at === null).length
        },
        actual_configuration: {
          category,
          known_variant_ids: known,
          has_unknown_variant: !confirmations.length || confirmations.some(record => record.actual_variant_id === null),
          has_unknown_runtime:
            !confirmations.length ||
            confirmations.some(record =>
              [record.product, record.product_version, record.model, record.reasoning_setting, record.environment_id].includes(null)
            ),
          has_runtime_drift: confirmations.some(record => record.deviation_codes.includes('version_drift')),
          self_attested: confirmations.filter(record => record.evidence_method === 'self_attested').length,
          selected_artifact_hash: confirmations.filter(record => record.evidence_method === 'selected_artifact_hash').length
        },
        deviations: row.deviations.filter(record => inWindow(record.occurred_at) && ms(record.recorded_at) <= ms(data.evaluated_at)),
        observations: row.observations.filter(overlaps).map(interval => ({
          ...clip(interval),
          status: interval.ended_at === null || ms(interval.ended_at) > ms(end) ? 'unmeasurable' : interval.status,
          reason: interval.ended_at === null || ms(interval.ended_at) > ms(end) ? 'incomplete' : interval.reason
        })),
        time: { active_ms: started ? activeMs : null, elapsed_ms: started ? ms(end) - ms(row.started_at!) : null, elapsed_is_labor: false }
      };
    });
}
export type ComparisonTask = ReturnType<typeof projectComparisonTasks>[number];
