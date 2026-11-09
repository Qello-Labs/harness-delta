import { expect, test } from 'vitest';
import { assessmentSchema, consumedContracts } from '../scripts/tool-update/assessment.mjs';
import { boundedParse, canonical, maxRecordBytes } from '../scripts/tool-update/manifest.mjs';
import {
  assessmentSourcePathLimit,
  expandedSourcePathAllowlist,
  legacySourcePathAllowlist,
  policyAssessmentSourcePathLimit,
  policySourcePathAllowlist,
  producerAssessmentSourcePathLimit,
  producerSourcePathAllowlist,
  projectionAssessmentSourcePathLimit,
  projectionSourcePathAllowlist,
  sourcePathAllowlist
} from '../scripts/tool-update/source-snapshot.mjs';

const versions = [1, 2, 3, 4, 5, 6, 7] as const;
test.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true]
])('schema10 captures denial infrastructure without widening schema9 manual=%s machine=%s', (reviewed, machine) => {
  const input = {
    ...currentRecord(reviewed, machine),
    schema_version: 10,
    rule_revision: 'static-assessment-v6',
    source_paths: ['src/core/tool-version-promotion-store.ts', 'src/deletion.ts', 'src/migrations/038_tool_version_promotion_denials.sql']
  };
  expect(assessmentSchema.parse(input)).toEqual(input);
  expect(
    assessmentSchema.safeParse({
      ...input,
      schema_version: 9,
      rule_revision: 'static-assessment-v5'
    }).success
  ).toBe(false);
  expect(assessmentSourcePathLimit).toBe(87);
  expect(sourcePathAllowlist).toHaveLength(87);
  expect(
    assessmentSchema.safeParse({
      ...input,
      source_paths: Array<string>(88).fill('src/source-compatibility.ts')
    }).success
  ).toBe(false);
});
const policy = {
  parser_base_transition: 'none',
  baseline_transition: null,
  next_step: 'selected_exact'
} as const;
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
  declared_scope: {
    max_depth: 0,
    max_members: 1,
    read_only: false,
    exact_only: false
  },
  reasons: ['baseline_missing', 'contracts_unknown'],
  review: {
    coverage: 'baseline_missing',
    baseline_version: null,
    releases: [],
    edges: [],
    parser_comparison: null,
    contracts: consumedContracts.map(contract_id => ({
      contract_id,
      judgment: 'unknown' as const
    }))
  },
  live: {
    invalidation: 'not_assessed',
    binary: 'not_assessed',
    permissions: 'not_assessed',
    config: 'not_assessed',
    authentication: 'not_assessed'
  },
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
    source_paths: schemaVersion <= 4 ? legacySourcePathAllowlist : expandedSourcePathAllowlist,
    rule_revision: schemaVersion <= 4 ? 'static-assessment-v1' : 'static-assessment-v2',
    review_sources: [
      {
        version: '0.158.0',
        commit: 'd'.repeat(40),
        path: 'codex-rs/protocol/src/protocol.rs',
        availability: 'not_assessed'
      }
    ],
    lanes: [lane]
  };
  const reviewed = {
    inventory_scope: 'legacy_full_inventory',
    review_ids: ['a'.repeat(64), 'b'.repeat(64)],
    unused_review_ids: ['a'.repeat(64)]
  };
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
      return {
        ...fields,
        ...reviewed,
        lanes: [{ ...lane, selection_policy: policy }]
      };
    case 7:
      return {
        ...fields,
        ...reviewed,
        judgment_ids: automated.judgment_ids,
        unused_judgment_ids: [],
        lanes: [{ ...lane, automated }]
      };
  }
}

test.each(versions)('schema %i reads its finite closure and preserves portable fields', schemaVersion => {
  const input = record(schemaVersion);

  const parsed = assessmentSchema.parse(input);

  expect(parsed).toEqual(input);
  expect(parsed.source_paths).toHaveLength(schemaVersion <= 4 ? 31 : 48);
});

test.each([5, 6] as const)('schema %i reads both named expanded revisions without rewriting v2 records', schemaVersion => {
  const input = record(schemaVersion);

  for (const rule_revision of ['static-assessment-v2', 'static-assessment-v3']) {
    expect(assessmentSchema.parse({ ...input, rule_revision })).toEqual({ ...input, rule_revision });
  }
  for (const path of policySourcePathAllowlist.filter(path => !expandedSourcePathAllowlist.includes(path))) {
    expect(assessmentSchema.safeParse({ ...input, source_paths: [path] }).success).toBe(false);
    expect(
      assessmentSchema.parse({
        ...input,
        rule_revision: 'static-assessment-v3',
        source_paths: [path]
      }).source_paths
    ).toEqual([path]);
  }
});

