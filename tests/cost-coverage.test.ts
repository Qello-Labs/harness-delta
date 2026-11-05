import { expect, test } from 'vitest';
import { makeFlexibleFixture } from './helpers/flexible-fixture.js';
test('complete_requires_all_metric_facts', async () => {
  const { evaluateCostCoverage } = await import('../src/cost-coverage.js');
  const { coverage } = makeFlexibleFixture();
  expect(evaluateCostCoverage(coverage).eligible).toBe(true);
  for (const fact of Object.keys(coverage.facts))
    for (const state of ['unknown', 'violated']) {
      expect(evaluateCostCoverage({ ...coverage, facts: { ...coverage.facts, [fact]: state } }).eligible).toBe(false);
    }
});
test('observed_zero_requires_presence', async () => {
  const { evaluateCostCoverage } = await import('../src/cost-coverage.js');
  const { coverage } = makeFlexibleFixture();
  expect(evaluateCostCoverage({ ...coverage, has_observed_value: false })).toEqual({ eligible: false, reasons: ['missing_value'] });
  expect(evaluateCostCoverage({ ...coverage, profile_id: 'real-unvalidated' }).eligible).toBe(false);
});
test('merge_preserves_unknown_and_violations', async () => {
  const { mergeCostFacts } = await import('../src/cost-coverage.js');
  const { coverage } = makeFlexibleFixture();
  const prior = { ...coverage.facts, continuous_observation: 'violated' as const, bounded_topology: 'unknown' as const };
  expect(mergeCostFacts(prior, coverage.facts)).toEqual(prior);
});
