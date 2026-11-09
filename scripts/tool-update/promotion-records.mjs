import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { boundedParse, canonical, compareVersions, digest, fail, maxRecordBytes, shaSchema, versionSchema } from './manifest.mjs';
import { laneKey, laneSchema } from './lanes.mjs';
import { consumedContracts, facets, requiredFacets } from './difference-contracts.mjs';
import { reducePromotionGates } from './promotion-gates.mjs';

export const promotionEngineRevision = 'promotion-engine-v1';
export const promotionEngineDigestScheme = 'promotion-engine-files-sha256-v1';
export const promotionEngineFiles = Object.freeze([
  'scripts/tool-update.mjs',
  'scripts/tool-update/promotion.mjs',
  'src/core/tool-version-promotion.ts',
  'scripts/tool-update/difference-records.mjs',
  'scripts/tool-update/difference-judgment.mjs',
  'scripts/tool-update/promotion-records.mjs',
  'scripts/tool-update/promotion-gates.mjs',
  'scripts/tool-update/manifest.mjs',
  'scripts/tool-update/lanes.mjs',
  'scripts/tool-update/difference-contracts.mjs',
  'scripts/tool-update/assessment.mjs',
  'scripts/tool-update/source-snapshot.mjs',
  'scripts/tool-update/discovery.mjs',
  'scripts/tool-update/discovery-records.mjs',
  'scripts/tool-update/discovery-transport.mjs',
  'package.json',
  'package-lock.json'
]);
export async function promotionEngineDigest(root) {
  const files = await Promise.all(
    promotionEngineFiles.map(async path => ({
      path,
      sha256: createHash('sha256')
        .update(await readFile(join(root, path)))
        .digest('hex')
    }))
  );
  return digest({
    scheme: promotionEngineDigestScheme,
    engine_revision: promotionEngineRevision,
    files
  });
}
export const promotionEvidenceClasses = Object.freeze([
  'static',
  'synthetic',
  'pinned_upstream_comparison',
  'actual_target_binary_conformance',
  'native_trial',
  'real_session'
]);
export const promotionGateIds = Object.freeze(Array.from({ length: 12 }, (_, index) => `G${String(index + 1).padStart(2, '0')}`));
const sortedUnique = values => values.every((value, index) => index === 0 || value > values[index - 1]);
const idsSchema = z.array(shaSchema).max(256).refine(sortedUnique);
const finiteList = values => z.array(z.enum(values)).max(values.length).refine(sortedUnique);
const classesSchema = finiteList(promotionEvidenceClasses);
const grantsSchema = finiteList(['admission', 'qualification', 'children']);
const refSchema = z.strictObject({
  version: versionSchema,
  commit: z.string().regex(/^[a-f0-9]{40}$/)
});
const reasonCodes = [
  'evidence_missing',
  'baseline_missing',
  'parser_base_missing',
  'edge_missing',
  'coverage_incomplete',
  'affected_contract',
  'unknown_contract',
  'stale_evidence',
  'pre_release_pending',
  'review_required',
  'scoped_approval',
  'qualification_withdrawn',
  'maintenance_ended',
  'authority_withdrawn',
  'confirmed_incompatibility',
  'authority_deleted',
  'target_refused'
];
const reasonsSchema = finiteList(reasonCodes);
const fits = value => Buffer.byteLength(canonical(value)) <= maxRecordBytes;
function validLane(lane) {
  const prefix = lane.product === 'codex' ? 'codex' : 'claude';
  if (!lane.profile_id.startsWith(`${prefix}-`)) return false;
  if (lane.route !== 'file' && !lane.route.startsWith(`${prefix}_`)) {
    return false;
  }
  if (!lane.profile_id.startsWith(`${prefix}-${lane.route === 'file' ? 'file' : lane.route.split('_')[1]}-`)) return false;
  if (lane.profile_id.endsWith('-root-window-v1')) {
    return lane.topology === 'root' && ['link', 'collect', 'restart'].includes(lane.operation);
  }
  if (lane.route === 'file') {
    return lane.topology === 'root' && ['collect', 'restart'].includes(lane.operation);
  }
  if (lane.route.endsWith('_binding')) {
    return ['root', 'bounded_family'].includes(lane.topology) && ['link', 'collect', 'restart', 'resume'].includes(lane.operation);
  }
  return (
    lane.topology === (lane.profile_id.includes('-direct-child-') ? 'root_direct_child' : 'root') &&
    (lane.product === 'codex' ? ['launch', 'link', 'collect', 'resume'] : ['launch', 'resume']).includes(lane.operation)
  );
}
export const promotionScopeSchema = z
  .strictObject({
    target: refSchema,
    lane: laneSchema,
    platform: z.enum(['darwin_arm64', 'darwin_x64', 'linux_arm64', 'linux_x64', 'win32_x64']),
    runtime: z.enum(['node24', 'node26'])
  })
  .refine(value => validLane(value.lane));
