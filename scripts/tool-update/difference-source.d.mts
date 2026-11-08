import type { DifferenceEvidence, DifferenceJob } from './difference-records.mjs';

export const codexSourceLimits: Readonly<{
  documentBytes: number;
  jobBytes: number;
  responses: number;
  redirects: number;
  deadlineMs: number;
}>;
export type CodexSourceFailure =
  | 'source_document_invalid'
  | 'source_identity_invalid'
  | 'source_redirect_invalid'
  | 'source_document_limit'
  | 'source_job_limit'
  | 'source_response_limit'
  | 'source_rate_limited'
  | 'source_material_absent'
  | 'source_http_error'
  | 'source_identity_drift'
  | 'source_commit_mismatch'
  | 'source_deadline'
  | 'source_fetch_failed';
export interface CodexSourceResult {
  readonly evidence: readonly DifferenceEvidence[];
  readonly failure: CodexSourceFailure | null;
  readonly usage: { readonly responses: number; readonly decodedBytes: number };
}
export function collectCodexSourceEvidence(
  job: DifferenceJob,
  options: { readonly fetch: (url: string, init: RequestInit) => Promise<Response>; readonly signal?: AbortSignal }
): Promise<CodexSourceResult>;
export interface ClaudeDocumentationResult extends CodexSourceResult {
  readonly documents: readonly {
    readonly path_id: 'release_documentation';
    readonly content_hash: string;
    readonly fetched_at: string;
    readonly release: null;
    readonly limitation: 'unversioned_doc';
  }[];
}
export function collectClaudeDocumentationEvidence(
  job: DifferenceJob,
  options: {
    readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
    readonly signal?: AbortSignal;
    readonly documentation?: 'pinned' | 'unversioned_doc';
  }
): Promise<ClaudeDocumentationResult>;
