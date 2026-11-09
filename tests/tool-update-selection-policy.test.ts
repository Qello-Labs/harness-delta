import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test, vi } from 'vitest';
import { assessCandidate, assessmentSchema, consumedContracts, validateBaselineForSource } from '../scripts/tool-update/assessment.mjs';
import type { ContractReview, SelectionPolicy } from '../scripts/tool-update/assessment.mjs';
import type { Candidate, Observation, Product } from '../scripts/tool-update/discovery.mjs';
import { boundedParse, canonical, digest, maxRecordBytes } from '../scripts/tool-update/manifest.mjs';
import type { Baseline } from '../scripts/tool-update/manifest.mjs';
import * as snapshots from '../scripts/tool-update/source-snapshot.mjs';
import type { SourceRegistry } from '../scripts/tool-update/source-snapshot.mjs';
import { parseToolVersionPromotionDescriptor, projectToolVersionPromotions } from '../src/core/tool-version-promotion.js';
import { appendPromotionDecision, promotionFixture } from './helpers/tool-version-promotion.js';

const root = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const key = {
  product: 'codex',
  route: 'file',
  profile_id: 'codex-file-checkpoint-v1',
  operation: 'collect',
  topology: 'root'
} as const;
afterEach(() => {
  vi.restoreAllMocks();
});
function fixture(target = '0.163.0', product: Product = 'codex', versions = [target]) {
  const identity = {
    release_id: 1,
    tag: `${product === 'codex' ? 'rust-v' : 'v'}${target}`,
    commit: '1'.repeat(40),
    npm_integrity: `sha512-${Buffer.alloc(64).toString('base64')}`
  };
  const candidate: Candidate = {
    schema_version: 1,
    kind: 'candidate',
    product,
    target,
    ...identity
  };
  const observation: Observation = {
    schema_version: 1,
    kind: 'observation',
    product,
    checked_at: '2026-11-02T00:00:00.000Z',
    result: 'metadata_reconciled',
    reasons: ['baseline_missing'],
    heads: { github: target, npm_latest: target, npm_stable: target },
    checks: [],
    releases: versions.map((version, index) =>
      version === target
        ? { version, ...identity }
        : {
            ...identity,
            version,
            release_id: index + 2,
            tag: `${product === 'codex' ? 'rust-v' : 'v'}${version}`,
            commit: '2'.repeat(40)
          }
    ),
    candidate_id: digest(candidate)
  };
  return { root, candidate, observation };
}
const unusedReview = () => ({
  ...review(),
  from: { version: '0.150.0', commit: '2'.repeat(40) },
  to: { version: '0.151.0', commit: '3'.repeat(40) }
});
async function reviewed(input = fixture(), baseline?: Baseline) {
  const result = await assessCandidate({
    ...input,
    reviews: [unusedReview()],
    ...(baseline ? { baseline } : {})
  });
  if (result.schema_version !== 10 || result.review_ids === undefined || result.judgment_ids !== undefined) throw new Error('reviewed_schema_10_required');
  return result;
}
function syntheticRegistry(base?: string): SourceRegistry {
  return {
    ruleRevision: 'forward-version-v1',
    ordinaryWindows: [],
    resolveOrdinaryWindow: () => null,
    retiredClaudeWorkflowVersions: [],
    resolve: () => null,
    windows: base
      ? [
          {
            product: 'codex',
            source: 'file',
            base,
            upper_exclusive: '0.164.0',
            profile_id: key.profile_id
          }
        ]
      : [],
    files: [
      {
        product: 'codex',
        version: '0.158.0',
        boundaryMode: 'checkpoint'
      }
    ],
    evidence: [],
    promotionFacets: [],
    codexAdmissions: [],
    claudeAdmissions: []
  };
}
function useRegistry(source: SourceRegistry) {
  vi.spyOn(snapshots, 'withSourceSnapshot').mockImplementationOnce(async (_root, project) => ({
    value: await project(source),
    source_digest: 'b'.repeat(64),
    source_paths: ['src/source-compatibility.ts']
  }));
}
function review(sourceDigest = 'b'.repeat(64)): ContractReview {
  return {
    schema_version: 1,
    kind: 'contract_review',
    ...key,
    contract_revision: 'consumed-v1',
    from: { version: '0.162.1', commit: '2'.repeat(40) },
    to: { version: '0.163.0', commit: '1'.repeat(40) },
    contracts: consumedContracts.map(contract_id => ({
      contract_id,
      judgment: 'unaffected'
    })),
    evidence_ids: ['a'.repeat(64)],
    source_digest: sourceDigest
  };
}

