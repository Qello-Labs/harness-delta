import { expect, test } from 'vitest';
import { computeStatistic, referenceTail, referenceRatios } from '../scripts/analysis-validation/statistics.js';
import { enumerateDesign } from '../scripts/analysis-validation/design.js';
const full = {
  blockSize: 4,
  strata: [{ stratumId: 's', blocks: [{ blockId: 'b', scheduledTaskIds: ['a', 'b', 'c', 'd'], observationMask: [true, true, true, true] }] }]
};
test('HT retains single-arm paths, exact big integers and inclusive fixed-observation tails', () => {
  expect(computeStatistic(['A'], [10])).toEqual({ numerator: -20n, denominator: 1n });
  expect(computeStatistic(['B', 'B'], [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER])).toEqual({ numerator: 18014398509481982n, denominator: 1n });
  expect(referenceTail(enumerateDesign(full), [10, 20, 25, 35], ['A', 'A', 'B', 'B'])).toEqual({ numerator: 1n, denominator: 3n });
  expect(referenceTail(enumerateDesign(full), [0, 0, 0, 0], ['A', 'A', 'B', 'B'])).toEqual({ numerator: 1n, denominator: 1n });
});
test('invalid outcomes, support and observations are rejected', () => {
  for (const value of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) expect(() => computeStatistic(['A'], [value])).toThrow('invalid_outcomes');
  expect(() => computeStatistic([], [])).toThrow('invalid_outcomes');
  expect(() => computeStatistic(['A'], [1, 2])).toThrow('invalid_outcomes');
  expect(() => referenceTail(enumerateDesign(full), [1, 2, 3, 4], ['A', 'A', 'A', 'A'])).toThrow('observed_outside_support');
  expect(() => referenceTail(enumerateDesign(full).slice(1), [1, 2, 3, 4], ['A', 'A', 'B', 'B'])).toThrow('invalid_support');
});
test('ratios use task means and include failures in success numerator, with explicit undefined denominators', () => {
  const a = { taskCount: 2, totalUsage: 150n, successCount: 1 },
    b = { taskCount: 4, totalUsage: 300n, successCount: 2 };
  expect(referenceRatios(a, b)).toEqual({
    change: { value: { numerator: 0n, denominator: 1n }, reason: null },
    tokensPerSuccessA: { value: { numerator: 150n, denominator: 1n }, reason: null },
    tokensPerSuccessB: { value: { numerator: 150n, denominator: 1n }, reason: null }
  });
  expect(referenceRatios({ ...a, totalUsage: 0n }, b).change.reason).toBe('zero_baseline');
  expect(referenceRatios({ ...a, successCount: 0 }, b).tokensPerSuccessA.reason).toBe('zero_successes');
  expect(referenceRatios({ taskCount: 0, totalUsage: 0n, successCount: 0 }, b).change.reason).toBe('empty_arm');
  for (const bad of [
    { ...a, successCount: 3 },
    { ...a, taskCount: 0.5 },
    { ...a, totalUsage: -1n }
  ])
    expect(() => referenceRatios(bad, b)).toThrow('invalid_arm');
});

import { builtInCases, designGrid, scenarioNames, variantNames } from '../scripts/analysis-validation/cases.js';
import { add, multiply, rational, lessEqual, decodeRational } from '../scripts/analysis-validation/contracts.js';
import { realize } from '../scripts/analysis-validation/statistics.js';
import { oracleDesign, oracleRealize, oracleStatistic, oracleTail } from './helpers/analysis-oracle.js';
test('frozen full grid: exact expectations and all-observed fixed-imputation tails agree independently', () => {
  const cases = builtInCases();
  expect(cases).toHaveLength(432);
  expect(designGrid().map(x => x.id)).toEqual([
    ...[2, 4, 6, 8].flatMap(b => Array.from({ length: b }, (_, i) => `b${b}r${i + 1}`)),
    'two-full',
    'full-one',
    'two-strata',
    'reversed-names'
  ]);
  expect(scenarioNames).toEqual(['zero', 'constant', 'heterogeneous-null', 'decrease', 'increase', 'heterogeneous-effect']);
  expect(variantNames).toEqual(['base', 'user-offset', 'time-trend']);
  let vectors = 0,
    calibrations = 0;
  for (const c of cases) {
    const support = enumerateDesign(c.design),
      oracle = oracleDesign(c.design);
    expect(support).toEqual(oracle);
    let expectation = rational(0n);
    const rejection = [rational(0n), rational(0n)],
      alphas = [rational(1n, 20n), rational(1n, 10n)];
    const sharp = c.population.every(x => x.yA === x.yB);
    for (const row of support) {
      const y = realize(row.labels, c.population);
      expect(y).toEqual(oracleRealize(row.labels, c.population));
      const t = computeStatistic(row.labels, y),
        p = referenceTail(support, y, row.labels);
      expect(t).toEqual(oracleStatistic(row.labels, y));
      expect(p).toEqual(oracleTail(oracle, y, row.labels));
      expectation = add(expectation, multiply(row.weight, t));
      vectors++;
      if (sharp)
        alphas.forEach((alpha, i) => {
          if (lessEqual(p, alpha)) rejection[i] = add(rejection[i]!, row.weight);
        });
      if (c.caseId.endsWith('-zero-base')) expect(p).toEqual(rational(1n));
    }
    const target = rational(
      c.population.reduce((s, x) => s + BigInt(x.yB) - BigInt(x.yA), 0n),
      BigInt(c.population.length)
    );
    expect(expectation).toEqual(target);
    if (c.caseId.includes('-decrease-')) expect(target).toEqual(rational(-5n));
    if (c.caseId.includes('-increase-')) expect(target).toEqual(rational(5n));
    if (c.caseId.includes('-heterogeneous-effect-') && c.population.length % 4 === 0) {
      expect(target).toEqual(rational(0n));
      expect(sharp).toBe(false);
    }
    if (sharp)
      alphas.forEach((alpha, i) => {
        expect(lessEqual(rejection[i]!, alpha)).toBe(true);
        calibrations++;
      });
  }
  expect(vectors).toBe(7272);
  expect(calibrations).toBe(432);
}, 30000);
test('canonical JSON rationals and probabilities reject malformed encodings', () => {
  expect(decodeRational({ numerator: '0', denominator: '1' }, true)).toEqual(rational(0n));
  for (const [numerator, denominator] of [
    ['01', '2'],
    ['-0', '1'],
    ['1', '0'],
    ['1', '-2'],
    ['2', '4'],
    ['2', '1'],
    ['-1', '2']
  ])
    expect(() => decodeRational({ numerator, denominator }, true)).toThrow('invalid_rational');
});
