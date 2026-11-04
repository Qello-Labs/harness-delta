import { createHash } from 'node:crypto';
import { EventSchema, IdSchema, TimestampSchema } from './contracts.js';
import { canonicalJson } from './core/canonical-json.js';
import { parseComparison } from './comparison-contracts.js';
import { PriceTableSchema, type PriceTable, type UsageEvent, type RuntimeEvidence } from './flexible-contracts.js';
import { Lifecycle } from './lifecycle.js';
import { costFormulaVersion, priceUsage, readPriceTable, sumAmounts, type LegacyInputBasis } from './pricing.js';
import type { Store } from './store.js';
import { partitionCost } from './report-source-trust.js';
import { overlayEventCompatibility } from './source-compatibility.js';
import { readRuntimeHistory } from './runtime-history.js';
import { linkedRequestPriceEvidence } from './pricing/request-price-evidence.js';
import { observedCostCoverage } from './pricing/observed-cost-coverage.js';

/** Metadata-only descriptive projection; no coverage or source admission implied. */
export function projectObservedCost(
  events: readonly UsageEvent[],
  inputTable: PriceTable,
  taskId: string,
  cutoff: string,
  inputBasis: LegacyInputBasis,
  runtimeEvidence: readonly RuntimeEvidence[] = [],
  historicalReplay = false
) {
  parseComparison(IdSchema, taskId);
  const end = parseComparison(TimestampSchema, cutoff);
  if (!['output-only-v1', 'cache-read-remainder-ordinary-v1'].includes(inputBasis)) throw new Error('invalid_input_basis');
  const table = parseComparison(PriceTableSchema, inputTable, 'invalid_price_table');
  const unique = new Map<string, UsageEvent>();
  for (const input of events) {
    const event = parseComparison(EventSchema, input, 'invalid_event');
    if (event.payload.kind !== 'usage') throw new Error('invalid_event');
    if (event.task_id !== taskId) throw new Error('scope_mismatch');
    if (Date.parse(event.occurred_at) >= Date.parse(end)) continue;
    const previous = unique.get(event.source_key);
    if (previous && canonicalJson({ ...previous, id: event.id }) !== canonicalJson(event)) throw new Error('event_conflict');
    if (!previous) unique.set(event.source_key, event as UsageEvent);
  }
  const rows = [...unique.values()].sort((a, b) => (a.source_key < b.source_key ? -1 : a.source_key > b.source_key ? 1 : 0));
  const priced = rows.map(event => priceUsage(event, table, inputBasis, runtimeEvidence));
  const trust = partitionCost(
    rows,
    priced.map(value => value.partial_amount)
  );
  // Old serialized reports omit trust fields; live projections include them.
  const cost: { partial_amount: string | null } & Partial<Omit<typeof trust, 'partial_amount'>> = historicalReplay
    ? {
        partial_amount: priced.some(p => p.partial_amount !== null)
          ? sumAmounts(priced.flatMap(p => (p.partial_amount === null ? [] : [p.partial_amount])))
          : null
      }
    : trust;
  return {
    schema_version: 1,
    report_version: 'observed-cost-v1',
    task_id: taskId,
    cutoff: end,
    currency: table.currency,
    price_table: table,
    price_table_hash: createHash('sha256').update(canonicalJson(table)).digest('hex'),
    usage_snapshot_hash: createHash('sha256').update(canonicalJson(rows)).digest('hex'),
    formula_version: costFormulaVersion,
    input_basis: inputBasis,
    complete_amount: null,
    ...cost,
    event_count: rows.length,
    session_count: new Set(rows.map(event => event.session_id)).size,
    assumed_input_events: rows.filter(
      event =>
        !('schema_version' in event.payload) &&
        inputBasis === 'cache-read-remainder-ordinary-v1' &&
        event.payload.input_total.status === 'observed' &&
        event.payload.cached_input.status === 'observed'
    ).length,
    unpriced_events: priced.filter(value => value.reasons.includes('unpriced_component')).length,
    unavailable_events: priced.filter(value => value.partial_amount === null).length,
    reasons: [
      ...new Set([
        'incomplete',
        'unsupported_profile',
        ...(!rows.length ? ['missing_value'] : []),
        ...(!historicalReplay && trust.compatibility.invalidated_events ? ['invalidated'] : []),
        ...(!historicalReplay && trust.compatibility.compatibility_unverified_events + trust.compatibility.legacy_unverified_events > 0
          ? ['source_unverified']
          : []),
        ...priced.flatMap(value => value.reasons)
      ])
    ].sort(),
    limitations: [
      'standardized_estimated_cost_is_not_actual_billing',
      'whole_task_cost_unconfirmed_without_coverage',
      'parent_child_counter_overlap_unverified',
      ...(inputBasis === 'cache-read-remainder-ordinary-v1' ? ['legacy_cache_write_split_assumed'] : [])
    ]
  };
}

