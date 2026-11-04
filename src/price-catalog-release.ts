import { z } from 'zod';
import { IdSchema, TimestampSchema } from './contracts.js';
import { catalogByteLimit, digest, parsePriceCatalog, referencePolicyId, requestTierPolicyId, observedCacheTtlPolicyId } from './price-catalog.js';

export const CatalogReleaseManifestSchema = z
  .strictObject({
    schema_version: z.literal(1),
    publisher_id: z.literal('harness-delta'),
    catalog_id: IdSchema,
    catalog_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    policy_id: z.enum([referencePolicyId, requestTierPolicyId, observedCacheTtlPolicyId]),
    published_at: TimestampSchema,
    verified_at: TimestampSchema,
    artifact_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    artifact_bytes: z.number().int().positive().max(catalogByteLimit),
    artifact_file: z.string()
  })
  .refine(m => m.artifact_file === `catalog-${m.artifact_sha256}.json` && Date.parse(m.verified_at) <= Date.parse(m.published_at));
export type CatalogReleaseManifest = z.infer<typeof CatalogReleaseManifestSchema>;
/** Local deployment preparation only. The artifact contains validated price metadata, never work records. */
export function preparePriceCatalogRelease(bytes: Uint8Array) {
  if (bytes.byteLength > catalogByteLimit) throw new Error('catalog_too_large');
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
  } catch {
    throw new Error('invalid_price_catalog');
  }
  const catalog = parsePriceCatalog(raw);
  const hash = digest(bytes);
  const manifest = CatalogReleaseManifestSchema.parse({
    schema_version: 1,
    publisher_id: 'harness-delta',
    catalog_id: catalog.catalog_id,
    catalog_version: catalog.catalog_version,
    policy_id: catalog.policy_id,
    published_at: catalog.published_at,
    verified_at: catalog.verified_at,
    artifact_sha256: hash,
    artifact_bytes: bytes.byteLength,
    artifact_file: `catalog-${hash}.json`
  });
  return { manifest, artifact: Buffer.from(bytes) };
}
