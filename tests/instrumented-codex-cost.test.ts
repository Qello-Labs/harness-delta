import { expect, test } from 'vitest';
import { Deletion } from '../src/deletion.js';
import { instrumentedMetadataHash } from '../src/instrumented-codex-accounting.js';
import { InstrumentedBuildIdentitySchema, InstrumentedLaunchReceiptSchema } from '../src/instrumented-codex-contracts.js';
import {
  captureInstrumentedCostSnapshot, createInstrumentedValuation, readInstrumentedValuation,
} from '../src/instrumented-codex-cost.js';
import { registerPriceTable } from '../src/pricing.js';
import { instrumentedFixtureProfile, makeInstrumentedCostFixture } from './helpers/instrumented-codex-fixture.js';

function storedQualifiedFixture() {
  const f = makeInstrumentedCostFixture(':memory:', false);
  const identity = InstrumentedBuildIdentitySchema.parse({
    schema_version: 1, id: 'synthetic-build-identity', profile: instrumentedFixtureProfile,
    qualification_kind: 'instrumented_localhost', qualification_hash: instrumentedMetadataHash('synthetic-conformance'),
    qualified_at: f.now(),
  });
  f.store.execute(
    'INSERT INTO instrumented_codex_build_identities(id,profile_id,binary_sha256,manifest_hash,qualification_kind,qualification_hash,qualified_at,payload) VALUES (?,?,?,?,?,?,?,?)',
    [identity.id, identity.profile.profile_id, identity.profile.binary_sha256, identity.profile.build_manifest_digest,
      identity.qualification_kind, identity.qualification_hash, identity.qualified_at, JSON.stringify(identity)]);
  const launch = InstrumentedLaunchReceiptSchema.parse({
    schema_version: 1, receipt_id: 'launch-1', run_id: 'run-1',
    binary_sha256: identity.profile.binary_sha256, manifest_hash: identity.profile.build_manifest_digest,
    process_id: 123, started_at: f.now(), start_kind: 'task_start',
    configuration_receipt_hash: instrumentedMetadataHash([f.control.configuration_receipt_id, identity.profile]),
    authorization_receipt_hash: instrumentedMetadataHash([
      f.control.task_id, f.control.task_generation, f.control.authorization_receipt_id,
    ]),
  });
  f.store.execute(
    'INSERT INTO instrumented_codex_launch_receipts(run_id,receipt_id,binary_sha256,manifest_hash,process_id,started_at,start_kind,payload) VALUES (?,?,?,?,?,?,?,?)',
    [launch.run_id, launch.receipt_id, launch.binary_sha256, launch.manifest_hash,
      launch.process_id, launch.started_at, launch.start_kind, JSON.stringify(launch)]);
  f.ready();
  return f;
}

test('stored qualified source evidence establishes a complete window but not an unclosed task', () => {
  const f = storedQualifiedFixture();
  try {
    f.request(); f.seal();
    const snapshot = captureInstrumentedCostSnapshot(f.store, {
      inputId: 'input-1', runId: 'run-1', cutoff: f.now(),
    }, f.now());
    const result = createInstrumentedValuation(f.store, {
      id: 'valuation-1', inputId: snapshot.input_id, targetTableId: f.table.id,
    }, f.now());
    expect(result).toMatchObject({
      usage_complete: true, price_complete: true, complete_window_amount: '0.22',
      complete_amount: null, coverage_scope: 'work_window', partial_amount: '0.22',
      source_unverified_partial_amount: null,
    });
  } finally { f.store.close(); }
});

test('qualified source still needs process retirement before human finalization covers a task', () => {
  const f = storedQualifiedFixture();
  try {
    f.request(); f.seal();
    f.setTime('2026-10-12T00:00:05Z');
    f.lifecycle.finalize('task-1', 'success', ['criterion-1']);
    const snapshot = captureInstrumentedCostSnapshot(f.store, {
      inputId: 'input-1', runId: 'run-1', cutoff: f.now(),
    }, f.now());
    const result = createInstrumentedValuation(f.store, {
      id: 'valuation-1', inputId: snapshot.input_id, targetTableId: f.table.id,
    }, f.now());
    expect(result.complete_window_amount).toBe('0.22');
    expect(result.complete_amount).toBeNull();
    expect(result.coverage_scope).toBe('work_window');
  } finally { f.store.close(); }
});

