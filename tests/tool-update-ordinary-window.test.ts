import { expect, test } from 'vitest';
import { assessCandidate, assessmentSchema } from '../scripts/tool-update/assessment.mjs';
import { laneKey, sourceLanes } from '../scripts/tool-update/lanes.mjs';
import { withSourceSnapshot } from '../scripts/tool-update/source-snapshot.mjs';
import { assessmentRoot, ordinaryAssessmentFixture } from './helpers/tool-update-ordinary-window-fixture.js';

const policies = [
  ['codex', 'codex_binding', 'codex-binding-root-window-v1', 'codex-ordinary-root-window-v1', '0.163.0', '0.170.0', '0.166.0'],
  ['claude_code', 'claude_binding', 'claude-binding-root-window-v1', 'claude-ordinary-root-window-v1', '2.1.306', '2.2.0', '2.1.307']
] as const;

test('snapshot exposes only the two finite root-policy operation sets and refuses unstable or foreign selections', async () => {
  const snapshot = await withSourceSnapshot(assessmentRoot, source => ({
    profiles: source.ordinaryWindows.map(row => row.policyId),
    lanes: sourceLanes(source).filter(row => row.profile_id.endsWith('-root-window-v1')),
    refused: policies.flatMap(([product, , profile, , , , target]) =>
      [`${target}-rc.1`, `${target}+build`, 'latest', '01.2.3']
        .map(version => source.resolveOrdinaryWindow(product, version, profile))
        .concat([source.resolveOrdinaryWindow(product, target, product === 'codex' ? 'claude-binding-root-window-v1' : 'codex-binding-root-window-v1')])
    )
  }));

  expect(snapshot.value.profiles).toEqual(['codex-binding-root-window-v1', 'claude-binding-root-window-v1']);
  expect(snapshot.value.lanes).toEqual(
    policies
      .flatMap(([product, route, profile_id]) =>
        (['link', 'collect', 'restart'] as const).map(operation => ({
          product,
          route,
          profile_id,
          operation,
          topology: 'root' as const
        }))
      )
      .sort((a, b) => laneKey(a).localeCompare(laneKey(b), 'en'))
  );
  expect(snapshot.value.refused).toEqual(Array(10).fill(null));
  expect(snapshot.source_paths).toHaveLength(44);
});

test.each([
  ['codex', '0.166.0', 'selected_window', 'exact_qualification_required', 'minor'],
  ['codex', '0.163.1', 'selected_window', 'exact_qualification_required', 'none'],
  ['codex', '0.169.999', 'selected_window', 'exact_qualification_required', 'minor'],
  ['codex', '0.163.0', 'older_version_unsupported', 'out_of_window', 'none'],
  ['codex', '0.162.9', 'older_version_unsupported', 'out_of_window', 'minor'],
  ['codex', '0.170.0', 'window_extension_required', 'upper_bound', 'minor'],
  ['codex', '0.171.0', 'window_extension_required', 'out_of_window', 'minor'],
  ['codex', '1.0.0', 'window_extension_required', 'out_of_window', 'major'],
  ['claude_code', '2.1.307', 'selected_window', 'exact_qualification_required', 'none'],
  ['claude_code', '2.1.999', 'selected_window', 'exact_qualification_required', 'none'],
  ['claude_code', '2.1.306', 'older_version_unsupported', 'out_of_window', 'none'],
  ['claude_code', '2.1.305', 'older_version_unsupported', 'out_of_window', 'none'],
  ['claude_code', '2.0.999', 'older_version_unsupported', 'out_of_window', 'minor'],
  ['claude_code', '2.2.0', 'window_extension_required', 'upper_bound', 'minor'],
  ['claude_code', '2.3.0', 'window_extension_required', 'out_of_window', 'minor'],
  ['claude_code', '3.0.0', 'window_extension_required', 'out_of_window', 'major']
] as const)('describes %s %s root selection as %s without live authority', async (product, target, nextStep, reason, transition) => {
  const policy = policies.find(row => row[0] === product);
  if (!policy) throw new Error('fixture_policy_required');
  const [, route, profile, revision, base, upper] = policy;

  const result = await assessCandidate(ordinaryAssessmentFixture(product, target, true));

  expect(result.schema_version).toBe(6);
  if (result.schema_version !== 6) throw new Error('schema_6_required');
  const lanes = result.lanes.filter(row => row.profile_id === profile);
  expect(lanes.map(row => row.operation)).toEqual(['collect', 'link', 'restart']);
  for (const row of lanes) {
    expect(row).toMatchObject({
      product,
      route,
      topology: 'root',
      rule_revision: revision,
      parser_base: base,
      static_selection: nextStep === 'selected_window' ? 'inherited' : 'unsupported',
      window: { base, upper_exclusive: upper },
      declared_scope: {
        max_depth: 0,
        max_members: 1,
        read_only: true,
        exact_only: false
      },
      selection_policy: {
        next_step: nextStep,
        parser_base_transition: transition,
        baseline_transition: null
      }
    });
    expect(row.reasons).toEqual(['baseline_missing', 'contracts_unknown', reason, ...(transition === 'none' ? [] : [`${transition}_transition`])].sort());
    expect(row.compatibility).toEqual(
      nextStep === 'selected_window'
        ? {
            state: 'compatibility_unverified',
            product,
            product_version: target,
            source: route,
            parser_version: base,
            parser_revision: profile,
            profile_id: profile,
            rule_revision: revision
          }
        : null
    );
  }
  for (const row of result.lanes) {
    expect(row.live).toEqual({
      invalidation: 'not_assessed',
      binary: 'not_assessed',
      permissions: 'not_assessed',
      config: 'not_assessed',
      authentication: 'not_assessed'
    });
    expect(row.gates).toEqual({
      contracts_reviewed: 'unknown',
      conformance: 'not_assessed',
      regression: 'not_assessed',
      implementation_review: 'not_assessed',
      admission: 'not_assessed',
      default_promotion: 'not_assessed'
    });
  }
});