test('reviewed schema 8 preserves every schema 3 lane field when selection policy is removed', async () => {
  // Given
  const input = fixture();
  const plain = await assessCandidate(input);
  const record = review(plain.source_digest);
  const baseline: Baseline = {
    schema_version: 1,
    kind: 'baseline',
    rows: [
      {
        ...key,
        last_reviewed_version: '0.163.0',
        contract_revision: 'consumed-v1',
        evidence_ids: [digest(record)],
        source_digest: plain.source_digest
      }
    ]
  };

  // When
  const result = await assessCandidate({
    ...input,
    baseline,
    reviews: [record]
  });

  // Then
  expect(result.schema_version).toBe(10);
  if (result.schema_version !== 10 || result.review_ids === undefined || result.judgment_ids !== undefined) throw new Error('reviewed_schema_10_required');
  expect(result.lanes).toHaveLength(39);
  const previousLanes = result.lanes
    .filter(row => !['codex-binding-01660-direct-family-v1', 'codex-binding-root-window-v1'].includes(row.profile_id))
    .map(row => {
      const { selection_policy, ...previous } = row;
      expect(selection_policy).toBeDefined();
      return previous;
    });
  expect(previousLanes).toHaveLength(28);
  // Frozen from schema 3 before the descriptive field was implemented.
  expect(digest(previousLanes)).toBe('adcb1651d9942ea5a5e27298cd6fe5be0a43b4a3613d118c875f8af9d8634d90');
  expect(digest(plain.lanes.filter(row => !['codex-binding-01660-direct-family-v1', 'codex-binding-root-window-v1'].includes(row.profile_id)))).toBe(
    '356ee379727d6dcdfd211428b62ea7ef21151134075979bf40a7a71c8271d228'
  );
  expect(plain.schema_version).toBe(10);
  expect(plain.lanes.every(row => !('selection_policy' in row))).toBe(true);
});

test.each([
  ['codex', '0.160.0', 'codex-workflow-direct-child-v1', 'resume', 'operation_unsupported', []],
  ['claude_code', '2.1.291', 'claude-workflow-direct-child-v1', 'resume', 'operation_unsupported', ['retired', 'exact_only']],
  ['claude_code', '2.1.291', 'claude-workflow-own-trace-v1', 'launch', 'retired', ['retired', 'out_of_window']],
  ['codex', '0.160.0', 'codex-workflow-own-response-v1', 'launch', 'selected_exact', []],
  ['codex', '0.163.0', 'codex-binding-01630-direct-family-v1', 'collect', 'selected_exact', ['exact_only']],
  ['codex', '0.163.0', 'codex-workflow-own-response-v1', 'launch', 'selected_window', ['exact_qualification_required']],
  ['codex', '0.156.1', 'codex-binding-01621-direct-family-v1', 'collect', 'exact_admission_required', ['exact_only', 'no_window']],
  ['codex', '0.156.1', 'codex-file-checkpoint-v1', 'collect', 'older_version_unsupported', ['out_of_window']],
  ['codex', '0.158.0', 'codex-file-checkpoint-v1', 'collect', 'selected_exact', []],
  ['codex', '0.164.0', 'codex-file-checkpoint-v1', 'collect', 'window_extension_required', ['upper_bound']],
  ['codex', '0.165.0', 'codex-file-checkpoint-v1', 'collect', 'window_extension_required', ['out_of_window']],
  ['codex', '0.163.0', 'codex-file-legacy-v1', 'collect', 'window_rule_required', ['no_window']]
] as const)('describes %s %s %s %s as %s with first-match precedence', async (product, target, profile, operation, expected, reasons) => {
  // Given
  const input = fixture(target, product);

  // When
  const result = await reviewed(input);

  // Then
  const selected = result.lanes.find(row => row.profile_id === profile && row.operation === operation);
  expect(selected?.selection_policy.next_step).toBe(expected);
  expect(selected?.reasons).toEqual(expect.arrayContaining([...reasons]));
  expect(selected?.gates.admission).toBe('not_assessed');
});

