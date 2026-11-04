import { describe, expect, it } from 'vitest';
import { compatibleSchedules, scheduleTarget } from '../scripts/analysis-validation/confidence.js';
import { rational } from '../scripts/analysis-validation/contracts.js';
import type { StudyDesign } from '../scripts/analysis-validation/contracts.js';
const design: StudyDesign = {
  blockSize: 2,
  strata: [{ stratumId: 's', blocks: [{ blockId: 'b', scheduledTaskIds: ['t0', 't1'], observationMask: [true, false] }] }]
};
const observation = { taskIds: ['t0'], labels: ['B'], values: [0] };
const domain = { endpoint: 'usage', lattice: [0, 1, 2] };
describe('bounded observation completion', () => {
  it('branches only the missing potential and retains observed zero', () => {
    expect(compatibleSchedules(design, observation, domain)).toEqual([
      { potentialA: [0], potentialB: [0] },
      { potentialA: [1], potentialB: [0] },
      { potentialA: [2], potentialB: [0] }
    ]);
    expect(scheduleTarget({ potentialA: [0, 1, 1, 2], potentialB: [1, 0, 2, 1] })).toEqual(rational(0n));
  });
  it.each([
    { taskIds: [], labels: [], values: [] },
    { taskIds: ['t1'], labels: ['B'], values: [0] },
    { taskIds: ['t0', 't0'], labels: ['B', 'B'], values: [0, 0] },
    { taskIds: ['t0'], labels: ['C'], values: [0] },
    { taskIds: ['t0'], labels: ['B'], values: [3] },
    { taskIds: ['t0'], labels: ['B'], values: [null] },
    { ...observation, potentialA: [2] }
  ])('rejects malformed observations without filtering', input => expect(() => compatibleSchedules(design, input, domain)).toThrow());
  it('rejects endpoint/lattice substitution and empty populations', () => {
    expect(() => compatibleSchedules(design, observation, { endpoint: 'deadline_success', lattice: [0, 1, 2] })).toThrow('invalid_domain');
    expect(() => scheduleTarget({ potentialA: [], potentialB: [] })).toThrow('invalid_schedule');
    const empty = structuredClone(design);
    empty.strata[0]!.blocks[0]!.observationMask = [false, false];
    expect(() => compatibleSchedules(empty, observation, domain)).toThrow('empty_population');
  });
});

import { confidenceDesigns, truthTables } from '../scripts/analysis-validation/confidence-cases.js';
import { domains, assertBudget } from '../scripts/analysis-validation/confidence-contracts.js';
import { oracleCalibration, oracleIndex, oracleTarget } from './helpers/confidence-oracle.js';
import { enumerateDesign, observedIds } from '../scripts/analysis-validation/design.js';
it('matches all compatible schedules and targets for every frozen observation', () => {
  const canonical = (h: { potentialA: number[]; potentialB: number[] }) => JSON.stringify(h);
  for (const { design } of confidenceDesigns())
    for (const d of domains) {
      const oracle = oracleIndex(design, d);
      expect(enumerateDesign(design)).toEqual(oracle.support);
      expect(truthTables(observedIds(design).length, d)).toEqual(oracle.tables);
      for (const entry of oracle.index.values()) {
        const actual = compatibleSchedules(design, entry.observation, d);
        expect(actual.map(canonical).sort()).toEqual(entry.tables.map(x => canonical(x.schedule)).sort());
        actual.forEach(h => expect(scheduleTarget(h)).toEqual(oracleTarget(h)));
      }
    }
}, 30000);
it('rejects non-prefix, misordered IDs, unsupported paths and resource work before completion', () => {
  const d = confidenceDesigns()[3]!.design,
    ids = observedIds(d);
  expect(() => compatibleSchedules(d, { taskIds: [...ids].reverse(), labels: ['A', 'B'], values: [0, 0] }, domain)).toThrow('observation_alignment');
  const hole = structuredClone(d);
  hole.strata[0]!.blocks[0]!.observationMask = [true, false, true, false];
  expect(() => compatibleSchedules(hole, observation, domain)).toThrow('non_prefix');
  const full = confidenceDesigns()[1]!.design;
  expect(() => compatibleSchedules(full, { taskIds: observedIds(full), labels: ['A', 'A'], values: [0, 0] }, domain)).toThrow('observed_outside_support');
  for (const args of [
    [5, 3, 2],
    [4, 3, 17],
    [4, 4, 16],
    [0, 3, 2]
  ])
    expect(() => assertBudget(args[0]!, args[1]!, args[2]!)).toThrow('confidence_resource_limit');
  expect(() => assertBudget(4, 3, 16)).not.toThrow();
});
import { validateFraction } from '../scripts/analysis-validation/confidence-contracts.js';
it('rejects empty strata and noncanonical fractions without silently normalizing', () => {
  const d = confidenceDesigns()[7]!.design;
  d.strata[1]!.blocks[0]!.observationMask = [false, false];
  expect(() => compatibleSchedules(d, observation, domain)).toThrow('empty_stratum');
  for (const r of [
    { numerator: 2n, denominator: 4n },
    { numerator: 0n, denominator: 0n },
    { numerator: 1n, denominator: -2n }
  ])
    expect(() => validateFraction(r)).toThrow('invalid_rational');
  expect(scheduleTarget({ potentialA: [0, 0, 0, 0], potentialB: [0, 0, 1, 1] })).toEqual({ numerator: 1n, denominator: 2n });
});
it('rejects table generation with substituted endpoint lattice or fractional population', () => {
  expect(() => truthTables(1, { endpoint: 'deadline_success', lattice: [0, 1, 2] })).toThrow('invalid_domain');
  expect(() => truthTables(1.5, domains[0]!)).toThrow('confidence_resource_limit');
});

