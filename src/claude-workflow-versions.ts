import { resolveSourceCompatibility } from './source-compatibility.js';
import { productionSourceEvidence, type SourceReadinessEvidence } from './readiness.js';

/** Parent-only own-trace workflow profile; admission is per exact version in the registry. */
export const claudeWorkflowProfileId = 'claude-workflow-own-trace-v1';
/** Fresh root with one fresh direct child. Exact admission only: it has no conditional window. */
export const claudeWorkflowChildProfileId = 'claude-workflow-direct-child-v1';
/** The internal native probe's own pinned version (claude-minimal-run). It is independent of
 * the workflow list below, so retiring a workflow version never changes the probe path. */
export const claudeProbeProductVersion = '2.1.288';
/** Exact admitted versions stay distinct from the conditional workflow window.
 * Candidate-only and internal probe callers continue using this closed list.
 * 2.1.288 was retired on 2026-10-06 and 2.1.291 on 2026-10-13; see the source-readiness evidence. */
export const claudeWorkflowProductVersions = Object.freeze(['2.1.296'] as const);
export type ClaudeWorkflowProductVersion = string;
export function isClaudeWorkflowProductVersion(value: unknown): value is ClaudeWorkflowProductVersion {
  return typeof value === 'string' && resolveSourceCompatibility('claude_code', value, 'claude_workflow', claudeWorkflowProfileId) !== null;
}

function numericVersion(version: string): [number, number, number] {
  const match = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/.exec(version);
  if (!match) throw new Error('claude_workflow_version_not_latest');
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
/** Newest admitted Claude workflow version of one profile by semantic version order, or null when none is admitted. */
export function newestAdmittedClaudeWorkflowVersion(registry: readonly SourceReadinessEvidence[] = productionSourceEvidence, profileId: string = claudeWorkflowProfileId): string | null {
  let newest: string | null = null;
  for (const row of registry) {
    if (row.product !== 'claude_code' || row.profile_id !== profileId || row.validation_kind !== 'real_operations') continue;
    const [a, b, c] = numericVersion(row.product_version);
    if (newest === null) { newest = row.product_version; continue; }
    const [x, y, z] = numericVersion(newest);
    if (a > x || a === x && (b > y || b === y && c > z)) newest = row.product_version;
  }
  return newest;
}
/** Registration-time policy for v2 non-synthetic protocols: at most one entry per Claude workflow
 * profile, each at that profile's newest admitted version. A registered protocol keeps its version
 * until it is retired. */
export function requireLatestClaudeWorkflowProfile(profiles: readonly { product: string; product_version: string; profile_id: string }[],
  registry: readonly SourceReadinessEvidence[] = productionSourceEvidence, allowConditional=false): void {
  for (const profileId of [claudeWorkflowProfileId, claudeWorkflowChildProfileId]) {
    const claude = profiles.filter(p => p.product === 'claude_code' && p.profile_id === profileId);
    if (claude.length === 0) continue;
    if(allowConditional&&claude.length===1&&resolveSourceCompatibility('claude_code',claude[0]!.product_version,'claude_workflow',profileId)?.state==='compatibility_unverified')continue;
    if (claude.length > 1 || claude[0]!.product_version !== newestAdmittedClaudeWorkflowVersion(registry, profileId)) throw new Error('claude_workflow_version_not_latest');
  }
}
