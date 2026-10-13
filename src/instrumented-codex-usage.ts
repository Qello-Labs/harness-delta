import { EventV2Schema, RuntimeEvidenceSchema } from './flexible-contracts.js';
import type { BillingComponent } from './flexible-contracts.js';
import type { Reading } from './contracts.js';
import type { InstrumentedProducerProfile, InstrumentedProducerRecord } from './instrumented-codex-contracts.js';
import { InstrumentedAccountingError } from './instrumented-codex-accounting.js';

/** Arithmetic projection is not admission; production coverage also requires owned launch and gate evidence. */
export function projectInstrumentedTerminal(input: {
  readonly record: InstrumentedProducerRecord;
  readonly profile: InstrumentedProducerProfile;
  readonly taskId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly receivedAt: string;
}) {
  const body = input.record.body;
  if (body.kind !== 'attempt_terminal') throw new InstrumentedAccountingError('invalid_record');
  const readings = body.readings;
  const unavailable: Reading = { status: 'missing', value: null, reason: 'not_available' };
  const invalid: Reading = { status: 'error', value: null, reason: 'source_error' };
  const observed = (value: number): Reading => ({ status: 'observed', value, reason: null });
  const { input_total: total, cached_input: cached, cache_write_input: write,
    output_total: output, reasoning_output: reasoning, total_tokens: combined } = readings;
  const inputKnown = total.status === 'observed' && cached.status === 'observed' && write.status === 'observed';
  const inputValid = inputKnown && Number.isSafeInteger(cached.value + write.value) &&
    cached.value + write.value <= total.value;
  const counterError = inputKnown && !inputValid ||
    output.status === 'observed' && reasoning.status === 'observed' && reasoning.value > output.value ||
    total.status === 'observed' && output.status === 'observed' &&
      (!Number.isSafeInteger(total.value + output.value) ||
        combined.status === 'observed' && combined.value !== total.value + output.value);
  const ordinary = counterError ? invalid : inputValid
    ? observed(total.value - cached.value - write.value) : unavailable;
  const components: BillingComponent[] = [
    { kind: 'ordinary_input', reading: ordinary },
    { kind: 'cache_read', reading: counterError ? invalid : cached },
    { kind: 'output', reading: counterError ? invalid : output },
  ];
  // An explicitly empty write component has no disjoint quantity to price.
  if (write.status !== 'observed' || write.value !== 0) {
    components.push({ kind: 'cache_write', reading: counterError ? invalid : write });
  }
  const evidenceId = `instrumented:${input.record.run_id}:${body.attempt_id}`;
  const runtime = RuntimeEvidenceSchema.parse({
    id: evidenceId, task_id: input.taskId, session_id: input.sessionId,
    turn_id: null, request_id: body.attempt_id, model: body.effective_model,
    effort: 'high', product: 'codex', product_version: input.profile.product_version,
    source: 'validated_integration', occurred_at: input.record.occurred_at,
    recorded_at: input.receivedAt, boundary: 'request',
  });
  const event = EventV2Schema.parse({
    id: evidenceId, source_key: evidenceId, task_id: input.taskId, project_id: input.projectId,
    session_id: input.sessionId, occurred_at: input.record.occurred_at,
    payload: {
      schema_version: 2, kind: 'usage', product: 'codex',
      product_version: input.profile.product_version, model: body.effective_model,
      epoch: input.record.run_id, runtime_evidence_id: runtime.id,
      attribution: body.effective_model === null ? 'unknown' : 'verified',
      input_total: total, cached_input: cached, output_total: output, reasoning_output: reasoning,
      billing_components: components,
    },
  });
  return {
    event, runtime, counter_error: counterError,
    required_counters_present: inputValid && output.status === 'observed' && !counterError,
    raw_readings: readings,
  };
}
