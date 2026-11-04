import { expect, test } from 'vitest';
import { evaluateCoverage, mergeCoverageFacts, type CoverageEvidence, type CoverageFact } from '../src/coverage.js';

// Independent fixture: omitting any gate in the evaluator must fail its negative case.
const facts = {
  scopeBeforeAccess: 'verified',
  freshSession: 'verified',
  readyBeforeFirstRequest: 'verified',
  continuousObservation: 'verified',
  fixedModel: 'verified',
  boundedTopology: 'verified',
  requestUniverse: 'verified',
  terminalAccounting: 'verified',
  immutableIdentity: 'verified',
  durableFlush: 'verified',
  counterSemantics: 'verified'
} as const;
const evidence: CoverageEvidence = {
  profileId: 'synthetic-coverage-v1',
  metric: 'input_total',
  facts,
  hasObservedValue: true
};
const factNames = Object.keys(facts) as CoverageFact[];

test('allVerifiedCandidate: a present synthetic observation satisfies the policy only', () => {
  expect(evaluateCoverage(evidence)).toEqual({ eligible: true, reasons: [] });
});
for (const state of ['unknown', 'violated'] as const) {
  test.each(factNames)(`${state} evidence for %s prevents eligibility`, fact => {
    expect(evaluateCoverage({ ...evidence, facts: { ...facts, [fact]: state } })).toEqual({ eligible: false, reasons: [fact] });
  });
}
test('missingValueIsNotZero: presence, including an observed zero, is distinct from missing', () => {
  // Values are deliberately outside this evaluator; true represents observed presence, not truthiness.
  expect(evaluateCoverage({ ...evidence, hasObservedValue: false })).toEqual({ eligible: false, reasons: ['missing_value'] });
  expect(evaluateCoverage({ ...evidence, hasObservedValue: true }).eligible).toBe(true);
});
test('returns every blocking reason in lexical order without mutating evidence', () => {
  const input = {
    ...evidence,
    hasObservedValue: false,
    facts: { ...facts, terminalAccounting: 'unknown', durableFlush: 'violated', boundedTopology: 'unknown' }
  };
  const before = structuredClone(input);
  expect(evaluateCoverage(input)).toEqual({ eligible: false, reasons: ['boundedTopology', 'durableFlush', 'missing_value', 'terminalAccounting'] });
  expect(input).toEqual(before);
});
test('counterMetricIsolation: verified input does not repair unknown output semantics', () => {
  expect(evaluateCoverage({ ...evidence, metric: 'output_total', facts: { ...facts, counterSemantics: 'unknown' } })).toEqual({
    eligible: false,
    reasons: ['counterSemantics']
  });
  expect(evaluateCoverage(evidence)).toEqual({ eligible: true, reasons: [] });
});
const invalidInputs: unknown[] = [
  null,
  [],
  {},
  { ...evidence, profileId: 'codex' },
  { ...evidence, profileId: 'synthetic-coverage-v2' },
  { ...evidence, metric: 'total_tokens' },
  { ...evidence, hasObservedValue: 0 },
  { ...evidence, hasObservedValue: undefined },
  { ...evidence, outcome: 'success' },
  { ...evidence, prompt: 'SYNTHETIC_PRIVATE_SENTINEL' },
  { ...evidence, facts: { ...facts, counterSemantics: undefined } },
  { ...evidence, facts: { ...facts, counterSemantics: 'complete' } },
  { ...evidence, facts: { ...facts, extra: 'verified' } }
];
test.each(invalidInputs)('rejects malformed or unsupported evidence with a fixed safe error (%#)', input => {
  expect(() => evaluateCoverage(input)).toThrow(/^invalid_coverage_input$/);
});
test.each([
  ['verified', 'verified', 'verified'],
  ['verified', 'unknown', 'unknown'],
  ['verified', 'violated', 'violated'],
  ['unknown', 'verified', 'unknown'],
  ['unknown', 'unknown', 'unknown'],
  ['unknown', 'violated', 'violated'],
  ['violated', 'verified', 'violated'],
  ['violated', 'unknown', 'violated'],
  ['violated', 'violated', 'violated']
] as const)('completed interval merge %s + %s retains %s', (previous, next, expected) => {
  expect(mergeCoverageFacts({ ...facts, continuousObservation: previous }, { ...facts, continuousObservation: next })).toEqual({
    ...facts,
    continuousObservation: expected
  });
});
test('gapCannotBeRepairedByLaterSegment: accumulated gaps and conflicts remain ineligible', () => {
  const first = { ...facts, continuousObservation: 'violated', requestUniverse: 'unknown' } as const;
  const later = { ...facts, immutableIdentity: 'violated' } as const;
  const merged = mergeCoverageFacts(first, later);
  const again = mergeCoverageFacts(merged, facts);
  expect(evaluateCoverage({ ...evidence, facts: again })).toEqual({
    eligible: false,
    reasons: ['continuousObservation', 'immutableIdentity', 'requestUniverse']
  });
  expect(first).toEqual({ ...facts, continuousObservation: 'violated', requestUniverse: 'unknown' });
  expect(later).toEqual({ ...facts, immutableIdentity: 'violated' });
  expect(merged).not.toBe(first);
});
test('merge rejects incomplete facts rather than treating an absent gate as verified', () => {
  const incomplete = { ...facts, durableFlush: undefined } as unknown as CoverageEvidence['facts'];
  expect(() => mergeCoverageFacts(incomplete, facts)).toThrow(/^invalid_coverage_input$/);
  expect(() => mergeCoverageFacts(facts, incomplete)).toThrow(/^invalid_coverage_input$/);
});