const comparisonSchema = z
  .strictObject({
    comparison_kind: z.enum(['adjacent_release', 'parser_base']),
    from: refSchema,
    to: refSchema
  })
  .refine(
    value => compareVersions(value.from.version, value.to.version) <= 0 && (value.from.version !== value.to.version || value.from.commit === value.to.commit)
  );
const coverageSchema = z
  .strictObject({
    baseline_status: z.enum(['present', 'missing']),
    baseline_digest: shaSchema.nullable(),
    baseline_ref: refSchema.nullable(),
    parser_base: refSchema.nullable(),
    releases: z.array(refSchema).min(1).max(256),
    complete: z.boolean(),
    comparisons: z.array(comparisonSchema).max(512)
  })
  .refine(
    value =>
      (value.baseline_status === 'present') === (value.baseline_digest !== null && value.baseline_ref !== null) &&
      (value.baseline_status !== 'missing' || (value.baseline_digest === null && value.baseline_ref === null)) &&
      value.releases.every((ref, index) => index === 0 || compareVersions(value.releases[index - 1].version, ref.version) < 0) &&
      new Set(value.comparisons.map(canonical)).size === value.comparisons.length
  );
const proofSchema = z
  .strictObject({
    evidence_id: shaSchema,
    scope_digest: shaSchema,
    evidence_class: z.enum(promotionEvidenceClasses),
    result: z.enum(['pass', 'fail', 'unknown']),
    freshness: z.enum(['current', 'stale']),
    contract_id: z.enum(consumedContracts).nullable(),
    facet: z.enum(facets).nullable()
  })
  .refine(value => (value.contract_id === null) === (value.facet === null));
const gateSchema = z
  .strictObject({
    gate_id: z.enum(promotionGateIds),
    required_classes: classesSchema,
    evidence: z.array(proofSchema).max(256)
  })
  .refine(value => sortedUnique(value.evidence.map(row => row.evidence_id)));
const contractsSchema = z
  .array(
    z.strictObject({
      contract_id: z.enum(consumedContracts),
      facets: z
        .array(
          z.strictObject({
            facet: z.enum(facets),
            result: z.enum(['unaffected', 'affected', 'unknown']),
            required_classes: classesSchema
          })
        )
        .min(1)
        .max(facets.length)
    })
  )
  .length(consumedContracts.length);
export const promotionGateInputSchema = z
  .strictObject({
    scope: promotionScopeSchema,
    requested_grants: grantsSchema.nonempty(),
    required_validation: classesSchema,
    coverage: coverageSchema,
    contracts: contractsSchema,
    gate_matrix: z.array(gateSchema).length(12),
    unresolved_finding_ids: idsSchema
  })
  .refine(validGateInput);
function validGateInput(value) {
  const scopeDigest = digest(value.scope);
  if (value.requested_grants.includes('children') && value.scope.lane.topology === 'root') return false;
  if (!value.gate_matrix.every((row, index) => row.gate_id === promotionGateIds[index] && row.evidence.every(proof => proof.scope_digest === scopeDigest))) {
    return false;
  }
  return value.contracts.every((group, index) => {
    const required = requiredFacets(group.contract_id, value.scope.lane);
    return (
      group.contract_id === consumedContracts[index] && group.facets.length === required.length && group.facets.every((row, i) => row.facet === required[i])
    );
  });
}
const identitiesSchema = z.strictObject({
  source_digest: shaSchema,
  judgment_engine_digest: shaSchema,
  promotion_engine_digest: shaSchema,
  promotion_engine_revision: z.literal(promotionEngineRevision),
  policy_revision: z.literal('closed-windows-v1'),
  map_revision: z.literal('difference-map-v2'),
  contract_revision: z.literal('consumed-v1'),
  implementation_scheme: z.literal('promotion-implementation-v1'),
  evidence_revision: z.literal('promotion-evidence-v1')
});
const reconciliationSchema = z
  .strictObject({
    predecessor_proposal_ids: idsSchema.nonempty(),
    originating_grant_ids: idsSchema.nonempty(),
    current_grant_ids: idsSchema.nonempty(),
    coverage_mapping_ids: idsSchema.nonempty(),
    descriptor_lineage_ids: idsSchema.nonempty(),
    matched_scope: promotionScopeSchema,
    matched_contracts: finiteList(consumedContracts).nonempty(),
    matched_facets: finiteList(facets).nonempty(),
    triggering_judgment_ids: idsSchema.nonempty(),
    unresolved_findings: z
      .array(
        z.strictObject({
          finding_id: shaSchema,
          judgment_id: shaSchema,
          proposal_id: shaSchema,
          reason: z.enum(['affected_contract', 'unknown_contract', 'stale_evidence', 'review_required'])
        })
      )
      .min(1)
      .max(256)
  })
  .refine(value => sortedUnique(value.unresolved_findings.map(row => row.finding_id)));
