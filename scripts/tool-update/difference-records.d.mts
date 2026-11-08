import type { z } from 'zod';
import type { laneSchema } from './lanes.mjs';
import type {
  ContractId,
  EligibilityRecommendation,
  Facet,
  Impact,
  Method,
  ReasonCode,
  RequiredValidation,
  Result,
  VariantRequirement
} from './difference-contracts.mjs';
export interface ReleaseRef {
  readonly version: string;
  readonly commit: string;
}
export interface Comparison {
  readonly comparison_kind: 'adjacent_release' | 'parser_base';
  readonly from: ReleaseRef;
  readonly to: ReleaseRef;
}
export interface DifferenceIdentities {
  readonly source_digest: string;
  readonly engine_digest: string;
  readonly map_revision: 'difference-map-v0' | 'difference-map-v1' | 'difference-map-v2';
  readonly engine_revision: 'difference-engine-v0' | 'difference-engine-v1';
  readonly contract_revision: 'consumed-v1';
}
export interface PinReference {
  readonly applicability: 'not_applicable' | 'unavailable' | 'applicable';
  readonly digest: string | null;
}
export interface EvidenceSnapshot {
  readonly policy_revision: 'closed-windows-v0' | 'closed-windows-v1';
  readonly windows: 'closed';
  readonly actual_evidence: 'deferred_pre_release';
  readonly evidence_mode: 'static' | 'source_only' | 'pid_start_disk_pin';
  readonly version_basis: 'pinned_release' | 'creation_header';
  readonly lifecycle_policy: 'static' | 'frozen_root';
  readonly writer_ownership: 'unverified';
  readonly root_ownership: 'unverified';
  readonly native_image: 'unavailable' | 'not_required';
  readonly publisher_proof: 'unavailable' | 'disk_pin_policy' | 'not_required';
  readonly process_proof: 'unavailable' | 'pid_start_policy' | 'not_required';
  readonly mapped_image_proof: 'unverified' | 'not_required';
}
export interface JobFields extends DifferenceIdentities {
  readonly candidate_id: string;
  readonly observation_id: string;
  readonly observation_candidate_id: string;
  readonly repository_id: 'openai_codex' | 'anthropics_claude_code';
  readonly lane: z.infer<typeof laneSchema>;
  readonly baseline_digest: string | null;
  readonly baseline_row:
    | (z.infer<typeof laneSchema> & {
        readonly ref: ReleaseRef;
        readonly source_digest: string;
        readonly evidence_ids: readonly string[];
      })
    | null;
  readonly parser_base: (ReleaseRef & { readonly profile_id: string }) | null;
  readonly target: ReleaseRef;
  readonly comparison: Comparison | null;
  readonly inventory: {
    readonly inventory_id: string;
    readonly scope: 'latest_and_npm_review_range' | 'parser_comparison_range' | 'synthetic_review_range';
    readonly coverage: 'complete' | 'incomplete';
    readonly releases: readonly ReleaseRef[];
  };
  readonly evidence_snapshot: EvidenceSnapshot;
  readonly pins: {
    readonly build: PinReference;
    readonly native_pin: PinReference;
    readonly artifact: PinReference;
  };
  readonly reasons: readonly ReasonCode[];
}
export interface DifferenceJob extends JobFields {
  readonly schema_version: 1;
  readonly kind: 'difference_job';
}
export type Fact =
  | { readonly kind: 'number'; readonly value: number | null }
  | {
      readonly kind: 'field_shape';
      readonly value: 'absent' | 'string' | 'integer' | 'number' | 'boolean' | 'object' | 'array' | 'nullable' | 'string_enum';
    };
export interface Finding {
  readonly contract_id: ContractId;
  readonly facet: Facet;
  readonly result: Result;
  readonly reason: ReasonCode;
  readonly impact: Impact;
  readonly field_id:
    | 'version'
    | 'request_id'
    | 'input_tokens'
    | 'cached_input_tokens'
    | 'reasoning_tokens'
    | 'terminal_id'
    | 'parent_id'
    | 'permission_mode'
    | 'model'
    | 'effort'
    | 'checkpoint'
    | 'hook_event'
    | null;
  readonly expected: Fact | null;
  readonly actual: Fact | null;
}
export type Material =
  | {
      readonly kind: 'official';
      readonly repository_id: 'openai_codex' | 'anthropics_claude_code';
      readonly path_id: 'source_closure' | 'serialized_schema' | 'release_documentation';
      readonly from_commit: string;
      readonly to_commit: string;
    }
  | {
      readonly kind: 'synthetic';
      readonly fixture_id: 'parser_provider_v1' | 'field_shapes_v1' | 'counter_ledger_v1' | 'lifecycle_v1';
      readonly scenario_id: 'unchanged' | 'shape_change' | 'counter_change' | 'replay_conflict' | 'missing_usage' | 'interrupted';
      readonly fixture_digest: string;
      readonly harness_digest: string;
    };
export interface DifferenceEvidence extends DifferenceIdentities {
  readonly schema_version: 1;
  readonly kind: 'difference_evidence';
  readonly job_id: string;
  readonly policy_revision: EvidenceSnapshot['policy_revision'];
  readonly method: Method;
  readonly capability_revision: 'difference-capability-v0' | 'difference-capability-v1';
  readonly comparison: Comparison;
  readonly material: Material;
  readonly from_content_hash: string | null;
  readonly to_content_hash: string | null;
  readonly availability: 'available' | 'absent' | 'failed';
  readonly extraction_completeness: 'complete' | 'incomplete' | 'unsupported';
  readonly findings: readonly Finding[];
  readonly reasons: readonly ReasonCode[];
}
export interface FacetResult {
  readonly facet: Facet;
  readonly result: Result;
  readonly methods: readonly Method[];
  readonly evidence_ids: readonly string[];
  readonly reasons: readonly ReasonCode[];
}
export interface GroupResult {
  readonly contract_id: ContractId;
  readonly result: Result;
  readonly facets: readonly FacetResult[];
  readonly impacts: readonly Impact[];
  readonly required_validation: readonly RequiredValidation[];
  readonly variant_requirement: VariantRequirement;
  readonly eligibility_recommendation: EligibilityRecommendation;
}
export interface DifferenceJudgment extends JobFields {
  readonly schema_version: 1;
  readonly kind: 'difference_judgment';
  readonly job_id: string;
  readonly evidence_ids: readonly string[];
  readonly comparisons: readonly Comparison[];
  readonly coverage_reasons: readonly ReasonCode[];
  readonly groups: readonly GroupResult[];
}
export const differenceJobSchema: z.ZodType<DifferenceJob>;
export const differenceEvidenceSchema: z.ZodType<DifferenceEvidence>;
export const differenceJudgmentSchema: z.ZodType<DifferenceJudgment>;
export function parseDifferenceJob(input: unknown): DifferenceJob;
export function parseDifferenceEvidence(input: unknown): DifferenceEvidence;
export function parseDifferenceJudgment(input: unknown): DifferenceJudgment;
export function differenceJobId(input: unknown): string;
export function requiredDifferenceCoverage(job: JobFields): {
  readonly comparisons: readonly Comparison[];
  readonly reasons: readonly ReasonCode[];
};
