import type { z } from 'zod';
import type { laneSchema } from './lanes.mjs';
import type { Comparison, ReleaseRef } from './difference-records.mjs';
import type { ContractId, Facet } from './difference-contracts.mjs';

export type PromotionEvidenceClass =
  'static' | 'synthetic' | 'pinned_upstream_comparison' | 'actual_target_binary_conformance' | 'native_trial' | 'real_session';
export type PromotionGateId = 'G01' | 'G02' | 'G03' | 'G04' | 'G05' | 'G06' | 'G07' | 'G08' | 'G09' | 'G10' | 'G11' | 'G12';
export type PromotionState = 'blocked' | 'pending_pre_release' | 'ready_for_decision' | 'review_needed';
export type PromotionGrant = 'admission' | 'qualification' | 'children';
export interface PromotionScope {
  readonly target: ReleaseRef;
  readonly lane: z.infer<typeof laneSchema>;
  readonly platform: 'darwin_arm64' | 'darwin_x64' | 'linux_arm64' | 'linux_x64' | 'win32_x64';
  readonly runtime: 'node24' | 'node26';
}
export interface PromotionCoverage {
  readonly baseline_status: 'present' | 'missing';
  readonly baseline_digest: string | null;
  readonly baseline_ref: ReleaseRef | null;
  readonly parser_base: ReleaseRef | null;
  readonly releases: readonly ReleaseRef[];
  readonly complete: boolean;
  readonly comparisons: readonly Comparison[];
}
export interface PromotionProof {
  readonly evidence_id: string;
  readonly scope_digest: string;
  readonly evidence_class: PromotionEvidenceClass;
  readonly result: 'pass' | 'fail' | 'unknown';
  readonly freshness: 'current' | 'stale';
  readonly contract_id: ContractId | null;
  readonly facet: Facet | null;
}
export interface PromotionGate {
  readonly gate_id: PromotionGateId;
  readonly required_classes: readonly PromotionEvidenceClass[];
  readonly evidence: readonly PromotionProof[];
}
export interface PromotionContract {
  readonly contract_id: ContractId;
  readonly facets: readonly {
    readonly facet: Facet;
    readonly result: 'unaffected' | 'affected' | 'unknown';
    readonly required_classes: readonly PromotionEvidenceClass[];
  }[];
}
export interface PromotionGateInput {
  readonly scope: PromotionScope;
  readonly requested_grants: readonly PromotionGrant[];
  readonly required_validation: readonly PromotionEvidenceClass[];
  readonly coverage: PromotionCoverage;
  readonly contracts: readonly PromotionContract[];
  readonly gate_matrix: readonly PromotionGate[];
  readonly unresolved_finding_ids: readonly string[];
}
export type PromotionReason =
  | 'evidence_missing'
  | 'baseline_missing'
  | 'parser_base_missing'
  | 'edge_missing'
  | 'coverage_incomplete'
  | 'affected_contract'
  | 'unknown_contract'
  | 'stale_evidence'
  | 'pre_release_pending'
  | 'review_required'
  | 'scoped_approval'
  | 'qualification_withdrawn'
  | 'maintenance_ended'
  | 'authority_withdrawn'
  | 'confirmed_incompatibility'
  | 'authority_deleted'
  | 'target_refused';
