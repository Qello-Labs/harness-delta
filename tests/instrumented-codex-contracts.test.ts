import { expect, test } from 'vitest';
import {
  InstrumentedProducerRecordSchema, InstrumentedTokenReadingsSchema, InstrumentedWindowSealSchema,
} from '../src/instrumented-codex-contracts.js';

const observed = (value: number) => ({ status: 'observed' as const, value, reason: null });
const readings = {
  input_total: observed(12), cached_input: observed(2), cache_write_input: observed(0),
  output_total: observed(4), reasoning_output: observed(1), total_tokens: observed(16),
};
const terminal = {
  schema_version: 1, run_id: 'run-1', producer_instance_id: 'producer-1',
  member_id: 'member-1', task_generation: 1, sequence: 2,
  previous_record_hash: 'a'.repeat(64), occurred_at: '2026-01-01T00:00:01Z',
  body: {
    kind: 'attempt_terminal', attempt_id: 'attempt-1', disposition: 'response_completed',
    response_id: 'response-1', effective_model: 'gpt-6.1-sol', readings,
  },
};

test('measurement records reject response bodies and arbitrary error text', () => {
  for (const extra of [{ response: 'synthetic content' }, { error_message: 'synthetic content' }]) {
    expect(InstrumentedProducerRecordSchema.safeParse({
      ...terminal, body: { ...terminal.body, ...extra },
    }).success).toBe(false);
  }
});

test('measurement envelopes reject credentials and caller-provided completeness', () => {
  for (const extra of [{ credentials: 'synthetic-secret' }, { verified: true }, { complete: true }]) {
    expect(InstrumentedProducerRecordSchema.safeParse({ ...terminal, ...extra }).success).toBe(false);
  }
});

test('token readings reject negative, fractional and unsafe integer counts', () => {
  for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(InstrumentedTokenReadingsSchema.safeParse({ ...readings, input_total: observed(value) }).success).toBe(false);
  }
});

test('seals reject caller-assessed eligibility without changing accounting evidence', () => {
  const seal = {
    schema_version: 1, seal_id: 'seal-1', run_id: 'run-1', task_generation: 1,
    profile_id: 'profile-1', producer_manifest_hash: 'a'.repeat(64),
    open_control_sequence: 1, close_control_sequence: 4,
    opened_at: '2026-01-01T00:00:00Z', closed_at: '2026-01-01T00:00:01Z',
    sealed_at: '2026-01-01T00:00:02Z',
    members: [{
      member_id: 'member-1', session_id: 'session-1', identity_receipt_hash: 'b'.repeat(64),
      final_record_sequence: 2, final_record_hash: 'c'.repeat(64), close_receipt_id: 'close-1',
    }],
    attempt_ledger_hash: 'd'.repeat(64), terminal_records_hash: 'e'.repeat(64),
    lifecycle_evidence_hash: 'f'.repeat(64), configuration_evidence_hash: 'a'.repeat(64),
    counts: { reserved: 1, dispatch_committed: 1, not_dispatched: 0, terminal: 0, unresolved: 1 },
    unresolved_attempt_ids: ['attempt-1'], reason_codes: ['unresolved_attempt'],
  };
  expect(InstrumentedWindowSealSchema.safeParse(seal).success).toBe(true);
  expect(InstrumentedWindowSealSchema.safeParse({ ...seal, eligible: true }).success).toBe(false);
  expect(InstrumentedWindowSealSchema.safeParse({ ...seal, unresolved_attempt_ids: [] }).success).toBe(false);
});