test.each(versions)('schema %i rejects wrong top-level and lane revisions', schemaVersion => {
  const input = record(schemaVersion);
  const revisions =
    schemaVersion <= 4 ? ['static-assessment-v2', 'static-assessment-v3', 'unknown'] : ['static-assessment-v1', 'static-assessment-v4', 'unknown'];

  for (const rule_revision of revisions) {
    expect(assessmentSchema.safeParse({ ...input, rule_revision }).success).toBe(false);
  }
  expect(
    assessmentSchema.safeParse({
      ...input,
      lanes: input.lanes.map(row => ({
        ...row,
        rule_revision: 'forward-version-v2'
      }))
    }).success
  ).toBe(false);
});

test.each([1, 2, 3, 4] as const)('legacy schema %i refuses expanded writer control and migration paths', schemaVersion => {
  const input = record(schemaVersion);
  const expanded = sourcePathAllowlist.filter(path => !legacySourcePathAllowlist.includes(path));

  for (const path of expanded) {
    expect(assessmentSchema.safeParse({ ...input, source_paths: [path] }).success).toBe(false);
  }
  for (const path of ['src/store.ts', 'src/core/ordinary-window-activation.ts', 'src/migrations/037_ordinary_window_decisions.sql']) {
    expect(assessmentSchema.safeParse({ ...input, source_paths: [path] }).success).toBe(false);
  }
  expect(
    assessmentSchema.safeParse({
      ...input,
      source_paths: sourcePathAllowlist
    }).success
  ).toBe(false);
});

test.each(versions)('schema %i rejects unknown paths duplicates and over-bound lists', schemaVersion => {
  const input = record(schemaVersion);
  const path = 'src/source-compatibility.ts';
  const limit = schemaVersion <= 4 ? 32 : 48;

  for (const source_paths of [[], ['../SECRET'], ['src/unlisted-control.ts'], [path, path]]) {
    expect(assessmentSchema.safeParse({ ...input, source_paths }).success).toBe(false);
  }
  const overflow = assessmentSchema.safeParse({
    ...input,
    source_paths: Array<string>(limit + 1).fill(path)
  });
  if (overflow.success) throw new Error('source_path_limit_required');
  expect(overflow.error.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: 'too_big',
        maximum: limit,
        path: ['source_paths']
      })
    ])
  );
  expect(
    assessmentSchema.safeParse({
      ...input,
      lanes: [...input.lanes, ...input.lanes]
    }).success
  ).toBe(false);
});

test.each(versions)('schema %i never accepts forged live or admission gates', schemaVersion => {
  const input = record(schemaVersion);
  const selected = input.lanes[0];
  if (!selected) throw new Error('fixture_lane_required');

  for (const key of Object.keys(selected.live)) {
    expect(
      assessmentSchema.safeParse({
        ...input,
        lanes: [
          {
            ...selected,
            live: { ...selected.live, [key]: 'pass' }
          }
        ]
      }).success
    ).toBe(false);
  }
  for (const key of ['conformance', 'regression', 'implementation_review', 'admission', 'default_promotion']) {
    expect(
      assessmentSchema.safeParse({
        ...input,
        lanes: [
          {
            ...selected,
            gates: { ...selected.gates, [key]: 'closed' }
          }
        ]
      }).success
    ).toBe(false);
  }
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
    {
      lanes: [
        {
          ...selected,
          gates: {
            ...selected.gates,
            contracts_reviewed: 'closed'
          }
        }
      ]
    }
  ]) {
    expect(assessmentSchema.safeParse({ ...input, ...changes }).success).toBe(false);
  }
});

test.each([4, 6] as const)('policy schema %i retains strict required selection fields', schemaVersion => {
  const input = record(schemaVersion);
  const incomplete = {
    parser_base_transition: policy.parser_base_transition,
    baseline_transition: policy.baseline_transition
  };

  for (const selection_policy of [
    incomplete,
    {
      ...policy,
      next_step: 'supported'
    },
    { ...policy, extra: true }
  ]) {
    expect(
      assessmentSchema.safeParse({
        ...input,
        lanes: [{ ...lane, selection_policy }]
      }).success
    ).toBe(false);
  }
  expect(assessmentSchema.safeParse({ ...input, lanes: [lane] }).success).toBe(false);
});