test.each([false, true])('outside source events prevent whole-task coverage even with a retired qualified family: %s', external => {
  const f = storedQualifiedFixture();
  try {
    f.request(); f.seal();
    const count = f.store.all('SELECT sequence FROM instrumented_codex_records').length;
    const retirement = {
      schema_version: 1, run_id: 'run-1', launch_receipt_id: 'launch-1',
      process_id: 123, exit_code: 0, retired_at: f.now(), final_producer_sequence: count,
    };
    f.store.execute(
      'INSERT INTO instrumented_codex_retirements(run_id,launch_receipt_id,process_id,exit_code,retired_at,final_producer_sequence,payload) VALUES (?,?,?,?,?,?,?)',
      [retirement.run_id, retirement.launch_receipt_id, retirement.process_id, retirement.exit_code,
        retirement.retired_at, retirement.final_producer_sequence, JSON.stringify(retirement)]);
    f.setTime('2026-10-12T00:00:05Z');
    if (external) f.store.execute(
      'INSERT INTO events(id,project_id,task_id,session_id,source_key,occurred_at,payload) VALUES (?,?,?,?,?,?,?)',
      ['outside-event', 'project-1', 'task-1', 'session-1', 'outside-source-key', f.now(), '{}']);
    f.lifecycle.finalize('task-1', 'success', ['criterion-1']);
    const snapshot = captureInstrumentedCostSnapshot(f.store, {
      inputId: 'input-1', runId: 'run-1', cutoff: f.now(),
    }, f.now());
    const result = createInstrumentedValuation(f.store, {
      id: 'valuation-1', inputId: snapshot.input_id, targetTableId: f.table.id,
    }, f.now());
    expect(result.complete_window_amount).toBe('0.22');
    expect(result.complete_amount).toBe(external ? null : '0.22');
    expect(result.coverage_scope).toBe(external ? 'work_window' : 'whole_task');
  } finally { f.store.close(); }
});

test('launch receipts are immutable while their run exists and purge with task deletion', () => {
  const f = makeInstrumentedCostFixture(':memory:', false);
  try {
    const launch = {
      schema_version: 1, receipt_id: 'launch-1', run_id: 'run-1',
      binary_sha256: instrumentedFixtureProfile.binary_sha256,
      manifest_hash: instrumentedFixtureProfile.build_manifest_digest, process_id: 123,
      started_at: f.now(), start_kind: 'task_start',
      configuration_receipt_hash: instrumentedMetadataHash([f.control.configuration_receipt_id, instrumentedFixtureProfile]),
      authorization_receipt_hash: instrumentedMetadataHash([
        f.control.task_id, f.control.task_generation, f.control.authorization_receipt_id,
      ]),
    };
    f.store.execute(
      'INSERT INTO instrumented_codex_launch_receipts(run_id,receipt_id,binary_sha256,manifest_hash,process_id,started_at,start_kind,payload) VALUES (?,?,?,?,?,?,?,?)',
      [launch.run_id, launch.receipt_id, launch.binary_sha256, launch.manifest_hash,
        launch.process_id, launch.started_at, launch.start_kind, JSON.stringify(launch)],
    );
    expect(() => f.store.execute('DELETE FROM instrumented_codex_launch_receipts', [])).toThrow('immutable_instrumented_launch');
    expect(() => f.store.execute("UPDATE instrumented_codex_launch_receipts SET start_kind='work_window'", [])).toThrow('immutable_instrumented_launch');
    new Deletion(f.store, f.now).deleteTask('task-1');
    expect(f.store.all('SELECT * FROM instrumented_codex_launch_receipts')).toEqual([]);
  } finally { f.store.close(); }
});

