import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex } from 'node:stream';
import { afterEach, expect, test } from 'vitest';
import { InstrumentedAccounting, instrumentedMetadataHash } from '../src/instrumented-codex-accounting.js';
import { connectInstrumentedDescriptor } from '../src/instrumented-codex-descriptor.js';
import {
  InstrumentedRunControlSchema,
  type InstrumentedProducerRecord,
} from '../src/instrumented-codex-contracts.js';
import { Lifecycle } from '../src/lifecycle.js';
import { Store } from '../src/store.js';
import { instrumentedFixtureProfile as profile } from './helpers/instrumented-codex-fixture.js';
import { PriceTableSchema } from '../src/flexible-contracts.js';
import { registerPriceTable } from '../src/pricing.js';
import { registerProtocol, registerVariant } from '../src/comparison.js';
import { makeFlexibleFixture } from './helpers/flexible-fixture.js';
import { Deletion } from '../src/deletion.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'harness-accounting-'));
  const now = '2026-01-01T00:00:00Z';
  const store = new Store(':memory:', () => now);
  cleanups.push(() => { store.close(); rmSync(root, { recursive: true }); });
  const lifecycle = new Lifecycle(store, () => now);
  lifecycle.registerProject('project-1', root);
  lifecycle.createTask('project-1', 'task-1', {
    type: 'feature', expected_size: 'small', assignee: 'user-1', product: 'codex',
    model: 'gpt-6.1-sol', criterion_ids: ['criterion-1'],
  });
  lifecycle.start('task-1');
  store.execute('INSERT INTO sessions(id,project_id,task_id,product,product_version) VALUES (?,?,?,?,?)',
    ['session-1', 'project-1', 'task-1', 'codex', '0.162.1']);
  const table = PriceTableSchema.parse({
    id: 'prices-1', version: 'synthetic-v1', currency: 'USD', source_id: 'synthetic-rates',
    as_of: now, unit_tokens: 1000, display_decimals: 6, rounding: 'half_even',
    entries: [{ product: 'codex', model: 'gpt-6.1-sol', component: 'ordinary_input', price_per_unit: '2' }],
  });
  registerPriceTable(store, table);
  const control = InstrumentedRunControlSchema.parse({
    schema_version: 1, run_id: 'run-1', project_id: 'project-1', task_id: 'task-1',
    task_generation: 1, collector_instance_id: 'collector-1', profile_id: profile.profile_id,
    producer_manifest_hash: profile.build_manifest_digest, root_session_id: 'session-1',
    configuration_receipt_id: 'configuration-1', authorization_receipt_id: 'authorization-1',
    price_table_id: 'prices-1', price_table_hash: instrumentedMetadataHash(table), price_basis_hash: null,
    state: 'prepared', opened_at: null, closed_at: null, control_sequence: 0,
  });
  const accounting = InstrumentedAccounting.prepare(store, { control, profile, producerInstanceId: 'producer-1' }, () => now);
  let sequence = 0;
  let previousHash: string | null = null;
  const send = (body: InstrumentedProducerRecord['body'], memberId = 'session-1') => {
    const record: InstrumentedProducerRecord = {
      schema_version: 1, run_id: 'run-1', producer_instance_id: 'producer-1', member_id: memberId,
      task_generation: 1, sequence: sequence + 1, previous_record_hash: previousHash,
      occurred_at: now, body,
    };
    const receipt = accounting.receive(record);
    sequence = record.sequence; previousHash = instrumentedMetadataHash(record);
    return { record, receipt };
  };
  const ready = (memberId = 'session-1', parentId: string | null = null, reservationId: string | null = null) =>
    send({ kind: 'member_ready', native_session_id: randomUUID(), parent_member_id: parentId,
      child_reservation_id: reservationId, configuration_receipt_id: 'configuration-1' }, memberId);
  const open = () => send({ kind: 'operation_open', operation_id: 'operation-1', turn_id: null,
    operation_class: 'generation', transport_class: 'http_responses', requested_model: 'gpt-6.1-sol',
    requested_effort: 'high', configuration_revision: 'configuration-1' });
  const reserve = () => {
    const { receipt } = send({ kind: 'attempt_reserve', operation_id: 'operation-1', retry_parent_attempt_id: null });
    if (receipt.body.kind !== 'attempt_reserved') throw new Error('unexpected_fixture_receipt');
    return receipt.body.attempt_id;
  };
  const close = (memberId = 'session-1', fenceId?: string) => {
    let id = fenceId;
    if (!id) {
      const { receipt } = send({ kind: 'close_request' });
      if (receipt.body.kind !== 'close_fence') throw new Error('unexpected_fixture_receipt');
      id = receipt.body.close_fence_id;
    }
    send({ kind: 'member_close', close_fence_id: id,
      final_record_sequence: sequence, final_record_hash: previousHash }, memberId);
    return id;
  };
  return { store, lifecycle, accounting, send, ready, open, reserve, close };
}