const common = { schema_version: z.literal(1), authority: z.literal('none') };
export const promotionProposalSchema = z
  .strictObject({
    ...common,
    kind: z.literal('promotion_proposal'),
    state: z.enum(['blocked', 'pending_pre_release', 'ready_for_decision', 'review_needed']),
    selection_reason: z.enum(['release_candidate', 'consumed_contract_fix', 'explicit_operator_need']),
    selection_reference: shaSchema,
    scope: promotionScopeSchema,
    original_lanes: z
      .array(laneSchema)
      .min(1)
      .max(256)
      .refine(rows => sortedUnique(rows.map(laneKey))),
    coverage_mapping_ids: idsSchema,
    requested_grants: grantsSchema.nonempty(),
    candidate_id: shaSchema,
    observation_id: shaSchema,
    assessment_ids: idsSchema.nonempty(),
    job_ids: idsSchema.nonempty(),
    judgment_ids: idsSchema,
    descriptor_digest: shaSchema,
    variant_digest: shaSchema.nullable(),
    registry_before_digest: shaSchema,
    proposed_projection_digest: shaSchema,
    identities: identitiesSchema,
    coverage: coverageSchema,
    contracts: contractsSchema,
    gate_matrix: z.array(gateSchema).length(12),
    required_validation: classesSchema,
    reasons: reasonsSchema,
    reconciliation: reconciliationSchema.nullable()
  })
  .refine(value => validGateInput(value) && value.original_lanes.every(validLane))
  .refine(value => value.original_lanes.every(lane => laneKey(lane) === laneKey(value.scope.lane)) || value.coverage_mapping_ids.length > 0)
  .refine(value => {
    if ((value.state === 'review_needed') !== (value.reconciliation !== null)) return false;
    if (value.reconciliation && canonical(value.scope) !== canonical(value.reconciliation.matched_scope)) return false;
    return (
      !['pending_pre_release', 'ready_for_decision'].includes(value.state) ||
      (value.coverage.baseline_status === 'present' && value.coverage.parser_base !== null && value.coverage.complete)
    );
  })
  .refine(value => {
    const input = {
      scope: value.scope,
      requested_grants: value.requested_grants,
      required_validation: value.required_validation,
      coverage: value.coverage,
      contracts: value.contracts,
      gate_matrix: value.gate_matrix,
      unresolved_finding_ids: value.reconciliation?.unresolved_findings.map(row => row.finding_id) ?? []
    };
    const parsed = promotionGateInputSchema.safeParse(input);
    return parsed.success && value.state === reducePromotionGates(parsed.data).state;
  })
  .refine(fits);
const outcomeSchema = z
  .strictObject({
    metric: z.enum(['event_count', 'input_tokens', 'output_tokens', 'cached_input_tokens', 'reasoning_tokens', 'request_count', 'violation_count']),
    status: z.enum(['observed', 'missing', 'error', 'excluded', 'unmeasurable']),
    value: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable()
  })
  .refine(value => (value.status === 'observed') === (value.value !== null));