export interface PromotionReconciliation {
  readonly predecessor_proposal_ids: readonly string[];
  readonly originating_grant_ids: readonly string[];
  readonly current_grant_ids: readonly string[];
  readonly coverage_mapping_ids: readonly string[];
  readonly descriptor_lineage_ids: readonly string[];
  readonly matched_scope: PromotionScope;
  readonly matched_contracts: readonly ContractId[];
  readonly matched_facets: readonly Facet[];
  readonly triggering_judgment_ids: readonly string[];
  readonly unresolved_findings: readonly {
    readonly finding_id: string;
    readonly judgment_id: string;
    readonly proposal_id: string;
    readonly reason: 'affected_contract' | 'unknown_contract' | 'stale_evidence' | 'review_required';
  }[];
}
export interface PromotionProposal extends Omit<PromotionGateInput, 'unresolved_finding_ids'> {
  readonly schema_version: 1;
  readonly kind: 'promotion_proposal';
  readonly authority: 'none';
  readonly state: PromotionState;
  readonly selection_reason: 'release_candidate' | 'consumed_contract_fix' | 'explicit_operator_need';
  readonly selection_reference: string;
  readonly original_lanes: readonly z.infer<typeof laneSchema>[];
  readonly coverage_mapping_ids: readonly string[];
  readonly candidate_id: string;
  readonly observation_id: string;
  readonly assessment_ids: readonly string[];
  readonly job_ids: readonly string[];
  readonly judgment_ids: readonly string[];
  readonly descriptor_digest: string;
  readonly variant_digest: string | null;
  readonly registry_before_digest: string;
  readonly proposed_projection_digest: string;
  readonly identities: {
    readonly source_digest: string;
    readonly judgment_engine_digest: string;
    readonly promotion_engine_digest: string;
    readonly promotion_engine_revision: 'promotion-engine-v1';
    readonly policy_revision: 'closed-windows-v1';
    readonly map_revision: 'difference-map-v2';
    readonly contract_revision: 'consumed-v1';
    readonly implementation_scheme: 'promotion-implementation-v1';
    readonly evidence_revision: 'promotion-evidence-v1';
  };
  readonly reasons: readonly PromotionReason[];
  readonly reconciliation: PromotionReconciliation | null;
}
export interface PromotionValidation {
  readonly schema_version: 1;
  readonly kind: 'promotion_validation';
  readonly authority: 'none';
  readonly proposal_id: string;
  readonly scope: PromotionScope;
  readonly descriptor_digest: string;
  readonly evidence_revision: 'promotion-evidence-v1';
  readonly evidence_class: PromotionEvidenceClass;
  readonly evidence_origin: 'static' | 'synthetic' | 'pinned' | 'actual';
  readonly result: 'pass' | 'fail' | 'unknown';
  readonly accepted_result_ids: readonly string[];
  readonly pins: {
    readonly image: string | null;
    readonly component: string | null;
    readonly build: string | null;
    readonly instrument: string | null;
    readonly implementation: string | null;
    readonly runtime: string | null;
    readonly model: string | null;
  };
  readonly implementation_scheme: 'promotion-implementation-v1';
  readonly scenario: 'normal' | 'interrupted' | 'replacement' | 'cleanup' | 'scope_denial' | 'replay' | 'counter_attribution' | 'child_lifecycle';
  readonly outcomes: readonly {
    readonly metric: 'event_count' | 'input_tokens' | 'output_tokens' | 'cached_input_tokens' | 'reasoning_tokens' | 'request_count' | 'violation_count';
    readonly status: 'observed' | 'missing' | 'error' | 'excluded' | 'unmeasurable';
    readonly value: number | null;
  }[];
  readonly limitations: readonly (
    'synthetic_only' | 'partial_coverage' | 'model_specific' | 'platform_specific' | 'ownership_unverified' | 'delivery_unverified'
  )[];
  readonly reviewer_reference: string | null;
  readonly unresolved_requirements: readonly PromotionEvidenceClass[];
}
export type PromotionDecisionAction = 'approve' | 'demote' | 'retire' | 'revoke' | 'invalidate' | 'delete';
export interface PromotionDecision {
  readonly schema_version: 1;
  readonly kind: 'promotion_decision';
  readonly authority: 'none';
  readonly proposal_id: string;
  readonly scope: PromotionScope;
  readonly proposed_scope: PromotionScope;
  readonly requested_grants: readonly PromotionGrant[];
  readonly grants: readonly PromotionGrant[];
  readonly accepted_validation_ids: readonly string[];
  readonly descriptor_digest: string;
  readonly implementation_digest: string;
  readonly implementation_scheme: 'promotion-implementation-v1';
  readonly registry_before_digest: string;
  readonly effective_projection_digest: string;
  readonly predecessor: { readonly id: string; readonly sequence: number; readonly decision: PromotionDecisionAction } | null;
  readonly sequence: number;
  readonly decision: PromotionDecisionAction;
  readonly reason:
    'scoped_approval' | 'qualification_withdrawn' | 'maintenance_ended' | 'authority_withdrawn' | 'confirmed_incompatibility' | 'authority_deleted';
  readonly prior_deny_ids: readonly string[];
  readonly independent_review_ids: readonly string[];
  readonly authorization_reference_ids: readonly string[];
}
export const promotionScopeSchema: z.ZodType<PromotionScope>;
export const promotionGateInputSchema: z.ZodType<PromotionGateInput>;
export const promotionProposalSchema: z.ZodType<PromotionProposal>;
export const promotionValidationSchema: z.ZodType<PromotionValidation>;
export const promotionDecisionSchema: z.ZodType<PromotionDecision>;
export const promotionEvidenceClasses: readonly PromotionEvidenceClass[];
export const promotionGateIds: readonly PromotionGateId[];
export const promotionEngineFiles: readonly string[];
export const promotionEngineRevision: 'promotion-engine-v1';
export const promotionEngineDigestScheme: 'promotion-engine-files-sha256-v1';
export function promotionEngineDigest(root: string): Promise<string>;
export function parsePromotionProposal(input: unknown): PromotionProposal;
export function parsePromotionValidation(input: unknown): PromotionValidation;
export function parsePromotionDecision(input: unknown): PromotionDecision;