test('record hashing canonicalizes nested field order across the native and receiver serializers', () => {
  const expected = createHash('sha256').update('{"a":[{"b":1,"c":2}],"z":0}').digest('hex');
  expect(instrumentedMetadataHash({ z: 0, a: [{ c: 2, b: 1 }] })).toBe(expected);
});

test('a mismatched price pin is rejected before producer preparation', () => {
  const f = fixture();
  expect(() => InstrumentedAccounting.prepare(f.store, {
    control: { ...f.accounting.control(), run_id: 'run-2', price_table_hash: '0'.repeat(64) },
    profile, producerInstanceId: 'producer-2',
  })).toThrow('price_conflict');
  expect(f.store.get<{ count: number }>('SELECT count(*) AS count FROM instrumented_codex_runs')?.count).toBe(1);
});

test('an assigned task cannot replace its frozen price reference with another registered table', () => {
  const f = fixture();
  const comparison = makeFlexibleFixture();
  registerVariant(f.store, comparison.variants[0]);
  registerProtocol(f.store, { ...comparison.protocol, price_table_id: 'frozen-prices' });
  f.store.execute("UPDATE comparison_protocols SET status='frozen',frozen_at=? WHERE id=?",
    ['2025-12-31T00:00:00Z', comparison.protocol.id]);
  f.store.execute(
    'INSERT INTO comparison_assignments(id,task_id,project_id,protocol_id,variant_id,assigned_at,recorded_at,followup_ends_at,stratum_id,block_id,allocation_index,allocator_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    ['synthetic-assignment', 'task-1', 'project-1', comparison.protocol.id, 'variant-a',
      '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z',
      'stratum-user-1', 'synthetic-block', 0, 'allocator-1']);
  expect(() => InstrumentedAccounting.prepare(f.store, {
    control: { ...f.accounting.control(), run_id: 'run-2' },
    profile, producerInstanceId: 'producer-2',
  })).toThrow('price_conflict');
  expect(f.store.get<{ count: number }>('SELECT count(*) AS count FROM instrumented_codex_runs')?.count).toBe(1);
});

test('a dispatched attempt without its terminal remains unresolved in the sealed ledger', () => {
  const f = fixture(); f.ready(); f.open(); const attemptId = f.reserve();
  f.send({ kind: 'dispatch_commit', attempt_id: attemptId });
  f.send({ kind: 'operation_close', operation_id: 'operation-1', disposition: 'failed' }); f.close();
  const seal = f.accounting.seal();
  expect(seal.counts).toEqual({ reserved: 1, dispatch_committed: 1, not_dispatched: 0, terminal: 0, unresolved: 1 });
  expect(seal.unresolved_attempt_ids).toEqual([attemptId]);
  expect(seal.reason_codes).toContain('unresolved_attempt');
});

test('identical record replay returns its durable receipt without reserving a second attempt', () => {
  const f = fixture(); f.ready(); f.open();
  const accepted = f.send({ kind: 'attempt_reserve', operation_id: 'operation-1', retry_parent_attempt_id: null });
  expect(f.accounting.receive(accepted.record)).toEqual(accepted.receipt);
  expect(f.store.get<{ count: number }>('SELECT count(*) AS count FROM instrumented_codex_attempts')?.count).toBe(1);
});

test('a conflicting replay cannot overwrite its accepted receipt and permanently marks the stream', () => {
  const f = fixture(); const accepted = f.ready();
  expect(() => f.accounting.receive({ ...accepted.record, occurred_at: '2026-01-01T00:00:01Z' })).toThrow('record_conflict');
  expect(f.accounting.receive(accepted.record)).toEqual(accepted.receipt);
  expect(f.store.get<{ reason_codes: string }>('SELECT reason_codes FROM instrumented_codex_runs')?.reason_codes).toContain('record_conflict');
});

test('generation revocation wins before accessing a late record body', () => {
  const f = fixture(); f.ready(); f.lifecycle.pause('task-1');
  let decoded = false;
  expect(() => f.accounting.receive({ get body() { decoded = true; return 'late'; } })).toThrow('inactive_scope');
  expect(decoded).toBe(false);
  expect(f.store.get<{ state: string }>('SELECT state FROM instrumented_codex_runs')?.state).toBe('revoked');
});

test('a close fence prohibits a new dispatch but permits retirement of an unconsumed reservation', () => {
  const f = fixture(); f.ready(); f.open(); const attemptId = f.reserve();
  f.send({ kind: 'close_request' });
  expect(() => f.send({ kind: 'dispatch_commit', attempt_id: attemptId })).toThrow('invalid_attempt');
  f.send({ kind: 'not_dispatched', attempt_id: attemptId });
  expect(f.store.get<{ state: string }>('SELECT state FROM instrumented_codex_attempts')?.state).toBe('not_dispatched');
});

