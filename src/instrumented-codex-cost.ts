import { IdSchema, TimestampSchema } from './contracts.js';
import { CostFactsSchema } from './flexible-contracts.js';
import {
  InstrumentedAttemptSchema, InstrumentedCostResultSchema, InstrumentedCostSnapshotSchema,
  InstrumentedGateReceiptSchema, InstrumentedLaunchReceiptSchema, InstrumentedProducerProfileSchema,
  InstrumentedProducerRecordSchema, InstrumentedRunControlSchema, InstrumentedWindowSealSchema,
  InstrumentedRetirementReceiptSchema,
  type InstrumentedCostSnapshot,
} from './instrumented-codex-contracts.js';
import { instrumentedMetadataHash } from './instrumented-codex-accounting.js';
import { projectInstrumentedTerminal } from './instrumented-codex-usage.js';
import { costFormulaVersion, priceUsage, readPriceTable, sumAmounts } from './pricing.js';
import { canonicalJson } from './reports/comparison-snapshot.js';
import type { Store } from './store.js';
import { readInstrumentedBuildIdentity } from './instrumented-codex-build-identity.js';

type CostErrorCode = 'unknown_snapshot' | 'invalid_snapshot' | 'snapshot_conflict' |
  'invalidated_snapshot' | 'invalid_cutoff' | 'unknown_seal' | 'price_conflict' |
  'unknown_valuation' | 'valuation_conflict';
export class InstrumentedCostError extends Error {
  readonly name = 'InstrumentedCostError';
  constructor(readonly code: CostErrorCode) { super(code); }
}

function readSnapshot(store: Store, id: string): InstrumentedCostSnapshot {
  IdSchema.parse(id);
  if (store.get("SELECT id FROM instrumented_codex_cost_tombstones WHERE kind='snapshot' AND id=?", [id])) {
    throw new InstrumentedCostError('invalidated_snapshot');
  }
  const row = store.get<{ payload: string; snapshot_hash: string }>(
    'SELECT payload,snapshot_hash FROM instrumented_codex_cost_snapshots WHERE id=?', [id]);
  if (!row) throw new InstrumentedCostError('unknown_snapshot');
  const parsed = InstrumentedCostSnapshotSchema.safeParse(JSON.parse(row.payload) as unknown);
  if (!parsed.success) throw new InstrumentedCostError('invalid_snapshot');
  const { snapshot_hash: hash, ...body } = parsed.data;
  if (hash !== row.snapshot_hash || hash !== instrumentedMetadataHash(body)) {
    throw new InstrumentedCostError('invalid_snapshot');
  }
  return parsed.data;
}