test.each(policies.flatMap(policy => [false, true].map(reviewed => ({ policy, reviewed }))))(
  'v3 writer and strict root-policy reader preserve $policy.0 reviewed=$reviewed',
  async ({ policy, reviewed }) => {
    const [product, , profile, revision, , , target] = policy;
    const result = await assessCandidate(ordinaryAssessmentFixture(product, target, reviewed));
    const row = result.lanes.find(lane => lane.profile_id === profile && lane.operation === 'collect');
    if (!row?.compatibility) {
      throw new Error('fixture_inherited_lane_required');
    }
    const foreignRevision = product === 'codex' ? 'claude-ordinary-root-window-v1' : 'codex-ordinary-root-window-v1';
    const foreignProfile = product === 'codex' ? 'claude-binding-root-window-v1' : 'codex-binding-root-window-v1';
    const parse = (changes: object) =>
      assessmentSchema.safeParse({
        ...result,
        lanes: [{ ...row, ...changes }]
      });

    expect(result.schema_version).toBe(reviewed ? 6 : 5);
    expect(result.rule_revision).toBe('static-assessment-v3');
    expect(assessmentSchema.parse(result)).toEqual(result);
    expect(row.rule_revision).toBe(revision);
    for (const rule_revision of ['static-assessment-v1', 'static-assessment-v2', 'static-assessment-v4']) {
      expect(assessmentSchema.safeParse({ ...result, rule_revision }).success).toBe(false);
    }
    for (const changes of [
      { product: product === 'codex' ? 'claude_code' : 'codex' },
      { route: 'file' },
      { profile_id: foreignProfile },
      { profile_id: 'codex-file-checkpoint-v1' },
      { operation: 'resume' },
      { operation: 'launch' },
      { topology: 'bounded_family' },
      { topology: 'root_direct_child' },
      ...['forward-version-v1', foreignRevision, 'unknown'].map(rule_revision => ({ rule_revision })),
      ...['forward-version-v1', foreignRevision, 'unknown'].map(rule_revision => ({
        compatibility: { ...row.compatibility, rule_revision }
      })),
      ...['forward-version-v1', foreignRevision].map(rule_revision => ({
        rule_revision,
        compatibility: { ...row.compatibility, rule_revision }
      })),
      {
        compatibility: {
          ...row.compatibility,
          product: product === 'codex' ? 'claude_code' : 'codex'
        }
      },
      { compatibility: { ...row.compatibility, source: 'file' } },
      {
        compatibility: {
          ...row.compatibility,
          profile_id: foreignProfile
        }
      },
      {
        compatibility: {
          ...row.compatibility,
          parser_revision: foreignProfile
        }
      },
      ...[{ max_depth: 1 }, { max_depth: null }, { max_members: 2 }, { max_members: null }, { read_only: false }, { exact_only: true }].map(scope => ({
        declared_scope: { ...row.declared_scope, ...scope }
      })),
      ...Object.keys(row.live).map(key => ({
        live: { ...row.live, [key]: 'pass' }
      })),
      ...['conformance', 'regression', 'implementation_review', 'admission', 'default_promotion'].map(key => ({
        gates: { ...row.gates, [key]: 'closed' }
      }))
    ])
      expect(parse(changes).success).toBe(false);
  }
);

test('0.166.0 keeps exact assigned-family selection distinct from inherited root policy', async () => {
  const result = await assessCandidate(ordinaryAssessmentFixture('codex', '0.166.0', true));
  if (result.schema_version !== 6) throw new Error('schema_6_required');

  expect(
    result.lanes
      .filter(row => row.operation === 'collect' && row.route === 'codex_binding' && row.static_selection !== 'unsupported')
      .map(row => ({
        profile: row.profile_id,
        topology: row.topology,
        selection: row.static_selection,
        exactOnly: row.declared_scope.exact_only,
        next: row.selection_policy.next_step
      }))
  ).toEqual([
    {
      profile: 'codex-binding-01660-direct-family-v1',
      topology: 'bounded_family',
      selection: 'exact',
      exactOnly: true,
      next: 'selected_exact'
    },
    {
      profile: 'codex-binding-01660-direct-family-v1',
      topology: 'root',
      selection: 'exact',
      exactOnly: true,
      next: 'selected_exact'
    },
    {
      profile: 'codex-binding-root-window-v1',
      topology: 'root',
      selection: 'inherited',
      exactOnly: false,
      next: 'selected_window'
    }
  ]);
});
