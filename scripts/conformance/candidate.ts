import { lookupFileProfile } from '../../src/adapter-profiles.js';
import { toolVersionRecipe } from '../../src/core/tool-version-profiles.js';
export interface ConformanceCandidate {
  readonly kind: 'conformance_candidate';
  readonly product: 'codex';
  readonly version: string;
  readonly previousVersion: string;
  readonly sourceRef: string;
  readonly admitted: false;
  readonly counterMode: 'cumulative_total';
  readonly productionUsageField: 'total_token_usage';
  readonly inspectedUsageField: 'last_token_usage';
  readonly recognizedTypes: readonly [
    'session_meta', 'event_msg', 'response_item', 'world_state',
    'turn_context', 'token_usage_record', 'compacted',
  ];
  readonly blockingTypes: readonly ['compacted'];
  readonly excludedTypes: readonly ['token_usage_record'];
  readonly requiredTotalFields: readonly [
    'input_tokens', 'cached_input_tokens', 'output_tokens',
    'reasoning_output_tokens', 'cache_write_input_tokens',
  ];
}

const fileConformanceRecipe = toolVersionRecipe('codex-file-conformance-01580');
if (fileConformanceRecipe.kind !== 'codex_file_conformance' ||
  fileConformanceRecipe.version !== '0.158.0' || fileConformanceRecipe.previousVersion !== '0.156.1' ||
  fileConformanceRecipe.sourceRef !== 'rust-v0.158.0') throw new Error('file_conformance_recipe_mismatch');

export const codex01580Candidate = {
  kind: 'conformance_candidate',
  product: fileConformanceRecipe.product,
  version: fileConformanceRecipe.version,
  previousVersion: fileConformanceRecipe.previousVersion,
  sourceRef: fileConformanceRecipe.sourceRef,
  admitted: fileConformanceRecipe.admitted,
  counterMode: 'cumulative_total',
  productionUsageField: 'total_token_usage',
  inspectedUsageField: 'last_token_usage',
  recognizedTypes: [
    'session_meta', 'event_msg', 'response_item', 'world_state',
    'turn_context', 'token_usage_record', 'compacted',
  ],
  blockingTypes: ['compacted'],
  excludedTypes: ['token_usage_record'],
  requiredTotalFields: [
    'input_tokens', 'cached_input_tokens', 'output_tokens',
    'reasoning_output_tokens', 'cache_write_input_tokens',
  ],
} as const satisfies ConformanceCandidate;

/** Add an exact source-reviewed entry here; CLI input never constructs candidates. */
export const conformanceCandidates: readonly ConformanceCandidate[] = [codex01580Candidate];
export function lookupCandidate(version: string): ConformanceCandidate | undefined {
  return conformanceCandidates.find(candidate => candidate.version === version);
}

export function compareCandidate(candidate: ConformanceCandidate) {
  const previous = lookupFileProfile(candidate.product, candidate.previousVersion);
  if (previous === 'unsupported' || previous.product !== 'codex') throw new Error('unsupported_previous_profile');
  const previousFields: readonly string[] = previous.boundaryMode === 'settings_checkpoint'
    ? [...previous.counterFields, 'cache_write_input_tokens'] : previous.counterFields;
  return {
    addedRequiredCounters: candidate.requiredTotalFields.filter(field => !previousFields.includes(field)),
    removedRequiredCounters: previousFields.filter(field => !(candidate.requiredTotalFields as readonly string[]).includes(field)),
    addedRecordTypes: candidate.recognizedTypes.filter(type => !(previous.recognizedTypes as readonly string[]).includes(type)),
    counterModeChanged: candidate.counterMode !== previous.counterMode,
    boundaryVariantChanged: previous.boundaryMode !== 'settings_checkpoint',
    commandDiagnosticsExcluded: true,
  };
}
