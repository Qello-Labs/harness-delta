export const legacyAssessmentRuleRevision: 'static-assessment-v1';
export const expandedAssessmentRuleRevision: 'static-assessment-v2';
export const policyAssessmentRuleRevision: 'static-assessment-v3';
export const projectionAssessmentRuleRevision: 'static-assessment-v4';
export const assessmentRuleRevision: 'static-assessment-v5';
export const projectionAssessmentSourcePathLimit: 55;
export const policyAssessmentSourcePathLimit: 52;
export const assessmentSourcePathLimit: 82;
export const expandedAssessmentSourcePathLimit: 48;
export const legacySourcePathAllowlist: readonly string[];
export const expandedSourcePathAllowlist: readonly string[];
export const policySourcePathAllowlist: readonly string[];
export const projectionSourcePathAllowlist: readonly string[];
export const sourcePathAllowlist: readonly string[];
export interface Compatibility {
  readonly state: 'verified' | 'compatibility_unverified';
  readonly product: 'codex' | 'claude_code';
  readonly product_version: string;
  readonly source: import('./lanes.mjs').Lane['route'];
  readonly parser_version: string;
  readonly parser_revision: string;
  readonly profile_id: string;
  readonly rule_revision: string;
}
export interface SourceRegistry {
  readonly ordinaryWindows: readonly import('../../src/core/ordinary-window-policy.js').OrdinaryWindowPolicy[];
  readonly resolveOrdinaryWindow: typeof import('../../src/core/ordinary-window-policy.js').resolveOrdinaryWindow;
  readonly retiredClaudeWorkflowVersions: readonly string[];
  readonly resolve: (
    product: string,
    version: string,
    source: import('./lanes.mjs').Lane['route'],
    profileId: string,
    operation?: import('./lanes.mjs').Lane['operation'],
    topology?: import('./lanes.mjs').Lane['topology']
  ) => Compatibility | null;
  readonly promotionFacets: readonly import('../../src/core/tool-version-promotion.js').ToolVersionPromotionFacet[];
  readonly ruleRevision: string;
  readonly windows: readonly {
    readonly product: string;
    readonly source: string;
    readonly base: string;
    readonly upper_exclusive: string;
    readonly profile_id: string;
  }[];
  readonly files: readonly { readonly product: string; readonly version: string; readonly boundaryMode?: string }[];
  readonly evidence: readonly { readonly product: string; readonly product_version: string; readonly profile_id: string }[];
  readonly codexAdmissions: readonly {
    readonly profileId: string;
    readonly productVersion: string;
    readonly maxDepth: number;
    readonly maxFamilyMembers: number;
  }[];
  readonly claudeAdmissions: readonly { readonly profileId: string; readonly productVersion: string; readonly maxFamilyMembers: number }[];
}
export function withSourceSnapshot<T>(
  root: string,
  project: (source: SourceRegistry) => T | Promise<T>
): Promise<{
  readonly source_digest: string;
  readonly source_paths: readonly string[];
  readonly value: T;
}>;
