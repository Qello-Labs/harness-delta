import { z } from 'zod';
import { compareVersions, versionSchema } from './manifest.mjs';

export const products = z.enum(['codex', 'claude_code']);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const commitSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const instant = z.iso.datetime().max(32);
export const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const integritySchema = z.string().length(95).refine(value => {
  if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(value)) return false;
  const bytes = Buffer.from(value.slice(7), 'base64');
  return bytes.length === 64 && `sha512-${bytes.toString('base64')}` === value;
});
const tagSchema = z.string().max(128).regex(/^(?:rust-v|v)?(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})$/);

export const discoveryReasonCodes = Object.freeze([
  'baseline_missing', 'baseline_ahead', 'baseline_invalid', 'metadata_invalid',
  'metadata_conflict', 'metadata_drift', 'github_empty', 'npm_empty',
  'npm_latest_mismatch', 'stable_head_mismatch', 'github_release_missing',
  'npm_version_missing', 'npm_integrity_missing', 'tag_missing', 'tag_invalid',
  'tag_cycle', 'tag_depth_limit', 'request_failed', 'http_error', 'rate_limited',
  'redirect_invalid', 'pagination_invalid', 'pagination_cycle', 'page_limit',
  'item_limit', 'response_limit', 'total_limit', 'deadline_exceeded',
  'reference_limit', 'record_limit',
]);
const reasonsSchema = z.enum(discoveryReasonCodes);
const releaseSchema = z.strictObject({
  version: versionSchema, release_id: positiveInteger, tag: tagSchema,
  commit: commitSchema, npm_integrity: integritySchema,
});
const checkSchema = z.strictObject({
  source: z.enum(['github_repository', 'github_releases', 'github_latest', 'github_release', 'github_tag', 'npm']),
  key: z.string().max(128).refine(value => /^(?:[1-9][0-9]?|100)$/.test(value) || versionSchema.safeParse(value).success),
  queried_at: instant, checked_at: instant, sha256, validator: sha256.nullable(),
});
export const recordFits = value => Buffer.byteLength(JSON.stringify(value)) <= 256 * 1024;
const ordered = (values, compare) => values.every((value, i) => i === 0 || compare(values[i - 1], value) < 0);
export const checkOrder = (a, b) => a.source.localeCompare(b.source, 'en') || (
  a.key.includes('.') && b.key.includes('.') ? compareVersions(a.key, b.key) : Number(a.key) - Number(b.key)
);
export function versionFromTag(product, tag) {
  if (typeof tag !== 'string' || tag.length > 128) return null;
  const prefix = product === 'codex' ? 'rust-v' : 'v';
  const version = tag.startsWith(prefix) ? tag.slice(prefix.length) : tag;
  return versionSchema.safeParse(version).success ? version : null;
}
export const candidateSchema = z.strictObject({
  schema_version: z.literal(1), kind: z.literal('candidate'), product: products,
  target: versionSchema, release_id: positiveInteger, tag: tagSchema,
  commit: commitSchema, npm_integrity: integritySchema,
}).refine(value => versionFromTag(value.product, value.tag) === value.target).refine(recordFits);
const observationFields = {
  kind: z.literal('observation'), product: products,
  checked_at: instant,
  result: z.enum(['metadata_reconciled', 'release_mismatch', 'discovery_incomplete', 'metadata_conflict']),
  reasons: z.array(reasonsSchema).max(32),
  heads: z.strictObject({
    github: versionSchema.nullable(), npm_latest: versionSchema.nullable(), npm_stable: versionSchema.nullable(),
  }),
  checks: z.array(checkSchema).max(512), releases: z.array(releaseSchema).max(512),
  candidate_id: sha256.nullable(),
};
export const observationSchema = z.discriminatedUnion('schema_version', [
  z.strictObject({ schema_version: z.literal(1), ...observationFields }),
  z.strictObject({ schema_version: z.literal(2), inventory_scope: z.literal('latest_and_npm_review_range'), ...observationFields }),
]).refine(value =>
  (value.schema_version === 1 ? value.checks.every(row => !['github_latest', 'github_release'].includes(row.source)) :
    value.checks.every(row => row.source !== 'github_releases')) &&
  ordered(value.reasons, (a, b) => a.localeCompare(b, 'en')) &&
  ordered(value.checks, checkOrder) &&
  ordered(value.releases, (a, b) => compareVersions(a.version, b.version)) &&
  value.releases.every(row => versionFromTag(value.product, row.tag) === row.version) &&
    value.checks.every(row => row.source === 'github_tag' || row.source === 'github_release' ?
      versionSchema.safeParse(row.key).success : /^(?:[1-9][0-9]?|100)$/.test(row.key)) &&
  (value.result === 'metadata_reconciled' ? value.candidate_id !== null : value.candidate_id === null)
).refine(recordFits);
