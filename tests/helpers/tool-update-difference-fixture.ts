import { consumedContracts, requiredFacets } from '../../scripts/tool-update/difference-contracts.mjs';
import { differenceJobId } from '../../scripts/tool-update/difference-records.mjs';
import type { Comparison, DifferenceEvidence, DifferenceJob, Finding } from '../../scripts/tool-update/difference-records.mjs';

export const currentIdentities = {
  source_digest: 'a'.repeat(64),
  engine_digest: 'b'.repeat(64),
  map_revision: 'difference-map-v1'
} as const;
export const baseRef = { version: '0.163.0', commit: '1'.repeat(40) };
export const middleRef = { version: '0.164.0', commit: '2'.repeat(40) };
export const targetRef = { version: '0.165.0', commit: '3'.repeat(40) };
export function differenceJob(): DifferenceJob {
  const lane = {
    product: 'codex',
    route: 'codex_binding',
    profile_id: 'codex-binding-root-window-v1',
    operation: 'collect',
    topology: 'root'
  } as const;
  const absentPin = {
    applicability: 'not_applicable',
    digest: null
  } as const;
  return {
    schema_version: 1,
    kind: 'difference_job',
    ...currentIdentities,
    engine_revision: 'difference-engine-v1',
    contract_revision: 'consumed-v1',
    candidate_id: 'c'.repeat(64),
    observation_candidate_id: 'c'.repeat(64),
    observation_id: 'd'.repeat(64),
    repository_id: 'openai_codex',
    lane,
    baseline_digest: 'e'.repeat(64),
    baseline_row: {
      ...lane,
      ref: baseRef,
      source_digest: currentIdentities.source_digest,
      evidence_ids: ['f'.repeat(64)]
    },
    parser_base: { ...baseRef, profile_id: lane.profile_id },
    target: targetRef,
    comparison: {
      comparison_kind: 'adjacent_release',
      from: baseRef,
      to: targetRef
    },
    inventory: {
      inventory_id: '4'.repeat(64),
      scope: 'synthetic_review_range',
      coverage: 'complete',
      releases: [baseRef, middleRef, targetRef]
    },
    evidence_snapshot: {
      policy_revision: 'closed-windows-v1',
      windows: 'closed',
      actual_evidence: 'deferred_pre_release',
      evidence_mode: 'static',
      version_basis: 'pinned_release',
      lifecycle_policy: 'static',
      writer_ownership: 'unverified',
      root_ownership: 'unverified',
      native_image: 'not_required',
      publisher_proof: 'not_required',
      process_proof: 'not_required',
      mapped_image_proof: 'not_required'
    },
    pins: { build: absentPin, native_pin: absentPin, artifact: absentPin },
    reasons: []
  };
}
export function sourceEvidence(job = differenceJob()): DifferenceEvidence[] {
  const parser = job.parser_base ?? baseRef;
  const from = { version: parser.version, commit: parser.commit };
  const refs = job.inventory.releases;
  const comparisons: Comparison[] = refs.slice(1).map((to, index) => {
    const previous = refs[index];
    if (!previous) throw new Error('invalid_synthetic_inventory');
    return { comparison_kind: 'adjacent_release', from: previous, to };
  });
  comparisons.push({ comparison_kind: 'parser_base', from, to: job.target });
  const findings: Finding[] = consumedContracts.flatMap(contractId =>
    requiredFacets(contractId, job.lane)
      .filter(facet => !['native_execution', 'backend_counter_meaning'].includes(facet))
      .map(facet => ({
        contract_id: contractId,
        facet,
        result: 'unaffected',
        reason: 'established_unchanged',
        impact: 'none_established',
        field_id: null,
        expected: null,
        actual: null
      }))
  );
  return comparisons.map(comparison => ({
    schema_version: 1,
    kind: 'difference_evidence',
    ...currentIdentities,
    engine_revision: 'difference-engine-v1',
    contract_revision: 'consumed-v1',
    job_id: differenceJobId(job),
    policy_revision: 'closed-windows-v1',
    method: 'codex_source_identity',
    capability_revision: 'difference-capability-v1',
    comparison,
    material: {
      kind: 'official',
      repository_id: job.repository_id,
      path_id: 'source_closure',
      from_commit: comparison.from.commit,
      to_commit: comparison.to.commit
    },
    from_content_hash: '5'.repeat(64),
    to_content_hash: '5'.repeat(64),
    availability: 'available',
    extraction_completeness: 'complete',
    findings,
    reasons: []
  }));
}