export function captureObservedCostInput(store: Store, taskId: string, tableId: string, cutoff: string, inputBasis: LegacyInputBasis) {
  return store.transaction(() => {
    const task = new Lifecycle(store).task(taskId);
    const end = parseComparison(TimestampSchema, cutoff);
    const until = task.finalized_at !== null && Date.parse(task.finalized_at) < Date.parse(end) ? task.finalized_at : end;
    const active = store.all<{ started_at: string; ended_at: string | null }>(
      'SELECT started_at, ended_at FROM active_intervals WHERE task_id=? ORDER BY started_at, id',
      [taskId]
    );
    const uncertain = store.all<{ started_at: string; ended_at: string | null; status: string; reason: string | null }>(
      "SELECT started_at, ended_at, status, reason FROM observations WHERE task_id=? AND status!='observed' ORDER BY started_at, id",
      [taskId]
    );
    const gaps = store.all<{ started_at: string; ended_at: string | null; reason: string }>(
      'SELECT started_at, ended_at, reason FROM observation_gaps WHERE task_id=? ORDER BY started_at, id',
      [taskId]
    );
    // Unknown whole-task coverage does not erase independently observed usage.
    // Explicit loss/exclusion remains conservative across every linked session.
    const coverageOnly = (reason: string | null) => reason === 'incomplete' || reason === 'not_available';
    const loss = [...uncertain.filter(row => !(row.status === 'unmeasurable' && coverageOnly(row.reason))), ...gaps.filter(row => !coverageOnly(row.reason))];
    const candidates = store
      .all<{ payload: string } & Omit<UsageEvent, 'payload'>>(
        'SELECT id, project_id, task_id, session_id, source_key, occurred_at, payload FROM events WHERE task_id=? ORDER BY occurred_at, source_key',
        [taskId]
      )
      .map(row => overlayEventCompatibility(store, parseComparison(EventSchema, { ...row, payload: JSON.parse(row.payload) as unknown }, 'invalid_event')))
      .flatMap(event =>
        event.payload.kind === 'usage' &&
        task.started_at !== null &&
        Date.parse(event.occurred_at) >= Date.parse(task.started_at) &&
        Date.parse(event.occurred_at) < Date.parse(until)
          ? [event as UsageEvent]
          : []
      );
    const contains = (interval: { started_at: string; ended_at: string | null }, at: number) =>
      at >= Date.parse(interval.started_at) && at < Date.parse(interval.ended_at ?? until);
    const events = candidates.filter(event => {
      const at = Date.parse(event.occurred_at);
      return active.some(interval => contains(interval, at)) && !loss.some(interval => contains(interval, at));
    });
    const excluded = candidates.length - events.length;
    const runtimeEvidence = linkedRequestPriceEvidence(events, readRuntimeHistory(store, taskId, end));
    const table = readPriceTable(store, tableId);
    const report = projectObservedCost(events, table, taskId, end, inputBasis, runtimeEvidence);
    const windowPolicy = 'active-observed-loss-half-open-v2';
    const result = {
      ...report,
      reasons: [
        ...new Set([
          ...report.reasons,
          ...uncertain.flatMap(row => (row.reason ? [row.reason] : [])),
          ...gaps.map(row => row.reason),
          ...(excluded ? ['excluded_intervals'] : [])
        ])
      ].sort(),
      window_start: task.started_at,
      window_end: until,
      window_policy: windowPolicy,
      excluded_event_count: excluded,
      coverage: observedCostCoverage(store, taskId, task.started_at, until, events, table, inputBasis, runtimeEvidence),
      observation_snapshot_hash: createHash('sha256')
        .update(canonicalJson({ policy: windowPolicy, active, uncertain, gaps }))
        .digest('hex')
    };
    return { report: result, events, runtimeEvidence };
  });
}

/** Existing report serialization stays unchanged; capture exposes eligible metadata for immutable repricing. */
export function readObservedCostReport(store: Store, taskId: string, tableId: string, cutoff: string, inputBasis: LegacyInputBasis) {
  return captureObservedCostInput(store, taskId, tableId, cutoff, inputBasis).report;
}
