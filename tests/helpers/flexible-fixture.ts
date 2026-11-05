import { protocol as legacy } from './comparison-fixture.js';
import {
  FlexibleProtocolSchema,
  FlexibleTaskMetadataSchema,
  FlexibleVariantSchema,
  PriceTableSchema,
  RuntimeEvidenceSchema,
  EventV2Schema,
  CostCoverageEvidenceSchema,
  CostFactsSchema
} from '../../src/flexible-contracts.js';
export function makeFlexibleFixture() {
  const protocol = FlexibleProtocolSchema.parse({
    ...legacy,
    schema_version: 2,
    primary_metric: 'standardized_cost',
    price_table_id: 'prices-1',
    estimand: 'registered_task_mean',
    runtime_policy: 'flexible',
    source_profiles: [{ product: 'synthetic', product_version: '1.0.0', profile_id: 'synthetic-flexible-v1' }],
    planning_basis_id: 'synthetic-basis',
    collaboration_policy_id: 'single-owner-v1',
    strata: legacy.participants.map(assignee => ({ ...legacy.strata[0], id: `stratum-${assignee}`, assignees: [assignee] }))
  });
  const variants = ['a', 'b'].map(arm =>
    FlexibleVariantSchema.parse({
      schema_version: 2,
      id: `variant-${arm}`,
      harness_version: `${arm}-v1`,
      instruction_manifest_hash: arm.repeat(64),
      policy_version: 'policy-v1',
      policy_status: 'eligible',
      runtime_policy: 'flexible'
    })
  );
  const metadata = FlexibleTaskMetadataSchema.parse({
    schema_version: 2,
    type: 'feature',
    expected_size: 'small',
    assignee: 'user-1',
    product: 'synthetic',
    initial_model: null,
    criterion_ids: ['criterion-1']
  });
  const priceTable = PriceTableSchema.parse({
    id: 'prices-1',
    version: 'prices-v1',
    currency: 'USD',
    source_id: 'synthetic-prices',
    as_of: '2025-12-31T00:00:00Z',
    unit_tokens: 1000,
    display_decimals: 2,
    rounding: 'half_even',
    entries: [
      ['ordinary_input', '2'],
      ['cache_read', '1'],
      ['output', '4']
    ].map(([component, price_per_unit]) => ({ product: 'synthetic', model: 'synthetic-model', component, price_per_unit }))
  });
  const runtime = [
    RuntimeEvidenceSchema.parse({
      id: 'runtime-1',
      task_id: 'task-1',
      session_id: 'session-1',
      turn_id: 'turn-1',
      request_id: 'request-1',
      model: 'synthetic-model',
      effort: null,
      product: 'synthetic',
      product_version: '1.0.0',
      source: 'product_log',
      occurred_at: '2026-01-01T00:00:01Z',
      recorded_at: '2026-01-01T00:00:02Z',
      boundary: 'request'
    })
  ];
  const observed = (value: number) => ({ status: 'observed', value, reason: null });
  const events = [
    EventV2Schema.parse({
      id: 'event-1',
      source_key: 'event-1',
      task_id: 'task-1',
      project_id: 'project-1',
      session_id: 'session-1',
      occurred_at: '2026-01-01T00:00:03Z',
      payload: {
        schema_version: 2,
        kind: 'usage',
        input_total: observed(120),
        cached_input: observed(20),
        output_total: observed(10),
        reasoning_output: observed(5),
        product: 'synthetic',
        product_version: '1.0.0',
        model: 'synthetic-model',
        epoch: 'epoch-1',
        runtime_evidence_id: 'runtime-1',
        attribution: 'verified',
        billing_components: [
          ['ordinary_input', 100],
          ['cache_read', 20],
          ['output', 10]
        ].map(([kind, value]) => ({ kind, reading: observed(Number(value)) }))
      }
    })
  ];
  const coverage = CostCoverageEvidenceSchema.parse({
    profile_id: 'synthetic-cost-coverage-v1',
    task_id: 'task-1',
    window_start: '2026-01-01T00:00:00Z',
    window_end: '2026-01-01T01:00:00Z',
    facts: Object.fromEntries(Object.keys(CostFactsSchema.shape).map(key => [key, 'verified'])),
    has_observed_value: true
  });
  return { protocol, variants, metadata, priceTable, runtime, events, coverage };
}
