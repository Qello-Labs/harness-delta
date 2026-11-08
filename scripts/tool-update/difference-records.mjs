import { z } from 'zod';
import { boundedParse, canonical, compareVersions, digest, maxRecordBytes, shaSchema, versionSchema } from './manifest.mjs';
import { laneKey, laneSchema } from './lanes.mjs';
import {
  consumedContracts,
  contractRevision,
  deferredValidation,
  eligibilityRecommendations,
  facets,
  impacts,
  methods,
  reasonCodes,
  requiredFacets,
  requiredValidations,
  variantRequirements
} from './difference-contracts.mjs';

const commitSchema = z.string().regex(/^[a-f0-9]{40}$/);
const refSchema = z.strictObject({
  version: versionSchema,
  commit: commitSchema
});
const sortedUnique = values => values.every((value, index) => index === 0 || value > values[index - 1]);
const idsSchema = z.array(shaSchema).max(256).refine(sortedUnique);
const reasonsSchema = z.array(z.enum(reasonCodes)).max(reasonCodes.length).refine(sortedUnique);
const mapSchema = z.enum(['difference-map-v0', 'difference-map-v1']);
const engineRevisionSchema = z.enum(['difference-engine-v0', 'difference-engine-v1']);
const comparisonFields = {
  comparison_kind: z.enum(['adjacent_release', 'parser_base']),
  from: refSchema,
  to: refSchema
};
const comparisonSchema = z
  .strictObject(comparisonFields)
  .refine(
    value =>
      versionSchema.safeParse(value.from.version).success &&
      versionSchema.safeParse(value.to.version).success &&
      compareVersions(value.from.version, value.to.version) <= 0 &&
      (value.from.version !== value.to.version || value.from.commit === value.to.commit)
  );
const pinSchema = z
  .strictObject({
    applicability: z.enum(['not_applicable', 'unavailable', 'applicable']),
    digest: shaSchema.nullable()
  })
  .refine(value => (value.applicability === 'applicable') === (value.digest !== null));
