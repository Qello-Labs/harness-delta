import { afterEach, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { judgeDifferences } from '../scripts/tool-update/difference-judgment.mjs';
import { differenceJobId } from '../scripts/tool-update/difference-records.mjs';
import type { DifferenceEvidence, DifferenceJob, Finding } from '../scripts/tool-update/difference-records.mjs';
import { baseRef, currentIdentities, differenceJob, middleRef, sourceEvidence, targetRef } from './helpers/tool-update-difference-fixture.js';

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});
function withJob(job: DifferenceJob, records: readonly DifferenceEvidence[]): DifferenceEvidence[] {
  return records.map(record => ({
    ...record,
    job_id: differenceJobId(job)
  }));
}
function changedFinding(record: DifferenceEvidence, result: Finding['result']): DifferenceEvidence {
  return {
    ...record,
    findings: record.findings.map(finding =>
      finding.contract_id === 'fields_types_enums' && finding.facet === 'serialized_shape'
        ? {
            ...finding,
            result,
            reason: result === 'affected' ? 'confirmed_contradiction' : 'unresolved_dependency',
            impact: result === 'affected' ? 'shape_changed' : 'undetermined'
          }
        : finding
    )
  };
}
function fieldGroup(job = differenceJob(), evidence = sourceEvidence(job)) {
  const group = judgeDifferences(job, evidence, currentIdentities).groups.find(group => group.contract_id === 'fields_types_enums');
  if (!group) throw new Error('missing_synthetic_group');
  return group;
}
function shapeFacet(job = differenceJob(), evidence = sourceEvidence(job)) {
  const facet = fieldGroup(job, evidence).facets.find(facet => facet.facet === 'serialized_shape');
  if (!facet) throw new Error('missing_synthetic_facet');
  return facet;
}
function fixture(record: DifferenceEvidence): DifferenceEvidence {
  return {
    ...record,
    method: 'synthetic_parser_provider_replay',
    material: {
      kind: 'synthetic',
      fixture_id: 'parser_provider_v1',
      scenario_id: 'unchanged',
      fixture_digest: '6'.repeat(64),
      harness_digest: '7'.repeat(64)
    }
  };
}
test('all eight ordered groups keep native and backend validation pending despite complete client proof', () => {
  const judgment = judgeDifferences(differenceJob(), sourceEvidence(), currentIdentities);
  expect(judgment.groups.map(group => [group.contract_id, group.result, group.eligibility_recommendation])).toEqual([
    ['identity_source_mapping', 'unknown', 'validation_pending'],
    ['fields_types_enums', 'unaffected', 'ready_for_scoped_review'],
    ['partial_rotation_checkpoint', 'unknown', 'validation_pending'],
    ['counters_cache_reasoning_reset_overflow', 'unknown', 'validation_pending'],
    ['hooks_order_receipts_loading', 'unknown', 'validation_pending'],
    ['invocation_permissions_config_model_effort', 'unknown', 'validation_pending'],
    ['history_topology_resume_compaction', 'unaffected', 'ready_for_scoped_review'],
    ['finality_replay_conflict_stop_flush_sigint', 'unknown', 'validation_pending']
  ]);
  expect(judgment.groups[2]?.required_validation).toContain('real_session');
  expect(judgment.groups[3]?.required_validation).toContain('backend_counter_meaning');
  expect(judgment.comparisons).toEqual([
    { comparison_kind: 'adjacent_release', from: baseRef, to: middleRef },
    { comparison_kind: 'adjacent_release', from: middleRef, to: targetRef },
    { comparison_kind: 'parser_base', from: baseRef, to: targetRef }
  ]);
});
test.each(['affected', 'unknown'] as const)('%s outranks an unaffected comparison at facet and group levels', result => {
  const job = differenceJob();
  const evidence = sourceEvidence(job).map((record, index) => (index === 0 ? changedFinding(record, result) : record));
  expect(fieldGroup(job, evidence).result).toBe(result);
  expect(shapeFacet(job, evidence).result).toBe(result);
});
test('a confirmed contradiction outranks a passing fixture and preserves both evidence identities', () => {
  const job = differenceJob();
  const source = sourceEvidence(job);
  const first = source[0];
  if (!first) throw new Error('missing_synthetic_evidence');
  const evidence = [...source.map((record, i) => (i === 0 ? changedFinding(record, 'affected') : record)), fixture(first)];
  const facet = shapeFacet(job, evidence);
  expect(facet.result).toBe('affected');
  expect(facet.reasons).toContain('conflicting_evidence');
  expect(facet.methods).toEqual(['codex_source_identity', 'synthetic_parser_provider_replay']);
  expect(fieldGroup(job, evidence).variant_requirement).toBe('named_variant_review_required');
});
test('unknown evidence cannot hide an established relevant contradiction', () => {
  const job = differenceJob();
  const source = sourceEvidence(job);
  const first = source[0];
  if (!first) throw new Error('missing_synthetic_evidence');
  expect(
    fieldGroup(job, [...source.map((record, i) => (i === 0 ? changedFinding(record, 'affected') : record)), changedFinding(fixture(first), 'unknown')]).result
  ).toBe('affected');
});
test('a changed source blob without established impact is unknown, not a variant requirement', () => {
  const evidence = sourceEvidence().map(record => ({
    ...record,
    to_content_hash: '8'.repeat(64)
  }));
  expect(shapeFacet(differenceJob(), evidence)).toMatchObject({
    result: 'unknown',
    reasons: ['source_changed_impact_unknown']
  });
  expect(fieldGroup(differenceJob(), evidence).variant_requirement).toBe('undetermined');
});
test.each([
  ['incomplete', { extraction_completeness: 'incomplete' }, 'extraction_incomplete'],
  ['unsupported', { extraction_completeness: 'unsupported' }, 'unsupported_extractor'],
  [
    'absent',
    {
      availability: 'absent',
      from_content_hash: null,
      to_content_hash: null,
      reasons: ['pinned_material_absent']
    },
    'pinned_material_absent'
  ],
  ['unresolved', { reasons: ['unresolved_dependency'] }, 'unresolved_dependency']
] as const)('%s proof cannot become unaffected', (_name, change, reason) => {
  const evidence = sourceEvidence().map(record => ({
    ...record,
    ...change
  }));
  expect(shapeFacet(differenceJob(), evidence).result).toBe('unknown');
  expect(shapeFacet(differenceJob(), evidence).reasons).toContain(reason);
});
test('a shape-only method cannot claim client transformation or satisfy it by omission', () => {
  const evidence = sourceEvidence().map(record => ({
    ...record,
    method: 'serialized_schema' as const,
    material: {
      kind: 'official' as const,
      repository_id: 'openai_codex' as const,
      path_id: 'serialized_schema' as const,
      from_commit: record.comparison.from.commit,
      to_commit: record.comparison.to.commit
    }
  }));
  const group = fieldGroup(differenceJob(), evidence);
  expect(group.result).toBe('unknown');
  expect(group.facets).toMatchObject([
    { facet: 'serialized_shape', result: 'unaffected' },
    {
      facet: 'client_transformation',
      result: 'unknown',
      reasons: ['method_inapplicable']
    }
  ]);
});
test('one missing required facet on one edge leaves that group unknown', () => {
  const evidence = sourceEvidence().map((record, index) =>
    index === 0
      ? {
          ...record,
          findings: record.findings.filter(finding => finding.contract_id !== 'fields_types_enums' || finding.facet !== 'client_transformation')
        }
      : record
  );
  expect(fieldGroup(differenceJob(), evidence).result).toBe('unknown');
});
test('synthetic replay alone never claims unchanged vendor behavior', () => {
  const evidence = sourceEvidence().map(fixture);
  expect(shapeFacet(differenceJob(), evidence)).toMatchObject({
    result: 'unknown',
    reasons: ['established_unchanged', 'synthetic_only']
  });
});
test.each([
  ['source_digest', '9'.repeat(64), 'stale_source'],
  ['engine_digest', '9'.repeat(64), 'stale_engine'],
  ['engine_revision', 'difference-engine-v0', 'stale_engine'],
  ['map_revision', 'difference-map-v0', 'stale_map'],
  ['policy_revision', 'closed-windows-v0', 'stale_policy'],
  ['capability_revision', 'difference-capability-v0', 'stale_evidence']
] as const)('stale %s becomes unknown instead of error or affected', (key, value, reason) => {
  const evidence = sourceEvidence().map(record => ({
    ...changedFinding(record, 'affected'),
    [key]: value
  }));
  expect(shapeFacet(differenceJob(), evidence)).toMatchObject({
    result: 'unknown',
    reasons: [reason]
  });
});
test('a stale job remains unknown even if supplied evidence carries the current identities', () => {
  const job = { ...differenceJob(), source_digest: '9'.repeat(64) };
  const judgment = judgeDifferences(job, sourceEvidence(job), currentIdentities);
  expect(judgment.source_digest).toBe(currentIdentities.source_digest);
  expect(judgment.coverage_reasons).toContain('stale_source');
  expect(judgment.groups.every(group => group.result === 'unknown')).toBe(true);
});
test('an evidence packet for another job is rejected without echoing its contents', () => {
  const evidence = sourceEvidence().map(record => ({
    ...record,
    job_id: '9'.repeat(64)
  }));
  expect(() => judgeDifferences(differenceJob(), evidence, currentIdentities)).toThrowError('difference_job_mismatch');
});
test('a source-identity method cannot borrow a release-documentation path as source proof', () => {
  const evidence = sourceEvidence().map(record => ({
    ...record,
    material: {
      kind: 'official' as const,
      repository_id: 'openai_codex' as const,
      path_id: 'release_documentation' as const,
      from_commit: record.comparison.from.commit,
      to_commit: record.comparison.to.commit
    }
  }));
  expect(() => judgeDifferences(differenceJob(), evidence, currentIdentities)).toThrowError('difference_identity_mismatch');
});
test('a cross-product repository identity is rejected instead of treated as stale', () => {
  const evidence = sourceEvidence().map(record => ({
    ...record,
    material: {
      kind: 'official' as const,
      repository_id: 'anthropics_claude_code' as const,
      path_id: 'source_closure' as const,
      from_commit: record.comparison.from.commit,
      to_commit: record.comparison.to.commit
    }
  }));
  expect(() => judgeDifferences(differenceJob(), evidence, currentIdentities)).toThrowError('difference_identity_mismatch');
});
test.each(['adjacent_release', 'parser_base'] as const)('missing %s evidence keeps all groups pending', kind => {
  const evidence = sourceEvidence().filter(record => record.comparison.comparison_kind !== kind);
  const judgment = judgeDifferences(differenceJob(), evidence, currentIdentities);
  expect(judgment.coverage_reasons).toContain(kind === 'parser_base' ? 'comparison_missing' : 'edge_missing');
  expect(judgment.groups.every(group => group.result === 'unknown')).toBe(true);
});
test('duplicate proof for an edge is unknown even when both copies pass', () => {
  const evidence = sourceEvidence();
  const first = evidence[0];
  if (!first) throw new Error('missing_synthetic_evidence');
  const judgment = judgeDifferences(differenceJob(), [...evidence, first], currentIdentities);
  expect(judgment.coverage_reasons).toEqual(['edge_duplicate']);
  expect(fieldGroup(differenceJob(), [...evidence, first]).result).toBe('unknown');
});
test('commit-conflicting edges are unknown, never borrowed as proof for the pinned endpoint', () => {
  const evidence = sourceEvidence().map((record, index) =>
    index === 0
      ? {
          ...record,
          comparison: {
            ...record.comparison,
            from: { ...record.comparison.from, commit: '9'.repeat(40) }
          },
          material: {
            kind: 'official' as const,
            repository_id: 'openai_codex' as const,
            path_id: 'source_closure' as const,
            from_commit: '9'.repeat(40),
            to_commit: record.comparison.to.commit
          }
        }
      : record
  );
  const judgment = judgeDifferences(differenceJob(), evidence, currentIdentities);
  expect(judgment.coverage_reasons).toEqual(['edge_commit_conflict', 'edge_missing']);
  expect(fieldGroup(differenceJob(), evidence).result).toBe('unknown');
});
test.each(['incomplete', 'missing_endpoint', 'duplicate_version', 'conflicting_commit'] as const)('inventory %s cannot establish coverage', kind => {
  const original = differenceJob();
  const inventory = original.inventory;
  const changes = {
    incomplete: { ...inventory, coverage: 'incomplete' as const },
    missing_endpoint: {
      ...inventory,
      releases: [middleRef, targetRef]
    },
    duplicate_version: {
      ...inventory,
      releases: [baseRef, baseRef, middleRef, targetRef]
    },
    conflicting_commit: {
      ...inventory,
      releases: [{ ...baseRef, commit: '9'.repeat(40) }, middleRef, targetRef]
    }
  };
  const job = { ...original, inventory: changes[kind] };
  const judgment = judgeDifferences(job, sourceEvidence(job), currentIdentities);
  const expected = {
    incomplete: 'release_coverage_incomplete',
    missing_endpoint: 'release_coverage_incomplete',
    duplicate_version: 'edge_duplicate',
    conflicting_commit: 'edge_commit_conflict'
  }[kind];
  expect(judgment.coverage_reasons).toContain(expected);
  expect(fieldGroup(job, sourceEvidence(job)).result).toBe('unknown');
});
test('parser-base edges remain required before an explicitly newer reviewed baseline', () => {
  const original = differenceJob();
  const row = original.baseline_row;
  if (!row) throw new Error('missing_synthetic_baseline');
  const job = {
    ...original,
    baseline_row: { ...row, ref: middleRef },
    comparison: {
      comparison_kind: 'adjacent_release' as const,
      from: middleRef,
      to: targetRef
    }
  };
  const evidence = sourceEvidence(job).filter(
    record => record.comparison.from.version !== baseRef.version || record.comparison.comparison_kind === 'parser_base'
  );
  expect(judgeDifferences(job, evidence, currentIdentities).coverage_reasons).toEqual(['edge_missing']);
});
test('equal baseline and target still require cumulative parser comparison and its edges', () => {
  const original = differenceJob();
  const row = original.baseline_row;
  if (!row) throw new Error('missing_synthetic_baseline');
  const job = {
    ...original,
    baseline_row: { ...row, ref: targetRef },
    comparison: {
      comparison_kind: 'adjacent_release' as const,
      from: targetRef,
      to: targetRef
    }
  };
  const complete = sourceEvidence(job);
  expect(fieldGroup(job, complete).result).toBe('unaffected');
  expect(
    fieldGroup(
      job,
      complete.filter(record => record.comparison.comparison_kind !== 'parser_base')
    ).result
  ).toBe('unknown');
});
test('missing parser base remains explicit and unknown even when interval edges pass', () => {
  const job = { ...differenceJob(), parser_base: null };
  const evidence = sourceEvidence(job).filter(record => record.comparison.comparison_kind === 'adjacent_release');
  expect(judgeDifferences(job, evidence, currentIdentities).coverage_reasons).toEqual(['parser_base_missing']);
  expect(fieldGroup(job, evidence).result).toBe('unknown');
});
test('missing baseline never invents a first review or makes the interval ready', () => {
  const original = differenceJob();
  const job: DifferenceJob = {
    ...original,
    baseline_digest: null,
    baseline_row: null,
    comparison: {
      comparison_kind: 'parser_base',
      from: baseRef,
      to: targetRef
    },
    reasons: ['baseline_missing']
  };
  const judgment = judgeDifferences(job, sourceEvidence(job), currentIdentities);
  expect(judgment.baseline_digest).toBeNull();
  expect(judgment.coverage_reasons).toEqual(['baseline_missing']);
  expect(judgment.groups.every(group => group.eligibility_recommendation === 'validation_pending')).toBe(true);
});
test('file-only applicability omits native identity and invocation facets rather than counting them as passes', () => {
  const original = differenceJob();
  const lane = {
    ...original.lane,
    route: 'file' as const,
    profile_id: 'codex-file-checkpoint-v1'
  };
  const row = original.baseline_row;
  if (!row) throw new Error('missing_synthetic_baseline');
  const job = {
    ...original,
    lane,
    baseline_row: { ...row, ...lane },
    parser_base: { ...baseRef, profile_id: lane.profile_id }
  };
  const judgment = judgeDifferences(job, sourceEvidence(job), currentIdentities);
  expect(judgment.groups[0]?.eligibility_recommendation).toBe('ready_for_scoped_review');
  expect(judgment.groups[0]?.facets.map(facet => facet.facet)).toEqual(['serialized_shape', 'client_transformation', 'identity_lifecycle']);
  expect(judgment.groups[5]?.eligibility_recommendation).toBe('ready_for_scoped_review');
});
test('family history requires deferred execution and real-session validation despite passing structural proof', () => {
  const original = differenceJob();
  const lane = { ...original.lane, profile_id: 'codex-binding-01630-direct-family-v1', topology: 'bounded_family' as const };
  const row = original.baseline_row;
  if (!row) throw new Error('missing_synthetic_baseline');
  const job = { ...original, lane, baseline_row: { ...row, ...lane }, parser_base: { ...baseRef, profile_id: lane.profile_id } };
  const group = judgeDifferences(job, sourceEvidence(job), currentIdentities).groups[6];
  expect(group?.eligibility_recommendation).toBe('validation_pending');
  expect(group?.required_validation).toContain('real_session');
  expect(group?.facets.at(-1)).toMatchObject({ facet: 'native_execution', result: 'unknown', reasons: ['native_validation_pending'] });
});
test('Claude documentation silence cannot establish unchanged undocumented contracts', () => {
  const original = differenceJob();
  const lane = {
    ...original.lane,
    product: 'claude_code' as const,
    route: 'claude_binding' as const,
    profile_id: 'claude-binding-root-window-v1'
  };
  const refs = [
    { version: '2.1.306', commit: baseRef.commit },
    {
      version: '2.1.307',
      commit: targetRef.commit
    }
  ];
  const from = refs[0];
  const to = refs[1];
  const row = original.baseline_row;
  if (!from || !to || !row) throw new Error('missing_synthetic_ref');
  const job: DifferenceJob = {
    ...original,
    lane,
    repository_id: 'anthropics_claude_code',
    baseline_row: { ...row, ...lane, ref: from },
    parser_base: { ...from, profile_id: lane.profile_id },
    target: to,
    comparison: { comparison_kind: 'adjacent_release', from, to },
    inventory: { ...original.inventory, releases: refs }
  };
  const evidence = sourceEvidence(job).map(record => ({
    ...record,
    method: 'claude_pinned_documentation' as const,
    material: {
      kind: 'official' as const,
      repository_id: 'anthropics_claude_code' as const,
      path_id: 'release_documentation' as const,
      from_commit: record.comparison.from.commit,
      to_commit: record.comparison.to.commit
    }
  }));
  expect(shapeFacet(job, evidence)).toMatchObject({
    result: 'unknown',
    reasons: ['established_unchanged', 'undocumented_contract']
  });
});
test('evidence order does not alter deterministic judgment bytes or IDs', () => {
  const job = differenceJob();
  const evidence = sourceEvidence(job);
  expect(judgeDifferences(job, [...evidence].reverse(), currentIdentities)).toEqual(judgeDifferences(job, evidence, currentIdentities));
});
test('pure reduction performs no filesystem or network access', () => {
  const job = differenceJob();
  const evidence = withJob(job, sourceEvidence(job));
  const noIo = () => {
    throw new Error('unexpected_filesystem_access');
  };
  vi.spyOn(fs, 'readFile').mockImplementation(noIo);
  vi.spyOn(fs, 'open').mockImplementation(noIo);
  vi.spyOn(fs, 'mkdir').mockImplementation(noIo);
  vi.spyOn(fs, 'writeFile').mockImplementation(noIo);
  vi.spyOn(globalThis, 'fetch').mockImplementation(noIo);
  syncBuiltinESMExports();
  expect(judgeDifferences(job, evidence, currentIdentities).groups).toHaveLength(8);
});
