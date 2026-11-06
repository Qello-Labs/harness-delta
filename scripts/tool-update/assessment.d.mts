import type { z } from 'zod';
import type { Lane } from './lanes.mjs';
import type { Release } from './discovery.mjs';
import type { Compatibility } from './source-snapshot.mjs';
export const consumedContracts: readonly [
  'identity_source_mapping', 'fields_types_enums', 'partial_rotation_checkpoint',
  'counters_cache_reasoning_reset_overflow', 'hooks_order_receipts_loading',
  'invocation_permissions_config_model_effort', 'history_topology_resume_compaction',
  'finality_replay_conflict_stop_flush_sigint',
];
export interface ContractCheck {
  readonly contract_id: typeof consumedContracts[number];
  readonly judgment: 'unaffected' | 'affected' | 'unknown';
}
export interface ContractReview extends Lane {
  readonly schema_version: 1;
  readonly kind: 'contract_review';
  readonly contract_revision: 'consumed-v1';
  readonly from: { readonly version: string; readonly commit: string };
  readonly to: { readonly version: string; readonly commit: string };
  readonly contracts: readonly ContractCheck[];
  readonly evidence_ids: readonly string[];
  readonly source_digest: string;
}
export const contractReviewSchema: z.ZodType<ContractReview>;
export interface AssessmentLane extends Lane {
  readonly static_selection: 'exact' | 'inherited' | 'unsupported';
  readonly compatibility: Compatibility | null;
  readonly parser_base: string | null;
  readonly window: { readonly base: string; readonly upper_exclusive: string } | null;
  readonly rule_revision: 'forward-version-v1';
  readonly declared_scope: {
    readonly max_depth: number | null; readonly max_members: number | null;
    readonly read_only: boolean; readonly exact_only: boolean;
  };
  readonly reasons: readonly (
    'baseline_missing' | 'contracts_unknown' | 'unsupported_operation' | 'exact_only' |
    'no_window' | 'out_of_window' | 'upper_bound' | 'major_transition' | 'minor_transition' |
    'baseline_source_changed' | 'exact_qualification_required' | 'retired' |
    'contracts_affected' | 'review_source_changed'
  )[];
  readonly review: {
    readonly coverage: 'baseline_missing' | 'review_required';
    readonly baseline_version: string | null;
    readonly releases: readonly Release[];
    readonly edges: readonly { readonly from: Release; readonly to: Release; readonly contracts: readonly ContractCheck[] }[];
    readonly parser_comparison: { readonly from_version: string; readonly to: Release; readonly contracts: readonly ContractCheck[] } | null;
    readonly contracts: readonly ContractCheck[];
  };
  readonly live: {
    readonly invalidation: 'not_assessed'; readonly binary: 'not_assessed'; readonly permissions: 'not_assessed';
    readonly config: 'not_assessed'; readonly authentication: 'not_assessed';
  };
  readonly gates: {
    readonly contracts_reviewed: 'unknown' | 'closed' | 'affected'; readonly conformance: 'not_assessed'; readonly regression: 'not_assessed';
    readonly implementation_review: 'not_assessed'; readonly admission: 'not_assessed'; readonly default_promotion: 'not_assessed';
  };
}
export interface SelectionPolicy {
  readonly parser_base_transition: 'none' | 'minor' | 'major' | null;
  readonly baseline_transition: 'none' | 'minor' | 'major' | null;
  readonly next_step: 'operation_unsupported' | 'retired' | 'selected_exact' | 'selected_window' |
    'exact_admission_required' | 'older_version_unsupported' | 'window_extension_required' | 'window_rule_required';
}
interface AssessmentFields {
  readonly kind: 'assessment';
  readonly candidate_id: string;
  readonly observation_id: string;
  readonly baseline_digest: string | null;
  readonly source_digest: string;
  readonly source_paths: readonly string[];
  readonly review_sources: readonly {
    readonly version: string; readonly commit: string;
    readonly path: 'codex-rs/core/src/session/mod.rs' | 'codex-rs/protocol/src/protocol.rs' | 'CHANGELOG.md';
    readonly availability: 'not_assessed';
  }[];
}
type LegacyAssessment = AssessmentFields & { readonly rule_revision: 'static-assessment-v1' } & (
  { readonly lanes: readonly AssessmentLane[] } & (
  { readonly schema_version: 1 } |
  { readonly schema_version: 2; readonly inventory_scope: 'legacy_full_inventory' | 'latest_and_npm_review_range' } |
  {
    readonly schema_version: 3; readonly inventory_scope: 'legacy_full_inventory' | 'latest_and_npm_review_range';
    readonly review_ids: readonly string[]; readonly unused_review_ids: readonly string[];
  }
  ) |
  {
    readonly schema_version: 4; readonly inventory_scope: 'legacy_full_inventory' | 'latest_and_npm_review_range';
    readonly review_ids: readonly string[]; readonly unused_review_ids: readonly string[];
    readonly lanes: readonly (AssessmentLane & { readonly selection_policy: SelectionPolicy })[];
  }
);
export type Assessment = LegacyAssessment | AssessmentFields & { readonly rule_revision: 'static-assessment-v2' } & (
  { readonly schema_version: 5; readonly inventory_scope: 'legacy_full_inventory' | 'latest_and_npm_review_range';
    readonly lanes: readonly AssessmentLane[] } |
  { readonly schema_version: 6; readonly inventory_scope: 'legacy_full_inventory' | 'latest_and_npm_review_range';
    readonly review_ids: readonly string[]; readonly unused_review_ids: readonly string[];
    readonly lanes: readonly (AssessmentLane & { readonly selection_policy: SelectionPolicy })[] }
);
export const assessmentSchema: z.ZodType<Assessment>;
export function assessCandidate(input: {
  readonly candidate: unknown; readonly observation: unknown; readonly baseline?: unknown;
  readonly reviews?: readonly unknown[] | null; readonly root: string;
}): Promise<Assessment>;
export function validateBaselineForSource(baseline: unknown, root: string): Promise<void>;
