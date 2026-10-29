export const assessmentRuleRevision: 'static-assessment-v1';
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
  readonly resolve: (product: string, version: string, source: import('./lanes.mjs').Lane['route'], profileId: string) => Compatibility | null;
  readonly ruleRevision: string;
  readonly windows: readonly {
    readonly product: string; readonly source: string; readonly base: string;
    readonly upper_exclusive: string; readonly profile_id: string;
  }[];
  readonly files: readonly { readonly product: string; readonly version: string; readonly boundaryMode?: string }[];
  readonly evidence: readonly { readonly product: string; readonly product_version: string; readonly profile_id: string }[];
  readonly codexAdmissions: readonly { readonly profileId: string; readonly productVersion: string; readonly maxDepth: number; readonly maxFamilyMembers: number }[];
  readonly claudeAdmissions: readonly { readonly profileId: string; readonly productVersion: string; readonly maxFamilyMembers: number }[];
}
export function withSourceSnapshot<T>(root: string, project: (source: SourceRegistry) => T | Promise<T>): Promise<{
  readonly source_digest: string;
  readonly source_paths: readonly string[];
  readonly value: T;
}>;