test.each([
  ['0.158.0', '0.158.0', 'none', 'none'],
  ['0.163.0', '0.163.0', 'minor', 'none'],
  ['0.163.0', '0.162.1', 'minor', 'minor'],
  ['1.0.0', '0.163.0', 'major', 'major']
] as const)('separates parser and baseline transitions for target %s and baseline %s', async (target, from, parserTransition, baselineTransition) => {
  // Given
  const input = fixture(target, 'codex', from === target ? [target] : [from, target]);
  const baseline: Baseline = {
    schema_version: 1,
    kind: 'baseline',
    rows: [
      {
        ...key,
        last_reviewed_version: from,
        contract_revision: 'consumed-v1',
        evidence_ids: ['a'.repeat(64)],
        source_digest: 'b'.repeat(64)
      }
    ]
  };

  // When
  const result = await reviewed(input, baseline);

  // Then
  expect(result.lanes.find(row => row.profile_id === key.profile_id && row.operation === key.operation)?.selection_policy).toMatchObject({
    parser_base_transition: parserTransition,
    baseline_transition: baselineTransition
  });
});

test('missing parser and baseline produce null transitions without inventing versions', async () => {
  // Given
  useRegistry(syntheticRegistry());

  // When
  const result = await reviewed();

  // Then
  expect(
    result.lanes.every(
      row =>
        row.selection_policy.parser_base_transition === null &&
        row.selection_policy.baseline_transition === null &&
        row.selection_policy.next_step === 'window_rule_required'
    )
  ).toBe(true);
});

test('an unresolved target equal to a window base stays older-version unsupported', async () => {
  // Given
  useRegistry(syntheticRegistry('0.163.0'));

  // When
  const result = await reviewed();

  // Then
  expect(result.lanes.every(row => row.selection_policy.next_step === 'older_version_unsupported')).toBe(true);
});

test('an unmatched selection state fails through the existing invalid-record path', async () => {
  // Given
  useRegistry(syntheticRegistry('0.158.0'));

  // When / Then
  await expect(reviewed()).rejects.toMatchObject({ code: 'invalid_record' });
});

test('schema 8 strictly rejects missing fields and unknown policy fields or values', async () => {
  // Given
  const result = await reviewed();
  const first = result.lanes[0];
  if (!first) throw new Error('fixture_lane_required');
  const policy = first.selection_policy;
  const { next_step, ...withoutNext } = policy;
  const { parser_base_transition, ...withoutParser } = policy;
  const { baseline_transition, ...withoutBaseline } = policy;
  const { selection_policy, ...withoutPolicy } = first;
  expect([next_step, parser_base_transition, baseline_transition, selection_policy]).toHaveLength(4);
  const invalidPolicies = [
    { ...policy, note: 'text' },
    { ...policy, next_step: 'supported' },
    { ...policy, next_step: null },
    { ...policy, parser_base_transition: 'patch' },
    { ...policy, baseline_transition: 'patch' },
    { ...policy, parser_base_transition: 0 },
    { ...policy, baseline_transition: false },
    withoutNext,
    withoutParser,
    withoutBaseline
  ];

  // When
  const parsed = [
    assessmentSchema.safeParse({ ...result, lanes: [withoutPolicy] }),
    assessmentSchema.safeParse({
      ...result,
      lanes: [{ ...first, extra: 'text' }]
    }),
    ...invalidPolicies.map(selection_policy =>
      assessmentSchema.safeParse({
        ...result,
        lanes: [{ ...first, selection_policy }]
      })
    ),
    assessmentSchema.safeParse({ ...result, schema_version: 3 }),
    assessmentSchema.safeParse({
      ...result,
      unused_review_ids: ['f'.repeat(64)]
    }),
    assessmentSchema.safeParse({
      ...result,
      review_ids: [...result.review_ids, ...result.review_ids]
    })
  ];

  // Then
  expect(parsed.every(value => !value.success)).toBe(true);
});

