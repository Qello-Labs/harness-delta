import { expect, test } from 'vitest';
import { assessmentSchema, consumedContracts } from '../scripts/tool-update/assessment.mjs';
import { boundedParse, canonical, maxRecordBytes } from '../scripts/tool-update/manifest.mjs';
import { legacySourcePathAllowlist, sourcePathAllowlist } from '../scripts/tool-update/source-snapshot.mjs';

const versions = [1, 2, 3, 4, 5, 6] as const;
const policy = { parser_base_transition: 'none', baseline_transition: null, next_step: 'selected_exact' } as const;
const lane = {
  product: 'codex',
  route: 'file',
  profile_id: 'codex-file-checkpoint-v1',
  operation: 'collect',
  topology: 'root',
  static_selection: 'exact',
  compatibility: null,
  parser_base: '0.158.0',
  window: null,
  rule_revision: 'forward-version-v1',
  declared_scope: { max_depth: 0, max_members: 1, read_only: false, exact_only: false },
  reasons: ['baseline_missing', 'contracts_unknown'],
  review: {
    coverage: 'baseline_missing',
    baseline_version: null,
    releases: [],
    edges: [],
    parser_comparison: null,
    contracts: consumedContracts.map(contract_id => ({ contract_id, judgment: 'unknown' as const }))
  },
  live: { invalidation: 'not_assessed', binary: 'not_assessed', permissions: 'not_assessed', config: 'not_assessed', authentication: 'not_assessed' },
  gates: {
    contracts_reviewed: 'unknown',
    conformance: 'not_assessed',
    regression: 'not_assessed',
    implementation_review: 'not_assessed',
    admission: 'not_assessed',
    default_promotion: 'not_assessed'
  }
} as const;
function record(schemaVersion: (typeof versions)[number]) {
  const fields = {
    schema_version: schemaVersion,
    kind: 'assessment',
    candidate_id: 'a'.repeat(64),
    observation_id: 'b'.repeat(64),
    baseline_digest: null,
    source_digest: 'c'.repeat(64),
    source_paths: schemaVersion <= 4 ? legacySourcePathAllowlist : sourcePathAllowlist,
    rule_revision: schemaVersion <= 4 ? 'static-assessment-v1' : 'static-assessment-v2',
    review_sources: [{ version: '0.158.0', commit: 'd'.repeat(40), path: 'codex-rs/protocol/src/protocol.rs', availability: 'not_assessed' }],
    lanes: [lane]
  };
  const reviewed = { inventory_scope: 'legacy_full_inventory', review_ids: ['a'.repeat(64), 'b'.repeat(64)], unused_review_ids: ['a'.repeat(64)] };
  switch (schemaVersion) {
    case 1:
      return fields;
    case 2:
    case 5:
      return { ...fields, inventory_scope: 'legacy_full_inventory' };
    case 3:
      return { ...fields, ...reviewed };
    case 4:
    case 6:
      return { ...fields, ...reviewed, lanes: [{ ...lane, selection_policy: policy }] };
  }
}

test.each(versions)('schema %i reads its finite closure and preserves portable fields', schemaVersion => {
  const input = record(schemaVersion);

  const parsed = assessmentSchema.parse(input);

  expect(parsed).toEqual(input);
  expect(parsed.source_paths).toHaveLength(schemaVersion <= 4 ? 31 : 44);
});

test.each([5, 6] as const)('schema %i reads both named expanded revisions without rewriting v2 records', schemaVersion => {
  const input = record(schemaVersion);

  for (const rule_revision of ['static-assessment-v2', 'static-assessment-v3']) {
    expect(assessmentSchema.parse({ ...input, rule_revision })).toEqual({ ...input, rule_revision });
  }
});

test.each(versions)('schema %i rejects wrong top-level and lane revisions', schemaVersion => {
  const input = record(schemaVersion);
  const revisions =
    schemaVersion <= 4 ? ['static-assessment-v2', 'static-assessment-v3', 'unknown'] : ['static-assessment-v1', 'static-assessment-v4', 'unknown'];

  for (const rule_revision of revisions) expect(assessmentSchema.safeParse({ ...input, rule_revision }).success).toBe(false);
  expect(assessmentSchema.safeParse({ ...input, lanes: input.lanes.map(row => ({ ...row, rule_revision: 'forward-version-v2' })) }).success).toBe(false);
});

test.each([1, 2, 3, 4] as const)('legacy schema %i refuses expanded writer control and migration paths', schemaVersion => {
  const input = record(schemaVersion);
  const expanded = sourcePathAllowlist.filter(path => !legacySourcePathAllowlist.includes(path));

  for (const path of expanded) expect(assessmentSchema.safeParse({ ...input, source_paths: [path] }).success).toBe(false);
  for (const path of ['src/store.ts', 'src/core/ordinary-window-activation.ts', 'src/migrations/037_ordinary_window_decisions.sql'])
    expect(assessmentSchema.safeParse({ ...input, source_paths: [path] }).success).toBe(false);
  expect(assessmentSchema.safeParse({ ...input, source_paths: sourcePathAllowlist }).success).toBe(false);
});

test.each(versions)('schema %i rejects unknown paths duplicates and over-bound lists', schemaVersion => {
  const input = record(schemaVersion);
  const path = 'src/source-compatibility.ts';
  const limit = schemaVersion <= 4 ? 32 : 44;

  for (const source_paths of [[], ['../SECRET'], ['src/unlisted-control.ts'], [path, path]])
    expect(assessmentSchema.safeParse({ ...input, source_paths }).success).toBe(false);
  const overflow = assessmentSchema.safeParse({ ...input, source_paths: Array<string>(limit + 1).fill(path) });
  if (overflow.success) throw new Error('source_path_limit_required');
  expect(overflow.error.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'too_big', maximum: limit, path: ['source_paths'] })]));
  expect(assessmentSchema.safeParse({ ...input, lanes: [...input.lanes, ...input.lanes] }).success).toBe(false);
});

