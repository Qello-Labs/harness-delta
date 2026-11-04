import { expect, test } from 'vitest';
import { codex01580Candidate, lookupCandidate } from '../scripts/conformance/candidate.js';
import { assessAdmission } from '../scripts/conformance/admission.js';
import { checkNames } from '../scripts/conformance/checks.js';
import { codexRolloutPolicy } from '../src/codex-rollout-policy.js';

const identity = { policyRevision: codexRolloutPolicy.revision, implementationDigest: 'a'.repeat(64), sourceRef: 'rust-v0.158.0', previousVersion: '0.156.1' };
const report = () => ({
  ...identity,
  version: '0.158.0',
  scenario: 'exec_initial_resume',
  confirmed: true,
  stop: null,
  productVersionBefore: 'match',
  productVersionAfter: 'match',
  configMetadataUnchanged: true,
  stages: ['initial', 'resume'].map(stage => ({
    stage,
    exit: 'ok',
    rolloutMatch: 'match',
    sameRolloutAsInitial: stage === 'resume' ? true : null,
    parseError: null,
    exec: { threadIdPresent: true, conflict: false, turnCompletedCount: 1 },
    conformance: {
      version: '0.158.0',
      blocked: false,
      limitExceeded: false,
      checks: Object.fromEntries(checkNames.map(name => [name, name === 'nonzero_reasoning' ? 'not_observed' : 'pass']))
    }
  }))
});
test('only an exact reviewed candidate and matching current evidence can be eligible', () => {
  expect(lookupCandidate('0.158.0')).toBeDefined();
  expect(lookupCandidate('0.158.1')).toBeUndefined();
  expect(lookupCandidate('0.158.0+build')).toBeUndefined();
  expect(assessAdmission(codex01580Candidate, report(), identity).eligible).toBe(true);
});
test.each(['implementationDigest', 'policyRevision', 'sourceRef', 'version', 'previousVersion'])('stale %s prevents promotion', key => {
  const value = { ...report(), [key]: 'old' };
  expect(assessAdmission(codex01580Candidate, value, identity).eligible).toBe(false);
});
test('missing/failed required checks block; optional nonzero reasoning does not', () => {
  const value = report();
  value.stages[1]!.conformance.checks.thread_settings_applied = 'not_observed';
  expect(assessAdmission(codex01580Candidate, value, identity)).toMatchObject({ eligible: false });
  expect(assessAdmission(codex01580Candidate, value, identity).reasons).toContain('resume:thread_settings_applied:not_observed');
  value.stages[1]!.conformance.checks.thread_settings_applied = 'pass';
  value.stages[0]!.conformance.blocked = true;
  expect(assessAdmission(codex01580Candidate, value, identity).eligible).toBe(false);
});
test('old, incomplete, duplicate-stage, unconfirmed, mismatched and malformed reports cannot register', () => {
  for (const value of [
    null,
    {},
    { ...report(), confirmed: false },
    { ...report(), stages: [] },
    { ...report(), stages: [report().stages[0], report().stages[0]] },
    { ...report(), stop: 'timeout' },
    { ...report(), productVersionAfter: 'mismatch' }
  ]) {
    expect(assessAdmission(codex01580Candidate, value, identity).eligible).toBe(false);
  }
});

test('declared comparison names the extra required input subset and semantic boundary variant', async () => {
  const { compareCandidate } = await import('../scripts/conformance/candidate.js');
  expect(compareCandidate(codex01580Candidate)).toMatchObject({
    addedRequiredCounters: ['cache_write_input_tokens'],
    removedRequiredCounters: [],
    addedRecordTypes: [],
    counterModeChanged: false,
    boundaryVariantChanged: true,
    commandDiagnosticsExcluded: true
  });
});