test.each([1, 2, 3, 5] as const)('non-policy schema %i refuses selection policy fields', schemaVersion => {
  const input = record(schemaVersion);

  expect(
    assessmentSchema.safeParse({
      ...input,
      lanes: [{ ...lane, selection_policy: policy }]
    }).success
  ).toBe(false);
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
      review: {
        ...selected.review,
        releases: Array.from({ length: 256 }, () => release)
      }
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

test.each([0, 7, 9])('rejects unsupported or incomplete assessment schema %i', schema_version => {
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
  const legacy = {
    ...input,
    lanes: input.lanes.map(row => ({ ...row, compatibility }))
  };
  expect(assessmentSchema.parse(legacy)).toEqual(legacy);
  for (const id of ['codex-binding-root-window-v1', 'claude-binding-root-window-v1']) {
    for (const key of ['profile_id', 'parser_revision']) {
      expect(
        assessmentSchema.safeParse({
          ...legacy,
          lanes: legacy.lanes.map(row => ({
            ...row,
            compatibility: { ...compatibility, [key]: id }
          }))
        }).success
      ).toBe(false);
    }
  }
});

const automated = {
  judgment_ids: ['e'.repeat(64)],
  contracts: consumedContracts.map(contract_id => ({
    contract_id,
    judgment: 'unknown'
  })),
  comparisons: [],
  freshness_reasons: [],
  pending_reasons: ['baseline_missing'],
  required_validation: ['backend_counter_meaning', 'native_execution', 'real_session'],
  validation: 'pending',
  conflicts: []
};
test.each([3, 4, 6, 7] as const)('frozen schema %i retains closed manual gates and rejects mismatched contracts', schemaVersion => {
  const input = record(schemaVersion);
  const selected = input.lanes[0];
  if (!selected) throw new Error('fixture_lane_required');
  const closed = {
    ...input,
    lanes: [
      {
        ...selected,
        reasons: [],
        review: {
          ...selected.review,
          contracts: consumedContracts.map(contract_id => ({
            contract_id,
            judgment: 'unaffected'
          }))
        },
        gates: { ...selected.gates, contracts_reviewed: 'closed' }
      }
    ]
  };
  expect(assessmentSchema.parse(closed)).toEqual(closed);
  expect(
    assessmentSchema.safeParse({
      ...closed,
      lanes: closed.lanes.map(row => ({
        ...row,
        review: { ...row.review, contracts: lane.review.contracts }
      }))
    }).success
  ).toBe(false);
});
test('frozen schema7 retains automated identity, sorting, pending and conflict boundaries', () => {
  const input = record(7);
  expect(assessmentSchema.parse(input)).toEqual(input);
  for (const changes of [
    { judgment_ids: ['f'.repeat(64)] },
    { judgment_ids: ['f'.repeat(64), 'e'.repeat(64)] },
    { unused_judgment_ids: ['f'.repeat(64)] },
    {
      lanes: [
        {
          ...lane,
          automated: { ...automated, validation: 'pass' }
        }
      ]
    },
    {
      lanes: [
        {
          ...lane,
          automated: {
            ...automated,
            required_validation: ['native_execution']
          }
        }
      ]
    },
    {
      lanes: [
        {
          ...lane,
          automated: {
            ...automated,
            comparisons: [
              {
                comparison_kind: 'parser_base',
                from: {
                  version: '0.158.0',
                  commit: 'a'.repeat(40)
                },
                to: {
                  version: '0.163.0',
                  commit: 'b'.repeat(40)
                },
                judgment_id: 'f'.repeat(64),
                result_scope: 'job_aggregate',
                contracts: automated.contracts
              }
            ]
          }
        }
      ]
    }
  ]) {
    expect(assessmentSchema.safeParse({ ...input, ...changes }).success).toBe(false);
  }
});
function currentRecord(reviewed = false, machine = false) {
  return {
    ...record(5),
    schema_version: 8,
    rule_revision: 'static-assessment-v4',
    source_paths: projectionSourcePathAllowlist,
    ...(reviewed || machine
      ? {
          review_ids: reviewed ? ['a'.repeat(64)] : [],
          unused_review_ids: []
        }
      : {}),
    ...(machine ? { judgment_ids: automated.judgment_ids, unused_judgment_ids: [] } : {}),
    lanes: [
      {
        ...lane,
        ...(reviewed ? { selection_policy: policy } : {}),
        ...(machine ? { automated } : {})
      }
    ]
  };
}

test.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true]
])('schema9 preserves manual=%s machine=%s channels with promoted raw inputs', (reviewed, machine) => {
  const input = {
    ...currentRecord(reviewed, machine),
    schema_version: 9,
    rule_revision: 'static-assessment-v5',
    source_paths: ['scripts/session-binding-codex-promoted-hook.template.mjs']
  };
  expect(assessmentSchema.parse(input)).toEqual(input);
  expect(producerAssessmentSourcePathLimit).toBe(82);
  expect(producerSourcePathAllowlist).toHaveLength(82);
  expect(
    assessmentSchema.parse({
      ...input,
      source_paths: producerSourcePathAllowlist
    }).source_paths
  ).toEqual(producerSourcePathAllowlist);
  const overflow = assessmentSchema.safeParse({
    ...input,
    source_paths: Array<string>(83).fill('src/source-compatibility.ts')
  });
  if (overflow.success) throw new Error('current_path_limit_required');
  expect(overflow.error.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: 'too_big',
        maximum: 82,
        path: ['source_paths']
      })
    ])
  );
  expect(
    assessmentSchema.safeParse({
      ...input,
      schema_version: 8,
      rule_revision: 'static-assessment-v4'
    }).success
  ).toBe(false);
  expect(
    assessmentSchema.safeParse({
      ...input,
      rule_revision: 'static-assessment-v4'
    }).success
  ).toBe(false);
});

