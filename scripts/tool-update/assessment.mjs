import { z } from 'zod';
import { boundedParse, canonical, compareVersions, digest, fail, parseBaseline, shaSchema, ToolUpdateError, versionSchema } from './manifest.mjs';
import { candidateSchema, observationSchema } from './discovery.mjs';
import { laneKey, laneSchema, sourceLanes } from './lanes.mjs';
import {
  assessmentRuleRevision,
  assessmentSourcePathLimit,
  denialAssessmentRuleRevision,
  denialAssessmentSourcePathLimit,
  denialSourcePathAllowlist,
  expandedAssessmentRuleRevision,
  expandedAssessmentSourcePathLimit,
  expandedSourcePathAllowlist,
  legacyAssessmentRuleRevision,
  legacySourcePathAllowlist,
  policyAssessmentRuleRevision,
  policyAssessmentSourcePathLimit,
  policySourcePathAllowlist,
  producerAssessmentRuleRevision,
  producerAssessmentSourcePathLimit,
  producerSourcePathAllowlist,
  projectionAssessmentRuleRevision,
  projectionAssessmentSourcePathLimit,
  projectionSourcePathAllowlist,
  sourcePathAllowlist,
  withSourceSnapshot
} from './source-snapshot.mjs';

export const consumedContracts = [
  'identity_source_mapping',
  'fields_types_enums',
  'partial_rotation_checkpoint',
  'counters_cache_reasoning_reset_overflow',
  'hooks_order_receipts_loading',
  'invocation_permissions_config_model_effort',
  'history_topology_resume_compaction',
  'finality_replay_conflict_stop_flush_sigint'
];
const judgments = ['unaffected', 'affected', 'unknown'];
const contractsSchema = reviewed =>
  z
    .array(
      z.strictObject({
        contract_id: z.enum(consumedContracts),
        judgment: reviewed ? z.enum(judgments) : z.literal('unknown')
      })
    )
    .length(consumedContracts.length);
const checks = () =>
  consumedContracts.map(contract_id => ({
    contract_id,
    judgment: 'unknown'
  }));
const commitSchema = z.string().regex(/^[a-f0-9]{40}$/);
const ordered = (from, to) => versionSchema.safeParse(from).success && versionSchema.safeParse(to).success && compareVersions(from, to) < 0;
const reviewRefSchema = z.strictObject({
  version: versionSchema,
  commit: commitSchema
});
export const contractReviewSchema = laneSchema
  .extend({
    schema_version: z.literal(1),
    kind: z.literal('contract_review'),
    contract_revision: z.literal('consumed-v1'),
    from: reviewRefSchema,
    to: reviewRefSchema,
    contracts: contractsSchema(true),
    evidence_ids: z.array(shaSchema).min(1).max(64),
    source_digest: shaSchema
  })
  .refine(
    value =>
      ordered(value.from.version, value.to.version) &&
      value.contracts.every((row, index) => row.contract_id === consumedContracts[index]) &&
      value.evidence_ids.every((id, index) => index === 0 || id > value.evidence_ids[index - 1])
  );
const refSchema = z
  .strictObject({
    version: versionSchema,
    release_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    tag: z
      .string()
      .max(128)
      .regex(/^(?:rust-v|v)?(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})$/),
    commit: commitSchema,
    npm_integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/)
  })
  .refine(value => Buffer.from(value.npm_integrity.slice(7), 'base64').toString('base64') === value.npm_integrity.slice(7));
const edgeSchema = reviewed =>
  z.strictObject({
    from: refSchema,
    to: refSchema,
    contracts: contractsSchema(reviewed)
  });
