import type { ChildProcess } from 'node:child_process';
import type { z } from 'zod';
export interface Approval {
  readonly schema_version: 1;
  readonly approved: true;
  readonly run_id: string;
  readonly approved_at: string;
  readonly expires_at: string;
  readonly product: 'claude_code';
  readonly version: '2.1.306';
  readonly binary_sha256: string;
  readonly binary_size: 272984176;
  readonly route: 'claude_binding';
  readonly profile_id: 'claude-binding-2-1-306-family-v1';
  readonly runtime: { readonly version: string; readonly sha256: string; readonly platform: 'darwin'; readonly arch: 'arm64' };
  readonly scope: { readonly kind: 'localhost_synthetic_print'; readonly roots: 1; readonly members: 2;
    readonly scenarios: readonly ['normal', 'sigint']; readonly model: 'claude-sonnet-5-5' };
  readonly mode: 'manual' | 'unattended';
  readonly localhost_only_not_isolated: true;
  readonly budgets: { readonly duration_ms: number; readonly termination_ms: number; readonly term_grace_ms: number };
  readonly pins: Readonly<Record<string, string>>;
}
export const admittedImage: Readonly<{ version: '2.1.306'; sha256: string; size: 272984176 }>;
export const approvalSchema: z.ZodType<Approval>;
export interface FailureEvidence {
  readonly schema_version: 1; readonly status: 'failed'; readonly code: string; readonly run_id: string | null;
  readonly stage: 'initialization' | 'scenario' | 'cleanup' | 'finalization';
  readonly scenario: 'normal' | 'sigint' | null; readonly execution_attempted: boolean;
  readonly lane: 'claude-2.1.306-localhost-print'; readonly endpoint: 'localhost_synthetic';
  readonly authenticated: false; readonly interactive_qualified: false; readonly ordinary_qualified: false;
  readonly complete_cost: false; readonly egress_isolation_verified: false;
}
export const failureEvidenceSchema: z.ZodType<FailureEvidence>;
export function persistFailure(directory: string, state: {
  readonly runId: string | null; readonly stage: FailureEvidence['stage'];
  readonly scenario: 'normal' | 'sigint' | null; readonly executionAttempted: boolean;
}, error: unknown): FailureEvidence;
export function validateApproval(input: unknown, context: {
  readonly now: number; readonly version: string; readonly platform: string; readonly arch: string;
  readonly runtimeSha256: string; readonly binarySha256: string; readonly binarySize: number;
  readonly pins: Readonly<Record<string, string>>;
}): Approval;
export function loadApproval(path: string, binary: string): Approval;
export function preflight(path: string, binary: string): Promise<Approval>;
export function verifyOwner(result: unknown, exit: readonly unknown[]): {
  readonly tracked_identities_gone: true; readonly ownership_verified: true;
  readonly observed_escape: boolean; readonly tracked_count: number; readonly unobserved_escapes_excluded: false;
};
export function startOwnedWorker(config: { readonly command: string; readonly args: readonly string[];
  readonly cwd: string; readonly durationMs: number; readonly terminationMs: number; readonly termGraceMs: number },
  onEvidence?: (evidence: unknown) => void): { readonly child: ChildProcess; readonly completed: Promise<unknown> };
export function runConformance(input: { readonly approvalFile: string; readonly binary: string; readonly out: string }): Promise<unknown>;
export function parseArguments(argv: readonly string[]): { readonly approvalFile: string; readonly binary: string; readonly out: string };