test.each(versions)('schema %i never accepts forged live or admission gates', schemaVersion => {
  const input = record(schemaVersion);
  const selected = input.lanes[0];
  if (!selected) throw new Error('fixture_lane_required');

  for (const key of Object.keys(selected.live))
    expect(assessmentSchema.safeParse({ ...input, lanes: [{ ...selected, live: { ...selected.live, [key]: 'pass' } }] }).success).toBe(false);
  for (const key of ['conformance', 'regression', 'implementation_review', 'admission', 'default_promotion'])
    expect(assessmentSchema.safeParse({ ...input, lanes: [{ ...selected, gates: { ...selected.gates, [key]: 'closed' } }] }).success).toBe(false);
});

test.each([3, 4, 6] as const)('reviewed schema %i retains sorting subset and contract gate checks', schemaVersion => {
  const input = record(schemaVersion);
  const selected = input.lanes[0];
  if (!selected) throw new Error('fixture_lane_required');

  for (const changes of [
    { review_ids: ['b'.repeat(64), 'a'.repeat(64)] },
    { review_ids: ['a'.repeat(64), 'a'.repeat(64)] },
    { unused_review_ids: ['b'.repeat(64), 'a'.repeat(64)] },
    { unused_review_ids: ['a'.repeat(64), 'a'.repeat(64)] },
    { unused_review_ids: ['f'.repeat(64)] },
    { lanes: [{ ...selected, gates: { ...selected.gates, contracts_reviewed: 'closed' } }] }
  ])
    expect(assessmentSchema.safeParse({ ...input, ...changes }).success).toBe(false);
});

test.each([4, 6] as const)('policy schema %i retains strict required selection fields', schemaVersion => {
  const input = record(schemaVersion);
  const incomplete = { parser_base_transition: policy.parser_base_transition, baseline_transition: policy.baseline_transition };

  for (const selection_policy of [incomplete, { ...policy, next_step: 'supported' }, { ...policy, extra: true }])
    expect(assessmentSchema.safeParse({ ...input, lanes: [{ ...lane, selection_policy }] }).success).toBe(false);
  expect(assessmentSchema.safeParse({ ...input, lanes: [lane] }).success).toBe(false);
});

test.each([1, 2, 3, 5] as const)('non-policy schema %i refuses selection policy fields', schemaVersion => {
  const input = record(schemaVersion);

  expect(assessmentSchema.safeParse({ ...input, lanes: [{ ...lane, selection_policy: policy }] }).success).toBe(false);
});

test.each([5, 6] as const)('schema %i keeps the 256 KiB portable record ceiling', schemaVersion => {
  const input = record(schemaVersion);
  const selected = input.lanes[0];
  if (!selected) throw new Error('fixture_lane_required');
  const release = {
    version: '0.158.0',
    release_id: 1,
    tag: 'rust-v0.158.0',
    commit: 'd'.repeat(40),
    npm_integrity: 'sha512-' + Buffer.alloc(64).toString('base64')
  };
  const oversized = {
    ...input,
    lanes: ['link', 'collect', 'restart', 'launch', 'resume'].map(operation => ({
      ...selected,
      operation,
      review: { ...selected.review, releases: Array.from({ length: 256 }, () => release) }
    }))
  };

  expect(Buffer.byteLength(canonical(oversized))).toBeGreaterThan(maxRecordBytes);
  expect(assessmentSchema.safeParse(oversized).success).toBe(false);
  expect(() => boundedParse(oversized, assessmentSchema)).toThrow('record_too_large');
});

test.each([1, 2, 3, 4] as const)('legacy schema %i refuses new root-policy profiles under its original revision', schemaVersion => {
  const input = record(schemaVersion);

  for (const profile_id of ['codex-binding-root-window-v1', 'claude-binding-root-window-v1']) {
    expect(
      assessmentSchema.safeParse({
        ...input,
        lanes: input.lanes.map(row => ({
          ...row,
          product: profile_id.startsWith('codex') ? 'codex' : 'claude_code',
          route: profile_id.startsWith('codex') ? 'codex_binding' : 'claude_binding',
          profile_id
        }))
      }).success
    ).toBe(false);
  }
});

test.each([0, 7])('rejects unknown assessment schema %i', schema_version => {
  expect(assessmentSchema.safeParse({ ...record(5), schema_version }).success).toBe(false);
});

test.each(versions)('schema %i keeps root policy IDs out of legacy compatibility fields', schemaVersion => {
  const input = record(schemaVersion);
  const compatibility = {
    state: 'verified',
    product: 'codex',
    product_version: '0.158.0',
    source: 'file',
    parser_version: '0.158.0',
    parser_revision: 'codex-file-checkpoint-v1',
    profile_id: 'codex-file-checkpoint-v1',
    rule_revision: 'forward-version-v1'
  };
  const legacy = { ...input, lanes: input.lanes.map(row => ({ ...row, compatibility })) };
  expect(assessmentSchema.parse(legacy)).toEqual(legacy);
  for (const id of ['codex-binding-root-window-v1', 'claude-binding-root-window-v1'])
    for (const key of ['profile_id', 'parser_revision'])
      expect(
        assessmentSchema.safeParse({ ...legacy, lanes: legacy.lanes.map(row => ({ ...row, compatibility: { ...compatibility, [key]: id } })) }).success
      ).toBe(false);
});