import { envelopeTail, confidenceSet } from '../scripts/analysis-validation/confidence.js';
import { setFromEnvelopes } from '../scripts/analysis-validation/confidence-contracts.js';
import { referenceTail } from '../scripts/analysis-validation/statistics.js';
it.each(domains)('uses weighted schedule-specific reference outcomes for $endpoint', d => {
  const design = confidenceDesigns()[8]!.design,
    m = d.endpoint === 'usage' ? 2 : 1;
  const obs = { taskIds: observedIds(design), labels: ['B', 'B', 'B', 'B'], values: [m, m, m, m] };
  expect(envelopeTail(design, obs, d, rational(0n))).toEqual({ value: rational(1n, 35n), compatibleCount: 1, status: 'evaluated' });
  expect(confidenceSet(design, obs, d, rational(1n, 20n)).values).not.toContainEqual(rational(0n));
  expect(confidenceSet(design, obs, d, rational(1n, 35n)).values).not.toContainEqual(rational(0n));
  expect(confidenceSet(design, obs, d, rational(1n, 40n)).values).toContainEqual(rational(0n));
});
it('preserves compatibility-only width, infeasible targets and inclusive ties', () => {
  const d = confidenceDesigns()[0]!.design,
    obs = { taskIds: observedIds(d), labels: ['B'], values: [0] };
  expect(envelopeTail(d, obs, domain, rational(0n))).toMatchObject({ value: rational(1n) });
  expect(envelopeTail(d, obs, domain, rational(2n))).toEqual({ value: rational(0n), compatibleCount: 0, status: 'infeasible_target' });
  const set = confidenceSet(d, obs, domain, rational(1n, 20n));
  expect(set.values).toEqual([-2n, -1n, 0n].map(n => rational(n)));
  expect(set.diagnostics).toEqual({
    compatibleTargetCount: 3,
    acceptedTargetCount: 3,
    removedCompatibleTargetCount: 0,
    compatibilityHullWidth: rational(2n),
    confidenceHullWidth: rational(2n),
    noInferentialNarrowing: true
  });
});
it('rejects replacing the weak-null envelope with the fixed-y sharp-null tail', () => {
  const d = confidenceDesigns()[8]!.design,
    h = { potentialA: [0, 1, 1, 2], potentialB: [1, 0, 2, 1] };
  const oracle = oracleCalibration(d, domains[0]!);
  let differences = 0;
  for (const row of enumerateDesign(d)) {
    const values = row.labels.map((arm, i) => (arm === 'A' ? h.potentialA[i]! : h.potentialB[i]!));
    const obs = { taskIds: observedIds(d), labels: row.labels, values };
    const fixed = referenceTail(enumerateDesign(d), values, row.labels);
    const weak = envelopeTail(d, obs, domain, rational(0n)).value;
    const expected = oracle.observations.get(`${row.labels.join('')}:${values.join(',')}`)!.envelopes.find(x => x.target.numerator === 0n)!.value;
    expect(weak).toEqual(expected);
    if (weak.numerator * fixed.denominator !== fixed.numerator * weak.denominator) differences++;
  }
  expect(differences).toBeGreaterThan(0);
});
it('keeps inferred sets identical when only hidden truth changes', () => {
  const d = confidenceDesigns()[3]!.design,
    z = ['A', 'B'] as const;
  const h1 = { potentialA: [0, 0], potentialB: [0, 1] },
    h2 = { potentialA: [0, 2], potentialB: [1, 1] };
  const infer = (h: typeof h1) =>
    confidenceSet(d, { taskIds: observedIds(d), labels: [...z], values: [h.potentialA[0], h.potentialB[1]] }, domain, rational(1n, 4n));
  expect(scheduleTarget(h1)).not.toEqual(scheduleTarget(h2));
  expect(infer(h1)).toEqual(infer(h2));
});
it('does not fill holes or discard empty confidence sets', () => {
  const rows = [-1n, 0n, 1n].map(n => ({ target: rational(n), value: rational(n === 0n ? 0n : 1n), compatibleCount: 1, status: 'evaluated' as const }));
  const set = setFromEnvelopes(rows, rational(1n, 2n));
  expect(set.values).toEqual([rational(-1n), rational(1n)]);
  expect(set.lower).toEqual(rational(-1n));
  expect(set.upper).toEqual(rational(1n));
  const empty = setFromEnvelopes(
    rows.map(x => ({ ...x, value: rational(0n) })),
    rational(1n, 2n)
  );
  expect(empty).toMatchObject({
    values: [],
    lower: null,
    upper: null,
    reason: 'empty_confidence_set',
    diagnostics: { confidenceHullWidth: null, removedCompatibleTargetCount: 3 }
  });
});
it('arm swapping negates the finite set and preserves precision for heterogeneous observations', () => {
  const d = confidenceDesigns()[8]!.design,
    obs = { taskIds: observedIds(d), labels: ['A', 'B', 'B', 'B'], values: [0, 1, 2, 1] };
  const a = confidenceSet(d, obs, domain, rational(1n, 4n));
  const b = confidenceSet(d, { ...obs, labels: obs.labels.map(x => (x === 'A' ? 'B' : 'A')) }, domain, rational(1n, 4n));
  expect(b.values).toEqual([...a.values].reverse().map(x => rational(-x.numerator, x.denominator)));
  expect(b.diagnostics).toEqual(a.diagnostics);
});