export function captureInstrumentedCostSnapshot(store: Store, request: {
  readonly inputId: string; readonly runId: string; readonly cutoff: string;
}, now = new Date().toISOString()): InstrumentedCostSnapshot {
  IdSchema.parse(request.inputId); IdSchema.parse(request.runId);
  TimestampSchema.parse(request.cutoff); TimestampSchema.parse(now);
  if (Date.parse(request.cutoff) > Date.parse(now)) throw new InstrumentedCostError('invalid_cutoff');
  return store.immediateTransaction(() => {
    if (store.get('SELECT id FROM instrumented_codex_cost_snapshots WHERE id=?', [request.inputId])) {
      const prior = readSnapshot(store, request.inputId);
      if (prior.run_id !== request.runId || prior.cutoff !== request.cutoff) {
        throw new InstrumentedCostError('snapshot_conflict');
      }
      return prior;
    }
    if (store.get("SELECT id FROM instrumented_codex_cost_tombstones WHERE kind='snapshot' AND id=?", [request.inputId])) {
      throw new InstrumentedCostError('invalidated_snapshot');
    }
    const run = store.get<{ control: string; profile: string; state: string }>(
      'SELECT control,profile,state FROM instrumented_codex_runs WHERE id=?', [request.runId]);
    const storedSeal = store.get<{ payload: string; sealed_at: string }>(
      'SELECT payload,sealed_at FROM instrumented_codex_seals WHERE run_id=?', [request.runId]);
    if (!run || run.state !== 'sealed' || !storedSeal) throw new InstrumentedCostError('unknown_seal');
    const seal = InstrumentedWindowSealSchema.parse(JSON.parse(storedSeal.payload));
    if (Date.parse(storedSeal.sealed_at) > Date.parse(request.cutoff)) {
      throw new InstrumentedCostError('invalid_cutoff');
    }
    const control = InstrumentedRunControlSchema.parse(JSON.parse(run.control));
    const profile = InstrumentedProducerProfileSchema.parse(JSON.parse(run.profile));
    const table = readPriceTable(store, control.price_table_id);
    if (instrumentedMetadataHash(table) !== control.price_table_hash) {
      throw new InstrumentedCostError('price_conflict');
    }
    const launchRow = store.get<{ payload: string }>(
      'SELECT payload FROM instrumented_codex_launch_receipts WHERE run_id=?', [request.runId]);
    const retirementRow = store.get<{ payload: string }>(
      'SELECT payload FROM instrumented_codex_retirements WHERE run_id=?', [request.runId]);
    const task = store.get<{ state: string; generation: number; started_at: string; finalized_at: string | null }>(
      'SELECT state,generation,started_at,finalized_at FROM tasks WHERE id=?', [control.task_id]);
    if (!task) throw new InstrumentedCostError('invalidated_snapshot');
    const records = store.all<{ sequence: number; record_hash: string; received_at: string; payload: string; receipt: string }>(
      'SELECT sequence,record_hash,received_at,payload,receipt FROM instrumented_codex_records WHERE run_id=? ORDER BY sequence', [request.runId]);
    const body = {
      schema_version: 1, kind: 'instrumented_cost_snapshot', input_id: request.inputId,
      run_id: request.runId, task_id: control.task_id, project_id: control.project_id,
      cutoff: request.cutoff, captured_at: now, profile, control, seal,
      launch: launchRow ? InstrumentedLaunchReceiptSchema.parse(JSON.parse(launchRow.payload)) : null,
      retirement: retirementRow ? InstrumentedRetirementReceiptSchema.parse(JSON.parse(retirementRow.payload)) : null,
      build_identity: readInstrumentedBuildIdentity(store, profile),
      price_table: table, price_table_hash: control.price_table_hash, price_basis_hash: control.price_basis_hash,
      attempts: store.all('SELECT * FROM instrumented_codex_attempts WHERE run_id=? ORDER BY id', [request.runId])
        .map(row => InstrumentedAttemptSchema.parse(row)),
      records: records.map(row => ({
        sequence: row.sequence, record_hash: row.record_hash, received_at: row.received_at,
        payload: InstrumentedProducerRecordSchema.parse(JSON.parse(row.payload)),
        receipt: InstrumentedGateReceiptSchema.parse(JSON.parse(row.receipt)),
      })),
      receipts: store.all<{ payload: string }>(
        'SELECT payload FROM instrumented_codex_receipts WHERE run_id=? ORDER BY sequence', [request.runId])
        .map(row => InstrumentedGateReceiptSchema.parse(JSON.parse(row.payload))),
      task_lifecycle: {
        ...task,
        active_interval_count: store.get<{ count: number }>(
          'SELECT count(*) AS count FROM active_intervals WHERE task_id=?', [control.task_id])?.count ?? 0,
        other_source_session_count: store.get<{ count: number }>(
          'SELECT count(*) AS count FROM sessions s WHERE s.task_id=? AND NOT EXISTS (SELECT 1 FROM instrumented_codex_members m WHERE m.run_id=? AND m.session_id=s.id)',
          [control.task_id, request.runId])?.count ?? 0,
        other_instrumented_run_count: store.get<{ count: number }>(
          'SELECT count(*) AS count FROM instrumented_codex_runs WHERE task_id=? AND id!=?',
          [control.task_id, request.runId])?.count ?? 0,
        observation_gap_count: store.get<{ count: number }>(
          "SELECT (SELECT count(*) FROM observation_gaps WHERE task_id=?) + (SELECT count(*) FROM observations WHERE task_id=? AND status!='observed') AS count",
          [control.task_id, control.task_id])?.count ?? 0,
        other_source_event_count: store.get<{ count: number }>(
          'SELECT count(*) AS count FROM events WHERE task_id=?', [control.task_id])?.count ?? 0,
      },
    };
    const snapshot = InstrumentedCostSnapshotSchema.parse({
      ...body, snapshot_hash: instrumentedMetadataHash(body),
    });
    store.execute('INSERT INTO instrumented_codex_cost_snapshots(id,run_id,task_id,cutoff,payload,snapshot_hash) VALUES (?,?,?,?,?,?)',
      [snapshot.input_id, snapshot.run_id, snapshot.task_id, snapshot.cutoff, canonicalJson(snapshot), snapshot.snapshot_hash]);
    return snapshot;
  });
}