const reviewSourceSchema = z.strictObject({
  version: versionSchema,
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  path: z.enum(['codex-rs/core/src/session/mod.rs', 'codex-rs/protocol/src/protocol.rs', 'CHANGELOG.md']),
  availability: z.literal('not_assessed')
});
const compatibilitySchema = z.strictObject({
  state: z.enum(['verified', 'compatibility_unverified']),
  product: laneSchema.shape.product,
  product_version: versionSchema,
  source: laneSchema.shape.route,
  parser_version: versionSchema,
  parser_revision: laneSchema.shape.profile_id,
  profile_id: laneSchema.shape.profile_id,
  rule_revision: z.literal('forward-version-v1')
});
const reasons = [
  'baseline_missing',
  'contracts_unknown',
  'unsupported_operation',
  'exact_only',
  'no_window',
  'out_of_window',
  'upper_bound',
  'major_transition',
  'minor_transition',
  'baseline_source_changed',
  'exact_qualification_required',
  'retired'
];
const reviewReasons = [...reasons, 'contracts_affected', 'review_source_changed'];
const gateOf = list => (list.some(row => row.judgment === 'affected') ? 'affected' : list.every(row => row.judgment === 'unaffected') ? 'closed' : 'unknown');
const ordinaryLaneRules = [
  {
    profile: 'codex-binding-root-window-v1',
    product: 'codex',
    route: 'codex_binding',
    revision: 'codex-ordinary-root-window-v1'
  },
  {
    profile: 'claude-binding-root-window-v1',
    product: 'claude_code',
    route: 'claude_binding',
    revision: 'claude-ordinary-root-window-v1'
  }
];
const expandedRuleSchema = z.enum(['forward-version-v1', 'codex-ordinary-root-window-v1', 'claude-ordinary-root-window-v1']);
const laneAssessment = (reviewed, ordinary = false) =>
  laneSchema.extend({
    static_selection: z.enum(['exact', 'inherited', 'unsupported']),
    compatibility: (ordinary ? compatibilitySchema.extend({ rule_revision: expandedRuleSchema }) : compatibilitySchema).nullable(),
    parser_base: versionSchema.nullable(),
    window: z
      .strictObject({
        base: versionSchema,
        upper_exclusive: versionSchema
      })
      .nullable(),
    rule_revision: ordinary ? expandedRuleSchema : z.literal('forward-version-v1'),
    declared_scope: z.strictObject({
      max_depth: z.number().int().min(0).max(1).nullable(),
      max_members: z.number().int().min(1).max(64).nullable(),
      read_only: z.boolean(),
      exact_only: z.boolean()
    }),
    reasons: z
      .array(z.enum(reviewed ? reviewReasons : reasons))
      .min(reviewed ? 0 : 1)
      .max((reviewed ? reviewReasons : reasons).length),
    review: z.strictObject({
      coverage: z.enum(['baseline_missing', 'review_required']),
      baseline_version: versionSchema.nullable(),
      releases: z.array(refSchema).max(256),
      edges: z.array(edgeSchema(reviewed)).max(256),
      parser_comparison: z
        .strictObject({
          from_version: versionSchema,
          to: refSchema,
          contracts: contractsSchema(reviewed)
        })
        .nullable(),
      contracts: contractsSchema(reviewed)
    }),
    live: z.strictObject({
      invalidation: z.literal('not_assessed'),
      binary: z.literal('not_assessed'),
      permissions: z.literal('not_assessed'),
      config: z.literal('not_assessed'),
      authentication: z.literal('not_assessed')
    }),
    gates: z.strictObject({
      contracts_reviewed: reviewed ? z.enum(['unknown', 'closed', 'affected']) : z.literal('unknown'),
      conformance: z.literal('not_assessed'),
      regression: z.literal('not_assessed'),
      implementation_review: z.literal('not_assessed'),
      admission: z.literal('not_assessed'),
      default_promotion: z.literal('not_assessed')
    })
  });
const assessmentFields = {
  kind: z.literal('assessment'),
  candidate_id: shaSchema,
  observation_id: shaSchema,
  baseline_digest: shaSchema.nullable(),
  source_digest: shaSchema,
  source_paths: z.array(z.enum(legacySourcePathAllowlist)).min(1).max(32),
  review_sources: z.array(reviewSourceSchema).min(1).max(1024),
  rule_revision: z.literal(legacyAssessmentRuleRevision),
  lanes: z.array(laneAssessment(false)).min(1).max(128)
};
const expandedAssessmentFields = {
  ...assessmentFields,
  source_paths: z.array(z.enum(policySourcePathAllowlist)).min(1).max(policyAssessmentSourcePathLimit),
  rule_revision: z.enum([expandedAssessmentRuleRevision, policyAssessmentRuleRevision]),
  lanes: z.array(laneAssessment(false, true)).min(1).max(128)
};
const expandedSourcePathsSchema = z.array(z.enum(expandedSourcePathAllowlist)).min(1).max(expandedAssessmentSourcePathLimit);
const inventoryScope = z.enum(['legacy_full_inventory', 'latest_and_npm_review_range']);
const transitionSchema = z.enum(['none', 'minor', 'major']).nullable();
const selectionPolicySchema = z.strictObject({
  parser_base_transition: transitionSchema,
  baseline_transition: transitionSchema,
  next_step: z.enum([
    'operation_unsupported',
    'retired',
    'selected_exact',
    'selected_window',
    'exact_admission_required',
    'older_version_unsupported',
    'window_extension_required',
    'window_rule_required'
  ])
});
const reviewFields = {
  inventory_scope: inventoryScope,
  review_ids: z.array(shaSchema).min(1).max(256),
  unused_review_ids: z.array(shaSchema).max(256)
};
const sortedUnique = list => list.every((id, index) => index === 0 || id > list[index - 1]);
const automatedContractsSchema = contractsSchema(true).refine(rows => rows.every((row, index) => row.contract_id === consumedContracts[index]));
const freshnessSchema = z.enum(['stale_source', 'stale_engine', 'stale_map', 'stale_policy']);
const automatedComparisonSchema = z.strictObject({
  comparison_kind: z.enum(['adjacent_release', 'parser_base']),
  from: reviewRefSchema,
  to: reviewRefSchema,
  judgment_id: shaSchema,
  result_scope: z.literal('job_aggregate'),
  contracts: automatedContractsSchema
});
const automatedSchema = z
  .strictObject({
    judgment_ids: z.array(shaSchema).max(256).refine(sortedUnique),
    contracts: automatedContractsSchema,
    comparisons: z.array(automatedComparisonSchema).max(512),
    freshness_reasons: z.array(freshnessSchema).max(4).refine(sortedUnique),
    pending_reasons: z
      .array(z.enum(['baseline_missing', 'equal_target', 'parser_chain_incomplete', 'judgment_missing']))
      .max(4)
      .refine(sortedUnique),
    required_validation: z
      .array(
        z.enum([
          'source_review',
          'schema_review',
          'synthetic_replay',
          'native_execution',
          'backend_counter_meaning',
          'real_session',
          'coverage_review',
          'fresh_evidence'
        ])
      )
      .max(8)
      .refine(sortedUnique),
    validation: z.literal('pending'),
    conflicts: z
      .array(
        z
          .strictObject({
            review_id: shaSchema,
            judgment_id: shaSchema,
            contract_id: z.enum(consumedContracts),
            manual_judgment: z.enum(['unaffected', 'affected']),
            automated_judgment: z.enum(['unaffected', 'affected']),
            comparison_kind: z.literal('adjacent_release'),
            from: reviewRefSchema,
            to: reviewRefSchema
          })
          .refine(row => row.manual_judgment !== row.automated_judgment)
      )
      .max(2048)
  })
  .refine(
    value =>
      value.comparisons.every(row => value.judgment_ids.includes(row.judgment_id)) &&
      value.conflicts.every(row => value.judgment_ids.includes(row.judgment_id)) &&
      ['native_execution', 'backend_counter_meaning', 'real_session'].every(code => value.required_validation.includes(code))
  );
