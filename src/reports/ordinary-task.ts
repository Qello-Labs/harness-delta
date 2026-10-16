import { addTokens, TimestampSchema } from '../contracts.js';
import { parseTaskMetadata } from '../flexible-contracts.js';
import { Lifecycle, type Outcome } from '../lifecycle.js';
import { captureObservedCostInput } from '../observed-cost-report.js';
import { ordinaryTask } from '../ordinary-observation.js';
import { projectCatalogCost } from '../catalog-cost-report.js';
import { readPriceBasis } from '../price-catalog-store.js';
import type { Store } from '../store.js';

export function aggregateOrdinaryTaskReport(store: Store, taskId: string, cutoff: string) {
  const end = TimestampSchema.parse(cutoff);
  if (Date.parse(end) > Date.now()) throw new Error('invalid_cutoff');
  return store.transaction(() => {
    const task = new Lifecycle(store).task(taskId);
    const prepared = ordinaryTask(store, taskId);
    if (!prepared) throw new Error('ordinary_preparation_required');
    const metadata = parseTaskMetadata(JSON.parse(task.metadata) as unknown);
    const capture = captureObservedCostInput(store, taskId, prepared.price_table_id, end, 'output-only-v1');
    const cost = projectCatalogCost(capture.events, readPriceBasis(store, prepared.price_table_id), taskId, end,
      'output-only-v1', { referenceBinding: true, runtimeEvidence: capture.runtimeEvidence });
    const total = (field: 'input_total' | 'cached_input' | 'output_total' | 'reasoning_output') => {
      const readings = capture.events.map(event => event.payload[field]);
      const observed = readings.filter(reading => reading.status === 'observed');
      return {
        status: readings.length && readings.length === observed.length ? 'observed' : observed.length ? 'partial' : 'missing',
        value: observed.length ? addTokens(observed.map(reading => reading.value)) : null,
        statuses: [...new Set(readings.map(reading => reading.status))].sort(),
        reasons: [...new Set(readings.flatMap(reading => reading.reason ? [reading.reason] : []))].sort(),
      };
    };
    const outcome = store.get<{ status: Outcome; criteria_met: string; assessed_at: string }>(
      'SELECT status,criteria_met,assessed_at FROM outcomes WHERE task_id=? AND julianday(assessed_at)<julianday(?)', [taskId, end]);
    const started = task.started_at !== null && Date.parse(task.started_at) < Date.parse(end) ? task.started_at : null;
    const until = Date.parse(capture.report.window_end);
    const activeMs = started === null ? null : store.all<{ started_at: string; ended_at: string | null }>(
      'SELECT started_at,ended_at FROM active_intervals WHERE task_id=?', [taskId]).reduce((sum, interval) =>
      sum + Math.max(0, Math.min(Date.parse(interval.ended_at ?? end), until) - Date.parse(interval.started_at)), 0);
    return {
      schema_version: 2, report_version: 'ordinary-task-v1', mode: 'ordinary', task_id: taskId, cutoff: end,
      metadata, inference: false,
      usage: { coverage: 'partial', event_count: capture.events.length, input_total: total('input_total'), cached_input: total('cached_input'),
        output_total: total('output_total'), reasoning_output: total('reasoning_output') },
      cost: { ...cost, cost_coverage: 'partial', price_selection: 'ordinary_task_pin', window_start: capture.report.window_start,
        window_end: capture.report.window_end, excluded_event_count: capture.report.excluded_event_count,
        reasons: [...new Set([...cost.reasons, ...capture.report.reasons])].sort() },
      quality: { outcome: outcome?.status ?? null, assessed_at: outcome?.assessed_at ?? null,
        criteria_met: outcome ? JSON.parse(outcome.criteria_met) as unknown : null, criteria_total: metadata.criterion_ids.length,
        first_success: task.first_assessed_at !== null && Date.parse(task.first_assessed_at) < Date.parse(end) &&
          task.first_success !== null ? Boolean(task.first_success) : null },
      time: { elapsed_ms: started === null ? null : Math.max(0, until - Date.parse(started)), active_ms: activeMs,
        rework_count: store.get<{ count: number }>(
          "SELECT count(*) AS count FROM attempts WHERE task_id=? AND kind='rework' AND julianday(started_at)<julianday(?)",
          [taskId, end])?.count ?? 0 },
    };
  });
}
