import { reportSourceTrust } from '../report-source-trust.js';
import { overlayEventCompatibility } from '../source-compatibility.js';
import { z } from 'zod';
import { EventSchema, IdSchema, MonetaryAmountSchema, TimestampSchema } from '../contracts.js';
import { EventV2Schema, RuntimeEvidenceSchema, type UsageEvent } from '../flexible-contracts.js';
import { captureObservedCostInput } from '../observed-cost-report.js';
import { projectCatalogCost } from '../catalog-cost-report.js';
import { digest } from './price-catalog.js';
import { readPriceBasis } from '../price-catalog-store.js';
import { costFormulaVersion, type LegacyInputBasis } from '../pricing.js';
import { readComparisonSnapshot } from '../comparison/reports/comparison-snapshot.js';
import { canonicalJson } from '../canonical-json.js';
import { FlexibleSnapshotInputSchema } from '../comparison/reports/flexible-comparison.js';
import { linkedRequestPriceEvidence } from './request-price-evidence.js';
import type { Store } from '../store.js';

const hex = z.string().regex(/^[a-f0-9]{64}$/);
const usageSchema = EventSchema.refine(event => event.payload.kind === 'usage');
const inputBasisSchema = z.enum(['output-only-v1', 'cache-read-remainder-ordinary-v1']);
const taskInputSchema = z.strictObject({
  task_id: IdSchema,
  original_variant_id: IdSchema.nullable(),
  cutoff: TimestampSchema,
  events: z.array(usageSchema),
  runtime_evidence: z.array(RuntimeEvidenceSchema).optional(),
  input_basis: inputBasisSchema,
  observation_snapshot_hash: hex,
  usage_snapshot_hash: hex,
  original_partial_amount: MonetaryAmountSchema.nullable(),
  reasons: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/))
});
const snapshotBodySchema = z.strictObject({
  schema_version: z.union([z.literal(1), z.literal(2)]),
  input_id: IdSchema,
  kind: z.enum(['task', 'comparison']),
  base_report_id: IdSchema.nullable(),
  base_report_hash: hex.nullable(),
  original_table_id: IdSchema,
  cutoff: TimestampSchema,
  formula_version: z.literal(costFormulaVersion),
  tasks: z.array(taskInputSchema)
});
const snapshotSchema = snapshotBodySchema.extend({ snapshot_hash: hex });
type CostSnapshot = z.infer<typeof snapshotSchema>;
export interface RevaluationRequest {
  id: string;
  inputId: string;
  targetTableId: string;
}
function readCostSnapshot(store: Store, id: string): CostSnapshot {
  IdSchema.parse(id);
  if (store.get("SELECT id FROM price_cost_tombstones WHERE kind='input' AND id=?", [id])) throw new Error('invalidated_cost_snapshot');
  const row = store.get<{ payload: string; hash: string }>('SELECT payload,hash FROM price_cost_inputs WHERE id=?', [id]);
  if (!row) throw new Error('unknown_cost_snapshot');
  const parsed = snapshotSchema.safeParse(JSON.parse(row.payload) as unknown);
  if (!parsed.success) throw new Error('invalid_cost_snapshot');
  const snapshot = parsed.data;
  const { snapshot_hash: hash, ...body } = snapshot;
  if (hash !== digest(canonicalJson(body)) || hash !== row.hash) throw new Error('invalid_cost_snapshot');
  if (snapshot.base_report_id !== null && readComparisonSnapshot(store, snapshot.base_report_id).validity_status !== 'valid')
    throw new Error('invalidated_cost_snapshot');
  return snapshot;
}
function persistSnapshot(store: Store, raw: z.infer<typeof snapshotBodySchema>): CostSnapshot {
  const body = snapshotBodySchema.parse(raw);
  const hash = digest(canonicalJson(body));
  const snapshot = { ...body, snapshot_hash: hash };
  const prior = store.get<{ payload: string }>('SELECT payload FROM price_cost_inputs WHERE id=?', [body.input_id]);
  if (prior) {
    if (prior.payload !== canonicalJson(snapshot)) throw new Error('cost_snapshot_conflict');
    return snapshot;
  }
  if (store.get("SELECT id FROM price_cost_tombstones WHERE kind='input' AND id=?", [body.input_id])) throw new Error('invalidated_cost_snapshot');
  store.execute('INSERT INTO price_cost_inputs(id,base_report_id,payload,hash) VALUES (?,?,?,?)', [
    body.input_id,
    body.base_report_id,
    canonicalJson(snapshot),
    hash
  ]);
  for (const id of new Set(body.tasks.map(task => task.task_id)))
    store.execute('INSERT INTO price_cost_input_dependencies(input_id,task_id) VALUES (?,?)', [body.input_id, id]);
  return snapshot;
}
export function captureTaskCostSnapshot(
  store: Store,
  request: { inputId: string; taskId: string; tableId: string; cutoff: string; inputBasis: LegacyInputBasis },
  now = new Date().toISOString()
) {
  TimestampSchema.parse(now);
  TimestampSchema.parse(request.cutoff);
  IdSchema.parse(request.inputId);
  if (Date.parse(request.cutoff) > Date.parse(now)) throw new Error('invalid_cutoff');
  return store.immediateTransaction(() => {
    if (store.get('SELECT id FROM price_cost_inputs WHERE id=?', [request.inputId])) {
      const prior = readCostSnapshot(store, request.inputId);
      if (
        prior.kind !== 'task' ||
        prior.original_table_id !== request.tableId ||
        prior.cutoff !== request.cutoff ||
        prior.tasks[0]?.task_id !== request.taskId ||
        prior.tasks[0].input_basis !== request.inputBasis
      )
        throw new Error('cost_snapshot_conflict');
      return prior;
    }
    if (store.get("SELECT id FROM price_cost_tombstones WHERE kind='input' AND id=?", [request.inputId])) throw new Error('invalidated_cost_snapshot');
    const { report, events, runtimeEvidence } = captureObservedCostInput(store, request.taskId, request.tableId, request.cutoff, request.inputBasis);
    return persistSnapshot(store, {
      schema_version: runtimeEvidence.length ? 2 : 1,
      input_id: request.inputId,
      kind: 'task',
      base_report_id: null,
      base_report_hash: null,
      original_table_id: request.tableId,
      cutoff: request.cutoff,
      formula_version: costFormulaVersion,
      tasks: [
        {
          task_id: request.taskId,
          original_variant_id: null,
          cutoff: request.cutoff,
          events,
          ...(runtimeEvidence.length ? { runtime_evidence: runtimeEvidence } : {}),
          input_basis: request.inputBasis,
          observation_snapshot_hash: report.observation_snapshot_hash,
          usage_snapshot_hash: report.usage_snapshot_hash,
          original_partial_amount: report.partial_amount,
          reasons: report.reasons
        }
      ]
    });
  });
}
export function captureComparisonCostSnapshot(store: Store, inputId: string, reportId: string) {
  IdSchema.parse(inputId);
  IdSchema.parse(reportId);
  return store.immediateTransaction(() => {
    const report = readComparisonSnapshot(store, reportId);
    if (report.validity_status !== 'valid') throw new Error('invalidated_cost_snapshot');
    if (report.schema_version !== 2) throw new Error('unsupported_report_mode');
    const row = store.get<{ input_json: string }>('SELECT input_json FROM flexible_report_snapshots WHERE report_id=?', [reportId]);
    if (!row) throw new Error('unknown_report');
    const input = FlexibleSnapshotInputSchema.parse(JSON.parse(row.input_json) as unknown);
    const tasks = report.tasks.map(task => {
      const assignment = input.assignments.find(a => a.task_id === task.task_id)!;
      const end = Math.min(Date.parse(input.cutoff), Date.parse(assignment.followup_ends_at));
      // Preserve the original flexible snapshot's window and receipt eligibility exactly.
      const events = assignment.usages
        .filter(
          u =>
            u.event.task_id === task.task_id &&
            Date.parse(u.event.occurred_at) >= Date.parse(assignment.assigned_at) &&
            Date.parse(u.event.occurred_at) < end &&
            u.recorded_at !== null &&
            Date.parse(u.recorded_at) <= Date.parse(input.evaluated_at)
        )
        .map(u => EventV2Schema.parse(u.event));
      const ordered = [...events].sort((a, b) => (a.source_key < b.source_key ? -1 : a.source_key > b.source_key ? 1 : 0));
      const runtime = linkedRequestPriceEvidence(
        events,
        assignment.runtime.filter(
          row =>
            row.task_id === task.task_id &&
            Date.parse(row.occurred_at) >= Date.parse(assignment.assigned_at) &&
            Date.parse(row.occurred_at) < end &&
            Date.parse(row.recorded_at) <= Date.parse(input.evaluated_at)
        )
      );
      return {
        task_id: task.task_id,
        original_variant_id: task.original_variant_id,
        cutoff: new Date(end).toISOString(),
        events,
        ...(runtime.length ? { runtime_evidence: runtime } : {}),
        input_basis: 'output-only-v1' as const,
        usage_snapshot_hash: digest(canonicalJson(ordered)),
        original_partial_amount: task.cost.partial_amount,
        observation_snapshot_hash: digest(
          canonicalJson({ source_snapshot_hash: report.snapshot_hash, coverage: assignment.coverage, gaps: assignment.gaps, runtime: assignment.runtime })
        ),
        reasons: task.cost.reasons
      };
    });
    return persistSnapshot(store, {
      schema_version: tasks.some(task => 'runtime_evidence' in task) ? 2 : 1,
      input_id: inputId,
      kind: 'comparison',
      base_report_id: reportId,
      base_report_hash: report.snapshot_hash,
      original_table_id: input.price_table.id,
      cutoff: input.cutoff,
      formula_version: input.formula_version,
      tasks
    });
  });
}
function projectRevaluation(
  snapshot: CostSnapshot,
  basis: ReturnType<typeof readPriceBasis>,
  id: string,
  evaluatedAt: string,
  store?: Store,
  historicalReplay = false
) {
  const tasks = snapshot.tasks.map(task => {
    const events = task.events.map(event => (store ? overlayEventCompatibility(store, event) : event)) as UsageEvent[];
    const uncertain = events.some(event => reportSourceTrust(event.payload) !== 'verified');
    const invalidated = events.some(event => reportSourceTrust(event.payload) === 'invalidated');
    return {
      task_id: task.task_id,
      original_variant_id: task.original_variant_id,
      usage_snapshot_hash: task.usage_snapshot_hash,
      observation_snapshot_hash: task.observation_snapshot_hash,
      original_partial_amount: historicalReplay || !uncertain ? task.original_partial_amount : null,
      ...(!historicalReplay && uncertain
        ? {
            original_unpartitioned_reference_amount: invalidated ? null : task.original_partial_amount,
            original_invalidated_amount: invalidated ? task.original_partial_amount : null
          }
        : {}),
      cost: projectCatalogCost(
        events,
        basis,
        task.task_id,
        task.cutoff,
        task.input_basis,
        { referenceBinding: true, runtimeEvidence: task.runtime_evidence ?? [] },
        historicalReplay
      ),
      source_reasons: task.reasons
    };
  });
  return {
    schema_version: 1,
    kind: 'reference_cost_revaluation',
    revaluation_id: id,
    validity_status: 'valid',
    base_input_id: snapshot.input_id,
    base_snapshot_hash: snapshot.snapshot_hash,
    base_report_id: snapshot.base_report_id,
    base_report_hash: snapshot.base_report_hash,
    original_table_id: snapshot.original_table_id,
    target_table_id: basis.table.id,
    target_price_basis_hash: basis.basis_hash,
    cutoff: snapshot.cutoff,
    evaluated_at: evaluatedAt,
    formula_version: snapshot.formula_version,
    matching_version: basis.matching_version,
    complete_amount: null,
    tasks,
    limitations: ['descriptive_revaluation_only', 'reference_cost_not_actual_billing', 'usage_coverage_unchanged', 'no_primary_means_or_adoption']
  };
}
export function createPriceRevaluation(store: Store, request: RevaluationRequest, now = new Date().toISOString()) {
  [request.id, request.inputId, request.targetTableId].forEach(id => IdSchema.parse(id));
  TimestampSchema.parse(now);
  return store.immediateTransaction(() => {
    if (store.get("SELECT id FROM price_cost_tombstones WHERE kind='revaluation' AND id=?", [request.id])) throw new Error('invalidated_revaluation');
    const existing = store.get<{ input_id: string; target_table_id: string; payload: string }>(
      'SELECT input_id,target_table_id,payload FROM price_revaluations WHERE id=?',
      [request.id]
    );
    if (existing) {
      if (existing.input_id !== request.inputId || existing.target_table_id !== request.targetTableId) throw new Error('revaluation_conflict');
      return projectRevaluation(
        readCostSnapshot(store, request.inputId),
        readPriceBasis(store, request.targetTableId),
        request.id,
        (JSON.parse(existing.payload) as { evaluated_at: string }).evaluated_at,
        store
      );
    }
    const snapshot = readCostSnapshot(store, request.inputId);
    if (Date.parse(now) < Date.parse(snapshot.cutoff)) throw new Error('invalid_cutoff');
    const result = projectRevaluation(snapshot, readPriceBasis(store, request.targetTableId), request.id, now);
    store.execute('INSERT INTO price_revaluations(id,input_id,target_table_id,payload) VALUES (?,?,?,?)', [
      request.id,
      request.inputId,
      request.targetTableId,
      canonicalJson(result)
    ]);
    return projectRevaluation(snapshot, readPriceBasis(store, request.targetTableId), request.id, now, store);
  });
}
export function readPriceRevaluation(store: Store, id: string) {
  IdSchema.parse(id);
  if (store.get("SELECT id FROM price_cost_tombstones WHERE kind='revaluation' AND id=?", [id]))
    return { revaluation_id: id, validity_status: 'invalidated', reason: 'deletion_or_invalidated_base' };
  const row = store.get<{ input_id: string; target_table_id: string; payload: string }>(
    'SELECT input_id,target_table_id,payload FROM price_revaluations WHERE id=?',
    [id]
  );
  if (!row) throw new Error('unknown_revaluation');
  const result = projectRevaluation(
    readCostSnapshot(store, row.input_id),
    readPriceBasis(store, row.target_table_id),
    id,
    (JSON.parse(row.payload) as { evaluated_at: string }).evaluated_at
  );
  if (canonicalJson(result) !== row.payload) {
    const snapshot = readCostSnapshot(store, row.input_id);
    if (snapshot.tasks.some(t => t.events.some(e => e.payload.kind === 'usage' && e.payload.source_compatibility))) throw new Error('invalid_revaluation');
    const legacy = projectRevaluation(snapshot, readPriceBasis(store, row.target_table_id), id, result.evaluated_at, undefined, true);
    if (canonicalJson(legacy) !== row.payload) throw new Error('invalid_revaluation');
  }
  const current = projectRevaluation(readCostSnapshot(store, row.input_id), readPriceBasis(store, row.target_table_id), id, result.evaluated_at, store);
  return {
    ...current,
    limitations: [...current.limitations, ...(canonicalJson(current) !== canonicalJson(result) ? ['source_compatibility_invalidated_since_capture'] : [])]
  };
}
