import { expect, test } from 'vitest';
import { EventSchema } from '../src/contracts.js';
import { ProtocolSchema } from '../src/comparison-contracts.js';
import { protocol } from './helpers/comparison-fixture.js';

const zero = { status: 'observed', value: 0, reason: null } as const;
const flexibleEvent = {
  id: 'event-2',
  project_id: 'project-1',
  task_id: 'task-1',
  session_id: 'session-1',
  source_key: 'source-2',
  occurred_at: '2026-01-01T00:00:00Z',
  payload: {
    schema_version: 2,
    kind: 'usage',
    input_total: zero,
    cached_input: zero,
    output_total: zero,
    reasoning_output: zero,
    product: 'synthetic',
    product_version: '1.0.0',
    model: null,
    epoch: 'epoch-1',
    runtime_evidence_id: null,
    attribution: 'unknown',
    billing_components: []
  }
};

test('versioned usage preserves unknown model and setting attribution without inventing defaults', () => {
  expect(EventSchema.safeParse(flexibleEvent).success).toBe(true);
  expect(EventSchema.parse(flexibleEvent).payload).toEqual(flexibleEvent.payload);
});

test('preserves_v1_shape_and_bytes', () => {
  expect(ProtocolSchema.shape.primary_metric.safeParse('input_total').success).toBe(true);
  expect(JSON.stringify(ProtocolSchema.parse(protocol))).toBe(JSON.stringify(protocol));
  const event = { ...flexibleEvent, payload: { kind: 'session_linked' } };
  expect(JSON.stringify(EventSchema.parse(event))).toBe(JSON.stringify(event));
});

test('accepts_flexible_policy_without_fixed_model', async () => {
  const { makeFlexibleFixture } = await import('./helpers/flexible-fixture.js');
  const { FlexibleProtocolSchema, FlexibleVariantSchema } = await import('../src/flexible-contracts.js');
  const fixture = makeFlexibleFixture();
  expect(fixture.variants.every(v => FlexibleVariantSchema.safeParse(v).success)).toBe(true);
  for (const key of ['price_table_id', 'followup_seconds', 'sample_plan', 'quality_margin', 'planning_basis_id']) {
    const incomplete: Record<string, unknown> = { ...fixture.protocol };
    delete incomplete[key];
    expect(FlexibleProtocolSchema.safeParse(incomplete).success).toBe(false);
  }
  expect(FlexibleProtocolSchema.safeParse({ ...fixture.protocol, strata: [{ ...fixture.protocol.strata[0], assignees: ['user-1', 'user-2'] }] }).success).toBe(
    false
  );
});

test('rejects_text_and_unknown_keys', async () => {
  const { parseTaskMetadata, parseProtocol, RuntimeEvidenceSchema } = await import('../src/flexible-contracts.js');
  const { makeFlexibleFixture } = await import('./helpers/flexible-fixture.js');
  const fixture = makeFlexibleFixture();
  for (const key of ['prompt', 'response', 'criterion_text']) {
    expect(() => parseTaskMetadata({ ...fixture.metadata, [key]: 'PRIVATE_TEXT' })).toThrow('invalid_metadata');
    expect(() => parseProtocol({ ...fixture.protocol, [key]: 'PRIVATE_TEXT' })).toThrow('invalid_protocol');
    expect(RuntimeEvidenceSchema.safeParse({ ...fixture.runtime[0], [key]: 'PRIVATE_TEXT' }).success).toBe(false);
  }
});
