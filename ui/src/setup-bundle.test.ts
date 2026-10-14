import { expect, test } from 'vitest';
import { SetupBundleSchema } from './setup-bundle';

const bundle = {
  kind: 'harness-delta.measurement-setup',
  schema_version: 1,
  input: {
    comparison_path: '/synthetic/comparison.json', project_id: 'project-one',
    profile: { id: 'profile-one' }, protocol: { schema_version: 2 },
    policy_status: { arm_a: 'eligible', arm_b: 'ineligible' },
  },
};

test('bundle retains production input values without manufacturing missing decisions', () => {
  const parsed = SetupBundleSchema.parse(bundle);
  expect(parsed.input).toEqual(bundle.input);
  expect(parsed.input).not.toHaveProperty('freeze_at');
  expect(parsed.input.price_table).toBeUndefined();
});

test.each([
  { ...bundle, kind: 'harness-delta.comparison' },
  { ...bundle, schema_version: 2 },
  { ...bundle, input: { ...bundle.input, project_id: undefined } },
  { ...bundle, input: { ...bundle.input, profile: [] } },
  { ...bundle, input: { ...bundle.input, policy_status: { arm_a: 'eligible', arm_b: null } } },
  { ...bundle, input: { ...bundle.input, start_measurement: true } },
  { ...bundle, input: { ...bundle.input, freeze_at: '2000-01-01T00:00:00Z' } },
  { ...bundle, input: { ...bundle.input, application_mode: 'automatic' } },
])('bundle rejects wrong envelopes and unrecognized instructions', input => {
  expect(SetupBundleSchema.safeParse(input).success).toBe(false);
});