const pinsSchema = z.strictObject({
  build: pinSchema,
  native_pin: pinSchema,
  artifact: pinSchema
});
const snapshotSchema = z.strictObject({
  policy_revision: z.enum(['closed-windows-v0', 'closed-windows-v1']),
  windows: z.literal('closed'),
  actual_evidence: z.literal('deferred_pre_release'),
  evidence_mode: z.enum(['static', 'source_only', 'pid_start_disk_pin']),
  version_basis: z.enum(['pinned_release', 'creation_header']),
  lifecycle_policy: z.enum(['static', 'frozen_root']),
  writer_ownership: z.literal('unverified'),
  root_ownership: z.literal('unverified'),
  native_image: z.enum(['unavailable', 'not_required']),
  publisher_proof: z.enum(['unavailable', 'disk_pin_policy', 'not_required']),
  process_proof: z.enum(['unavailable', 'pid_start_policy', 'not_required']),
  mapped_image_proof: z.enum(['unverified', 'not_required'])
});
const identities = {
  source_digest: shaSchema,
  engine_digest: shaSchema,
  map_revision: mapSchema,
  engine_revision: engineRevisionSchema,
  contract_revision: z.literal(contractRevision)
};
const baselineRowSchema = laneSchema.extend({
  ref: refSchema,
  source_digest: shaSchema,
  evidence_ids: idsSchema.nonempty()
});
const jobFields = {
  ...identities,
  candidate_id: shaSchema,
  observation_id: shaSchema,
  observation_candidate_id: shaSchema,
  repository_id: z.enum(['openai_codex', 'anthropics_claude_code']),
  lane: laneSchema,
  baseline_digest: shaSchema.nullable(),
  baseline_row: baselineRowSchema.nullable(),
  parser_base: refSchema.extend({ profile_id: laneSchema.shape.profile_id }).nullable(),
  target: refSchema,
  comparison: comparisonSchema.nullable(),
  inventory: z.strictObject({
    inventory_id: shaSchema,
    scope: z.enum(['latest_and_npm_review_range', 'parser_comparison_range', 'synthetic_review_range']),
    coverage: z.enum(['complete', 'incomplete']),
    releases: z.array(refSchema).min(1).max(256)
  }),
  evidence_snapshot: snapshotSchema,
  pins: pinsSchema,
  reasons: reasonsSchema
};
const sameRef = (a, b) => a.version === b.version && a.commit === b.commit;
function comparisonChain(job, from, reasons) {
  if (!from) return [];
  const releases = job.inventory.releases.filter(
    ref => compareVersions(ref.version, from.version) >= 0 && compareVersions(ref.version, job.target.version) <= 0
  );
  const versions = new Map();
  for (const ref of releases) {
    const previous = versions.get(ref.version);
    if (previous) reasons.push(previous.commit === ref.commit ? 'edge_duplicate' : 'edge_commit_conflict');
    versions.set(ref.version, ref);
  }
  const start = versions.get(from.version);
  const end = versions.get(job.target.version);
  if (!start || !end) reasons.push('release_coverage_incomplete');
  if ((start && !sameRef(start, from)) || (end && !sameRef(end, job.target))) reasons.push('edge_commit_conflict');
  const ordered = [...versions.values()].sort((a, b) => compareVersions(a.version, b.version));
  return ordered.slice(1).map((to, index) => ({ comparison_kind: 'adjacent_release', from: ordered[index], to }));
}
export function requiredDifferenceCoverage(job) {
  const reasons = [];
  if (!job.baseline_row) reasons.push('baseline_missing');
  if (!job.parser_base) reasons.push('parser_base_missing');
  if (job.inventory.coverage !== 'complete') reasons.push('release_coverage_incomplete');
  const comparisons = [...comparisonChain(job, job.baseline_row?.ref, reasons), ...comparisonChain(job, job.parser_base, reasons)];
  if (job.parser_base)
    comparisons.push({
      comparison_kind: 'parser_base',
      from: { version: job.parser_base.version, commit: job.parser_base.commit },
      to: job.target
    });
  return {
    comparisons: [...new Map(comparisons.map(row => [canonical(row), row])).values()],
    reasons: [...new Set(reasons)].sort()
  };
}
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
  const topology = lane.profile_id.includes('-direct-child-') ? 'root_direct_child' : 'root';
  const operations = lane.product === 'codex' ? ['launch', 'link', 'collect', 'resume'] : ['launch', 'resume'];
  return lane.topology === topology && operations.includes(lane.operation);
}
function validSnapshot(value) {
  const snapshot = value.evidence_snapshot;
  switch (snapshot.evidence_mode) {
    case 'static':
      return (
        snapshot.version_basis === 'pinned_release' &&
        snapshot.lifecycle_policy === 'static' &&
        snapshot.native_image === 'not_required' &&
        snapshot.publisher_proof === 'not_required' &&
        snapshot.process_proof === 'not_required' &&
        snapshot.mapped_image_proof === 'not_required' &&
        Object.values(value.pins).every(pin => pin.applicability === 'not_applicable')
      );
    case 'source_only':
      return (
        value.lane.product === 'codex' &&
        snapshot.version_basis === 'creation_header' &&
        snapshot.lifecycle_policy === 'frozen_root' &&
        snapshot.native_image === 'unavailable' &&
        snapshot.publisher_proof === 'not_required' &&
        snapshot.process_proof === 'not_required' &&
        snapshot.mapped_image_proof === 'not_required' &&
        value.pins.native_pin.applicability !== 'applicable'
      );
    case 'pid_start_disk_pin':
      return (
        value.lane.product === 'claude_code' &&
        snapshot.version_basis === 'creation_header' &&
        snapshot.lifecycle_policy === 'frozen_root' &&
        snapshot.native_image === 'unavailable' &&
        snapshot.publisher_proof === 'disk_pin_policy' &&
        snapshot.process_proof === 'pid_start_policy' &&
        snapshot.mapped_image_proof === 'unverified' &&
        value.pins.native_pin.applicability !== 'applicable'
      );
  }
}
function validJob(value) {
  if (![value.target, value.parser_base, value.baseline_row?.ref].filter(Boolean).every(ref => versionSchema.safeParse(ref.version).success)) return false;
  if (value.candidate_id !== value.observation_candidate_id || !validLane(value.lane) || !validSnapshot(value)) return false;
  if (value.repository_id !== (value.lane.product === 'codex' ? 'openai_codex' : 'anthropics_claude_code')) return false;
  if ((value.baseline_digest === null) !== (value.baseline_row === null)) {
    return false;
  }
  if ((value.baseline_row === null) !== value.reasons.includes('baseline_missing')) return false;
  if (
    value.baseline_row &&
    (laneKey(value.baseline_row) !== laneKey(value.lane) || compareVersions(value.baseline_row.ref.version, value.target.version) > 0)
  ) {
    return false;
  }
  if (value.parser_base && (value.parser_base.profile_id !== value.lane.profile_id || compareVersions(value.parser_base.version, value.target.version) > 0)) {
    return false;
  }
  if (
    value.parser_base &&
    value.lane.profile_id.endsWith('-root-window-v1') &&
    value.parser_base.version !== (value.lane.product === 'codex' ? '0.163.0' : '2.1.306')
  ) {
    return false;
  }
  if (value.comparison) {
    const from = value.comparison.comparison_kind === 'parser_base' ? value.parser_base : value.baseline_row?.ref;
    if (!from || !sameRef(from, value.comparison.from) || !sameRef(value.target, value.comparison.to)) return false;
  } else if (value.baseline_row || value.parser_base) return false;
  return true;
}
const fits = value => Buffer.byteLength(canonical(value)) <= maxRecordBytes;
export const differenceJobSchema = z
  .strictObject({
    schema_version: z.literal(1),
    kind: z.literal('difference_job'),
    ...jobFields
  })
  .refine(validJob, { message: 'invalid_difference_job' })
  .refine(fits, {
    message: 'record_too_large'
  });

const factSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('number'),
    value: z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER).nullable()
  }),
  z.strictObject({
    kind: z.literal('field_shape'),
    value: z.enum(['absent', 'string', 'integer', 'number', 'boolean', 'object', 'array', 'nullable', 'string_enum'])
  })
]);
const findingSchema = z
  .strictObject({
    contract_id: z.enum(consumedContracts),
    facet: z.enum(facets),
    result: z.enum(['unaffected', 'affected', 'unknown']),
    reason: z.enum(reasonCodes),
    impact: z.enum(impacts),
    field_id: z
      .enum([
        'version',
        'request_id',
        'input_tokens',
        'cached_input_tokens',
        'reasoning_tokens',
        'terminal_id',
        'parent_id',
        'permission_mode',
        'model',
        'effort',
        'checkpoint',
        'hook_event'
      ])
      .nullable(),
    expected: factSchema.nullable(),
    actual: factSchema.nullable()
  })
  .refine(value => {
    if ((value.field_id === null) !== (value.expected === null && value.actual === null)) return false;
    switch (value.result) {
      case 'unaffected':
        return canonical(value.expected) === canonical(value.actual) && value.reason === 'established_unchanged' && value.impact === 'none_established';
      case 'affected':
        return ['confirmed_contract_change', 'confirmed_contradiction'].includes(value.reason) && !['none_established', 'undetermined'].includes(value.impact);
      case 'unknown':
        return !['established_unchanged', 'confirmed_contract_change', 'confirmed_contradiction'].includes(value.reason) && value.impact === 'undetermined';
    }
  });
const materialSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('official'),
    repository_id: z.enum(['openai_codex', 'anthropics_claude_code']),
    path_id: z.enum(['source_closure', 'serialized_schema', 'release_documentation']),
    from_commit: commitSchema,
    to_commit: commitSchema
  }),
  z.strictObject({
    kind: z.literal('synthetic'),
    fixture_id: z.enum(['parser_provider_v1', 'field_shapes_v1', 'counter_ledger_v1', 'lifecycle_v1']),
    scenario_id: z.enum(['unchanged', 'shape_change', 'counter_change', 'replay_conflict', 'missing_usage', 'interrupted']),
    fixture_digest: shaSchema,
    harness_digest: shaSchema
  })
]);
export const differenceEvidenceSchema = z
  .strictObject({
    schema_version: z.literal(1),
    kind: z.literal('difference_evidence'),
    job_id: shaSchema,
    ...identities,
    policy_revision: snapshotSchema.shape.policy_revision,
    method: z.enum(Object.keys(methods)),
    capability_revision: z.enum(['difference-capability-v0', 'difference-capability-v1']),
    comparison: comparisonSchema,
    material: materialSchema,
    from_content_hash: shaSchema.nullable(),
    to_content_hash: shaSchema.nullable(),
    availability: z.enum(['available', 'absent', 'failed']),
    extraction_completeness: z.enum(['complete', 'incomplete', 'unsupported']),
    findings: z.array(findingSchema).max(128),
    reasons: reasonsSchema
  })
  .refine(
    value => {
      if (value.availability === 'available' && (value.from_content_hash === null || value.to_content_hash === null)) return false;
      if (value.availability !== 'available' && !value.reasons.includes('pinned_material_absent')) return false;
      if (
        value.material.kind === 'official' &&
        (value.material.from_commit !== value.comparison.from.commit || value.material.to_commit !== value.comparison.to.commit)
      ) {
        return false;
      }
      return new Set(value.findings.map(row => `${row.contract_id}:${row.facet}`)).size === value.findings.length;
    },
    { message: 'invalid_difference_evidence' }
  )
  .refine(fits, {
    message: 'record_too_large'
  });

