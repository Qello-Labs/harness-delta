import { InstrumentedProducerProfileSchema } from '../../src/instrumented-codex-contracts.js';
import { InstrumentedRunControlSchema, type InstrumentedProducerRecord } from '../../src/instrumented-codex-contracts.js';
import { InstrumentedAccounting, instrumentedMetadataHash } from '../../src/instrumented-codex-accounting.js';
import { Lifecycle } from '../../src/lifecycle.js';
import { Store } from '../../src/store.js';
import { PriceTableSchema } from '../../src/flexible-contracts.js';
import { registerPriceTable } from '../../src/pricing.js';
import { randomUUID } from 'node:crypto';

export const instrumentedFixtureProfile = InstrumentedProducerProfileSchema.parse({
  schema_version: 1, profile_id: 'synthetic-profile-1', upstream_commit: 'a'.repeat(40),
  upstream_version: '0.162.1', product_version: '0.162.1',
  patched_source_digest: 'b'.repeat(64), dependency_lock_digest: 'c'.repeat(64),
  build_manifest_digest: 'd'.repeat(64), binary_sha256: 'e'.repeat(64),
  target: 'synthetic-target', producer_protocol: 'harness-codex-accounting-v1',
  qualification_id: 'synthetic-qualification', transport_contract_id: 'synthetic-http',
  operation_inventory_digest: 'f'.repeat(64), counter_contract_id: 'synthetic-counter',
  configuration_policy_id: 'synthetic-configuration', model: 'gpt-6.1-sol', effort: 'high',
  max_roots: 1, max_direct_children: 2, max_depth: 1,
});

export function makeInstrumentedCostFixture(filename = ':memory:', admitRoot = true) {
  let at = '2026-10-12T00:00:00Z';
  const store = new Store(filename, () => at);
  const lifecycle = new Lifecycle(store, () => at);
  lifecycle.registerProject('project-1', process.cwd());
  lifecycle.createTask('project-1', 'task-1', {
    type: 'feature', expected_size: 'small', assignee: 'user-1', product: 'codex',
    model: 'gpt-6.1-sol', criterion_ids: ['criterion-1'],
  });
  lifecycle.start('task-1');
  store.execute('INSERT INTO sessions(id,project_id,task_id,product,product_version) VALUES (?,?,?,?,?)',
    ['session-1', 'project-1', 'task-1', 'codex', '0.162.1']);
  const table = PriceTableSchema.parse({
    id: 'synthetic-prices', version: 'synthetic-v1', currency: 'USD', source_id: 'synthetic-rates',
    as_of: at, unit_tokens: 1000, display_decimals: 6, rounding: 'half_even',
    entries: [
      { product: 'codex', model: 'gpt-6.1-sol', component: 'ordinary_input', price_per_unit: '2' },
      { product: 'codex', model: 'gpt-6.1-sol', component: 'cache_read', price_per_unit: '1' },
      { product: 'codex', model: 'gpt-6.1-sol', component: 'output', price_per_unit: '4' },
    ],
  });
  registerPriceTable(store, table);
  const control = InstrumentedRunControlSchema.parse({
    schema_version: 1, run_id: 'run-1', project_id: 'project-1', task_id: 'task-1',
    task_generation: 1, collector_instance_id: 'collector-1', profile_id: instrumentedFixtureProfile.profile_id,
    producer_manifest_hash: instrumentedFixtureProfile.build_manifest_digest, root_session_id: 'session-1',
    configuration_receipt_id: 'configuration-1', authorization_receipt_id: 'authorization-1',
    price_table_id: table.id, price_table_hash: instrumentedMetadataHash(table), price_basis_hash: null,
    state: 'prepared', opened_at: null, closed_at: null, control_sequence: 0,
  });
  const accounting = InstrumentedAccounting.prepare(store, {
    control, profile: instrumentedFixtureProfile, producerInstanceId: 'producer-1',
  }, () => at);
  let sequence = 0; let previousHash: string | null = null;
  const send = (body: InstrumentedProducerRecord['body'], memberId = 'session-1') => {
    const record: InstrumentedProducerRecord = {
      schema_version: 1, run_id: control.run_id, producer_instance_id: 'producer-1',
      member_id: memberId, task_generation: 1, sequence: sequence + 1,
      previous_record_hash: previousHash, occurred_at: at, body,
    };
    const receipt = accounting.receive(record);
    sequence = record.sequence; previousHash = instrumentedMetadataHash(record);
    return receipt;
  };
  const ready = () => send({ kind: 'member_ready', native_session_id: randomUUID(), parent_member_id: null,
    child_reservation_id: null, configuration_receipt_id: control.configuration_receipt_id });
  if (admitRoot) ready();
  const observed = (value: number) => ({ status: 'observed' as const, value, reason: null });
  const request = (responseId = 'response-1') => {
    const operationId = `operation-${sequence}`;
    send({ kind: 'operation_open', operation_id: operationId, turn_id: null,
      operation_class: 'generation', transport_class: 'http_responses',
      requested_model: 'gpt-6.1-sol', requested_effort: 'high',
      configuration_revision: control.configuration_receipt_id });
    const reserved = send({ kind: 'attempt_reserve', operation_id: operationId, retry_parent_attempt_id: null });
    if (reserved.body.kind !== 'attempt_reserved') throw new Error('unexpected_fixture_receipt');
    send({ kind: 'dispatch_commit', attempt_id: reserved.body.attempt_id });
    send({ kind: 'attempt_terminal', attempt_id: reserved.body.attempt_id, disposition: 'response_completed',
      response_id: responseId, effective_model: 'gpt-6.1-sol', readings: {
        input_total: observed(100), cached_input: observed(20), cache_write_input: observed(0),
        output_total: observed(10), reasoning_output: observed(5), total_tokens: observed(110),
      } });
    send({ kind: 'operation_close', operation_id: operationId, disposition: 'completed' });
  };
  const seal = () => {
    const receipt = send({ kind: 'close_request' });
    if (receipt.body.kind !== 'close_fence') throw new Error('unexpected_fixture_receipt');
    send({ kind: 'member_close', close_fence_id: receipt.body.close_fence_id,
      final_record_sequence: sequence, final_record_hash: previousHash });
    return accounting.seal();
  };
  return { store, lifecycle, table, control, accounting, send, ready, request, seal,
    now: () => at, setTime: (value: string) => { at = value; } };
}