export const promotionValidationSchema = z
  .strictObject({
    ...common,
    kind: z.literal('promotion_validation'),
    proposal_id: shaSchema,
    scope: promotionScopeSchema,
    descriptor_digest: shaSchema,
    evidence_revision: z.literal('promotion-evidence-v1'),
    evidence_class: z.enum(promotionEvidenceClasses),
    evidence_origin: z.enum(['static', 'synthetic', 'pinned', 'actual']),
    result: z.enum(['pass', 'fail', 'unknown']),
    accepted_result_ids: idsSchema,
    pins: z.strictObject({
      image: shaSchema.nullable(),
      component: shaSchema.nullable(),
      build: shaSchema.nullable(),
      instrument: shaSchema.nullable(),
      implementation: shaSchema.nullable(),
      runtime: shaSchema.nullable(),
      model: shaSchema.nullable()
    }),
    implementation_scheme: z.literal('promotion-implementation-v1'),
    scenario: z.enum(['normal', 'interrupted', 'replacement', 'cleanup', 'scope_denial', 'replay', 'counter_attribution', 'child_lifecycle']),
    outcomes: z.array(outcomeSchema).max(7),
    limitations: finiteList(['synthetic_only', 'partial_coverage', 'model_specific', 'platform_specific', 'ownership_unverified', 'delivery_unverified']),
    reviewer_reference: shaSchema.nullable(),
    unresolved_requirements: classesSchema
  })
  .refine(value => {
    const origin = {
      static: 'static',
      synthetic: 'synthetic',
      pinned_upstream_comparison: 'pinned',
      actual_target_binary_conformance: 'actual',
      native_trial: 'actual',
      real_session: 'actual'
    }[value.evidence_class];
    if (value.evidence_origin !== origin || new Set(value.outcomes.map(row => row.metric)).size !== value.outcomes.length) return false;
    if (value.evidence_class === 'synthetic' && !value.limitations.includes('synthetic_only')) return false;
    if (value.result !== 'pass') return true;
    if (value.accepted_result_ids.length === 0 || value.unresolved_requirements.length > 0) return false;
    if (origin !== 'actual') return true;
    return (
      !value.limitations.includes('synthetic_only') &&
      value.reviewer_reference !== null &&
      Object.entries(value.pins).every(([key, pin]) => key === 'model' || pin !== null) &&
      (!['native_trial', 'real_session'].includes(value.evidence_class) || value.pins.model !== null)
    );
  })
  .refine(fits);
const decisions = ['approve', 'demote', 'retire', 'revoke', 'invalidate', 'delete'];
export const promotionDecisionSchema = z
  .strictObject({
    ...common,
    kind: z.literal('promotion_decision'),
    proposal_id: shaSchema,
    scope: promotionScopeSchema,
    proposed_scope: promotionScopeSchema,
    requested_grants: grantsSchema.nonempty(),
    grants: grantsSchema,
    accepted_validation_ids: idsSchema,
    descriptor_digest: shaSchema,
    implementation_digest: shaSchema,
    implementation_scheme: z.literal('promotion-implementation-v1'),
    registry_before_digest: shaSchema,
    effective_projection_digest: shaSchema,
    predecessor: z
      .strictObject({
        id: shaSchema,
        sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        decision: z.enum(decisions)
      })
      .nullable(),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    decision: z.enum(decisions),
    reason: z.enum([
      'scoped_approval',
      'qualification_withdrawn',
      'maintenance_ended',
      'authority_withdrawn',
      'confirmed_incompatibility',
      'authority_deleted'
    ]),
    prior_deny_ids: idsSchema,
    independent_review_ids: idsSchema.nonempty(),
    authorization_reference_ids: idsSchema.nonempty()
  })
  .refine(value => {
    if (canonical(value.scope) !== canonical(value.proposed_scope) || value.grants.some(grant => !value.requested_grants.includes(grant))) return false;
    if (value.grants.includes('children') && value.scope.lane.topology === 'root') return false;
    if (value.sequence !== (value.predecessor ? value.predecessor.sequence + 1 : 1) || value.predecessor?.decision === 'delete') return false;
    const reason = {
      approve: 'scoped_approval',
      demote: 'qualification_withdrawn',
      retire: 'maintenance_ended',
      revoke: 'authority_withdrawn',
      invalidate: 'confirmed_incompatibility',
      delete: 'authority_deleted'
    }[value.decision];
    if (value.reason !== reason) return false;
    if (value.decision !== 'approve') return value.predecessor !== null;
    return (
      value.grants.length > 0 &&
      value.accepted_validation_ids.length > 0 &&
      value.prior_deny_ids.length === 0 &&
      (!value.predecessor || value.predecessor.decision === 'approve')
    );
  })
  .refine(fits);
function parsePortable(input, schema) {
  if (typeof input !== 'string') return boundedParse(input, schema);
  if (Buffer.byteLength(input) > maxRecordBytes) fail('record_too_large');
  let value;
  try {
    value = JSON.parse(input);
  } catch {
    return fail('invalid_record');
  }
  if (canonical(value) !== input) fail('non_canonical_record');
  return boundedParse(value, schema);
}
export const parsePromotionProposal = input => parsePortable(input, promotionProposalSchema);
export const parsePromotionValidation = input => parsePortable(input, promotionValidationSchema);
export const parsePromotionDecision = input => parsePortable(input, promotionDecisionSchema);
