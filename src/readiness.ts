import { toolVersionProfiles } from './core/tool-version-profiles.js';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { IdSchema } from './contracts.js';
import { parseComparison } from './comparison-contracts.js';
import {
  FlexibleProtocolSchema,
  CostCoverageEvidenceSchema,
  CostCoverageDecisionSchema,
  type FlexibleProtocol,
  type CostCoverageEvidence,
  type CostCoverageDecision
} from './flexible-contracts.js';
import { evaluateCostCoverage } from './cost-coverage.js';
import { codexBindingAdmissions, isAdmittedCodexBindingProtocol } from './codex-binding-admission.js';
export interface ReadinessInput {
  protocol: FlexibleProtocol;
  source_evidence_ids: string[];
  coverage: { evidence: CostCoverageEvidence; decision: CostCoverageDecision }[];
  analysis_evidence_id: string | null;
  invalidated: boolean;
  followup_complete: boolean;
}
export interface SourceReadinessEvidence {
  id: string;
  product: 'synthetic' | 'codex' | 'claude_code';
  product_version: string;
  profile_id: string;
  semantics_digest: string;
  validation_kind: 'synthetic' | 'real_operations';
  complete_cost: boolean;
}
// Registries are code-owned evidence, never writable protocol flags or imported claims.
// Exact root workflow operational evidence; see validation/codex-workflow-01600-source-readiness.md.
// Separate exact root/direct-child partial sources; never complete cost or inference.
export const productionSourceEvidence: readonly SourceReadinessEvidence[] = Object.freeze([
  ...toolVersionProfiles
    .flatMap(profile =>
      (profile.readiness ?? [])
        .filter(evidence => profile.workflow?.some(workflow => workflow.status === 'admitted' && workflow.profileId === evidence.profileId))
        .map(evidence => ({ profile, evidence }))
    )
    .sort((a, b) => a.evidence.order - b.evidence.order)
    .map(({ profile, evidence }) =>
      Object.freeze({
        id: evidence.id,
        product: profile.product,
        product_version: profile.version,
        profile_id: evidence.profileId,
        semantics_digest: evidence.semanticsDigest,
        validation_kind: evidence.validationKind,
        complete_cost: evidence.completeCost
      })
    ),
  ...codexBindingAdmissions.flatMap(admission =>
    'qualified' in admission && !admission.qualified
      ? []
      : [
          Object.freeze({
            id: admission.evidenceId,
            product: 'codex' as const,
            product_version: admission.productVersion,
            profile_id: admission.profileId,
            semantics_digest: createHash('sha256').update(JSON.stringify(admission)).digest('hex'),
            validation_kind: 'real_operations' as const,
            complete_cost: false
          })
        ]
  )
]);
export const productionAnalysisEvidence: readonly string[] = Object.freeze([]);
export const syntheticSourceEvidence: readonly SourceReadinessEvidence[] = Object.freeze([
  Object.freeze({
    id: 'synthetic-flexible-v1',
    product: 'synthetic',
    product_version: '1.0.0',
    profile_id: 'synthetic-flexible-v1',
    semantics_digest: createHash('sha256').update('synthetic-flexible-v1:disjoint-components:request-boundaries').digest('hex'),
    validation_kind: 'synthetic',
    complete_cost: true
  })
]);
const schema = z.strictObject({
  protocol: FlexibleProtocolSchema,
  source_evidence_ids: z
    .array(IdSchema)
    .max(256)
    .refine(a => new Set(a).size === a.length),
  coverage: z.array(z.strictObject({ evidence: CostCoverageEvidenceSchema, decision: CostCoverageDecisionSchema })).max(10000),
  analysis_evidence_id: IdSchema.nullable(),
  invalidated: z.boolean(),
  followup_complete: z.boolean()
});
export function evaluateReadiness(input: ReadinessInput) {
  const i = parseComparison(schema, input, 'invalid_readiness');
  const reasons: string[] = [];
  const registry =
    i.protocol.purpose === 'synthetic_validation'
      ? syntheticSourceEvidence
      : productionSourceEvidence.filter(
          e => !codexBindingAdmissions.some(admission => e.profile_id === admission.profileId) || isAdmittedCodexBindingProtocol(i.protocol)
        );
  const sources = i.source_evidence_ids.map(id => registry.find(e => e.id === id));
  const sourceReady =
    sources.length > 0 &&
    sources.every(e => e !== undefined && /^[a-f0-9]{64}$/.test(e.semantics_digest)) &&
    i.protocol.source_profiles.every(p =>
      sources.some(e => e?.product === p.product && e.product_version === p.product_version && e.profile_id === p.profile_id)
    ) &&
    sources.every(e =>
      i.protocol.source_profiles.some(p => p.product === e?.product && p.product_version === e.product_version && p.profile_id === e.profile_id)
    );
  const real = i.protocol.purpose !== 'synthetic_validation' && sourceReady && sources.every(e => e?.validation_kind === 'real_operations') && !i.invalidated;
  if (i.protocol.purpose === 'functional_pilot') reasons.push('functional_pilot_only');
  if (!sourceReady) reasons.push('source_unverified');
  if (i.protocol.purpose === 'synthetic_validation') reasons.push('synthetic_only');
  const windows =
    i.coverage.length > 0 &&
    new Set(i.coverage.map(c => c.evidence.task_id)).size === i.coverage.length &&
    i.coverage.every(c => Date.parse(c.evidence.window_end) - Date.parse(c.evidence.window_start) === i.protocol.followup_seconds * 1000);
  const coverageReady =
    windows &&
    i.coverage.every(c => {
      const decision = evaluateCostCoverage(c.evidence);
      return decision.eligible && c.decision.eligible && c.decision.reasons.length === 0;
    });
  const complete = sourceReady && sources.every(e => e?.complete_cost) && coverageReady && i.followup_complete && !i.invalidated;
  if (!windows) reasons.push('coverage_scope_unverified');
  if (!coverageReady || (sourceReady && !sources.every(e => e?.complete_cost))) reasons.push('cost_incomplete');
  if (!i.followup_complete) reasons.push('followup_pending');
  if (i.invalidated) reasons.push('invalidated');
  // No continuous-money/repeated-assignee method has production validation.
  const analysis = i.analysis_evidence_id !== null && productionAnalysisEvidence.includes(i.analysis_evidence_id);
  if (!analysis) reasons.push('analysis_unverified');
  return {
    real_allocation: real,
    complete_cost: complete,
    inference: i.protocol.purpose === 'real_experiment' && real && complete && analysis,
    reasons: [...new Set(reasons)].sort()
  };
}
