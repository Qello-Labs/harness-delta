import type { z } from 'zod';

export type Product = 'codex' | 'claude_code';
export interface Candidate {
  readonly schema_version: 1;
  readonly kind: 'candidate';
  readonly product: Product;
  readonly target: string;
  readonly release_id: number;
  readonly tag: string;
  readonly commit: string;
  readonly npm_integrity: string;
}
export interface Release {
  readonly version: string;
  readonly release_id: number;
  readonly tag: string;
  readonly commit: string;
  readonly npm_integrity: string;
}
export interface DiscoveryCheck {
  readonly source: 'github_repository' | 'github_releases' | 'github_latest' | 'github_release' | 'github_tag' | 'npm';
  readonly key: string;
  readonly queried_at: string;
  readonly checked_at: string;
  readonly sha256: string;
  readonly validator: string | null;
}
export const discoveryReasonCodes: readonly [
  'baseline_missing', 'baseline_ahead', 'baseline_invalid', 'metadata_invalid',
  'metadata_conflict', 'metadata_drift', 'github_empty', 'npm_empty',
  'npm_latest_mismatch', 'stable_head_mismatch', 'github_release_missing',
  'npm_version_missing', 'npm_integrity_missing', 'tag_missing', 'tag_invalid',
  'tag_cycle', 'tag_depth_limit', 'request_failed', 'http_error', 'rate_limited',
  'redirect_invalid', 'pagination_invalid', 'pagination_cycle', 'page_limit',
  'item_limit', 'response_limit', 'total_limit', 'deadline_exceeded',
  'reference_limit', 'record_limit',
];
export type DiscoveryReason = typeof discoveryReasonCodes[number];
interface ObservationFields {
  readonly kind: 'observation';
  readonly product: Product;
  readonly checked_at: string;
  readonly result: 'metadata_reconciled' | 'release_mismatch' | 'discovery_incomplete' | 'metadata_conflict';
  readonly reasons: readonly DiscoveryReason[];
  readonly heads: {
    readonly github: string | null;
    readonly npm_latest: string | null;
    readonly npm_stable: string | null;
  };
  readonly checks: readonly DiscoveryCheck[];
  readonly releases: readonly Release[];
  readonly candidate_id: string | null;
}
export type Observation = ObservationFields & (
  { readonly schema_version: 1 } |
  { readonly schema_version: 2; readonly inventory_scope: 'latest_and_npm_review_range' }
);
export interface DiscoveryOptions {
  readonly fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  readonly now?: () => string;
  readonly baseline?: unknown;
}
export const candidateSchema: z.ZodType<Candidate>;
export const observationSchema: z.ZodType<Observation>;
export function discover(product: Product, options?: DiscoveryOptions): Promise<{
  readonly candidate: Candidate | null;
  readonly observation: Observation;
}>;