test('finalizing a sealed window without an owned process retirement cannot cover the whole task', () => {
  const f = makeInstrumentedCostFixture(':memory:', false);
  try {
    const launch = {
      schema_version: 1, receipt_id: 'launch-1', run_id: 'run-1',
      binary_sha256: instrumentedFixtureProfile.binary_sha256,
      manifest_hash: instrumentedFixtureProfile.build_manifest_digest, process_id: 123,
      started_at: f.now(), start_kind: 'task_start',
      configuration_receipt_hash: instrumentedMetadataHash([f.control.configuration_receipt_id, instrumentedFixtureProfile]),
      authorization_receipt_hash: instrumentedMetadataHash([
        f.control.task_id, f.control.task_generation, f.control.authorization_receipt_id,
      ]),
    };
    f.store.execute(
      'INSERT INTO instrumented_codex_launch_receipts(run_id,receipt_id,binary_sha256,manifest_hash,process_id,started_at,start_kind,payload) VALUES (?,?,?,?,?,?,?,?)',
      [launch.run_id, launch.receipt_id, launch.binary_sha256, launch.manifest_hash,
        launch.process_id, launch.started_at, launch.start_kind, JSON.stringify(launch)],
    );
    f.ready(); f.request(); f.seal();
    f.setTime('2026-10-12T00:00:05Z');
    f.lifecycle.finalize('task-1', 'success', ['criterion-1']);
    const snapshot = captureInstrumentedCostSnapshot(f.store, {
      inputId: 'input-1', runId: 'run-1', cutoff: f.now(),
    }, f.now());
    const result = createInstrumentedValuation(f.store, {
      id: 'valuation-1', inputId: snapshot.input_id, targetTableId: f.table.id,
    }, f.now());
    expect(result.coverage_scope).toBe('work_window');
    expect(result.complete_window_amount).toBeNull();
    expect(result.partial_amount).toBeNull();
    expect(result.source_unverified_partial_amount).toBe('0.22');
    expect(result.complete_amount).toBeNull();
    expect(result.reasons).toContain('task_coverage');
    expect(result.reasons).toContain('source_unverified');
  } finally { f.store.close(); }
});

test('a launch receipt cannot be added retroactively after producer admission or sealing', () => {
  const f = makeInstrumentedCostFixture();
  try {
    f.request(); f.seal();
    const launch = InstrumentedLaunchReceiptSchema.parse({
      schema_version: 1, receipt_id: 'late-launch', run_id: 'run-1',
      binary_sha256: instrumentedFixtureProfile.binary_sha256,
      manifest_hash: instrumentedFixtureProfile.build_manifest_digest, process_id: 123,
      started_at: f.now(), start_kind: 'task_start',
      configuration_receipt_hash: instrumentedMetadataHash([f.control.configuration_receipt_id, instrumentedFixtureProfile]),
      authorization_receipt_hash: instrumentedMetadataHash([
        f.control.task_id, f.control.task_generation, f.control.authorization_receipt_id,
      ]),
    });
    expect(() => f.store.execute(
      'INSERT INTO instrumented_codex_launch_receipts(run_id,receipt_id,binary_sha256,manifest_hash,process_id,started_at,start_kind,payload) VALUES (?,?,?,?,?,?,?,?)',
      [launch.run_id, launch.receipt_id, launch.binary_sha256, launch.manifest_hash,
        launch.process_id, launch.started_at, launch.start_kind, JSON.stringify(launch)],
    )).toThrow('late_instrumented_launch');
  } finally { f.store.close(); }
});

