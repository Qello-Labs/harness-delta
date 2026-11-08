import type { z } from 'zod';
import type { laneSchema } from './lanes.mjs';
export { consumedContracts } from './assessment.mjs';
export type ContractId =
  | 'identity_source_mapping'
  | 'fields_types_enums'
  | 'partial_rotation_checkpoint'
  | 'counters_cache_reasoning_reset_overflow'
  | 'hooks_order_receipts_loading'
  | 'invocation_permissions_config_model_effort'
  | 'history_topology_resume_compaction'
  | 'finality_replay_conflict_stop_flush_sigint';
export type Facet = 'serialized_shape' | 'client_transformation' | 'identity_lifecycle' | 'operation_topology' | 'native_execution' | 'backend_counter_meaning';
export type Method = 'codex_source_identity' | 'serialized_schema' | 'claude_pinned_documentation' | 'synthetic_parser_provider_replay';
export type Result = 'unaffected' | 'affected' | 'unknown';
export type VariantRequirement = 'none_established' | 'named_variant_review_required' | 'undetermined';
export type EligibilityRecommendation = 'blocked_by_affected_contract' | 'validation_pending' | 'ready_for_scoped_review';
export type Impact =
  | 'none_established'
  | 'shape_changed'
  | 'client_behavior_changed'
  | 'identity_changed'
  | 'scope_changed'
  | 'execution_changed'
  | 'counter_meaning_changed'
  | 'undetermined';
export type RequiredValidation =
  | 'source_review'
  | 'schema_review'
  | 'synthetic_replay'
  | 'native_execution'
  | 'backend_counter_meaning'
  | 'real_session'
  | 'coverage_review'
  | 'fresh_evidence';
export type ReasonCode =
  | 'established_unchanged'
  | 'confirmed_contract_change'
  | 'confirmed_contradiction'
  | 'baseline_missing'
  | 'parser_base_missing'
  | 'release_coverage_incomplete'
  | 'edge_missing'
  | 'edge_duplicate'
  | 'edge_commit_conflict'
  | 'comparison_missing'
  | 'pinned_material_absent'
  | 'extraction_incomplete'
  | 'unsupported_extractor'
  | 'unresolved_dependency'
  | 'source_changed_impact_unknown'
  | 'method_inapplicable'
  | 'synthetic_only'
  | 'undocumented_contract'
  | 'evidence_missing'
  | 'conflicting_evidence'
  | 'stale_source'
  | 'stale_engine'
  | 'stale_map'
  | 'stale_policy'
  | 'stale_evidence'
  | 'native_validation_pending'
  | 'backend_validation_pending'
  | 'real_session_validation_pending';
export const contractRevision: 'consumed-v1';
export const mapRevision: 'difference-map-v2';
export const engineRevision: 'difference-engine-v1';
export const facets: readonly Facet[];
export const variantRequirements: readonly VariantRequirement[];
export const eligibilityRecommendations: readonly EligibilityRecommendation[];
export const impacts: readonly Impact[];
export const requiredValidations: readonly RequiredValidation[];
export const reasonCodes: readonly ReasonCode[];
export const methods: Readonly<
  Record<
    Method,
    {
      readonly product: 'codex' | 'claude_code' | null;
      readonly pathId: 'source_closure' | 'serialized_schema' | 'release_documentation' | null;
      readonly facets: readonly Facet[];
      readonly establishesUnchanged: boolean;
    }
  >
>;
export const contractFacetMap: Readonly<Record<ContractId, readonly Facet[]>>;
export const codexSourcePaths: Readonly<Record<string, { readonly path: string; readonly type: 'tree' | 'blob' }>>;
export const codexContractDescriptors: Readonly<
  Record<
    ContractId,
    {
      readonly pathIds: readonly string[];
      readonly facets: readonly Facet[];
      readonly schemaPathId: string | null;
      readonly schemaCompleteness: 'partial';
      readonly unsupportedReason: ReasonCode;
    }
  >
>;
export const codexSchemaFields: readonly {
  readonly property: string;
  readonly fieldId: 'model' | 'effort' | 'permission_mode';
}[];
export const deferredValidation: Readonly<
  Partial<
    Record<
      Facet,
      {
        readonly reason: ReasonCode;
        readonly requiredValidation: readonly RequiredValidation[];
      }
    >
  >
>;
export function requiredFacets(contractId: ContractId, lane: z.infer<typeof laneSchema>): Facet[];
export const engineDigestScheme: 'difference-engine-files-sha256-v1';
export const engineFiles: readonly string[];