const projectionAssessmentFields = {
  ...expandedAssessmentFields,
  schema_version: z.literal(8),
  inventory_scope: inventoryScope,
  source_paths: z.array(z.enum(projectionSourcePathAllowlist)).min(1).max(projectionAssessmentSourcePathLimit),
  rule_revision: z.literal(projectionAssessmentRuleRevision)
};
const producerAssessmentFields = {
  ...projectionAssessmentFields,
  schema_version: z.literal(9),
  source_paths: z.array(z.enum(producerSourcePathAllowlist)).min(1).max(producerAssessmentSourcePathLimit),
  rule_revision: z.literal(producerAssessmentRuleRevision)
};
const denialAssessmentFields = {
  ...producerAssessmentFields,
  schema_version: z.literal(10),
  source_paths: z.array(z.enum(denialSourcePathAllowlist)).min(1).max(denialAssessmentSourcePathLimit),
  rule_revision: z.literal(denialAssessmentRuleRevision)
};
const currentAssessmentFields = {
  ...denialAssessmentFields,
  schema_version: z.literal(11),
  source_paths: z.array(z.enum(sourcePathAllowlist)).min(1).max(assessmentSourcePathLimit),
  rule_revision: z.literal(assessmentRuleRevision)
};
const currentAssessmentVariants = fields => [
  z.strictObject(fields),
  z.strictObject({
    ...reviewFields,
    ...fields,
    lanes: z
      .array(
        laneAssessment(true, true).extend({
          selection_policy: selectionPolicySchema
        })
      )
      .min(1)
      .max(128)
  }),
  z.strictObject({
    ...fields,
    review_ids: z.array(shaSchema).max(256),
    unused_review_ids: z.array(shaSchema).max(256),
    judgment_ids: z.array(shaSchema).min(1).max(256),
    unused_judgment_ids: z.array(shaSchema).max(256),
    lanes: z
      .array(
        laneAssessment(true, true).extend({
          selection_policy: selectionPolicySchema.optional(),
          automated: automatedSchema
        })
      )
      .min(1)
      .max(128)
  })
];
export const assessmentSchema = z
  .discriminatedUnion('schema_version', [
    z.strictObject({ schema_version: z.literal(1), ...assessmentFields }),
    z.strictObject({
      schema_version: z.literal(2),
      inventory_scope: inventoryScope,
      ...assessmentFields
    }),
    z.strictObject({
      schema_version: z.literal(3),
      ...reviewFields,
      ...assessmentFields,
      lanes: z.array(laneAssessment(true)).min(1).max(128)
    }),
    z.strictObject({
      schema_version: z.literal(4),
      ...reviewFields,
      ...assessmentFields,
      lanes: z
        .array(
          laneAssessment(true).extend({
            selection_policy: selectionPolicySchema
          })
        )
        .min(1)
        .max(128)
    }),
    z.strictObject({
      schema_version: z.literal(5),
      inventory_scope: inventoryScope,
      ...expandedAssessmentFields
    }),
    z.strictObject({
      schema_version: z.literal(6),
      ...reviewFields,
      ...expandedAssessmentFields,
      lanes: z
        .array(
          laneAssessment(true, true).extend({
            selection_policy: selectionPolicySchema
          })
        )
        .min(1)
        .max(128)
    }),
    z.strictObject({
      schema_version: z.literal(7),
      ...expandedAssessmentFields,
      inventory_scope: inventoryScope,
      review_ids: z.array(shaSchema).max(256),
      unused_review_ids: z.array(shaSchema).max(256),
      judgment_ids: z.array(shaSchema).min(1).max(256),
      unused_judgment_ids: z.array(shaSchema).max(256),
      lanes: z
        .array(
          laneAssessment(true, true).extend({
            selection_policy: selectionPolicySchema.optional(),
            automated: automatedSchema
          })
        )
        .min(1)
        .max(128)
    }),
    ...[projectionAssessmentFields, producerAssessmentFields, denialAssessmentFields, currentAssessmentFields].map(fields =>
      z.strictObject({
        ...fields,
        review_ids: z.array(shaSchema).max(256).optional(),
        unused_review_ids: z.array(shaSchema).max(256).optional(),
        judgment_ids: z.array(shaSchema).min(1).max(256).optional(),
        unused_judgment_ids: z.array(shaSchema).max(256).optional(),
        lanes: z
          .array(
            laneAssessment(true, true).extend({
              selection_policy: selectionPolicySchema.optional(),
              automated: automatedSchema.optional()
            })
          )
          .min(1)
          .max(128)
      })
    )
  ])
  .superRefine((value, context) => {
    if (value.schema_version >= 8) {
      const fields =
        value.schema_version === 8
          ? projectionAssessmentFields
          : value.schema_version === 9
            ? producerAssessmentFields
            : value.schema_version === 10
              ? denialAssessmentFields
              : currentAssessmentFields;
      const parsed = z.union(currentAssessmentVariants(fields)).safeParse(value);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) context.addIssue(issue);
        return;
      }
    }
    if (
      new Set(value.lanes.map(laneKey)).size !== value.lanes.length ||
      new Set(value.source_paths).size !== value.source_paths.length ||
      ('review_ids' in value &&
        value.review_ids !== undefined &&
        (!sortedUnique(value.review_ids) ||
          !sortedUnique(value.unused_review_ids) ||
          value.unused_review_ids.some(id => !value.review_ids.includes(id)) ||
          value.lanes.some(row => row.gates.contracts_reviewed !== gateOf(row.review.contracts))))
    ) {
      context.addIssue({ code: 'custom', message: 'invalid_assessment' });
    }
    if (
      'judgment_ids' in value &&
      value.judgment_ids !== undefined &&
      (!sortedUnique(value.judgment_ids) ||
        !sortedUnique(value.unused_judgment_ids) ||
        value.unused_judgment_ids.some(id => !value.judgment_ids.includes(id)) ||
        value.lanes.some(
          lane =>
            lane.automated.judgment_ids.some(id => !value.judgment_ids.includes(id)) ||
            lane.automated.conflicts.some(row => !value.review_ids.includes(row.review_id))
        ))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'invalid_automated_assessment'
      });
    }
    if (value.rule_revision === expandedAssessmentRuleRevision) {
      const legacyScope = expandedSourcePathsSchema.safeParse(value.source_paths);
      if (!legacyScope.success) {
        for (const issue of legacyScope.error.issues) {
          context.addIssue({
            ...issue,
            path: ['source_paths', ...issue.path]
          });
        }
      }
    }
    const invalidPolicy = value.lanes.some(row => {
      const policy = ordinaryLaneRules.find(policy => policy.profile === row.profile_id);
      if (!policy) {
        return (
          row.rule_revision !== 'forward-version-v1' ||
          (row.compatibility !== null &&
            (row.compatibility.rule_revision !== 'forward-version-v1' ||
              ordinaryLaneRules.some(policy => policy.profile === row.compatibility.profile_id || policy.profile === row.compatibility.parser_revision)))
        );
      }
      return (
        value.schema_version < 5 ||
        value.rule_revision !==
          (value.schema_version === 11
            ? assessmentRuleRevision
            : value.schema_version === 10
              ? denialAssessmentRuleRevision
              : value.schema_version === 9
                ? producerAssessmentRuleRevision
                : value.schema_version === 8
                  ? projectionAssessmentRuleRevision
                  : policyAssessmentRuleRevision) ||
        row.product !== policy.product ||
        row.route !== policy.route ||
        row.rule_revision !== policy.revision ||
        row.topology !== 'root' ||
        !['link', 'collect', 'restart'].includes(row.operation) ||
        row.declared_scope.max_depth !== 0 ||
        row.declared_scope.max_members !== 1 ||
        row.declared_scope.exact_only ||
        !row.declared_scope.read_only ||
        (row.compatibility !== null &&
          (row.compatibility.rule_revision !== policy.revision ||
            row.compatibility.product !== row.product ||
            row.compatibility.source !== row.route ||
            row.compatibility.profile_id !== row.profile_id ||
            row.compatibility.parser_revision !== row.profile_id))
      );
    });
    if (invalidPolicy) {
      context.addIssue({ code: 'custom', message: 'invalid_policy_lane' });
    }
  })
  .refine(value => Buffer.byteLength(JSON.stringify(value)) <= 256 * 1024);
