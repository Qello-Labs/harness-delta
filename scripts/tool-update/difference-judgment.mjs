import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { boundedParse, canonical, compareVersions, digest, fail, shaSchema } from './manifest.mjs';
import { z } from 'zod';
import { consumedContracts, engineDigestScheme, engineFiles, engineRevision, mapRevision, methods, requiredFacets } from './difference-contracts.mjs';
import { parseDifferenceEvidence, parseDifferenceJob, parseDifferenceJudgment } from './difference-records.mjs';

export async function judgmentEngineDigest(root) {
  const files = await Promise.all(
    engineFiles.map(async path => ({
      path,
      sha256: createHash('sha256')
        .update(await readFile(join(root, path)))
        .digest('hex')
    }))
  );
  return digest({
    scheme: engineDigestScheme,
    engine_revision: engineRevision,
    files
  });
}
const unique = values => [...new Set(values)].sort();
const sameRef = (a, b) => a.version === b.version && a.commit === b.commit;
const comparisonKey = comparison => canonical(comparison);
const reduce = values => (values.includes('affected') ? 'affected' : values.includes('unknown') ? 'unknown' : 'unaffected');

function chain(job, from, reasons) {
  if (!from) return [];
  const releases = job.inventory.releases.filter(
    ref => compareVersions(ref.version, from.version) >= 0 && compareVersions(ref.version, job.target.version) <= 0
  );
  const versions = new Map();
  for (const ref of releases) {
    const previous = versions.get(ref.version);
    if (previous) {
      reasons.push(previous.commit === ref.commit ? 'edge_duplicate' : 'edge_commit_conflict');
    }
    versions.set(ref.version, ref);
  }
  const start = versions.get(from.version);
  const end = versions.get(job.target.version);
  if (!start || !end) reasons.push('release_coverage_incomplete');
  if ((start && !sameRef(start, from)) || (end && !sameRef(end, job.target))) {
    reasons.push('edge_commit_conflict');
  }
  const ordered = [...versions.values()].sort((a, b) => compareVersions(a.version, b.version));
  return ordered.slice(1).map((to, index) => ({
    comparison_kind: 'adjacent_release',
    from: ordered[index],
    to
  }));
}
function coverage(job, evidence) {
  const reasons = [];
  if (!job.baseline_row) reasons.push('baseline_missing');
  if (!job.parser_base) reasons.push('parser_base_missing');
  if (job.inventory.coverage !== 'complete') {
    reasons.push('release_coverage_incomplete');
  }
  const comparisons = [...chain(job, job.baseline_row?.ref, reasons), ...chain(job, job.parser_base, reasons)];
  if (job.parser_base) {
    comparisons.push({
      comparison_kind: 'parser_base',
      from: {
        version: job.parser_base.version,
        commit: job.parser_base.commit
      },
      to: job.target
    });
  }
  const required = [...new Map(comparisons.map(row => [comparisonKey(row), row])).values()];
  for (const comparison of required) {
    const matches = evidence.filter(row => comparisonKey(row.record.comparison) === comparisonKey(comparison));
    if (matches.length === 0) {
      reasons.push(comparison.comparison_kind === 'parser_base' ? 'comparison_missing' : 'edge_missing');
    }
    const methodKeys = matches.map(row => row.record.method);
    if (new Set(methodKeys).size !== methodKeys.length) {
      reasons.push('edge_duplicate');
    }
    if (
      evidence.some(
        ({ record }) =>
          record.comparison.comparison_kind === comparison.comparison_kind &&
          record.comparison.from.version === comparison.from.version &&
          record.comparison.to.version === comparison.to.version &&
          (!sameRef(record.comparison.from, comparison.from) || !sameRef(record.comparison.to, comparison.to))
      )
    ) {
      reasons.push('edge_commit_conflict');
    }
  }
  return { comparisons: required, reasons: unique(reasons) };
}
function freshness(job, evidence, current) {
  const reasons = [];
  if (job.source_digest !== current.source_digest || evidence.source_digest !== current.source_digest) reasons.push('stale_source');
  if (
    job.engine_digest !== current.engine_digest ||
    evidence.engine_digest !== current.engine_digest ||
    job.engine_revision !== engineRevision ||
    evidence.engine_revision !== engineRevision
  ) {
    reasons.push('stale_engine');
  }
  if (job.map_revision !== current.map_revision || evidence.map_revision !== current.map_revision) reasons.push('stale_map');
  if (job.evidence_snapshot.policy_revision !== 'closed-windows-v1' || evidence.policy_revision !== 'closed-windows-v1') {
    reasons.push('stale_policy');
  }
  if (evidence.capability_revision !== 'difference-capability-v1') {
    reasons.push('stale_evidence');
  }
  return reasons;
}
function evaluate(job, record, finding, current) {
  const stale = freshness(job, record, current);
  if (stale.length) {
    return { result: 'unknown', reasons: stale, impact: 'undetermined' };
  }
  const method = methods[record.method];
  if (!method.facets.includes(finding.facet) || (method.product !== null && method.product !== job.lane.product)) {
    return {
      result: 'unknown',
      reasons: ['method_inapplicable'],
      impact: 'undetermined'
    };
  }
  if (record.availability !== 'available') {
    return {
      result: 'unknown',
      reasons: ['pinned_material_absent'],
      impact: 'undetermined'
    };
  }
  if (record.extraction_completeness !== 'complete') {
    return {
      result: 'unknown',
      reasons: [record.extraction_completeness === 'unsupported' ? 'unsupported_extractor' : 'extraction_incomplete'],
      impact: 'undetermined'
    };
  }
  if (finding.result === 'unaffected' && record.method === 'codex_source_identity' && record.from_content_hash !== record.to_content_hash) {
    return {
      result: 'unknown',
      reasons: ['source_changed_impact_unknown'],
      impact: 'undetermined'
    };
  }
  if (finding.result === 'unaffected' && record.reasons.some(reason => reason !== 'established_unchanged')) {
    return {
      result: 'unknown',
      reasons: record.reasons,
      impact: 'undetermined'
    };
  }
  return {
    result: finding.result,
    reasons: unique([finding.reason, ...record.reasons]),
    impact: finding.impact
  };
}
function facetResult(job, contractId, facet, evidence, comparisons, coverageReasons, current) {
  const pending = facet === 'native_execution' ? 'native_validation_pending' : facet === 'backend_counter_meaning' ? 'backend_validation_pending' : null;
  if (pending) {
    return {
      facet,
      result: 'unknown',
      methods: [],
      evidence_ids: [],
      reasons: [pending],
      impacts: ['undetermined']
    };
  }
  const reasons = [...coverageReasons];
  const results = [];
  const usedMethods = [];
  const usedIds = [];
  const impacts = [];
  for (const comparison of comparisons) {
    const proofs = [];
    for (const { record, id } of evidence.filter(row => comparisonKey(row.record.comparison) === comparisonKey(comparison))) {
      for (const finding of record.findings.filter(row => row.contract_id === contractId && row.facet === facet)) {
        const result = evaluate(job, record, finding, current);
        usedMethods.push(record.method);
        usedIds.push(id);
        impacts.push(result.impact);
        reasons.push(...result.reasons);
        proofs.push({
          ...result,
          establishes: methods[record.method].establishesUnchanged
        });
      }
    }
    if (proofs.length === 0) {
      results.push('unknown');
      reasons.push('evidence_missing');
      continue;
    }
    const result = reduce(proofs.map(proof => proof.result));
    if (result === 'unaffected' && !proofs.some(proof => proof.establishes)) {
      results.push('unknown');
      reasons.push(job.lane.product === 'claude_code' && usedMethods.includes('claude_pinned_documentation') ? 'undocumented_contract' : 'synthetic_only');
    } else results.push(result);
    if (proofs.some(proof => proof.result === 'affected') && proofs.some(proof => proof.result === 'unaffected')) {
      reasons.push('conflicting_evidence');
    }
  }
  if (coverageReasons.length || comparisons.length === 0) {
    results.push('unknown');
  }
  return {
    facet,
    result: reduce(results),
    methods: unique(usedMethods),
    evidence_ids: unique(usedIds),
    reasons: unique(reasons),
    impacts: unique(impacts.length ? impacts : ['undetermined'])
  };
}
function groupResult(job, contractId, evidence, covered, current) {
  const facets = requiredFacets(contractId, job.lane).map(facet =>
    facetResult(job, contractId, facet, evidence, covered.comparisons, covered.reasons, current)
  );
  const result = reduce(facets.map(facet => facet.result));
  const validation = [];
  if (facets.some(row => row.reasons.includes('native_validation_pending'))) validation.push('native_execution', 'real_session');
  if (facets.some(row => row.reasons.includes('backend_validation_pending'))) validation.push('backend_counter_meaning');
  if (covered.reasons.length) validation.push('coverage_review');
  if (facets.some(row => row.reasons.some(reason => reason.startsWith('stale_')))) validation.push('fresh_evidence');
  if (result !== 'unaffected') {
    validation.push('source_review', 'synthetic_replay');
  }
  return {
    contract_id: contractId,
    result,
    facets: facets.map(({ impacts: ignored, ...facet }) => {
      void ignored;
      return facet;
    }),
    impacts: unique(facets.flatMap(facet => facet.impacts)),
    required_validation: unique(validation),
    variant_requirement: result === 'affected' ? 'named_variant_review_required' : result === 'unknown' ? 'undetermined' : 'none_established',
    eligibility_recommendation: result === 'affected' ? 'blocked_by_affected_contract' : result === 'unknown' ? 'validation_pending' : 'ready_for_scoped_review'
  };
}
const currentSchema = z.strictObject({
  source_digest: shaSchema,
  engine_digest: shaSchema,
  map_revision: z.literal(mapRevision)
});
export function judgeDifferences(jobInput, evidenceInputs, identities) {
  const job = parseDifferenceJob(jobInput);
  const current = boundedParse(identities, currentSchema);
  const jobId = digest(job);
  const evidence = evidenceInputs
    .map(input => {
      const record = parseDifferenceEvidence(input);
      if (record.job_id !== jobId) fail('difference_job_mismatch');
      if (record.material.kind === 'official' && record.material.repository_id !== job.repository_id) {
        fail('difference_identity_mismatch');
      }
      if (record.method === 'synthetic_parser_provider_replay' ? record.material.kind !== 'synthetic' : record.material.kind !== 'official') {
        fail('difference_identity_mismatch');
      }
      if (record.material.kind === 'official' && record.material.path_id !== methods[record.method].pathId) fail('difference_identity_mismatch');
      return { record, id: digest(record) };
    })
    .sort((a, b) => a.id.localeCompare(b.id, 'en'));
  const covered = coverage(job, evidence);
  covered.reasons = unique([
    ...covered.reasons,
    ...freshness(
      job,
      {
        ...job,
        policy_revision: job.evidence_snapshot.policy_revision,
        capability_revision: 'difference-capability-v1'
      },
      current
    )
  ]);
  if (job.baseline_row && job.baseline_row.source_digest !== current.source_digest) covered.reasons = unique([...covered.reasons, 'stale_source']);
  return parseDifferenceJudgment({
    ...job,
    ...current,
    engine_revision: engineRevision,
    schema_version: 1,
    kind: 'difference_judgment',
    job_id: jobId,
    evidence_ids: unique(evidence.map(row => row.id)),
    comparisons: covered.comparisons,
    coverage_reasons: covered.reasons,
    groups: consumedContracts.map(contractId => groupResult(job, contractId, evidence, covered, current))
  });
}