test('all transition codes including null remain valid strict policy values', async () => {
  // Given
  const result = await reviewed();
  const first = result.lanes[0];
  if (!first) throw new Error('fixture_lane_required');
  const values: readonly SelectionPolicy['parser_base_transition'][] = ['none', 'minor', 'major', null];

  // When
  const parsed = values.flatMap(parser_base_transition =>
    values.map(baseline_transition =>
      assessmentSchema.safeParse({
        ...result,
        lanes: [
          {
            ...first,
            selection_policy: {
              ...first.selection_policy,
              parser_base_transition,
              baseline_transition
            }
          }
        ]
      })
    )
  );

  // Then
  expect(parsed.every(value => value.success)).toBe(true);
});

test('39-lane assessments fit the unchanged byte limit and oversized records are rejected', async () => {
  // Given
  const result = await reviewed();
  const release = fixture().observation.releases[0];
  if (!release) throw new Error('fixture_release_required');
  const oversized = {
    ...result,
    lanes: result.lanes.map(row => ({
      ...row,
      review: {
        ...row.review,
        releases: Array.from({ length: 256 }, () => release)
      }
    }))
  };

  // When
  const parsed = assessmentSchema.safeParse(oversized);

  // Then
  expect(result.lanes).toHaveLength(39);
  expect(Buffer.byteLength(canonical(result))).toBeLessThanOrEqual(maxRecordBytes);
  expect(Buffer.byteLength(canonical(oversized))).toBeGreaterThan(maxRecordBytes);
  expect(parsed.success).toBe(false);
  expect(() => boundedParse(oversized, assessmentSchema)).toThrow('record_too_large');
});

test.each(['codex', 'claude_code'] as const)('assessment preserves the exact admitted root facet for %s', async product => {
  const input = promotionFixture(product);
  appendPromotionDecision(input);
  const projection = projectToolVersionPromotions(input);
  const descriptor = input.descriptors[0];
  if (!descriptor) throw new Error('fixture_descriptor_required');
  const source: SourceRegistry = {
    ...syntheticRegistry(),
    promotionFacets: projection.facets,
    resolve: (requestedProduct, target, route, profileId, operation, topology) => {
      const matched = projection.facets.some(
        ({ decision }) =>
          decision.scope.lane.operation === operation &&
          decision.scope.lane.topology === topology &&
          decision.scope.target.version === target &&
          decision.scope.lane.product === requestedProduct &&
          decision.scope.lane.route === route &&
          decision.scope.lane.profile_id === profileId
      );
      return matched
        ? {
            state: 'compatibility_unverified',
            product,
            product_version: target,
            source: descriptor.route,
            parser_version: descriptor.version,
            parser_revision: descriptor.profileId,
            profile_id: descriptor.profileId,
            rule_revision: 'forward-version-v1'
          }
        : null;
    }
  };
  useRegistry(source);
  const result = await assessCandidate(fixture(descriptor.version, product));
  const selected = result.lanes.filter(row => row.profile_id === descriptor.profileId);
  expect(selected.map(row => [row.operation, row.topology, row.static_selection])).toEqual([['collect', 'root', 'exact']]);
  expect(selected[0]?.declared_scope).toEqual({
    max_depth: 0,
    max_members: 1,
    read_only: false,
    exact_only: true
  });
  expect(result.lanes.filter(row => row.profile_id !== descriptor.profileId).map(row => row.profile_id)).toEqual(
    ['codex-file-checkpoint-v1', 'codex-file-checkpoint-v1'].filter(() => product === 'codex')
  );
});
test.each([
  {
    grants: ['qualification'] as const,
    topology: 'root' as const,
    expected: []
  },
  {
    grants: ['admission'] as const,
    topology: 'bounded_family' as const,
    expected: []
  },
  {
    grants: ['admission', 'children'] as const,
    topology: 'bounded_family' as const,
    expected: [['collect', 'bounded_family', 1, 3]]
  }
])('assessment requires admission and independent child authority: $grants $topology', async ({ grants, topology, expected }) => {
  const input = promotionFixture();
  const descriptor = input.descriptors[0];
  if (!descriptor) throw new Error('fixture_descriptor_required');
  const record = appendPromotionDecision(input, {
    scope: {
      target: {
        version: descriptor.version,
        commit: descriptor.sourceRef
      },
      lane: {
        product: 'codex',
        route: 'codex_binding',
        profile_id: descriptor.profileId,
        operation: 'collect',
        topology
      },
      platform: 'darwin_arm64',
      runtime: 'node26'
    },
    requested_grants: topology === 'root' ? ['admission', 'qualification'] : ['admission', 'children', 'qualification'],
    grants
  });
  const source: SourceRegistry = {
    ...syntheticRegistry(),
    promotionFacets: [{ descriptor, decision: record.decision }],
    resolve: (_product, target, route, profileId, operation, requestedTopology) =>
      route === descriptor.route && profileId === descriptor.profileId && operation === 'collect' && requestedTopology === topology
        ? {
            state: 'compatibility_unverified',
            product: 'codex',
            product_version: target,
            source: 'codex_binding',
            parser_version: descriptor.version,
            parser_revision: descriptor.profileId,
            profile_id: descriptor.profileId,
            rule_revision: 'forward-version-v1'
          }
        : null
  };
  useRegistry(source);
  const result = await assessCandidate(fixture(descriptor.version));
  expect(
    result.lanes
      .filter(row => row.profile_id === descriptor.profileId)
      .map(row => [row.operation, row.topology, row.declared_scope.max_depth, row.declared_scope.max_members])
  ).toEqual(expected);
});

