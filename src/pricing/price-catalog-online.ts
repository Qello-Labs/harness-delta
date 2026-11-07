import { z } from 'zod';
import { IdSchema, TimestampSchema } from '../contracts.js';
import { catalogByteLimit, digest, parsePriceCatalog } from './price-catalog.js';
import { CatalogReleaseManifestSchema } from './price-catalog-release.js';
import { ensureBundledCatalog, readPriceCatalogStatus, refreshPriceCatalog } from './price-catalog-store.js';
import type { Store } from '../store.js';

export interface TrustedPriceCatalogSource {
  publisherId: string;
  manifestUrl: string;
  redirectHosts?: string[];
}
const githubRepositoryPath = '/Qello-Labs/harness-delta';
const githubLatestManifestPath = `${githubRepositoryPath}/releases/latest/download/manifest.json`;
// The approved release retains its issuer and bytes when the repository owner changes.
export const defaultPriceCatalogSource: TrustedPriceCatalogSource | null = {
  publisherId: 'harness-delta',
  manifestUrl: `https://github.com${githubLatestManifestPath}`,
  redirectHosts: ['release-assets.githubusercontent.com', 'objects.githubusercontent.com']
};
const githubAssetPath = new RegExp(String.raw`^${githubRepositoryPath}/releases/download/[a-zA-Z0-9._-]{1,128}/(manifest\.json|catalog-[a-f0-9]{64}\.json)$`);
const sourceSchema = z
  .strictObject({
    publisherId: IdSchema,
    manifestUrl: z.string().url(),
    redirectHosts: z
      .array(z.enum(['release-assets.githubusercontent.com', 'objects.githubusercontent.com']))
      .max(2)
      .optional()
  })
  .refine(source => {
    const url = new URL(source.manifestUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return false;
    return (
      !source.redirectHosts?.length ||
      (source.publisherId === 'harness-delta' &&
        url.origin === 'https://github.com' &&
        ((githubAssetPath.test(url.pathname) && url.pathname.endsWith('/manifest.json')) || url.pathname === githubLatestManifestPath))
    );
  });
function verifiedSource(source: TrustedPriceCatalogSource): TrustedPriceCatalogSource {
  const result = sourceSchema.safeParse(source);
  if (!result.success) throw new Error('invalid_catalog_source');
  return {
    publisherId: result.data.publisherId,
    manifestUrl: result.data.manifestUrl,
    ...(result.data.redirectHosts ? { redirectHosts: result.data.redirectHosts } : {})
  };
}
export function readOnlinePriceCatalogStatus(
  store: Store,
  source: TrustedPriceCatalogSource | null = defaultPriceCatalogSource,
  now = new Date().toISOString()
) {
  TimestampSchema.parse(now);
  ensureBundledCatalog(store, now);
  const configured = source === null ? null : verifiedSource(source);
  const status = readPriceCatalogStatus(store);
  const age = status.verified_at === null ? null : (Date.parse(now) - Date.parse(status.verified_at)) / 86400000;
  return {
    ...status,
    can_attempt_online_refresh: configured !== null,
    verification_age_days: age === null || age < 0 ? null : Math.floor(age),
    online_source: {
      status: configured === null ? 'not_configured' : 'configured',
      publisher_id: configured?.publisherId ?? null,
      manifest_url: configured?.manifestUrl ?? null,
      redirect_hosts: configured?.redirectHosts ?? []
    },
    update_channel: configured === null ? 'bundled_or_verified_local_artifact' : 'verified_https_manifest',
    limitations: [
      'reference_cost_not_actual_billing',
      ...(configured === null ? ['no_deployed_network_feed'] : ['source_configuration_does_not_prove_availability'])
    ]
  };
}
async function readBoundedResponse(response: Response, limit: number): Promise<Buffer> {
  if (response.status !== 200 || response.redirected) throw new Error('catalog_http_error');
  const advertised = response.headers.get('content-length');
  if (advertised !== null && Number(advertised) > limit) throw new Error('catalog_too_large');
  if (!response.body) throw new Error('catalog_unavailable');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('catalog_too_large');
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
export interface PriceCatalogOnlineDependencies {
  fetch?: typeof globalThis.fetch;
}
/** The server owner supplies a fixed trusted source. Never take this configuration from browser request data. */
export async function refreshOnlinePriceCatalog(
  store: Store,
  source: TrustedPriceCatalogSource | null = defaultPriceCatalogSource,
  dependencies: PriceCatalogOnlineDependencies = {},
  now = new Date().toISOString()
) {
  const controller = new AbortController();
  let expectedHash = '';
  const fetch = dependencies.fetch ?? globalThis.fetch;
  const options: RequestInit = {
    method: 'GET',
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    cache: 'no-store',
    headers: { accept: 'application/json' },
    signal: controller.signal
  };
  async function download(url: string, limit: number, configured: TrustedPriceCatalogSource) {
    const approvedHosts = configured.redirectHosts ?? [];
    let current = url;
    let publicUrl = url;
    for (let hop = 0; hop <= 2; hop++) {
      const response = await fetch(current, { ...options, redirect: approvedHosts.length ? 'manual' : 'error' });
      if (![301, 302, 303, 307, 308].includes(response.status) || !approvedHosts.length)
        return { bytes: await readBoundedResponse(response, limit), publicUrl };
      const location = response.headers.get('location');
      if (!location || hop === 2) throw new Error('catalog_http_error');
      const target = new URL(location, current);
      const publisherAsset =
        target.origin === 'https://github.com' &&
        githubAssetPath.test(target.pathname) &&
        target.pathname.split('/').at(-1) === new URL(url).pathname.split('/').at(-1) &&
        !target.search;
      const approvedCdn = approvedHosts.includes(target.hostname) && (!target.port || target.port === '443');
      // Fixed publisher tag then approved CDN, at most two hops. Signed CDN queries stay transient.
      if (target.protocol !== 'https:' || target.username || target.password || target.hash || (!publisherAsset && !approvedCdn))
        throw new Error('catalog_http_error');
      await response.body?.cancel();
      if (publisherAsset) publicUrl = target.href;
      current = target.href;
    }
    throw new Error('catalog_http_error');
  }
  try {
    return await refreshPriceCatalog(
      store,
      async () => {
        if (source === null) throw new Error('catalog_source_not_configured');
        const configured = verifiedSource(source);
        const manifestDownload = await download(configured.manifestUrl, 16384, configured);
        let raw: unknown;
        try {
          raw = JSON.parse(manifestDownload.bytes.toString('utf8')) as unknown;
        } catch {
          throw new Error('invalid_catalog_manifest');
        }
        const parsed = CatalogReleaseManifestSchema.safeParse(raw);
        if (!parsed.success) throw new Error('invalid_catalog_manifest');
        const manifest = parsed.data;
        expectedHash = manifest.artifact_sha256;
        // A validated digest-only filename remains beside the fixed manifest on the same HTTPS origin.
        const artifactUrl = new URL(manifest.artifact_file, manifestDownload.publicUrl).href;
        const { bytes } = await download(artifactUrl, catalogByteLimit, configured);
        if (digest(bytes) !== expectedHash) throw new Error('catalog_hash_mismatch');
        if (bytes.length !== manifest.artifact_bytes) throw new Error('catalog_release_mismatch');
        let artifact: unknown;
        try {
          artifact = JSON.parse(bytes.toString('utf8')) as unknown;
        } catch {
          throw new Error('invalid_price_catalog');
        }
        const catalog = parsePriceCatalog(artifact);
        if (
          configured.publisherId !== manifest.publisher_id ||
          catalog.catalog_id !== manifest.catalog_id ||
          catalog.catalog_version !== manifest.catalog_version ||
          catalog.policy_id !== manifest.policy_id ||
          catalog.verified_at !== manifest.verified_at ||
          catalog.published_at !== manifest.published_at
        )
          throw new Error('catalog_release_mismatch');
        return bytes;
      },
      () => expectedHash,
      now
    );
  } finally {
    controller.abort();
  }
}
