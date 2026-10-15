import type { FlexibleProtocol } from './flexible-contracts.js';

export const codexBindingAdmission = Object.freeze({
  profileId: 'codex-binding-01621-direct-family-v1',
  productVersion: '0.162.1',
  // Qualification fixture pins must not constrain ordinary user runtime.
  model: 'gpt-6.1-sol',
  effort: 'high',
  maxDepth: 1,
  maxFamilyMembers: 3,
  evidenceId: 'codex-binding-01621-native-family-v1',
  sourceRef: '092d3acd6bec3e3a14bdc7e7a2810ab628ab759d',
  evidenceIntentSha256: 'bc6a3cdca7f0750c901e3f95087f63b34e5ecd6c1584fdae78f2729145f9fc2e',
} as const);

export function isCodexGptModel(model: string | null): boolean {
  return model !== null && /^gpt(?:-|$)/i.test(model);
}

export function isAdmittedCodexBindingProtocol(protocol: FlexibleProtocol): boolean {
  return protocol.purpose === 'functional_pilot' && protocol.source_profiles.length === 1 &&
    protocol.source_profiles.every(profile => profile.product === 'codex' &&
      profile.product_version === codexBindingAdmission.productVersion &&
      profile.profile_id === codexBindingAdmission.profileId);
}