test.each([5, 6, 7])('frozen schema %i retains the v3 closure and excludes promotion inputs', schema_version => {
  const input = {
    ...record(schema_version === 6 ? 6 : 5),
    schema_version,
    rule_revision: 'static-assessment-v3',
    source_paths: policySourcePathAllowlist,
    ...(schema_version === 7
      ? {
          review_ids: [],
          unused_review_ids: [],
          judgment_ids: automated.judgment_ids,
          unused_judgment_ids: [],
          lanes: [{ ...lane, automated }]
        }
      : {})
  };
  expect(policySourcePathAllowlist).toHaveLength(52);
  expect(policyAssessmentSourcePathLimit).toBe(52);
  expect(assessmentSchema.parse(input)).toEqual(input);
  for (const path of ['src/core/tool-version-promotion.ts', 'src/core/tool-version-promotions.json', 'src/core/tool-version-promotion-result.json']) {
    expect(assessmentSchema.safeParse({ ...input, source_paths: [path] }).success).toBe(false);
    expect(
      assessmentSchema.safeParse({
        ...input,
        rule_revision: 'static-assessment-v4',
        source_paths: [path]
      }).success
    ).toBe(false);
  }
  const overflow = assessmentSchema.safeParse({
    ...input,
    source_paths: Array<string>(53).fill('src/source-compatibility.ts')
  });
  if (overflow.success) throw new Error('frozen_path_limit_required');
  expect(overflow.error.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: 'too_big',
        maximum: 52,
        path: ['source_paths']
      })
    ])
  );
});

test.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true]
])('schema8 preserves manual=%s machine=%s channels without authorizing gates', (reviewed, machine) => {
  const input = currentRecord(reviewed, machine);
  expect(projectionAssessmentSourcePathLimit).toBe(55);
  expect(projectionSourcePathAllowlist).toEqual(
    [
      ...policySourcePathAllowlist,
      'src/core/tool-version-promotion.ts',
      'src/core/tool-version-promotions.json',
      'src/core/tool-version-promotion-result.json'
    ].sort()
  );
  expect(assessmentSchema.parse(input)).toEqual(input);
  const overflow = assessmentSchema.safeParse({
    ...input,
    source_paths: Array<string>(56).fill('src/source-compatibility.ts')
  });
  if (overflow.success) throw new Error('current_path_limit_required');
  expect(overflow.error.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: 'too_big',
        maximum: 55,
        path: ['source_paths']
      })
    ])
  );
  const selected = input.lanes[0];
  if (!selected) throw new Error('fixture_lane_required');
  expect(
    assessmentSchema.safeParse({
      ...input,
      lanes: [
        {
          ...selected,
          gates: { ...selected.gates, admission: 'closed' }
        }
      ]
    }).success
  ).toBe(false);
  expect(
    assessmentSchema.safeParse({
      ...input,
      rule_revision: 'static-assessment-v3'
    }).success
  ).toBe(false);
  expect(
    assessmentSchema.safeParse({
      ...input,
      source_paths: [...projectionSourcePathAllowlist, 'src/unlisted-control.ts']
    }).success
  ).toBe(false);
  expect(
    assessmentSchema.safeParse({
      ...input,
      review_ids: ['b'.repeat(64), 'a'.repeat(64)]
    }).success
  ).toBe(false);
  expect(
    assessmentSchema.safeParse({
      ...input,
      unused_review_ids: ['f'.repeat(64)]
    }).success
  ).toBe(false);
  if (machine) {
    expect(
      assessmentSchema.safeParse({
        ...input,
        unused_judgment_ids: ['f'.repeat(64)]
      }).success
    ).toBe(false);
    expect(
      assessmentSchema.safeParse({
        ...input,
        judgment_ids: ['f'.repeat(64)]
      }).success
    ).toBe(false);
    expect(
      assessmentSchema.safeParse({
        ...input,
        lanes: [
          {
            ...selected,
            automated: { ...automated, validation: 'pass' }
          }
        ]
      }).success
    ).toBe(false);
  } else {
    expect(
      assessmentSchema.safeParse({
        ...input,
        lanes: [{ ...selected, automated }]
      }).success
    ).toBe(false);
  }
});
