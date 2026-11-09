import {
  legacyClaudeBindingAdmissions,
  lookupEffectiveToolVersionFacet,
  lookupToolVersionProfile,
  toolVersionIdentity,
  toolVersionPromotionProjection
} from './core/tool-version-profiles.js';
import { promotionEvidenceId, type ToolVersionPromotionDescriptor } from './core/tool-version-promotion.js';
export const defaultClaudeBindingVersion = '2.1.306';

// Literal declarations preserve the legacy API; values come from the registry.
type LegacyAdmissions = readonly (
  | Readonly<{
      readonly profileId: 'claude-binding-02196-family-v1';
      readonly productVersion: '2.1.296';
      readonly binarySha256: 'c9b5341637becbd423ddffc5b254afb645682a3868cb708bbc6cc0e7bb419937';
      readonly model: 'claude-opus-5-5';
      readonly admitted: true;
      readonly maxFamilyMembers: 8;
      readonly evidenceId: 'claude-binding-02196-ordinary-native-v1';
      readonly qualified: false;
    }>
  | Readonly<{
      readonly profileId: 'claude-binding-2-1-301-family-v1';
      readonly productVersion: '2.1.301';
      readonly binarySha256: '1f04c69e1c24e4d0a716a863af0aad8fc64d49a499334c29701f073700276b99';
      readonly model: 'claude-sonnet-5-5';
      readonly admitted: true;
      readonly maxFamilyMembers: 3;
      readonly evidenceId: 'claude-binding-2-1-301-ordinary-native-v1';
      readonly qualified: false;
    }>
  | Readonly<{
      readonly profileId: 'claude-binding-2-1-306-family-v1';
      readonly productVersion: '2.1.306';
      readonly binarySha256: 'b5d795b7760032d79954b55a9cd1876dcf3a8dc9608fd6bb9f618593f69fd44b';
      readonly model: 'claude-sonnet-5-5';
      readonly admitted: true;
      readonly maxFamilyMembers: 3;
      readonly evidenceId: 'claude-binding-2-1-306-ordinary-localhost-v1';
      readonly qualified: false;
    }>
)[];
export const claudeBindingAdmissions = Object.freeze(legacyClaudeBindingAdmissions().map(admission => Object.freeze(admission))) as LegacyAdmissions;
export const claudeBindingAdmission = claudeBindingAdmissions[0] as Readonly<{
  readonly profileId: 'claude-binding-02196-family-v1';
  readonly productVersion: '2.1.296';
  readonly binarySha256: 'c9b5341637becbd423ddffc5b254afb645682a3868cb708bbc6cc0e7bb419937';
  readonly model: 'claude-opus-5-5';
  readonly admitted: true;
  readonly maxFamilyMembers: 8;
  readonly evidenceId: 'claude-binding-02196-ordinary-native-v1';
  readonly qualified: false;
}>;

export function getClaudeBindingAdmission(version: string) {
  return claudeBindingAdmissions.find(admission => admission.productVersion === version);
}

export interface EffectiveClaudeBindingAdmission {
  readonly kind: 'legacy' | 'promoted';
  readonly profileId: string;
  readonly productVersion: string;
  readonly binarySha256: string;
  readonly model: string;
  readonly admitted: true;
  readonly maxDepth: number;
  readonly maxFamilyMembers: number;
  readonly evidenceId: string;
  readonly qualified: boolean;
  readonly finalityVariant: ToolVersionPromotionDescriptor['variants']['finality'];
  readonly descriptor?: ToolVersionPromotionDescriptor;
}
export function getEffectiveClaudeBindingAdmission(version: string, operation = 'collect', topology = 'root'): EffectiveClaudeBindingAdmission | undefined {
  const legacy = getClaudeBindingAdmission(version);
  if (legacy && ['link', 'collect', 'restart', 'resume'].includes(operation) && ['root', 'bounded_family'].includes(topology)) {
    return {
      ...legacy,
      kind: 'legacy',
      maxDepth: 1,
      finalityVariant: lookupToolVersionProfile('claude_code', version)?.transcriptProfile?.finalityVariant ?? 'claude_candidate_quiescence_v1'
    };
  }
  const facet = lookupEffectiveToolVersionFacet(
    'claude_code',
    version,
    operation,
    topology,
    `${process.platform}_${process.arch}`,
    `node${process.versions.node.split('.')[0]}`
  );
  if (!facet) return undefined;
  const scope = facet.descriptor.scopes.find(scope => scope.operation === operation && scope.topology === topology);
  if (!scope) throw new Error('tool_version_promotion_invalid');
  return {
    kind: 'promoted',
    profileId: facet.descriptor.profileId,
    productVersion: facet.descriptor.version,
    binarySha256: toolVersionIdentity(facet.descriptor.nativeIdentity).sha256,
    model: facet.descriptor.model,
    admitted: true,
    maxDepth: scope.maxDepth,
    maxFamilyMembers: scope.maxFamilyMembers,
    evidenceId: promotionEvidenceId(facet),
    qualified: facet.decision.grants.includes('qualification'),
    finalityVariant: facet.descriptor.variants.finality,
    descriptor: facet.descriptor
  };
}
export function getEffectiveClaudeExactImages(): readonly {
  readonly productVersion: string;
  readonly binarySha256: string;
  readonly admitted: true;
}[] {
  const images = new Map<
    string,
    {
      readonly productVersion: string;
      readonly binarySha256: string;
      readonly admitted: true;
    }
  >(claudeBindingAdmissions.map(admission => [admission.productVersion, admission]));
  const promoted: {
    productVersion: string;
    binarySha256: string;
    admitted: true;
  }[] = [];
  for (const facet of toolVersionPromotionProjection.facets) {
    if (facet.descriptor.product !== 'claude_code') continue;
    const admission = getEffectiveClaudeBindingAdmission(facet.descriptor.version, facet.decision.scope.lane.operation, facet.decision.scope.lane.topology);
    if (!admission || images.has(admission.productVersion) || promoted.some(image => image.productVersion === admission.productVersion)) continue;
    promoted.push({
      productVersion: admission.productVersion,
      binarySha256: admission.binarySha256,
      admitted: true
    });
  }
  return [...images.values(), ...promoted];
}

export function isClaudeModel(model: string | null): boolean {
  return model !== null && /^claude(?:-|$)/i.test(model);
}

export function claudeBindingRuntimeSupported(): boolean {
  return process.platform === 'darwin' && process.arch === 'arm64' && [24, 26].includes(Number(process.versions.node.split('.')[0]));
}