test('an explicitly admitted resume facet is selectable and valid in a new baseline without changing historical resume lanes', async () => {
  const input = promotionFixture();
  const current = input.descriptors[0];
  if (!current) throw new Error('fixture_descriptor_required');
  const descriptor = parseToolVersionPromotionDescriptor({
    ...current,
    scopes: [
      ...current.scopes,
      {
        operation: 'resume',
        topology: 'root',
        maxDepth: 0,
        maxFamilyMembers: 1,
        grants: ['admission']
      }
    ]
  });
  input.descriptors = [descriptor];
  const record = appendPromotionDecision(input, {
    requested_grants: ['admission'],
    grants: ['admission'],
    scope: {
      target: {
        version: descriptor.version,
        commit: descriptor.sourceRef
      },
      lane: {
        product: 'codex',
        route: 'codex_binding',
        profile_id: descriptor.profileId,
        operation: 'resume',
        topology: 'root'
      },
      platform: 'darwin_arm64',
      runtime: 'node26'
    }
  });
  const source: SourceRegistry = {
    ...syntheticRegistry(),
    promotionFacets: projectToolVersionPromotions(input).facets,
    resolve: (_product, target, route, profileId, operation, topology) =>
      route === descriptor.route && profileId === descriptor.profileId && operation === 'resume' && topology === 'root'
        ? {
            state: 'compatibility_unverified',
            product: 'codex',
            product_version: target,
            source: descriptor.route,
            parser_version: descriptor.version,
            parser_revision: descriptor.profileId,
            profile_id: descriptor.profileId,
            rule_revision: 'forward-version-v1'
          }
        : null
  };
  useRegistry(source);
  const result = await assessCandidate(fixture(descriptor.version));
  expect(result.lanes.filter(row => row.profile_id === descriptor.profileId).map(row => [row.operation, row.static_selection])).toEqual([['resume', 'exact']]);
  const baseline: Baseline = {
    schema_version: 1,
    kind: 'baseline',
    rows: [
      {
        ...record.decision.scope.lane,
        last_reviewed_version: descriptor.version,
        contract_revision: 'consumed-v1',
        evidence_ids: [record.id],
        source_digest: 'b'.repeat(64)
      }
    ]
  };
  useRegistry(source);
  await expect(validateBaselineForSource(baseline, root)).resolves.toBeUndefined();
});