function projectSnapshot(snapshot: InstrumentedCostSnapshot, table: ReturnType<typeof readPriceTable>, valuationId: string, now: string) {
  const { seal, profile, launch, retirement, build_identity: buildIdentity, attempts, records, receipts, task_lifecycle: lifecycle } = snapshot;
  const receiptById = new Map(receipts.map(receipt => [receipt.receipt_id, receipt]));
  const recordBySequence = new Map(records.map(record => [record.sequence, record]));
  const members = new Map(seal.members.map(member => [member.member_id, member]));
  const trustedLaunch = launch !== null && buildIdentity !== null &&
    canonicalJson(buildIdentity.profile) === canonicalJson(profile) &&
    Date.parse(buildIdentity.qualified_at) <= Date.parse(launch.started_at) &&
    launch.run_id === snapshot.run_id &&
    launch.binary_sha256 === profile.binary_sha256 && launch.manifest_hash === profile.build_manifest_digest &&
    launch.configuration_receipt_hash === instrumentedMetadataHash([snapshot.control.configuration_receipt_id, profile]) &&
    launch.authorization_receipt_hash === instrumentedMetadataHash([
      snapshot.task_id, snapshot.control.task_generation, snapshot.control.authorization_receipt_id,
    ]) && records[0] !== undefined && Date.parse(launch.started_at) <= Date.parse(records[0].received_at) &&
    Date.parse(launch.started_at) <= Date.parse(seal.opened_at);
  const sealHashes = seal.attempt_ledger_hash === instrumentedMetadataHash(attempts) &&
    seal.terminal_records_hash === instrumentedMetadataHash(records.map(record => record.payload)) &&
    seal.lifecycle_evidence_hash === instrumentedMetadataHash([
      snapshot.task_id, snapshot.control.task_generation, snapshot.control.authorization_receipt_id,
    ]) &&
    seal.configuration_evidence_hash === instrumentedMetadataHash([
      snapshot.control.configuration_receipt_id, profile,
    ]);
  const chain = records.every((record, index) =>
    record.sequence === index + 1 && record.record_hash === instrumentedMetadataHash(record.payload) &&
    record.payload.previous_record_hash === (index === 0 ? null : records[index - 1]?.record_hash) &&
    record.receipt.control_sequence === index + 1 &&
    canonicalJson(record.receipt) === canonicalJson(receipts[index])) &&
    records.length === receipts.length && sealHashes;
  const memberBarriers = seal.members.every(member => {
    const closed = recordBySequence.get(member.final_record_sequence);
    const ready = records.find(record => record.payload.member_id === member.member_id &&
      record.payload.body.kind === 'member_ready');
    return closed?.payload.body.kind === 'member_close' &&
      closed.record_hash === member.final_record_hash && closed.receipt.receipt_id === member.close_receipt_id &&
      closed.payload.member_id === member.member_id && ready?.payload.body.kind === 'member_ready' &&
      member.identity_receipt_hash === instrumentedMetadataHash([
        ready.payload.body.native_session_id, member.session_id,
        ready.payload.body.parent_member_id, ready.receipt.receipt_id,
      ]);
  });
  const conserved = attempts.every(attempt => {
    const reservation = receiptById.get(attempt.reservation_receipt_id)?.body;
    if (reservation?.kind !== 'attempt_reserved' || reservation.attempt_id !== attempt.id ||
        reservation.member_id !== attempt.member_id || reservation.operation_id !== attempt.operation_id) return false;
    if (attempt.state === 'not_dispatched') return attempt.dispatch_receipt_id === null;
    if (attempt.state !== 'terminal' || attempt.terminal_sequence === null || attempt.dispatch_receipt_id === null) return false;
    const dispatched = receiptById.get(attempt.dispatch_receipt_id)?.body;
    const terminal = recordBySequence.get(attempt.terminal_sequence)?.payload;
    return dispatched?.kind === 'dispatch_committed' && dispatched.attempt_id === attempt.id &&
      terminal?.body.kind === 'attempt_terminal' && terminal.body.attempt_id === attempt.id &&
      terminal.member_id === attempt.member_id && members.has(attempt.member_id);
  });
  const terminals = attempts.flatMap(attempt => {
    if (attempt.state !== 'terminal' || attempt.terminal_sequence === null) return [];
    const record = recordBySequence.get(attempt.terminal_sequence);
    const member = members.get(attempt.member_id);
    if (!record || !member || record.payload.body.kind !== 'attempt_terminal') return [];
    return [{ ...projectInstrumentedTerminal({
      record: record.payload, profile, taskId: snapshot.task_id, projectId: snapshot.project_id,
      sessionId: member.session_id, receivedAt: record.received_at,
    }), responseId: record.payload.body.response_id }];
  });
  const duplicateIds = new Set(terminals.flatMap(terminal =>
    terminal.responseId !== null && terminals.filter(other => other.responseId === terminal.responseId).length > 1
      ? [terminal.responseId] : []));
  const priced = terminals.map(terminal => terminal.responseId !== null && duplicateIds.has(terminal.responseId)
    ? null : priceUsage(terminal.event, table, 'output-only-v1', [terminal.runtime]));
  const partial = priced.flatMap(value => value?.partial_amount === null || value === null ? [] : [value.partial_amount]);
  const amount = partial.length > 0 ? sumAmounts(partial) : null;
  const hasValue = terminals.some(terminal => terminal.event.payload.input_total.status === 'observed' ||
    terminal.event.payload.output_total.status === 'observed');
  const clean = seal.reason_codes.length === 0 && seal.counts.unresolved === 0 && memberBarriers &&
    seal.counts.reserved === attempts.length &&
    seal.counts.dispatch_committed === attempts.filter(attempt => attempt.state === 'terminal' || attempt.state === 'dispatched').length &&
    seal.counts.terminal === terminals.length;
  const requiredCounters = terminals.length > 0 && terminals.every(terminal =>
    terminal.required_counters_present && terminal.event.payload.attribution === 'verified') && duplicateIds.size === 0;
  const priceComplete = priced.length > 0 && priced.every(value => value !== null && value.amount !== null);
  const facts = CostFactsSchema.parse({
    scope_before_access: trustedLaunch ? 'verified' : 'unknown',
    fresh_session: trustedLaunch ? 'verified' : 'unknown',
    ready_before_first_request: trustedLaunch && conserved ? 'verified' : 'unknown',
    continuous_observation: clean && chain ? 'verified' : 'violated',
    configuration_accounting: trustedLaunch ? 'verified' : 'unknown',
    bounded_topology: clean && members.size <= 3 ? 'verified' : 'violated',
    request_universe: trustedLaunch && conserved && chain ? 'verified' : 'unknown',
    terminal_accounting: conserved && requiredCounters ? 'verified' : 'unknown',
    immutable_identity: trustedLaunch ? 'verified' : 'unknown',
    durable_flush: trustedLaunch && clean ? 'verified' : 'unknown',
    counter_semantics: requiredCounters ? 'verified' : 'unknown',
    price_coverage: priceComplete ? 'verified' : 'unknown',
  });
  const usageComplete = hasValue && CostFactsSchema.keyof().options.filter(key => key !== 'price_coverage')
    .every(key => facts[key] === 'verified');
  const windowAmount = usageComplete && priceComplete ? amount : null;
  const wholeTask = trustedLaunch && launch.start_kind === 'task_start' && lifecycle.state === 'finalized' &&
    lifecycle.generation === snapshot.control.task_generation + 1 && snapshot.control.task_generation === 1 &&
    lifecycle.finalized_at !== null && Date.parse(lifecycle.finalized_at) <= Date.parse(snapshot.cutoff) &&
    Date.parse(lifecycle.started_at) <= Date.parse(launch.started_at) &&
    Date.parse(seal.closed_at) <= Date.parse(lifecycle.finalized_at) &&
    lifecycle.active_interval_count === 1 && lifecycle.other_source_session_count === 0 &&
    lifecycle.other_instrumented_run_count === 0 && lifecycle.observation_gap_count === 0 &&
    lifecycle.other_source_event_count === 0 && retirement !== null &&
    retirement.run_id === snapshot.run_id && retirement.launch_receipt_id === launch.receipt_id &&
    retirement.process_id === launch.process_id && retirement.final_producer_sequence === records.length &&
    Date.parse(seal.sealed_at) <= Date.parse(retirement.retired_at) &&
    Date.parse(retirement.retired_at) <= Date.parse(lifecycle.finalized_at);
  return InstrumentedCostResultSchema.parse({
    schema_version: 3, kind: 'instrumented_standardized_cost', valuation_id: valuationId,
    input_id: snapshot.input_id, run_id: snapshot.run_id, task_id: snapshot.task_id, seal_id: seal.seal_id,
    source_snapshot_hash: snapshot.snapshot_hash, cutoff: snapshot.cutoff, evaluated_at: now,
    coverage_scope: wholeTask ? 'whole_task' : 'work_window', opened_at: seal.opened_at, closed_at: seal.closed_at,
    currency: table.currency, price_table_id: table.id, price_table_hash: instrumentedMetadataHash(table),
    price_basis_hash: table.id === snapshot.price_table.id ? snapshot.price_basis_hash : null,
    original_price_table_id: snapshot.price_table.id, formula_version: costFormulaVersion,
    usage_complete: usageComplete, price_complete: priceComplete, facts,
    complete_window_amount: windowAmount, complete_amount: wholeTask ? windowAmount : null,
    partial_amount: trustedLaunch ? amount : null, source_unverified_partial_amount: trustedLaunch ? null : amount,
    observed_attempt_count: terminals.length, unresolved_attempt_count: seal.counts.unresolved,
    reasons: [...new Set([
      ...seal.reason_codes, ...(!trustedLaunch ? ['source_unverified' as const] : []),
      ...(!hasValue ? ['missing_value' as const] : []), ...(!wholeTask ? ['task_coverage' as const] : []),
      ...(duplicateIds.size ? ['ambiguous_response' as const] : []),
      ...priced.flatMap(value => value?.reasons ?? []),
      ...CostFactsSchema.keyof().options.filter(key => facts[key] !== 'verified'),
    ])].sort(),
    limitations: ['reference_cost_not_actual_billing', 'no_inferential_adoption',
      ...(!wholeTask ? ['sealed_window_is_not_whole_task'] : [])],
  });
}

