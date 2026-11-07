import { lookupToolVersionProfile, orderedToolVersionProfiles } from './core/tool-version-profiles.js';
import admissions from './codex-admissions.json' with { type: 'json' };
import { codexRolloutPolicy } from './codex-rollout-policy.js';
export interface CodexRegisteredProfile {
  readonly kind: 'registered';
  readonly product: 'codex';
  readonly version: string;
  readonly boundaryMode: 'legacy' | 'settings_checkpoint';
  readonly commandDiagnostics: boolean;
  readonly counterMode: 'cumulative_total';
  readonly recognizedTypes: readonly ['session_meta', 'event_msg', 'response_item', 'world_state', 'turn_context', 'token_usage_record', 'compacted'];
  readonly blockingTypes: readonly ['compacted'];
  readonly blockingPayloadTypes: readonly ['context_compacted'];
  readonly blockingPayloadPrefixes: readonly ['collab_'];
  readonly allowedSources: readonly ['cli', 'exec'];
  readonly counterFields: readonly ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens'];
  readonly evidence: {
    readonly completeTotals: false;
    readonly reasoning: 'explicit_zero_observed_nonzero_unmeasurable';
  };
}

export interface ClaudeRegisteredProfile {
  readonly kind: 'registered';
  readonly product: 'claude_code';
  readonly version: '2.1.283';
  readonly counterMode: 'message_components';
  readonly identityTypes: readonly ['assistant', 'user', 'attachment'];
  readonly componentFields: readonly ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];
  readonly evidence: {
    readonly completeTotals: false;
    readonly reasoning: 'unmeasurable';
  };
}

export type RegisteredFileProfile = CodexRegisteredProfile | ClaudeRegisteredProfile;

const codex01561 = {
  kind: 'registered',
  product: 'codex',
  version: lookupToolVersionProfile('codex', '0.156.1')?.version as '0.156.1',
  boundaryMode: 'legacy',
  commandDiagnostics: true,
  counterMode: 'cumulative_total',
  recognizedTypes: ['session_meta', 'event_msg', 'response_item', 'world_state', 'turn_context', 'token_usage_record', 'compacted'],
  blockingTypes: ['compacted'],
  blockingPayloadTypes: ['context_compacted'],
  blockingPayloadPrefixes: ['collab_'],
  allowedSources: ['cli', 'exec'],
  counterFields: ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens'],
  evidence: {
    completeTotals: false,
    reasoning: 'explicit_zero_observed_nonzero_unmeasurable'
  }
} as const satisfies CodexRegisteredProfile;

/** Shared source semantics, not a registration. Candidate and runtime use this variant. */
export const codexCheckpointSemantics = {
  ...codex01561,
  boundaryMode: 'settings_checkpoint',
  commandDiagnostics: false
} as const;

const claude21283 = {
  kind: 'registered',
  product: 'claude_code',
  version: lookupToolVersionProfile('claude_code', '2.1.283')?.version as '2.1.283',
  counterMode: 'message_components',
  identityTypes: ['assistant', 'user', 'attachment'],
  componentFields: ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'],
  evidence: { completeTotals: false, reasoning: 'unmeasurable' }
} as const satisfies ClaudeRegisteredProfile;

export interface CodexAdmission {
  readonly version: string;
  readonly previousVersion: string;
  readonly sourceRef: string;
  readonly policyRevision: string;
  readonly implementationDigest: string;
  readonly scenario: 'exec_initial_resume';
}
// Reviewed application data, never external config. A policy change requires fresh admission.
export const registeredFileProfiles: readonly RegisteredFileProfile[] = orderedToolVersionProfiles('file').flatMap<RegisteredFileProfile>(profile => {
  if (profile.file?.status === 'registered') return [profile.product === 'codex' ? { ...codex01561, version: profile.version } : claude21283];
  return (admissions as readonly CodexAdmission[])
    .filter(
      entry =>
        entry.version === profile.version && entry.policyRevision === codexRolloutPolicy.revision && entry.policyRevision === profile.file?.policyRevision
    )
    .map(entry => ({ ...codexCheckpointSemantics, version: entry.version }));
});

export function lookupFileProfile(product: string, version: string): RegisteredFileProfile | 'unsupported' {
  return registeredFileProfiles.find(profile => profile.product === product && profile.version === version) ?? 'unsupported';
}

/** Flexible semantics are candidate-only until exact source evidence is admitted. */
export const flexibleProductionProfiles: readonly { product: string; version: string; profile_id: string }[] = Object.freeze([]);