test('family closure cannot substitute a root close for a missing admitted child close', () => {
  const f = fixture(); f.ready();
  const reservation = f.send({ kind: 'child_reserve', parent_member_id: 'session-1' }).receipt;
  if (reservation.body.kind !== 'child_reserved') throw new Error('unexpected_fixture_receipt');
  f.ready('child-1', 'session-1', reservation.body.child_reservation_id); f.close();
  expect(() => f.accounting.seal()).toThrow('missing_member_close');
});

test('a third lifetime child reservation fails and cannot be erased by a later clean closure', () => {
  const f = fixture(); f.ready();
  for (let index = 0; index < 2; index++) {
    const reservation = f.send({ kind: 'child_reserve', parent_member_id: 'session-1' }).receipt;
    if (reservation.body.kind !== 'child_reserved') throw new Error('unexpected_fixture_receipt');
    f.send({ kind: 'child_cancel', child_reservation_id: reservation.body.child_reservation_id });
  }
  expect(() => f.send({ kind: 'child_reserve', parent_member_id: 'session-1' })).toThrow('topology_mismatch');
  f.close();
  expect(f.accounting.seal().reason_codes).toContain('topology_mismatch');
});

test('unqualified auxiliary work stays partial without being attributed to the root', () => {
  const f = fixture(); f.ready();
  f.send({ kind: 'unsupported_operation', operation_id: 'auxiliary-1', operation_class: 'guardian',
    transport_class: 'websocket', reason: 'unsupported_operation' }, 'unadmitted-member');
  f.close();
  const seal = f.accounting.seal();
  expect(seal.reason_codes).toContain('unsupported_operation');
  expect(seal.members.map(member => member.member_id)).toEqual(['session-1']);
});

test('deleting an admitted child removes its retained records and invalidates the family', () => {
  const f = fixture(); f.ready();
  const reservation = f.send({ kind: 'child_reserve', parent_member_id: 'session-1' }).receipt;
  if (reservation.body.kind !== 'child_reserved') throw new Error('unexpected_fixture_receipt');
  const admitted = f.ready('child-1', 'session-1', reservation.body.child_reservation_id).receipt;
  if (admitted.body.kind !== 'member_admitted') throw new Error('unexpected_fixture_receipt');
  f.store.execute('DELETE FROM sessions WHERE id=?', [admitted.body.session_id]);
  expect(f.store.get<{ count: number }>("SELECT count(*) AS count FROM instrumented_codex_records WHERE member_id='child-1'")?.count).toBe(0);
  expect(f.store.get<{ count: number }>('SELECT count(*) AS count FROM instrumented_codex_receipts')?.count).toBe(0);
  expect(f.store.get<{ count: number }>('SELECT count(*) AS count FROM instrumented_codex_records')?.count).toBe(0);
  expect(() => f.accounting.assertActive()).toThrow('inactive_scope');
});

test('a duplicate operation is a sticky semantic rejection rather than a raw constraint failure', () => {
  const f = fixture(); f.ready(); f.open();
  expect(() => f.open()).toThrow('invalid_operation');
  f.send({ kind: 'operation_close', operation_id: 'operation-1', disposition: 'completed' });
  f.close();
  expect(f.accounting.seal().reason_codes).toContain('record_conflict');
});

test('producer operation identifiers are scoped to their own runs', () => {
  const f = fixture(); f.ready(); f.open();
  f.lifecycle.createTask('project-1', 'task-2', {
    type: 'feature', expected_size: 'small', assignee: 'user-1', product: 'codex',
    model: 'gpt-6.1-sol', criterion_ids: ['criterion-1'],
  });
  f.lifecycle.start('task-2');
  f.store.execute('INSERT INTO sessions(id,project_id,task_id,product,product_version) VALUES (?,?,?,?,?)',
    ['session-2', 'project-1', 'task-2', 'codex', '0.162.1']);
  const control = f.accounting.control();
  const second = InstrumentedAccounting.prepare(f.store, {
    control: { ...control, run_id: 'run-2', task_id: 'task-2', root_session_id: 'session-2',
      state: 'prepared', opened_at: null, closed_at: null, control_sequence: 0 },
    profile, producerInstanceId: 'producer-2',
  });
  const secondReady: InstrumentedProducerRecord = {
    schema_version: 1, run_id: 'run-2', producer_instance_id: 'producer-2', member_id: 'session-2',
    task_generation: 1, sequence: 1, previous_record_hash: null, occurred_at: '2026-01-01T00:00:00Z',
    body: { kind: 'member_ready', native_session_id: randomUUID(),
      parent_member_id: null, child_reservation_id: null, configuration_receipt_id: 'configuration-1' },
  };
  second.receive(secondReady);
  second.receive({
    ...secondReady, sequence: 2, previous_record_hash: instrumentedMetadataHash(secondReady),
    body: { kind: 'operation_open', operation_id: 'operation-1', turn_id: null,
      operation_class: 'generation', transport_class: 'http_responses', requested_model: 'gpt-6.1-sol',
      requested_effort: 'high', configuration_revision: 'configuration-1' },
  });
  f.send({ kind: 'operation_close', operation_id: 'operation-1', disposition: 'completed' });
  expect(f.store.all('SELECT run_id,state FROM instrumented_codex_operations ORDER BY run_id')).toEqual([
    { run_id: 'run-1', state: 'closed' }, { run_id: 'run-2', state: 'open' },
  ]);
});

