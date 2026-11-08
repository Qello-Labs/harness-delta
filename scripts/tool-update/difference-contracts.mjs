import { consumedContracts } from './assessment.mjs';

export { consumedContracts };
export const contractRevision = 'consumed-v1';
export const mapRevision = 'difference-map-v1';
export const engineRevision = 'difference-engine-v1';
export const facets = Object.freeze([
  'serialized_shape',
  'client_transformation',
  'identity_lifecycle',
  'operation_topology',
  'native_execution',
  'backend_counter_meaning'
]);
export const variantRequirements = Object.freeze(['none_established', 'named_variant_review_required', 'undetermined']);
export const eligibilityRecommendations = Object.freeze(['blocked_by_affected_contract', 'validation_pending', 'ready_for_scoped_review']);
export const impacts = Object.freeze([
  'none_established',
  'shape_changed',
  'client_behavior_changed',
  'identity_changed',
  'scope_changed',
  'execution_changed',
  'counter_meaning_changed',
  'undetermined'
]);
export const requiredValidations = Object.freeze([
  'source_review',
  'schema_review',
  'synthetic_replay',
  'native_execution',
  'backend_counter_meaning',
  'real_session',
  'coverage_review',
  'fresh_evidence'
]);
export const reasonCodes = Object.freeze([
  'established_unchanged',
  'confirmed_contract_change',
  'confirmed_contradiction',
  'baseline_missing',
  'parser_base_missing',
  'release_coverage_incomplete',
  'edge_missing',
  'edge_duplicate',
  'edge_commit_conflict',
  'comparison_missing',
  'pinned_material_absent',
  'extraction_incomplete',
  'unsupported_extractor',
  'unresolved_dependency',
  'source_changed_impact_unknown',
  'method_inapplicable',
  'synthetic_only',
  'undocumented_contract',
  'evidence_missing',
  'conflicting_evidence',
  'stale_source',
  'stale_engine',
  'stale_map',
  'stale_policy',
  'stale_evidence',
  'native_validation_pending',
  'backend_validation_pending',
  'real_session_validation_pending'
]);

export const methods = Object.freeze({
  codex_source_identity: Object.freeze({
    product: 'codex',
    pathId: 'source_closure',
    facets: Object.freeze(facets.slice(0, 4)),
    establishesUnchanged: true
  }),
  serialized_schema: Object.freeze({
    product: 'codex',
    pathId: 'serialized_schema',
    facets: Object.freeze(['serialized_shape']),
    establishesUnchanged: true
  }),
  claude_pinned_documentation: Object.freeze({
    product: 'claude_code',
    pathId: 'release_documentation',
    facets: Object.freeze(facets.slice(0, 4)),
    establishesUnchanged: false
  }),
  synthetic_parser_provider_replay: Object.freeze({
    product: null,
    pathId: null,
    facets: Object.freeze(facets.slice(0, 4)),
    establishesUnchanged: false
  })
});

const applicability = Object.freeze({
  identity_source_mapping: Object.freeze(['serialized_shape', 'client_transformation', 'identity_lifecycle']),
  fields_types_enums: Object.freeze(['serialized_shape', 'client_transformation']),
  partial_rotation_checkpoint: Object.freeze(['client_transformation', 'identity_lifecycle', 'native_execution']),
  counters_cache_reasoning_reset_overflow: Object.freeze(['serialized_shape', 'client_transformation', 'backend_counter_meaning']),
  hooks_order_receipts_loading: Object.freeze(['serialized_shape', 'identity_lifecycle', 'native_execution']),
  invocation_permissions_config_model_effort: Object.freeze(['serialized_shape', 'client_transformation', 'operation_topology']),
  history_topology_resume_compaction: Object.freeze(['client_transformation', 'identity_lifecycle', 'operation_topology']),
  finality_replay_conflict_stop_flush_sigint: Object.freeze(['serialized_shape', 'client_transformation', 'identity_lifecycle', 'native_execution'])
});
export const contractFacetMap = applicability;
export const deferredValidation = Object.freeze({
  native_execution: Object.freeze({
    reason: 'native_validation_pending',
    requiredValidation: Object.freeze(['native_execution', 'real_session'])
  }),
  backend_counter_meaning: Object.freeze({
    reason: 'backend_validation_pending',
    requiredValidation: Object.freeze(['backend_counter_meaning'])
  })
});
export function requiredFacets(contractId, lane) {
  const required = new Set(applicability[contractId]);
  if (lane.route !== 'file' && ['identity_source_mapping', 'invocation_permissions_config_model_effort'].includes(contractId)) {
    required.add('native_execution');
  }
  if (contractId === 'history_topology_resume_compaction' && (lane.topology !== 'root' || lane.operation === 'resume')) {
    required.add('native_execution');
  }
  return facets.filter(facet => required.has(facet));
}

// Importing the existing group owner also loads its shared validation dependencies.
export const engineDigestScheme = 'difference-engine-files-sha256-v1';
export const engineFiles = Object.freeze([
  'scripts/tool-update/difference-contracts.mjs',
  'scripts/tool-update/difference-records.mjs',
  'scripts/tool-update/difference-judgment.mjs',
  'scripts/tool-update/manifest.mjs',
  'scripts/tool-update/lanes.mjs',
  'scripts/tool-update/assessment.mjs',
  'scripts/tool-update/source-snapshot.mjs',
  'scripts/tool-update/discovery.mjs',
  'scripts/tool-update/discovery-records.mjs',
  'scripts/tool-update/discovery-transport.mjs',
  'package.json',
  'package-lock.json'
]);
