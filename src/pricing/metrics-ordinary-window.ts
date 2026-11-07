import { addTokens, TimestampSchema } from '../contracts.js';
import { captureOrdinaryWindowCostInput } from './observed-cost-report.js';
import { projectCatalogCost } from './catalog-cost-report.js';
import { readPriceBasis } from './price-catalog-store.js';
import { reportCompatibility, type ReportSourceTrust, reportSourceTrust } from './report-source-trust.js';
import type { UsageEvent } from '../flexible-contracts.js';
import type { Store } from '../store.js';
import { readOrdinaryWindowStatus } from '../core/ordinary-window-evidence.js';

function tokenPartition(events: readonly UsageEvent[], trust: ReportSourceTrust) {
  const rows = events.filter(event => reportSourceTrust(event.payload) === trust);
  const total = (field: 'input_total' | 'cached_input' | 'output_total' | 'reasoning_output') => {
    const readings = rows.map(row => row.payload[field]);
    const observed = readings.filter(reading => reading.status === 'observed');
    return {
      status: trust === 'invalidated' && rows.length ? 'invalidated' : observed.length ? 'partial' : 'missing',
      observed_sum: trust !== 'invalidated' && observed.length ? addTokens(observed.map(reading => reading.value)) : null,
      observed_events: observed.length,
      unavailable_events: readings.length - observed.length,
      statuses: [...new Set(readings.map(reading => reading.status))].sort(),
      reasons: [...new Set(readings.flatMap(reading => (reading.reason ? [reading.reason] : [])))].sort()
    };
  };
  const input = total('input_total');
  const output = total('output_total');
  return {
    event_count: rows.length,
    partial_tokens: input.observed_sum !== null && output.observed_sum !== null ? addTokens([input.observed_sum, output.observed_sum]) : null,
    complete_tokens: null,
    input_total: input,
    cached_input: total('cached_input'),
    output_total: output,
    reasoning_output: total('reasoning_output')
  };
}

/** A read-only versioned surface; no activation or provider is needed to describe saved evidence. */
export function aggregateOrdinaryWindowMetrics(store: Store, taskId: string, cutoff: string) {
  const end = TimestampSchema.parse(cutoff);
  if (Date.parse(end) > Date.now()) throw new Error('invalid_cutoff');
  return store.transaction(() => {
    const status = readOrdinaryWindowStatus(store, taskId);
    const capture = captureOrdinaryWindowCostInput(store, taskId, end);
    const basis = readPriceBasis(store, status.selection.price_table_id);
    const cost = (trust: ReportSourceTrust) => {
      const events = capture.events.filter(event => reportSourceTrust(event.payload) === trust);
      const priced = projectCatalogCost(events, basis, taskId, end, 'output-only-v1', { referenceBinding: true, runtimeEvidence: capture.runtimeEvidence });
      const amount =
        trust === 'verified'
          ? priced.partial_amount
          : trust === 'compatibility_unverified'
            ? priced.compatibility_unverified_partial_amount
            : trust === 'legacy_unverified'
              ? priced.legacy_unverified_partial_amount
              : null;
      return {
        event_count: events.length,
        partial_amount: amount ?? null,
        complete_amount: null,
        unpriced_events: priced.unpriced_events,
        unavailable_events: priced.unavailable_events,
        reasons: priced.reasons
      };
    };
    return {
      ...status,
      schema_version: 3,
      report_version: 'ordinary-window-task-v1',
      cutoff: end,
      usage: {
        coverage: 'partial',
        event_count: capture.events.length,
        complete_tokens: null,
        compatibility: reportCompatibility(
          capture.events.map(event => event.payload),
          capture.events.map(event => event.occurred_at)
        ),
        verified: tokenPartition(capture.events, 'verified'),
        compatibility_unverified: tokenPartition(capture.events, 'compatibility_unverified'),
        legacy_unverified: tokenPartition(capture.events, 'legacy_unverified'),
        invalidated: tokenPartition(capture.events, 'invalidated')
      },
      cost: {
        report_version: 'ordinary-window-cost-v1',
        currency: basis.table.currency,
        price_table_id: basis.table.id,
        price_table_hash: capture.report.price_table_hash,
        price_basis_hash: basis.basis_hash,
        catalog_hash: basis.catalog_hash,
        catalog_id: basis.catalog.catalog_id,
        reference_policy_id: basis.policy_id,
        matching_version: basis.matching_version,
        reference_conditions: basis.conditions,
        limitations: capture.report.limitations,
        input_basis: capture.report.input_basis,
        formula_version: capture.report.formula_version,
        cost_coverage: 'partial',
        complete_amount: null,
        window_start: capture.report.window_start,
        window_end: capture.report.window_end,
        window_policy: capture.report.window_policy,
        excluded_event_count: capture.report.excluded_event_count,
        reasons: capture.report.reasons,
        verified: cost('verified'),
        compatibility_unverified: cost('compatibility_unverified'),
        legacy_unverified: cost('legacy_unverified'),
        invalidated: cost('invalidated')
      },
      denominators: { complete_usage_tasks: 0, complete_cost_tasks: 0, tokens_per_success: null, cost_per_success: null }
    };
  });
}