test('caller-created metadata cannot become admitted complete cost without an owned launch', () => {
  const f = makeInstrumentedCostFixture();
  try {
    f.request(); f.seal();
    const snapshot = captureInstrumentedCostSnapshot(f.store, {
      inputId: 'input-1', runId: 'run-1', cutoff: f.now(),
    }, f.now());
    const result = createInstrumentedValuation(f.store, {
      id: 'valuation-1', inputId: snapshot.input_id, targetTableId: f.table.id,
    }, f.now());
    expect(result).toMatchObject({
      usage_complete: false, complete_window_amount: null, complete_amount: null,
      partial_amount: null, source_unverified_partial_amount: '0.22', coverage_scope: 'work_window',
    });
    expect(result.reasons).toContain('source_unverified');
  } finally { f.store.close(); }
});

test('a seal committed after cutoff cannot certify earlier knowledge', () => {
  const f = makeInstrumentedCostFixture();
  try {
    f.request(); f.setTime('2026-10-12T00:00:02Z'); f.seal();
    expect(() => captureInstrumentedCostSnapshot(f.store, {
      inputId: 'input-1', runId: 'run-1', cutoff: '2026-10-12T00:00:01Z',
    }, f.now())).toThrow('invalid_cutoff');
  } finally { f.store.close(); }
});

test('revaluation keeps the exact sealed usage and leaves the original pin and result unchanged', () => {
  const f = makeInstrumentedCostFixture();
  try {
    f.request(); f.seal();
    const snapshot = captureInstrumentedCostSnapshot(f.store, {
      inputId: 'input-1', runId: 'run-1', cutoff: f.now(),
    }, f.now());
    const original = createInstrumentedValuation(f.store, {
      id: 'original', inputId: snapshot.input_id, targetTableId: f.table.id,
    }, f.now());
    const next = { ...f.table, id: 'synthetic-next-prices', entries: f.table.entries.map(entry =>
      entry.component === 'output' ? { ...entry, price_per_unit: '8' } : entry) };
    registerPriceTable(f.store, next);
    const repriced = createInstrumentedValuation(f.store, {
      id: 'repriced', inputId: snapshot.input_id, targetTableId: next.id,
    }, f.now());
    expect(repriced).toMatchObject({
      source_snapshot_hash: snapshot.snapshot_hash, source_unverified_partial_amount: '0.26',
      original_price_table_id: f.table.id, complete_amount: null,
    });
    expect(readInstrumentedValuation(f.store, original.valuation_id)).toEqual(original);
    expect(f.accounting.control().price_table_id).toBe(f.table.id);
  } finally { f.store.close(); }
});

test('a repeated provider response identity across attempts is not automatically summed or collapsed', () => {
  const f = makeInstrumentedCostFixture();
  try {
    f.request('shared-response'); f.request('shared-response'); f.seal();
    const snapshot = captureInstrumentedCostSnapshot(f.store, {
      inputId: 'input-1', runId: 'run-1', cutoff: f.now(),
    }, f.now());
    const result = createInstrumentedValuation(f.store, {
      id: 'valuation-1', inputId: snapshot.input_id, targetTableId: f.table.id,
    }, f.now());
    expect(result.source_unverified_partial_amount).toBeNull();
    expect(result.reasons).toContain('ambiguous_response');
  } finally { f.store.close(); }
});

test('task deletion purges sealed usage snapshots and blocks valuation resurrection', () => {
  const f = makeInstrumentedCostFixture();
  try {
    f.request(); f.seal();
    captureInstrumentedCostSnapshot(f.store, { inputId: 'input-1', runId: 'run-1', cutoff: f.now() }, f.now());
    createInstrumentedValuation(f.store, { id: 'valuation-1', inputId: 'input-1', targetTableId: f.table.id }, f.now());
    new Deletion(f.store, f.now).deleteTask('task-1');
    expect(readInstrumentedValuation(f.store, 'valuation-1')).toMatchObject({ validity_status: 'invalidated' });
    expect(f.store.all('SELECT * FROM instrumented_codex_cost_snapshots')).toEqual([]);
    expect(() => createInstrumentedValuation(f.store, {
      id: 'valuation-1', inputId: 'input-1', targetTableId: f.table.id,
    }, f.now())).toThrow('invalidated_snapshot');
  } finally { f.store.close(); }
});
