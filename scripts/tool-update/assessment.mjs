import { z } from 'zod';
import {
  boundedParse, compareVersions, digest, fail, parseBaseline, shaSchema, ToolUpdateError, versionSchema,
} from './manifest.mjs';
import { candidateSchema, observationSchema } from './discovery.mjs';
import { laneKey, laneSchema, sourceLanes } from './lanes.mjs';
import { assessmentRuleRevision, assessmentSourcePathLimit, legacyAssessmentRuleRevision, legacySourcePathAllowlist,
  sourcePathAllowlist, withSourceSnapshot } from './source-snapshot.mjs';

export const consumedContracts = [
  'identity_source_mapping', 'fields_types_enums', 'partial_rotation_checkpoint',
  'counters_cache_reasoning_reset_overflow', 'hooks_order_receipts_loading',
  'invocation_permissions_config_model_effort', 'history_topology_resume_compaction',
  'finality_replay_conflict_stop_flush_sigint',
];
const judgments = ['unaffected', 'affected', 'unknown'];
const contractsSchema = reviewed => z.array(z.strictObject({
  contract_id: z.enum(consumedContracts), judgment: reviewed ? z.enum(judgments) : z.literal('unknown'),
})).length(consumedContracts.length);
const checks = () => consumedContracts.map(contract_id => ({ contract_id, judgment: 'unknown' }));
const commitSchema = z.string().regex(/^[a-f0-9]{40}$/);
const ordered = (from, to) => versionSchema.safeParse(from).success && versionSchema.safeParse(to).success &&
  compareVersions(from, to) < 0;
const reviewRefSchema = z.strictObject({ version: versionSchema, commit: commitSchema });
export const contractReviewSchema = laneSchema.extend({
  schema_version: z.literal(1), kind: z.literal('contract_review'), contract_revision: z.literal('consumed-v1'),
  from: reviewRefSchema, to: reviewRefSchema, contracts: contractsSchema(true),
  evidence_ids: z.array(shaSchema).min(1).max(64), source_digest: shaSchema,
}).refine(value => ordered(value.from.version, value.to.version) &&
  value.contracts.every((row, index) => row.contract_id === consumedContracts[index]) &&
  value.evidence_ids.every((id, index) => index === 0 || id > value.evidence_ids[index - 1]));
const refSchema = z.strictObject({
  version: versionSchema, release_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  tag: z.string().max(128).regex(/^(?:rust-v|v)?(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})$/),
  commit: commitSchema,
  npm_integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/),
}).refine(value => Buffer.from(value.npm_integrity.slice(7), 'base64').toString('base64') === value.npm_integrity.slice(7));
const edgeSchema = reviewed => z.strictObject({ from: refSchema, to: refSchema, contracts: contractsSchema(reviewed) });
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
const reviewReasons = [...reasons, 'contracts_affected', 'review_source_changed'];
const gateOf = list => list.some(row => row.judgment === 'affected') ? 'affected'
  : list.every(row => row.judgment === 'unaffected') ? 'closed' : 'unknown';
