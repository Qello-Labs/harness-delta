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

export function isClaudeModel(model: string | null): boolean {
  return model !== null && /^claude(?:-|$)/i.test(model);
}

export function claudeBindingRuntimeSupported(): boolean {
  return process.platform === 'darwin' && process.arch === 'arm64' &&
    [24, 26].includes(Number(process.versions.node.split('.')[0]));
}
