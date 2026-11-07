import { createHash } from 'node:crypto';
import { codexWorkflowCostFacts, type CodexWorkflowRun } from '../workflow/codex-workflow-journal.js';
import { evaluateCostCoverage } from '../cost-coverage.js';
import { CostCoverageEvidenceSchema, type PriceTable, type UsageEvent, type RuntimeEvidence } from '../flexible-contracts.js';
import { canonicalJson } from '../core/canonical-json.js';
import { priceUsage, type LegacyInputBasis } from './pricing.js';
import type { Store } from '../store.js';

/** Produces evidence about this recorded snapshot, never provider completeness.
 * Journals completed after the cutoff cannot justify an earlier coverage fact. */
export function observedCostCoverage(
  store: Store,
  taskId: string,
  start: string | null,
  end: string,
  events: readonly UsageEvent[],
  table: PriceTable,
  basis: LegacyInputBasis,
  runtimeEvidence: readonly RuntimeEvidence[] = []
) {
  const runs = store
    .all<CodexWorkflowRun>('SELECT * FROM codex_workflow_runs WHERE task_id=? ORDER BY id', [taskId])
    .filter(
      r =>
        start !== null &&
        Date.parse(r.started_at) < Date.parse(end) &&
        r.ended_at !== null &&
        Date.parse(r.ended_at) <= Date.parse(end) &&
        Date.parse(r.ended_at) >= Date.parse(start)
    )
    .map(r => ({
      id: r.id,
      session_id: r.session_id,
      generation: r.generation,
      state: r.state,
      purpose: r.purpose,
      started_at: r.started_at,
      ended_at: r.ended_at,
      reason: r.reason,
      scope_verified: r.scope_verified,
      identity_verified: r.identity_verified,
      source_identity: r.source_identity,
      source_size: r.source_size,
      source_prefix_hash: r.source_prefix_hash,
      children: store.all<{ session_id: string; source_identity: string | null; source_size: number | null; source_prefix_hash: string | null }>(
        'SELECT session_id,source_identity,source_size,source_prefix_hash FROM codex_workflow_children WHERE run_id=?',
        [r.id]
      )
    }));
  const evidence =
    start !== null && Date.parse(start) < Date.parse(end)
      ? CostCoverageEvidenceSchema.parse({
          profile_id: 'unsupported-production-cost',
          task_id: taskId,
          window_start: start,
          window_end: end,
          ...codexWorkflowCostFacts(store, taskId, { start, end }),
          has_observed_value: events.length > 0
        })
      : null;
  const decision = evidence ? evaluateCostCoverage(evidence) : { eligible: false, reasons: ['incomplete', 'missing_value'] };
  const observedComponentsPriced = events.length > 0 && events.every(e => priceUsage(e, table, basis, runtimeEvidence).amount !== null);
  return {
    evidence,
    decision,
    workflow_run_count: runs.length,
    observed_components_priced: observedComponentsPriced,
    snapshot_hash: createHash('sha256')
      .update(canonicalJson({ evidence, runs, events, table, basis, observed_components_priced: observedComponentsPriced }))
      .digest('hex'),
    limitations: ['recorded_source_facts_only', 'request_universe_unverified', 'terminal_flush_unverified', 'no_complete_cost_admission']
  };
}