test('an unowned record cannot leave the accepting run clean', () => {
  const f = fixture(); const ready = f.ready();
  expect(() => f.accounting.receive({ ...ready.record, producer_instance_id: 'other-producer' })).toThrow('unowned_record');
  f.close();
  expect(f.accounting.seal().reason_codes).toContain('record_conflict');
});

test('a pre-root unsupported record does not become the root opening receipt', () => {
  const f = fixture();
  f.send({ kind: 'unsupported_operation', operation_id: 'pre-root-http', operation_class: 'unknown',
    transport_class: 'http_other', reason: 'unsupported_operation' }, 'producer-1');
  f.ready(); f.close();
  expect(f.accounting.seal().open_control_sequence).toBe(2);
  expect(f.accounting.control().state).toBe('sealed');
});

test.each([Buffer.from('{bad}\n'), Buffer.from([0xff, 10]), Buffer.alloc(65537, 32)])(
  'malformed descriptor metadata leaves a durable conflict before closing the stream',
  async frame => {
    const f = fixture();
    const descriptor = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } });
    const bridge = connectInstrumentedDescriptor(f.accounting, descriptor, 'producer-1');
    descriptor.emit('data', frame);
    await bridge.closed;
    expect(bridge.failure()?.code).toBe('invalid_record');
    expect(f.store.get<{ reason_codes: string }>('SELECT reason_codes FROM instrumented_codex_runs')?.reason_codes).toContain('record_conflict');
  },
);

test('descriptor generation revocation happens before decoding the delivered bytes', async () => {
  const f = fixture();
  const descriptor = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } });
  const bridge = connectInstrumentedDescriptor(f.accounting, descriptor, 'producer-1');
  f.lifecycle.pause('task-1');
  descriptor.emit('data', Buffer.from([0xff, 10]));
  await bridge.closed;
  expect(bridge.failure()?.code).toBe('inactive_scope');
  expect(f.store.get<{ count: number }>('SELECT count(*) AS count FROM instrumented_codex_records')?.count).toBe(0);
});

test('late transport failure after task deletion neither throws nor recreates accounting', async () => {
  const f = fixture();
  const descriptor = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } });
  const bridge = connectInstrumentedDescriptor(f.accounting, descriptor, 'producer-1');
  new Deletion(f.store, () => '2026-01-01T00:00:01Z').deleteTask('task-1');
  let lateFailure: unknown;
  try { descriptor.emit('error', new Error('synthetic-late-close')); }
  catch (error) { lateFailure = error; }
  descriptor.emit('data', Buffer.from([0xff, 10]));
  await bridge.closed;
  expect(lateFailure).toBeUndefined();
  expect(f.store.all('SELECT id FROM instrumented_codex_runs')).toEqual([]);
  expect(f.store.all('SELECT id FROM instrumented_codex_receipts')).toEqual([]);
  expect(f.store.all('SELECT sequence FROM instrumented_codex_records')).toEqual([]);
});

test('a coalesced batch of individually bounded frames is not rejected by total chunk size', async () => {
  const f = fixture(); const ready = f.ready();
  const descriptor = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } });
  const bridge = connectInstrumentedDescriptor(f.accounting, descriptor, 'producer-1');
  const batch = Buffer.from(`${JSON.stringify(ready.record)}\n`.repeat(300));
  expect(batch.length).toBeGreaterThan(65536);
  descriptor.emit('data', batch);
  expect(bridge.failure()).toBeNull();
  expect(f.store.get<{ count: number }>('SELECT count(*) AS count FROM instrumented_codex_records')?.count).toBe(1);
  descriptor.destroy(); await bridge.closed;
});

test('descriptor bootstrap rejects an identity not owned by its stored run', () => {
  const f = fixture();
  const descriptor = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } });
  expect(() => connectInstrumentedDescriptor(f.accounting, descriptor, 'other-producer')).toThrow('unowned_record');
  descriptor.destroy();
});