function assessmentLanes(source, baseline = false) {
  const lanes = sourceLanes(source).filter(
    row =>
      !baseline ||
      (!(row.operation === 'resume' && row.route.endsWith('_binding')) &&
        !(row.topology === 'root_direct_child' && (row.operation === 'resume' || (row.route === 'codex_workflow' && row.operation === 'link'))))
  );
  for (const { decision } of source.promotionFacets) {
    const lane = decision.scope.lane;
    if (
      decision.grants.includes('admission') &&
      (lane.topology === 'root' || decision.grants.includes('children')) &&
      !lanes.some(row => laneKey(row) === laneKey(lane))
    )
      lanes.push(laneSchema.parse(lane));
  }
  return lanes.sort((a, b) => laneKey(a).localeCompare(laneKey(b), 'en'));
}
function validateSourceKeys(baseline, source) {
  const lanes = assessmentLanes(source, true);
  if (baseline.rows.some(row => !lanes.some(lane => laneKey(lane) === laneKey(row)))) fail('invalid_baseline');
}
export async function validateBaselineForSource(input, root) {
  const baseline = parseBaseline(input);
  await withSourceSnapshot(root, source => validateSourceKeys(baseline, source));
}
function transition(from, to) {
  const [a, b] = from.split('.');
  const [x, y] = to.split('.');
  return a !== x ? 'major' : b !== y ? 'minor' : 'none';
}
function resolveLaneSelection(lane, source, target) {
  const ordinary = source.ordinaryWindows.find(row => row.policyId === lane.profile_id);
  const window = ordinary
    ? {
        base: ordinary.baseVersion,
        upper_exclusive: ordinary.upperExclusive
      }
    : source.windows.find(row => row.product === lane.product && row.source === lane.route && row.profile_id === lane.profile_id);
  const promoted = source.promotionFacets.find(
    ({ decision }) =>
      decision.scope.target.version === target &&
      laneKey(decision.scope.lane) === laneKey(lane) &&
      decision.grants.includes('admission') &&
      (lane.topology === 'root' || decision.grants.includes('children'))
  );
  const compatibility = ordinary
    ? (source.resolveOrdinaryWindow(lane.product, target, lane.profile_id)?.compatibility ?? null)
    : source.resolve(lane.product, target, lane.route, lane.profile_id, ...(promoted ? [lane.operation, lane.topology] : []));
  const promotedScope = promoted?.descriptor.scopes.find(scope => scope.operation === lane.operation && scope.topology === lane.topology);
  const child = lane.topology === 'root_direct_child';
  const binding = !ordinary && lane.route.endsWith('_binding');
  const admission = (lane.product === 'codex' ? source.codexAdmissions : source.claudeAdmissions).find(row => row.profileId === lane.profile_id);
  return {
    window,
    compatibility,
    child,
    binding,
    promoted,
    promotedScope,
    ruleRevision: ordinary?.ruleRevision ?? source.ruleRevision,
    readOnly: ordinary !== undefined || child,
    admission,
    maxDepth: promotedScope ? promotedScope.maxDepth : child ? 1 : binding && lane.topology === 'bounded_family' ? (admission?.maxDepth ?? 1) : 0,
    maxMembers: promotedScope
      ? promotedScope.maxFamilyMembers
      : child
        ? 2
        : binding && lane.topology === 'bounded_family'
          ? (admission?.maxFamilyMembers ?? null)
          : 1
  };
}
function projectLane(lane, source, candidate, observation, baseline, reviewed) {
  const row = baseline?.rows.find(row => laneKey(row) === laneKey(lane));
  const { window, compatibility, child, binding, promoted, promotedScope, ruleRevision, readOnly, admission, maxDepth, maxMembers } = resolveLaneSelection(
    lane,
    source,
    candidate.target
  );
  const exact = compatibility?.parser_version === candidate.target;
  const operationAllowed =
    promotedScope !== undefined ||
    (!(binding && lane.operation === 'resume') &&
      !(child && lane.operation === 'resume') &&
      !(lane.route === 'codex_workflow' && child && lane.operation === 'link') &&
      !(lane.route === 'claude_workflow' && lane.operation === 'resume' && !exact));
  const selected = compatibility && operationAllowed;
  const registered =
    source.evidence.find(row => row.product === lane.product && row.profile_id === lane.profile_id)?.product_version ??
    source.files.find(row => row.product === lane.product && source.resolve(lane.product, row.version, lane.route, lane.profile_id)?.state === 'verified')
      ?.version;
  const parserBase = compatibility?.parser_version ?? window?.base ?? admission?.productVersion ?? promoted?.descriptor.version ?? registered ?? null;
  const required = ['contracts_unknown'];
  if (lane.route === 'claude_workflow' && source.retiredClaudeWorkflowVersions.includes(candidate.target)) {
    required.push('retired');
  }
  if (!row) required.push('baseline_missing');
  if (!operationAllowed) required.push('unsupported_operation');
  if (binding || (lane.route === 'claude_workflow' && (child || lane.operation === 'resume'))) required.push('exact_only');
  if (!compatibility) {
    if (!window) required.push('no_window');
    else {
      required.push(compareVersions(candidate.target, window.upper_exclusive) === 0 ? 'upper_bound' : 'out_of_window');
    }
  }
  if (compatibility?.state === 'compatibility_unverified') {
    required.push('exact_qualification_required');
  }
  const parserTransition = parserBase ? transition(parserBase, candidate.target) : null;
  const baselineTransition = row ? transition(row.last_reviewed_version, candidate.target) : null;
  if (parserTransition && parserTransition !== 'none') {
    required.push(`${parserTransition}_transition`);
  }
  if (baselineTransition && baselineTransition !== 'none') {
    required.push(`${baselineTransition}_transition`);
  }
  let policy;
  if (reviewed) {
    const nextStep = !operationAllowed
      ? 'operation_unsupported'
      : required.includes('retired')
        ? 'retired'
        : exact
          ? 'selected_exact'
          : compatibility
            ? 'selected_window'
            : required.includes('exact_only')
              ? 'exact_admission_required'
              : window && compareVersions(candidate.target, window.base) <= 0
                ? 'older_version_unsupported'
                : window && compareVersions(candidate.target, window.upper_exclusive) >= 0
                  ? 'window_extension_required'
                  : !window
                    ? 'window_rule_required'
                    : fail('invalid_record');
    policy = {
      parser_base_transition: parserTransition,
      baseline_transition: baselineTransition,
      next_step: nextStep
    };
  }
  const target = observation.releases.find(row => row.version === candidate.target);
  let interval = [];
  const edges = [];
  if (row) {
    if (compareVersions(row.last_reviewed_version, candidate.target) > 0) {
      fail('baseline_ahead');
    }
    let from = observation.releases.find(release => release.version === row.last_reviewed_version);
    if (!from) fail('discovery_incomplete');
    interval = observation.releases.filter(
      release => compareVersions(release.version, row.last_reviewed_version) > 0 && compareVersions(release.version, candidate.target) <= 0
    );
    for (const to of interval) {
      edges.push({ from, to, contracts: checks() });
      from = to;
    }
  }
  return {
    ...lane,
    static_selection: !selected ? 'unsupported' : exact ? 'exact' : 'inherited',
    compatibility,
    parser_base: parserBase,
    window: window ? { base: window.base, upper_exclusive: window.upper_exclusive } : null,
    rule_revision: ruleRevision,
    declared_scope: {
      max_depth: maxDepth,
      max_members: maxMembers,
      read_only: readOnly,
      exact_only: binding || (lane.route === 'claude_workflow' && (child || lane.operation === 'resume'))
    },
    reasons: [...new Set(required)].sort(),
    review: {
      coverage: row ? 'review_required' : 'baseline_missing',
      baseline_version: row?.last_reviewed_version ?? null,
      releases: interval,
      edges,
      parser_comparison: parserBase ? { from_version: parserBase, to: target, contracts: checks() } : null,
      contracts: checks()
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
    },
    ...(reviewed ? { selection_policy: policy } : {})
  };
}
const rank = { unaffected: 0, unknown: 1, affected: 2 };
const worst = sets =>
  consumedContracts.map((contract_id, index) => ({
    contract_id,
    judgment: sets.reduce((found, set) => (rank[set[index].judgment] > rank[found] ? set[index].judgment : found), 'unaffected')
  }));
