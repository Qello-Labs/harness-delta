import { legacyCodexBindingAdmissions, lookupEffectiveToolVersionFacet, lookupToolVersionProfile } from './core/tool-version-profiles.js';
import { promotionEvidenceId, type ToolVersionPromotionDescriptor } from './core/tool-version-promotion.js';
import type { FlexibleProtocol } from './flexible-contracts.js';

export const defaultCodexBindingVersion = '0.163.0';

export type CodexBindingAdmission = {
  readonly profileId: string;
  readonly productVersion: string;
  readonly model: string;
  readonly effort: string;
  readonly maxDepth: 1;
  readonly maxFamilyMembers: 3;
  readonly sourceRef: string;
} & (
  | { readonly qualified: false; readonly evidenceId?: never; readonly evidenceIntentSha256?: never }
  | { readonly qualified?: true; readonly evidenceId: string; readonly evidenceIntentSha256: string }
);

// Literal declarations preserve the legacy API; values come from the registry.
type LegacyAdmissions = readonly [
  Readonly<{
    readonly profileId: 'codex-binding-01621-direct-family-v1';
    readonly productVersion: '0.162.1';
    readonly model: 'gpt-6.1-sol';
    readonly effort: 'high';
    readonly maxDepth: 1;
    readonly maxFamilyMembers: 3;
    readonly evidenceId: 'codex-binding-01621-native-family-v1';
    readonly sourceRef: '092d3acd6bec3e3a14bdc7e7a2810ab628ab759d';
    readonly evidenceIntentSha256: 'bc6a3cdca7f0750c901e3f95087f63b34e5ecd6c1584fdae78f2729145f9fc2e';
  }>,
  Readonly<{
    readonly profileId: 'codex-binding-01630-direct-family-v1';
    readonly productVersion: '0.163.0';
    readonly model: 'gpt-6.1-sol';
    readonly effort: 'high';
    readonly maxDepth: 1;
    readonly maxFamilyMembers: 3;
    readonly evidenceId: 'codex-binding-01630-native-family-v1';
    readonly sourceRef: '83086188ae0614bd882818ff1aa23f3194962012';
    readonly evidenceIntentSha256: 'a8add9d20b6c7c7845090c70b4896d0b6922acfdb916495b81ec71dc4281683e';
    readonly qualified: true;
  }>,
  Readonly<{
    readonly profileId: 'codex-binding-01660-direct-family-v1';
    readonly productVersion: '0.166.0';
    readonly model: 'gpt-6.1-sol';
    readonly effort: 'high';
    readonly maxDepth: 1;
    readonly maxFamilyMembers: 3;
    readonly sourceRef: '6ff1e1ca3b30fc8b914720681fcf5fe62e95f856';
    readonly qualified: false;
  }>
];
export const codexBindingAdmissions = Object.freeze(legacyCodexBindingAdmissions().map(admission => Object.freeze(admission))) as LegacyAdmissions;
export const codexBindingAdmission = codexBindingAdmissions[0];

export function getCodexBindingAdmission(version: string) {
  return codexBindingAdmissions.find(admission => admission.productVersion === version);
}

export interface EffectiveCodexBindingAdmission {
  readonly kind: 'legacy' | 'promoted';
  readonly profileId: string;
  readonly productVersion: string;
  readonly model: string;
  readonly effort: string;
  readonly maxDepth: number;
  readonly maxFamilyMembers: number;
  readonly sourceRef: string;
  readonly qualified: boolean;
  readonly rootOnlyOverride: boolean;
  readonly historyVariant: ToolVersionPromotionDescriptor['variants']['history'];
  readonly evidenceId?: string;
  readonly evidenceIntentSha256?: string;
  readonly descriptor?: ToolVersionPromotionDescriptor;
}
export function getEffectiveCodexBindingAdmission(version: string, operation = 'collect', topology = 'root'): EffectiveCodexBindingAdmission | undefined {
  const legacy = getCodexBindingAdmission(version);
  const profile = lookupToolVersionProfile('codex', version)?.ordinaryBinding;
  if (legacy && profile && ['link', 'collect', 'restart', 'resume'].includes(operation) && ['root', 'bounded_family'].includes(topology)) {
    return {
      ...legacy,
      kind: 'legacy',
      qualified: !('qualified' in legacy) || legacy.qualified,
      rootOnlyOverride: profile.rootOnlyOverride,
      historyVariant: profile.historyVariant
    };
  }
  const facet = lookupEffectiveToolVersionFacet(
    'codex',
    version,
    operation,
    topology,
    `${process.platform}_${process.arch}`,
    `node${process.versions.node.split('.')[0]}`
  );
  if (!facet || facet.descriptor.effort === undefined) return undefined;
  const scope = facet.descriptor.scopes.find(scope => scope.operation === operation && scope.topology === topology);
  if (!scope) throw new Error('tool_version_promotion_invalid');
  return {
    kind: 'promoted',
    profileId: facet.descriptor.profileId,
    productVersion: facet.descriptor.version,
    model: facet.descriptor.model,
    effort: facet.descriptor.effort,
    maxDepth: scope.maxDepth,
    maxFamilyMembers: scope.maxFamilyMembers,
    sourceRef: facet.descriptor.sourceRef,
    qualified: facet.decision.grants.includes('qualification'),
    rootOnlyOverride: false,
    historyVariant: facet.descriptor.variants.history,
    evidenceId: promotionEvidenceId(facet),
    evidenceIntentSha256: facet.decision.implementation_digest,
    descriptor: facet.descriptor
  };
}

export function isQualifiedCodexBindingAdmission(version: string): boolean {
  const admission = getCodexBindingAdmission(version);
  return admission !== undefined && (!('qualified' in admission) || admission.qualified);
}

export function isCodexGptModel(model: string | null): boolean {
  return model !== null && /^gpt(?:-|$)/i.test(model);
}

export function isAdmittedCodexBindingProtocol(protocol: FlexibleProtocol): boolean {
  return (
    protocol.purpose === 'functional_pilot' &&
    protocol.source_profiles.length === 1 &&
    protocol.source_profiles.every(
      profile => profile.product === 'codex' && profile.profile_id === getEffectiveCodexBindingAdmission(profile.product_version)?.profileId
    )
  );
}
