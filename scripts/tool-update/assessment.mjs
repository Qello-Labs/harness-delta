import { z } from 'zod';
import { boundedParse, compareVersions, digest, fail, parseBaseline, shaSchema, versionSchema } from './manifest.mjs';
import { candidateSchema, observationSchema } from './discovery.mjs';
import { laneKey, laneSchema, sourceLanes, retiredClaudeWorkflowVersions } from './lanes.mjs';
import { assessmentRuleRevision, sourcePathAllowlist, withSourceSnapshot } from './source-snapshot.mjs';

export const consumedContracts = [
  'identity_source_mapping', 'fields_types_enums', 'partial_rotation_checkpoint',
  'counters_cache_reasoning_reset_overflow', 'hooks_order_receipts_loading',
  'invocation_permissions_config_model_effort', 'history_topology_resume_compaction',
  'finality_replay_conflict_stop_flush_sigint',
];
const contractSchema = z.strictObject({ contract_id: z.enum(consumedContracts), judgment: z.literal('unknown') });
const checks = () => consumedContracts.map(contract_id => ({ contract_id, judgment: 'unknown' }));
const refSchema = z.strictObject({
  version: versionSchema, release_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  tag: z.string().max(128).regex(/^(?:rust-v|v)?(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})$/),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  npm_integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/),
}).refine(value => Buffer.from(value.npm_integrity.slice(7), 'base64').toString('base64') === value.npm_integrity.slice(7));
const edgeSchema = z.strictObject({
  from: refSchema, to: refSchema, contracts: z.array(contractSchema).length(consumedContracts.length),
});
const reviewSourceSchema = z.strictObject({
  version: versionSchema, commit: z.string().regex(/^[a-f0-9]{40}$/),
  path: z.enum(['codex-rs/core/src/session/mod.rs', 'codex-rs/protocol/src/protocol.rs', 'CHANGELOG.md']),
  availability: z.literal('not_assessed'),
});
const compatibilitySchema = z.strictObject({
  state: z.enum(['verified', 'compatibility_unverified']), product: laneSchema.shape.product,
  product_version: versionSchema, source: laneSchema.shape.route, parser_version: versionSchema,
  parser_revision: laneSchema.shape.profile_id, profile_id: laneSchema.shape.profile_id,
  rule_revision: z.literal('forward-version-v1'),
});
const reasons = [
  'baseline_missing', 'contracts_unknown', 'unsupported_operation', 'exact_only',
  'no_window', 'out_of_window', 'upper_bound', 'major_transition', 'minor_transition',
  'baseline_source_changed', 'exact_qualification_required', 'retired',
];
const laneAssessmentSchema = laneSchema.extend({
  static_selection: z.enum(['exact', 'inherited', 'unsupported']),
  compatibility: compatibilitySchema.nullable(), parser_base: versionSchema.nullable(),
  window: z.strictObject({ base: versionSchema, upper_exclusive: versionSchema }).nullable(),
  rule_revision: z.literal('forward-version-v1'),
  declared_scope: z.strictObject({
    max_depth: z.number().int().min(0).max(1).nullable(),
    max_members: z.number().int().min(1).max(64).nullable(),
    read_only: z.boolean(), exact_only: z.boolean(),
  }),
  reasons: z.array(z.enum(reasons)).min(1).max(reasons.length),
  review: z.strictObject({
    coverage: z.enum(['baseline_missing', 'review_required']),
    baseline_version: versionSchema.nullable(),
    releases: z.array(refSchema).max(256), edges: z.array(edgeSchema).max(256),
    parser_comparison: z.strictObject({
      from_version: versionSchema, to: refSchema, contracts: z.array(contractSchema).length(consumedContracts.length),
    }).nullable(),
    contracts: z.array(contractSchema).length(consumedContracts.length),
  }),
  live: z.strictObject({
    invalidation: z.literal('not_assessed'), binary: z.literal('not_assessed'),
    permissions: z.literal('not_assessed'), config: z.literal('not_assessed'), authentication: z.literal('not_assessed'),
  }),
  gates: z.strictObject({
    contracts_reviewed: z.literal('unknown'), conformance: z.literal('not_assessed'),
    regression: z.literal('not_assessed'), implementation_review: z.literal('not_assessed'),
    admission: z.literal('not_assessed'), default_promotion: z.literal('not_assessed'),
  }),
});
const assessmentFields = {
  kind: z.literal('assessment'),
  candidate_id: shaSchema, observation_id: shaSchema, baseline_digest: shaSchema.nullable(),
  source_digest: shaSchema, source_paths: z.array(z.enum(sourcePathAllowlist)).min(1).max(32),
  review_sources: z.array(reviewSourceSchema).min(1).max(1024),
  rule_revision: z.literal(assessmentRuleRevision), lanes: z.array(laneAssessmentSchema).min(1).max(128),
};
export const assessmentSchema = z.discriminatedUnion('schema_version', [
  z.strictObject({ schema_version: z.literal(1), ...assessmentFields }),
  z.strictObject({ schema_version: z.literal(2), inventory_scope: z.enum([
    'legacy_full_inventory', 'latest_and_npm_review_range',
  ]), ...assessmentFields }),
]).superRefine((value, context) => {
  if (new Set(value.lanes.map(laneKey)).size !== value.lanes.length ||
      new Set(value.source_paths).size !== value.source_paths.length)
    context.addIssue({ code: 'custom', message: 'invalid_assessment' });
}).refine(value => Buffer.byteLength(JSON.stringify(value)) <= 256 * 1024);
function validateSourceKeys(baseline, source) {
  const lanes = sourceLanes(source).filter(row => !(row.operation === 'resume' && row.route.endsWith('_binding')) &&
    !(row.topology === 'root_direct_child' && (row.operation === 'resume' || row.route === 'codex_workflow' && row.operation === 'link')));
  if (baseline.rows.some(row => !lanes.some(lane => laneKey(lane) === laneKey(row)))) fail('invalid_baseline');
}
export async function validateBaselineForSource(input, root) {
  const baseline = parseBaseline(input);
  await withSourceSnapshot(root, source => validateSourceKeys(baseline, source));
}
function transition(from, to) {
  const [a, b] = from.split('.');
  const [x, y] = to.split('.');
  return a !== x ? ['major_transition'] : b !== y ? ['minor_transition'] : [];
}
function projectLane(lane, source, candidate, observation, baseline) {
  const row = baseline?.rows.find(row => laneKey(row) === laneKey(lane));
  const window = source.windows.find(row => row.product === lane.product && row.source === lane.route && row.profile_id === lane.profile_id);
  const compatibility = source.resolve(lane.product, candidate.target, lane.route, lane.profile_id);
  const child = lane.topology === 'root_direct_child';
  const binding = lane.route.endsWith('_binding');
  const exact = compatibility?.parser_version === candidate.target;
  const operationAllowed = !(binding && lane.operation === 'resume') && !(child && lane.operation === 'resume') &&
    !(lane.route === 'codex_workflow' && child && lane.operation === 'link') &&
    !(lane.route === 'claude_workflow' && lane.operation === 'resume' && !exact);
  const selected = compatibility && operationAllowed;
  const admission = (lane.product === 'codex' ? source.codexAdmissions : source.claudeAdmissions)
    .find(row => row.profileId === lane.profile_id);
  const registered = source.evidence.find(row => row.product === lane.product && row.profile_id === lane.profile_id)?.product_version ??
    source.files.find(row => row.product === lane.product &&
      source.resolve(lane.product, row.version, lane.route, lane.profile_id)?.state === 'verified')?.version;
  const parserBase = compatibility?.parser_version ?? window?.base ?? admission?.productVersion ?? registered ?? null;
  const required = ['contracts_unknown'];
  if (lane.route === 'claude_workflow' && retiredClaudeWorkflowVersions.includes(candidate.target))
    required.push('retired');
  if (!row) required.push('baseline_missing');
  if (!operationAllowed) required.push('unsupported_operation');
  if (binding || lane.route === 'claude_workflow' && (child || lane.operation === 'resume')) required.push('exact_only');
  if (!compatibility) {
    if (!window) required.push('no_window');
    else required.push(compareVersions(candidate.target, window.upper_exclusive) === 0 ? 'upper_bound' : 'out_of_window');
  }
  if (compatibility?.state === 'compatibility_unverified') required.push('exact_qualification_required');
  if (parserBase) required.push(...transition(parserBase, candidate.target));
  if (row) required.push(...transition(row.last_reviewed_version, candidate.target));
  const target = observation.releases.find(row => row.version === candidate.target);
  let interval = [];
  const edges = [];
  if (row) {
    if (compareVersions(row.last_reviewed_version, candidate.target) > 0) fail('baseline_ahead');
    let from = observation.releases.find(release => release.version === row.last_reviewed_version);
    if (!from) fail('discovery_incomplete');
    interval = observation.releases.filter(release => compareVersions(release.version, row.last_reviewed_version) > 0 &&
      compareVersions(release.version, candidate.target) <= 0);
    for (const to of interval) { edges.push({ from, to, contracts: checks() }); from = to; }
  }
  return {
    ...lane, static_selection: !selected ? 'unsupported' : exact ? 'exact' : 'inherited',
    compatibility, parser_base: parserBase,
    window: window ? { base: window.base, upper_exclusive: window.upper_exclusive } : null,
    rule_revision: source.ruleRevision,
    declared_scope: {
      max_depth: child ? 1 : binding && lane.topology === 'bounded_family' ? admission?.maxDepth ?? 1 : 0,
      max_members: child ? 2 : binding && lane.topology === 'bounded_family' ? admission?.maxFamilyMembers ?? null : 1,
      read_only: child, exact_only: binding || lane.route === 'claude_workflow' && (child || lane.operation === 'resume'),
    },
    reasons: [...new Set(required)].sort(),
    review: {
      coverage: row ? 'review_required' : 'baseline_missing', baseline_version: row?.last_reviewed_version ?? null,
      releases: interval, edges,
      parser_comparison: parserBase ? { from_version: parserBase, to: target, contracts: checks() } : null,
      contracts: checks(),
    },
    live: { invalidation: 'not_assessed', binary: 'not_assessed', permissions: 'not_assessed', config: 'not_assessed', authentication: 'not_assessed' },
    gates: { contracts_reviewed: 'unknown', conformance: 'not_assessed', regression: 'not_assessed',
      implementation_review: 'not_assessed', admission: 'not_assessed', default_promotion: 'not_assessed' },
  };
}
export async function assessCandidate({ candidate: input, observation: observed, baseline: baselineInput = null, root }) {
  const candidate = boundedParse(input, candidateSchema);
  const observation = boundedParse(observed, observationSchema);
  const baseline = baselineInput === null ? null : parseBaseline(baselineInput);
  if (observation.result !== 'metadata_reconciled') fail('discovery_incomplete');
  const target = observation.releases.find(row => row.version === candidate.target);
  if (observation.candidate_id !== digest(candidate) || observation.product !== candidate.product ||
      Object.values(observation.heads).some(version => version !== candidate.target) ||
      observation.reasons.some(reason => reason !== 'baseline_missing') ||
      !target || target.release_id !== candidate.release_id || target.tag !== candidate.tag ||
      target.commit !== candidate.commit || target.npm_integrity !== candidate.npm_integrity)
    fail('observation_mismatch');
  const releases = [...observation.releases].sort((a, b) => compareVersions(a.version, b.version));
  if (new Set(releases.map(row => row.version)).size !== releases.length ||
      releases.some(row => compareVersions(row.version, candidate.target) > 0)) fail('discovery_incomplete');
  const reviewedVersions = baseline?.rows.filter(row => row.product === candidate.product).map(row => row.last_reviewed_version) ?? [];
  if (reviewedVersions.length === 0 && releases.length !== 1) fail('discovery_incomplete');
  const snapshot = await withSourceSnapshot(root, source => {
    const lanes = sourceLanes(source);
    if (baseline) validateSourceKeys(baseline, source);
    if (baseline?.rows.some(row => row.product === candidate.product && compareVersions(row.last_reviewed_version, candidate.target) > 0))
      fail('baseline_ahead');
    return lanes.filter(row => row.product === candidate.product)
      .map(row => projectLane(row, source, candidate, { ...observation, releases }, baseline));
  });
  for (const lane of snapshot.value) {
    const row = baseline?.rows.find(row => laneKey(row) === laneKey(lane));
    if (row && row.source_digest !== snapshot.source_digest) lane.reasons.push('baseline_source_changed');
    lane.reasons.sort();
  }
  return boundedParse({
    schema_version: 2, kind: 'assessment',
    inventory_scope: observation.schema_version === 2 ? observation.inventory_scope : 'legacy_full_inventory',
    candidate_id: digest(candidate), observation_id: digest(observation),
    baseline_digest: baseline ? digest(baseline) : null, source_digest: snapshot.source_digest,
    review_sources: observation.releases.flatMap(release => (candidate.product === 'codex'
      ? ['codex-rs/core/src/session/mod.rs', 'codex-rs/protocol/src/protocol.rs'] : ['CHANGELOG.md'])
      .map(path => ({ version: release.version, commit: release.commit, path, availability: 'not_assessed' }))),
    source_paths: snapshot.source_paths, rule_revision: assessmentRuleRevision, lanes: snapshot.value,
  }, assessmentSchema);
}