const laneAssessment = reviewed => laneSchema.extend({
  static_selection: z.enum(['exact', 'inherited', 'unsupported']),
  compatibility: compatibilitySchema.nullable(), parser_base: versionSchema.nullable(),
  window: z.strictObject({ base: versionSchema, upper_exclusive: versionSchema }).nullable(),
  rule_revision: z.literal('forward-version-v1'),
  declared_scope: z.strictObject({
    max_depth: z.number().int().min(0).max(1).nullable(),
    max_members: z.number().int().min(1).max(64).nullable(),
    read_only: z.boolean(), exact_only: z.boolean(),
  }),
  reasons: z.array(z.enum(reviewed ? reviewReasons : reasons)).min(reviewed ? 0 : 1).max((reviewed ? reviewReasons : reasons).length),
  review: z.strictObject({
    coverage: z.enum(['baseline_missing', 'review_required']),
    baseline_version: versionSchema.nullable(),
    releases: z.array(refSchema).max(256), edges: z.array(edgeSchema(reviewed)).max(256),
    parser_comparison: z.strictObject({
      from_version: versionSchema, to: refSchema, contracts: contractsSchema(reviewed),
    }).nullable(),
    contracts: contractsSchema(reviewed),
  }),
  live: z.strictObject({
    invalidation: z.literal('not_assessed'), binary: z.literal('not_assessed'),
    permissions: z.literal('not_assessed'), config: z.literal('not_assessed'), authentication: z.literal('not_assessed'),
  }),
  gates: z.strictObject({
    contracts_reviewed: reviewed ? z.enum(['unknown', 'closed', 'affected']) : z.literal('unknown'), conformance: z.literal('not_assessed'),
    regression: z.literal('not_assessed'), implementation_review: z.literal('not_assessed'),
    admission: z.literal('not_assessed'), default_promotion: z.literal('not_assessed'),
  }),
});
const assessmentFields = {
  kind: z.literal('assessment'),
  candidate_id: shaSchema, observation_id: shaSchema, baseline_digest: shaSchema.nullable(),
  source_digest: shaSchema, source_paths: z.array(z.enum(legacySourcePathAllowlist)).min(1).max(32),
  review_sources: z.array(reviewSourceSchema).min(1).max(1024),
  rule_revision: z.literal(legacyAssessmentRuleRevision), lanes: z.array(laneAssessment(false)).min(1).max(128),
};
const expandedAssessmentFields = {
  ...assessmentFields, source_paths: z.array(z.enum(sourcePathAllowlist)).min(1).max(assessmentSourcePathLimit),
  rule_revision: z.literal(assessmentRuleRevision),
};
const inventoryScope = z.enum(['legacy_full_inventory', 'latest_and_npm_review_range']);
const transitionSchema = z.enum(['none', 'minor', 'major']).nullable();
const selectionPolicySchema = z.strictObject({
  parser_base_transition: transitionSchema, baseline_transition: transitionSchema,
  next_step: z.enum([
    'operation_unsupported', 'retired', 'selected_exact', 'selected_window',
    'exact_admission_required', 'older_version_unsupported', 'window_extension_required', 'window_rule_required',
  ]),
});
const reviewFields = {
  inventory_scope: inventoryScope,
  review_ids: z.array(shaSchema).min(1).max(256), unused_review_ids: z.array(shaSchema).max(256),
};
const sortedUnique = list => list.every((id, index) => index === 0 || id > list[index - 1]);
export const assessmentSchema = z.discriminatedUnion('schema_version', [
  z.strictObject({ schema_version: z.literal(1), ...assessmentFields }),
  z.strictObject({ schema_version: z.literal(2), inventory_scope: inventoryScope, ...assessmentFields }),
  z.strictObject({
    schema_version: z.literal(3), ...reviewFields,
    ...assessmentFields, lanes: z.array(laneAssessment(true)).min(1).max(128),
  }),
  z.strictObject({
    schema_version: z.literal(4), ...reviewFields, ...assessmentFields,
    lanes: z.array(laneAssessment(true).extend({ selection_policy: selectionPolicySchema })).min(1).max(128),
  }),
  z.strictObject({ schema_version: z.literal(5), inventory_scope: inventoryScope, ...expandedAssessmentFields }),
  z.strictObject({
    schema_version: z.literal(6), ...reviewFields, ...expandedAssessmentFields,
    lanes: z.array(laneAssessment(true).extend({ selection_policy: selectionPolicySchema })).min(1).max(128),
  }),
]).superRefine((value, context) => {
  if (new Set(value.lanes.map(laneKey)).size !== value.lanes.length ||
      new Set(value.source_paths).size !== value.source_paths.length ||
      [3, 4, 6].includes(value.schema_version) && (!sortedUnique(value.review_ids) || !sortedUnique(value.unused_review_ids) ||
        value.unused_review_ids.some(id => !value.review_ids.includes(id)) ||
        value.lanes.some(row => row.gates.contracts_reviewed !== gateOf(row.review.contracts))))
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
  return a !== x ? 'major' : b !== y ? 'minor' : 'none';
}
function projectLane(lane, source, candidate, observation, baseline, reviewed) {
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
  if (lane.route === 'claude_workflow' && source.retiredClaudeWorkflowVersions.includes(candidate.target))
    required.push('retired');
  if (!row) required.push('baseline_missing');
  if (!operationAllowed) required.push('unsupported_operation');
  if (binding || lane.route === 'claude_workflow' && (child || lane.operation === 'resume')) required.push('exact_only');
  if (!compatibility) {
    if (!window) required.push('no_window');
    else required.push(compareVersions(candidate.target, window.upper_exclusive) === 0 ? 'upper_bound' : 'out_of_window');
  }
  if (compatibility?.state === 'compatibility_unverified') required.push('exact_qualification_required');
  const parserTransition = parserBase ? transition(parserBase, candidate.target) : null;
  const baselineTransition = row ? transition(row.last_reviewed_version, candidate.target) : null;
  if (parserTransition && parserTransition !== 'none') required.push(`${parserTransition}_transition`);
  if (baselineTransition && baselineTransition !== 'none') required.push(`${baselineTransition}_transition`);
  let policy;
  if (reviewed) {
    const nextStep = !operationAllowed ? 'operation_unsupported'
      : required.includes('retired') ? 'retired'
      : exact ? 'selected_exact'
      : compatibility ? 'selected_window'
      : required.includes('exact_only') ? 'exact_admission_required'
      : window && compareVersions(candidate.target, window.base) <= 0 ? 'older_version_unsupported'
      : window && compareVersions(candidate.target, window.upper_exclusive) >= 0 ? 'window_extension_required'
      : !window ? 'window_rule_required' : fail('invalid_record');
    policy = {
      parser_base_transition: parserTransition, baseline_transition: baselineTransition, next_step: nextStep,
    };
  }
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
    ...reviewed ? { selection_policy: policy } : {},
  };
}
const rank = { unaffected: 0, unknown: 1, affected: 2 };
const worst = sets => consumedContracts.map((contract_id, index) => ({ contract_id,
  judgment: sets.reduce((found, set) => rank[set[index].judgment] > rank[found] ? set[index].judgment : found, 'unaffected') }));