const facetResultSchema = z
  .strictObject({
    facet: z.enum(facets),
    result: z.enum(['unaffected', 'affected', 'unknown']),
    methods: z
      .array(z.enum(Object.keys(methods)))
      .max(Object.keys(methods).length)
      .refine(sortedUnique),
    evidence_ids: idsSchema,
    reasons: reasonsSchema
  })
  .refine(value => value.result === 'unknown' || (value.methods.length > 0 && value.evidence_ids.length > 0));
const groupSchema = z.strictObject({
  contract_id: z.enum(consumedContracts),
  result: z.enum(['unaffected', 'affected', 'unknown']),
  facets: z.array(facetResultSchema).min(1).max(facets.length),
  impacts: z.array(z.enum(impacts)).min(1).max(impacts.length).refine(sortedUnique),
  required_validation: z.array(z.enum(requiredValidations)).max(requiredValidations.length).refine(sortedUnique),
  variant_requirement: z.enum(variantRequirements),
  eligibility_recommendation: z.enum(eligibilityRecommendations)
});
const reduce = values => (values.includes('affected') ? 'affected' : values.includes('unknown') ? 'unknown' : 'unaffected');
function validJudgmentCoverage(value) {
  if (!validJob(value) || !value.inventory.releases.every(ref => versionSchema.safeParse(ref.version).success)) return false;
  const required = requiredDifferenceCoverage(value);
  const comparisons = new Set(value.comparisons.map(row => canonical(row)));
  return (
    comparisons.size === value.comparisons.length &&
    comparisons.size === required.comparisons.length &&
    required.comparisons.every(row => comparisons.has(canonical(row))) &&
    required.reasons.every(reason => value.coverage_reasons.includes(reason))
  );
}
export const differenceJudgmentSchema = z
  .strictObject({
    schema_version: z.literal(1),
    kind: z.literal('difference_judgment'),
    ...jobFields,
    job_id: shaSchema,
    evidence_ids: idsSchema,
    comparisons: z.array(comparisonSchema).max(512),
    coverage_reasons: reasonsSchema,
    groups: z.array(groupSchema).length(consumedContracts.length)
  })
  .refine(validJob, { message: 'invalid_difference_job' })
  .refine(validJudgmentCoverage, { message: 'invalid_difference_coverage' })
  .refine(
    value =>
      value.groups.every((group, index) => {
        const required = requiredFacets(group.contract_id, value.lane);
        if (
          group.contract_id !== consumedContracts[index] ||
          group.facets.length !== required.length ||
          group.facets.some((facet, i) => facet.facet !== required[i] || facet.evidence_ids.some(id => !value.evidence_ids.includes(id)))
        ) {
          return false;
        }
        if (group.result !== reduce(group.facets.map(facet => facet.result))) return false;
        if (
          group.facets.some(
            facet =>
              facet.result !== 'unknown' &&
              facet.methods.some(
                method => !methods[method].facets.includes(facet.facet) || (methods[method].product !== null && methods[method].product !== value.lane.product)
              )
          )
        )
          return false;
        if (group.facets.some(facet => facet.result === 'unaffected' && !facet.methods.some(method => methods[method].establishesUnchanged))) return false;
        if (
          group.facets.some(facet => {
            const pending = deferredValidation[facet.facet];
            return (
              pending &&
              (facet.result !== 'unknown' ||
                !facet.reasons.includes(pending.reason) ||
                pending.requiredValidation.some(validation => !group.required_validation.includes(validation)))
            );
          })
        )
          return false;
        const recommendation =
          group.result === 'affected' ? 'blocked_by_affected_contract' : group.result === 'unknown' ? 'validation_pending' : 'ready_for_scoped_review';
        if (group.eligibility_recommendation !== recommendation) {
          return false;
        }
        const variant = group.result === 'affected' ? 'named_variant_review_required' : group.result === 'unknown' ? 'undetermined' : 'none_established';
        if (group.variant_requirement !== variant) return false;
        return group.result !== 'unaffected' || value.coverage_reasons.length === 0;
      }),
    { message: 'invalid_difference_judgment' }
  )
  .refine(fits, { message: 'record_too_large' });

export const parseDifferenceJob = input => boundedParse(input, differenceJobSchema);
export const parseDifferenceEvidence = input => boundedParse(input, differenceEvidenceSchema);
export const parseDifferenceJudgment = input => boundedParse(input, differenceJudgmentSchema);
export const differenceJobId = input => digest(parseDifferenceJob(input));