const sameRef = (a, b) => a.version === b.version && a.commit === b.commit;
function prepareReviews(inputs, candidate, releases) {
  const byId = new Map();
  for (const input of inputs) {
    let review;
    try {
      review = boundedParse(input, contractReviewSchema);
    } catch (error) {
      if (error instanceof ToolUpdateError && error.code === 'invalid_record') fail('invalid_review');
      throw error;
    }
    byId.set(digest(review), review);
  }
  const rows = [...byId].map(([id, review]) => ({ id, review })).sort((a, b) => (a.id < b.id ? -1 : 1));
  const edges = new Set();
  for (const { review } of rows) {
    const edge = [laneKey(review), review.from.version, review.to.version].join(':');
    if (edges.has(edge)) fail('review_conflict');
    edges.add(edge);
    if (
      review.product === candidate.product &&
      [review.from, review.to].some(ref => releases.some(release => release.version === ref.version && release.commit !== ref.commit))
    ) {
      fail('review_commit_conflict');
    }
  }
  return rows;
}
function parserChain(records, base, releases) {
  const start = releases.findIndex(release => release.version === base);
  if (start < 0) return [];
  const chain = [];
  for (let index = start + 1; index < releases.length; index++) {
    const item = records.find(({ review }) => sameRef(review.from, releases[index - 1]) && sameRef(review.to, releases[index]));
    if (!item) return [];
    chain.push(item);
  }
  return chain;
}
function applyReviews(lane, baselineRow, rows, sourceDigest, releases, used) {
  if (!baselineRow) return;
  const target = releases.at(-1);
  const mine = rows.filter(item => laneKey(item.review) === laneKey(lane));
  let changed = false;
  const read = item => {
    used.add(item.id);
    if (item.review.source_digest === sourceDigest) {
      return item.review.contracts;
    }
    changed = true;
    return null;
  };
  for (const edge of lane.review.edges) {
    const item = mine.find(({ review }) => sameRef(review.from, edge.from) && sameRef(review.to, edge.to));
    const contracts = item && read(item);
    if (contracts) edge.contracts = contracts;
  }
  if (lane.review.edges.length) {
    lane.review.contracts = worst(lane.review.edges.map(edge => edge.contracts));
  } else {
    const settled = mine
      .filter(({ id, review }) => baselineRow.evidence_ids.includes(id) && sameRef(review.to, target))
      .map(read)
      .filter(Boolean);
    if (settled.length) lane.review.contracts = worst(settled);
  }
  const comparison = lane.review.parser_comparison;
  if (comparison) {
    for (const item of parserChain(mine, comparison.from_version, releases)) read(item);
    const chain = parserChain(
      mine.filter(item => item.review.source_digest === sourceDigest),
      comparison.from_version,
      releases
    );
    if (chain.length) {
      comparison.contracts = worst(chain.map(item => item.review.contracts));
    }
  }
  const gate = gateOf(lane.review.contracts);
  lane.gates.contracts_reviewed = gate;
  if (gate === 'closed') {
    lane.reasons = lane.reasons.filter(reason => reason !== 'contracts_unknown');
  }
  if (gate === 'affected') lane.reasons.push('contracts_affected');
  if (changed) lane.reasons.push('review_source_changed');
}
const unique = values => [...new Set(values)].sort();
function validateJudgmentIdentity(job, judgment, assessment, baseline, releases) {
  const lane = assessment.lanes.find(row => laneKey(row) === laneKey(job.lane));
  const baselineRow = baseline?.rows.find(row => laneKey(row) === laneKey(job.lane));
  const parser = lane && releases.find(row => row.version === lane.parser_base);
  const baselineRef = baselineRow && releases.find(row => row.version === baselineRow.last_reviewed_version);
  const ref = row => ({ version: row.version, commit: row.commit });
  const expectedRow =
    baselineRow && baselineRef
      ? {
          ...job.lane,
          ref: ref(baselineRef),
          source_digest: baselineRow.source_digest,
          evidence_ids: baselineRow.evidence_ids
        }
      : null;
  const expectedParser = parser ? { ...ref(parser), profile_id: lane.profile_id } : null;
  const mutable = ['schema_version', 'kind', 'source_digest', 'engine_digest', 'map_revision', 'engine_revision'];
  if (
    !lane ||
    job.candidate_id !== assessment.candidate_id ||
    job.observation_id !== assessment.observation_id ||
    judgment.job_id !== digest(job) ||
    Object.keys(job).some(key => !mutable.includes(key) && canonical(job[key]) !== canonical(judgment[key])) ||
    canonical(job.target) !== canonical(ref(releases.at(-1))) ||
    job.baseline_digest !== (baselineRow ? assessment.baseline_digest : null) ||
    canonical(job.baseline_row) !== canonical(expectedRow) ||
    canonical(job.parser_base) !== canonical(expectedParser) ||
    canonical(job.inventory.releases) !== canonical(releases.map(ref)) ||
    job.inventory.inventory_id !== digest(releases.map(ref))
  ) {
    fail('difference_identity_mismatch');
  }
}
async function prepareJudgments(inputs, assessment, baseline, releases, root) {
  // The contract map imports this module's group owner; defer the reverse edge until evaluation.
  const { parseDifferenceJob, parseDifferenceJudgment } = await import('./difference-records.mjs');
  const { judgmentEngineDigest } = await import('./difference-judgment.mjs');
  const { engineRevision, mapRevision } = await import('./difference-contracts.mjs');
  const engineDigest = await judgmentEngineDigest(root);
  const byJob = new Map();
  for (const input of inputs) {
    const job = parseDifferenceJob(input.job);
    const judgment = parseDifferenceJudgment(input.judgment);
    validateJudgmentIdentity(job, judgment, assessment, baseline, releases);
    const id = digest(judgment);
    if (byJob.has(judgment.job_id) && byJob.get(judgment.job_id).id !== id) fail('difference_judgment_conflict');
    const freshness = unique([
      ...[job, judgment].flatMap(row => [
        ...(row.source_digest !== assessment.source_digest ? ['stale_source'] : []),
        ...(row.engine_digest !== engineDigest || row.engine_revision !== engineRevision ? ['stale_engine'] : []),
        ...(row.map_revision !== mapRevision ? ['stale_map'] : []),
        ...(row.evidence_snapshot.policy_revision !== 'closed-windows-v1' ? ['stale_policy'] : [])
      ]),
      ...judgment.coverage_reasons.filter(reason => ['stale_source', 'stale_engine', 'stale_map', 'stale_policy'].includes(reason))
    ]);
    byJob.set(judgment.job_id, { id, job, judgment, freshness });
  }
  return [...byJob.values()].sort((a, b) => a.id.localeCompare(b.id, 'en'));
}
function applyJudgments(lane, rows, reviews, sourceDigest, used) {
  const mine = rows.filter(row => laneKey(row.job.lane) === laneKey(lane));
  const contracts = row =>
    row.judgment.groups.map(group => ({
      contract_id: group.contract_id,
      judgment: row.freshness.length ? 'unknown' : group.result
    }));
  const pending = row => [
    ...(row.job.baseline_row ? [] : ['baseline_missing']),
    ...(row.job.baseline_row?.ref.version === row.job.target.version ? ['equal_target'] : []),
    ...(!row.job.parser_base ||
    row.job.inventory.coverage !== 'complete' ||
    row.judgment.coverage_reasons.some(reason => !['baseline_missing', 'stale_source', 'stale_engine', 'stale_map', 'stale_policy'].includes(reason))
      ? ['parser_chain_incomplete']
      : [])
  ];
  for (const row of mine) {
    if (!pending(row).length && !row.freshness.length) used.add(row.id);
  }
  const conflicts = [];
  for (const row of mine.filter(row => !row.freshness.length)) {
    const adjacent = row.judgment.comparisons.filter(row => row.comparison_kind === 'adjacent_release');
    const matching = comparison =>
      reviews.filter(
        item =>
          laneKey(item.review) === laneKey(lane) &&
          item.review.source_digest === sourceDigest &&
          sameRef(item.review.from, comparison.from) &&
          sameRef(item.review.to, comparison.to)
      );
    for (const comparison of adjacent) {
      for (const review of matching(comparison)) {
        for (const contract of contracts(row)) {
          const manual = review.review.contracts.find(item => item.contract_id === contract.contract_id).judgment;
          // A job-level change cannot contradict an unchanged edge without complete unchanged manual coverage.
          const completeUnchanged = adjacent.every(edge =>
            matching(edge).some(item => item.review.contracts.find(check => check.contract_id === contract.contract_id).judgment === 'unaffected')
          );
          if (
            manual !== 'unknown' &&
            contract.judgment !== 'unknown' &&
            manual !== contract.judgment &&
            (contract.judgment === 'unaffected' || completeUnchanged)
          ) {
            conflicts.push({
              review_id: review.id,
              judgment_id: row.id,
              contract_id: contract.contract_id,
              manual_judgment: manual,
              automated_judgment: contract.judgment,
              ...comparison
            });
          }
        }
      }
    }
  }
  lane.automated = {
    judgment_ids: mine.map(row => row.id),
    contracts: mine.length ? worst(mine.map(contracts)) : checks(),
    comparisons: mine.flatMap(row =>
      row.judgment.comparisons.map(comparison => ({
        ...comparison,
        judgment_id: row.id,
        result_scope: 'job_aggregate',
        contracts: contracts(row)
      }))
    ),
    freshness_reasons: unique(mine.flatMap(row => row.freshness)),
    pending_reasons: mine.length ? unique(mine.flatMap(pending)) : ['judgment_missing'],
    required_validation: unique([
      'native_execution',
      'backend_counter_meaning',
      'real_session',
      ...mine.flatMap(row => row.judgment.groups.flatMap(group => group.required_validation)),
      ...(mine.some(row => row.freshness.length) ? ['fresh_evidence'] : []),
      ...(!mine.length || mine.some(row => pending(row).length) ? ['coverage_review'] : [])
    ]),
    validation: 'pending',
    conflicts
  };
}
export async function assessCandidate({
  candidate: input,
  observation: observed,
  baseline: baselineInput = null,
  reviews: reviewInputs = null,
  judgments: judgmentInputs = null,
  root
}) {
  const candidate = boundedParse(input, candidateSchema);
  const observation = boundedParse(observed, observationSchema);
  const baseline = baselineInput === null ? null : parseBaseline(baselineInput);
  if (observation.result !== 'metadata_reconciled') {
    fail('discovery_incomplete');
  }
  const target = observation.releases.find(row => row.version === candidate.target);
  if (
    observation.candidate_id !== digest(candidate) ||
    observation.product !== candidate.product ||
    Object.values(observation.heads).some(version => version !== candidate.target) ||
    observation.reasons.some(reason => reason !== 'baseline_missing') ||
    !target ||
    target.release_id !== candidate.release_id ||
    target.tag !== candidate.tag ||
    target.commit !== candidate.commit ||
    target.npm_integrity !== candidate.npm_integrity
  ) {
    fail('observation_mismatch');
  }
  const releases = [...observation.releases].sort((a, b) => compareVersions(a.version, b.version));
  if (new Set(releases.map(row => row.version)).size !== releases.length || releases.some(row => compareVersions(row.version, candidate.target) > 0))
    fail('discovery_incomplete');
  const reviewedVersions = baseline?.rows.filter(row => row.product === candidate.product).map(row => row.last_reviewed_version) ?? [];
  if (reviewedVersions.length === 0 && releases.length !== 1) {
    fail('discovery_incomplete');
  }
  const rows = reviewInputs?.length ? prepareReviews(reviewInputs, candidate, releases) : null;
  const used = new Set();
  const snapshot = await withSourceSnapshot(root, source => {
    const lanes = assessmentLanes(source);
    if (baseline) validateSourceKeys(baseline, source);
    if (baseline?.rows.some(row => row.product === candidate.product && compareVersions(row.last_reviewed_version, candidate.target) > 0)) {
      fail('baseline_ahead');
    }
    return lanes
      .filter(row => row.product === candidate.product)
      .map(row => projectLane(row, source, candidate, { ...observation, releases }, baseline, rows !== null));
  });
  for (const lane of snapshot.value) {
    const row = baseline?.rows.find(row => laneKey(row) === laneKey(lane));
    if (row && row.source_digest !== snapshot.source_digest) {
      lane.reasons.push('baseline_source_changed');
    }
    if (rows) {
      applyReviews(lane, row, rows, snapshot.source_digest, releases, used);
    }
    lane.reasons.sort();
  }
  const assessment = {
    schema_version: 11,
    kind: 'assessment',
    inventory_scope: observation.schema_version === 2 ? observation.inventory_scope : 'legacy_full_inventory',
    candidate_id: digest(candidate),
    observation_id: digest(observation),
    baseline_digest: baseline ? digest(baseline) : null,
    source_digest: snapshot.source_digest,
    review_sources: observation.releases.flatMap(release =>
      (candidate.product === 'codex' ? ['codex-rs/core/src/session/mod.rs', 'codex-rs/protocol/src/protocol.rs'] : ['CHANGELOG.md']).map(path => ({
        version: release.version,
        commit: release.commit,
        path,
        availability: 'not_assessed'
      }))
    ),
    source_paths: snapshot.source_paths,
    rule_revision: assessmentRuleRevision,
    lanes: snapshot.value,
    ...(rows
      ? {
          review_ids: rows.map(item => item.id),
          unused_review_ids: rows.map(item => item.id).filter(id => !used.has(id))
        }
      : {})
  };
  if (judgmentInputs?.length) {
    const judgments = await prepareJudgments(judgmentInputs, assessment, baseline, releases, root);
    const usedJudgments = new Set();
    for (const lane of assessment.lanes) {
      applyJudgments(lane, judgments, rows ?? [], snapshot.source_digest, usedJudgments);
    }
    assessment.review_ids = rows?.map(row => row.id) ?? [];
    assessment.unused_review_ids = assessment.review_ids.filter(id => !used.has(id));
    assessment.judgment_ids = judgments.map(row => row.id);
    assessment.unused_judgment_ids = assessment.judgment_ids.filter(id => !usedJudgments.has(id));
  }
  return boundedParse(assessment, assessmentSchema);
}