const sameRef = (a, b) => a.version === b.version && a.commit === b.commit;
function prepareReviews(inputs, candidate, releases) {
  const byId = new Map();
  for (const input of inputs) {
    let review;
    try { review = boundedParse(input, contractReviewSchema); }
    catch (error) {
      if (error instanceof ToolUpdateError && error.code === 'invalid_record') fail('invalid_review');
      throw error;
    }
    byId.set(digest(review), review);
  }
  const rows = [...byId].map(([id, review]) => ({ id, review })).sort((a, b) => a.id < b.id ? -1 : 1);
  const edges = new Set();
  for (const { review } of rows) {
    const edge = [laneKey(review), review.from.version, review.to.version].join(':');
    if (edges.has(edge)) fail('review_conflict');
    edges.add(edge);
    if (review.product === candidate.product && [review.from, review.to].some(ref =>
      releases.some(release => release.version === ref.version && release.commit !== ref.commit)))
      fail('review_commit_conflict');
  }
  return rows;
}
function parserChain(records, base, releases) {
  const start = releases.findIndex(release => release.version === base);
  if (start < 0) return [];
  const chain = [];
  for (let index = start + 1; index < releases.length; index++) {
    const item = records.find(({ review }) => sameRef(review.from, releases[index - 1]) &&
      sameRef(review.to, releases[index]));
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
    if (item.review.source_digest === sourceDigest) return item.review.contracts;
    changed = true;
    return null;
  };
  for (const edge of lane.review.edges) {
    const item = mine.find(({ review }) => sameRef(review.from, edge.from) && sameRef(review.to, edge.to));
    const contracts = item && read(item);
    if (contracts) edge.contracts = contracts;
  }
  if (lane.review.edges.length) lane.review.contracts = worst(lane.review.edges.map(edge => edge.contracts));
  else {
    const settled = mine.filter(({ id, review }) => baselineRow.evidence_ids.includes(id) && sameRef(review.to, target))
      .map(read).filter(Boolean);
    if (settled.length) lane.review.contracts = worst(settled);
  }
  const comparison = lane.review.parser_comparison;
  if (comparison) {
    for (const item of parserChain(mine, comparison.from_version, releases)) read(item);
    const chain = parserChain(mine.filter(item => item.review.source_digest === sourceDigest),
      comparison.from_version, releases);
    if (chain.length) comparison.contracts = worst(chain.map(item => item.review.contracts));
  }
  const gate = gateOf(lane.review.contracts);
  lane.gates.contracts_reviewed = gate;
  if (gate === 'closed') lane.reasons = lane.reasons.filter(reason => reason !== 'contracts_unknown');
  if (gate === 'affected') lane.reasons.push('contracts_affected');
  if (changed) lane.reasons.push('review_source_changed');
}
export async function assessCandidate({
  candidate: input, observation: observed, baseline: baselineInput = null, reviews: reviewInputs = null, root,
}) {
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
  const rows = reviewInputs?.length ? prepareReviews(reviewInputs, candidate, releases) : null;
  const used = new Set();
  const snapshot = await withSourceSnapshot(root, source => {
    const lanes = sourceLanes(source);
    if (baseline) validateSourceKeys(baseline, source);
    if (baseline?.rows.some(row => row.product === candidate.product && compareVersions(row.last_reviewed_version, candidate.target) > 0))
      fail('baseline_ahead');
    return lanes.filter(row => row.product === candidate.product)
      .map(row => projectLane(row, source, candidate, { ...observation, releases }, baseline, rows !== null));
  });
  for (const lane of snapshot.value) {
    const row = baseline?.rows.find(row => laneKey(row) === laneKey(lane));
    if (row && row.source_digest !== snapshot.source_digest) lane.reasons.push('baseline_source_changed');
    if (rows) applyReviews(lane, row, rows, snapshot.source_digest, releases, used);
    lane.reasons.sort();
  }
  return boundedParse({
    schema_version: rows ? 6 : 5, kind: 'assessment',
    inventory_scope: observation.schema_version === 2 ? observation.inventory_scope : 'legacy_full_inventory',
    candidate_id: digest(candidate), observation_id: digest(observation),
    baseline_digest: baseline ? digest(baseline) : null, source_digest: snapshot.source_digest,
    review_sources: observation.releases.flatMap(release => (candidate.product === 'codex'
      ? ['codex-rs/core/src/session/mod.rs', 'codex-rs/protocol/src/protocol.rs'] : ['CHANGELOG.md'])
      .map(path => ({ version: release.version, commit: release.commit, path, availability: 'not_assessed' }))),
    source_paths: snapshot.source_paths, rule_revision: assessmentRuleRevision, lanes: snapshot.value,
    ...rows ? { review_ids: rows.map(item => item.id), unused_review_ids: rows.map(item => item.id).filter(id => !used.has(id)) } : {},
  }, assessmentSchema);
}
