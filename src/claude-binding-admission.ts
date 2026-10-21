export const defaultClaudeBindingVersion = '2.1.306';

export const claudeBindingAdmission = Object.freeze({
  profileId: 'claude-binding-02196-family-v1',
  productVersion: '2.1.296',
  binarySha256: 'c9b5341637becbd423ddffc5b254afb645682a3868cb708bbc6cc0e7bb419937',
  // Native qualification fixtures do not restrict ordinary user models.
  model: 'claude-opus-5-5',
  admitted: true,
  maxFamilyMembers: 8,
  evidenceId: 'claude-binding-02196-ordinary-native-v1',
  qualified: false,
} as const);

export const claudeBindingAdmissions = Object.freeze([
  claudeBindingAdmission,
  Object.freeze({
    profileId: 'claude-binding-2-1-301-family-v1',
    productVersion: '2.1.301',
    binarySha256: '1f04c69e1c24e4d0a716a863af0aad8fc64d49a499334c29701f073700276b99',
    model: 'claude-sonnet-5-5',
    admitted: true,
    maxFamilyMembers: 3,
    evidenceId: 'claude-binding-2-1-301-ordinary-native-v1',
    qualified: false,
  } as const),
  Object.freeze({
    profileId: 'claude-binding-2-1-306-family-v1',
    productVersion: '2.1.306',
    binarySha256: 'b5d795b7760032d79954b55a9cd1876dcf3a8dc9608fd6bb9f618593f69fd44b',
    model: 'claude-sonnet-5-5',
    admitted: true,
    maxFamilyMembers: 3,
    evidenceId: 'claude-binding-2-1-306-ordinary-localhost-v1',
    qualified: false,
  } as const),
]);

export function getClaudeBindingAdmission(version: string) {
  return claudeBindingAdmissions.find(admission => admission.productVersion === version);
}

export function isClaudeModel(model: string | null): boolean {
  return model !== null && /^claude(?:-|$)/i.test(model);
}

export function claudeBindingRuntimeSupported(): boolean {
  return process.platform === 'darwin' && process.arch === 'arm64' &&
    [24, 26].includes(Number(process.versions.node.split('.')[0]));
}