export function createInstrumentedValuation(store: Store, request: {
  readonly id: string; readonly inputId: string; readonly targetTableId: string;
}, now = new Date().toISOString()) {
  [request.id, request.inputId, request.targetTableId].forEach(id => IdSchema.parse(id));
  TimestampSchema.parse(now);
  return store.immediateTransaction(() => {
    if (store.get("SELECT id FROM instrumented_codex_cost_tombstones WHERE kind='valuation' AND id=?", [request.id])) {
      throw new InstrumentedCostError('invalidated_snapshot');
    }
    const previous = store.get<{ snapshot_id: string; target_table_id: string; payload: string }>(
      'SELECT snapshot_id,target_table_id,payload FROM instrumented_codex_valuations WHERE id=?', [request.id]);
    if (previous) {
      if (previous.snapshot_id !== request.inputId || previous.target_table_id !== request.targetTableId) {
        throw new InstrumentedCostError('valuation_conflict');
      }
      readSnapshot(store, request.inputId);
      return InstrumentedCostResultSchema.parse(JSON.parse(previous.payload));
    }
    const snapshot = readSnapshot(store, request.inputId);
    if (Date.parse(now) < Date.parse(snapshot.cutoff)) throw new InstrumentedCostError('invalid_cutoff');
    const result = projectSnapshot(snapshot, readPriceTable(store, request.targetTableId), request.id, now);
    store.execute('INSERT INTO instrumented_codex_valuations(id,snapshot_id,target_table_id,payload) VALUES (?,?,?,?)',
      [request.id, request.inputId, request.targetTableId, canonicalJson(result)]);
    return result;
  });
}

export function readInstrumentedValuation(store: Store, id: string) {
  IdSchema.parse(id);
  if (store.get("SELECT id FROM instrumented_codex_cost_tombstones WHERE kind='valuation' AND id=?", [id])) {
    return { valuation_id: id, validity_status: 'invalidated' as const };
  }
  const row = store.get<{ snapshot_id: string; payload: string }>(
    'SELECT snapshot_id,payload FROM instrumented_codex_valuations WHERE id=?', [id]);
  if (!row) throw new InstrumentedCostError('unknown_valuation');
  const snapshot = readSnapshot(store, row.snapshot_id);
  const result = InstrumentedCostResultSchema.parse(JSON.parse(row.payload));
  const current = projectSnapshot(snapshot, readPriceTable(store, result.price_table_id), id, result.evaluated_at);
  if (canonicalJson(result) !== canonicalJson(current)) throw new InstrumentedCostError('invalid_snapshot');
  return result;
}
