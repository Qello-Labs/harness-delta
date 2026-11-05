import { expect, test, vi } from 'vitest';
import { Store } from '../../src/store.js';
import { bundledCatalogBytes, bundledPriceCatalog, digest } from '../../src/pricing/price-catalog.js';
import { preparePriceBasis, readPriceBasis, readPriceCatalogStatus } from '../../src/price-catalog-store.js';
import { preparePriceCatalogRelease } from '../../src/pricing/price-catalog-release.js';
import {
  defaultPriceCatalogSource,
  readOnlinePriceCatalogStatus,
  refreshOnlinePriceCatalog,
  type TrustedPriceCatalogSource
} from '../../src/pricing/price-catalog-online.js';

const now = '2026-10-06T16:00:00Z';
const source: TrustedPriceCatalogSource = { publisherId: 'harness-delta', manifestUrl: 'https://catalog.example.invalid/prices/manifest.json' };
const nextBytes = () => Buffer.from(JSON.stringify({ ...bundledPriceCatalog(), catalog_id: 'catalog-next', catalog_version: 2 }));
function transport(bytes: Uint8Array = nextBytes(), modify: (value: ReturnType<typeof preparePriceCatalogRelease>['manifest']) => unknown = x => x) {
  const release = preparePriceCatalogRelease(bytes);
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(url =>
      Promise.resolve(new Response(requestUrl(url) === source.manifestUrl ? JSON.stringify(modify(release.manifest)) : Buffer.from(bytes), { status: 200 }))
    );
  return { fetch, release };
}
const requestUrl = (url: Parameters<typeof globalThis.fetch>[0]) => (typeof url === 'string' ? url : url instanceof URL ? url.href : url.url);
test('release preparation binds reviewed raw bytes, exact policy, version and verification without private records', () => {
  const bytes = bundledCatalogBytes();
  const release = preparePriceCatalogRelease(bytes);
  expect(release.manifest).toMatchObject({
    catalog_id: 'reference-catalog-2026-10-06',
    catalog_version: 1,
    artifact_sha256: digest(bytes),
    artifact_bytes: bytes.length,
    verified_at: '2026-10-06T00:00:00Z',
    policy_id: 'reference-standard-v1'
  });
  expect(release.manifest.artifact_file).toBe(`catalog-${digest(bytes)}.json`);
  expect(release.artifact).toEqual(bytes);
  expect(JSON.stringify(release.manifest)).not.toMatch(/private|Users|task_id|session|prompt/);
  expect(() => preparePriceCatalogRelease(Buffer.from('{}'))).toThrow('invalid_price_catalog');
});
test('absent publication is explicit, does not contact the network and retains bundle/pins', async () => {
  const store = new Store(':memory:');
  const fetch = vi.fn<typeof globalThis.fetch>();
  try {
    const basis = preparePriceBasis(store, now);
    expect(readOnlinePriceCatalogStatus(store, null, now)).toMatchObject({
      online_source: { status: 'not_configured', manifest_url: null },
      can_attempt_online_refresh: false,
      verification_age_days: 0
    });
    expect(await refreshOnlinePriceCatalog(store, null, { fetch }, now)).toEqual({ status: 'failed', reason: 'catalog_source_not_configured' });
    expect(fetch).not.toHaveBeenCalled();
    expect(preparePriceBasis(store, now)).toEqual(basis);
  } finally {
    store.close();
  }
});
test('one fixed HTTPS source updates future default only and sends no local data or credentials', async () => {
  const store = new Store(':memory:');
  const { fetch, release } = transport();
  try {
    const first = preparePriceBasis(store, now);
    expect(await refreshOnlinePriceCatalog(store, source, { fetch }, now)).toMatchObject({ status: 'updated', catalog_id: 'catalog-next' });
    expect(readPriceBasis(store, first.table.id)).toEqual(first);
    expect(readOnlinePriceCatalogStatus(store, source, now)).toMatchObject({
      catalog_version: 2,
      online_source: { status: 'configured', publisher_id: 'harness-delta' },
      can_attempt_online_refresh: true,
      verification_age_days: 0
    });
    expect(fetch.mock.calls.map(call => requestUrl(call[0]))).toEqual([
      source.manifestUrl,
      `https://catalog.example.invalid/prices/${release.manifest.artifact_file}`
    ]);
    for (const [, options] of fetch.mock.calls)
      expect(options).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
    expect(await refreshOnlinePriceCatalog(store, source, { fetch }, now)).toMatchObject({ status: 'unchanged' });
  } finally {
    store.close();
  }
});
test('fixed GitHub latest resolves a specific tag and approved CDN; unsafe redirect never receives a request', async () => {
  const store = new Store(':memory:');
  const release = preparePriceCatalogRelease(nextBytes());
  const github: TrustedPriceCatalogSource = {
    publisherId: 'harness-delta',
    manifestUrl: 'https://github.com/Qello-Labs/harness-delta/releases/latest/download/manifest.json',
    redirectHosts: ['release-assets.githubusercontent.com']
  };
  const tag = 'https://github.com/Qello-Labs/harness-delta/releases/download/reference-prices-test-v2/';
  const manifestCdn = 'https://release-assets.githubusercontent.com/synthetic/manifest?signature=synthetic';
  const artifactCdn = 'https://release-assets.githubusercontent.com/synthetic/artifact?signature=synthetic';
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(url => {
    const address = requestUrl(url);
    if (address === github.manifestUrl) return Promise.resolve(new Response(null, { status: 302, headers: { location: tag + 'manifest.json' } }));
    if (address === tag + 'manifest.json') return Promise.resolve(new Response(null, { status: 302, headers: { location: manifestCdn } }));
    if (address === manifestCdn) return Promise.resolve(new Response(JSON.stringify(release.manifest)));
    if (address === tag + release.manifest.artifact_file) return Promise.resolve(new Response(null, { status: 302, headers: { location: artifactCdn } }));
    if (address === artifactCdn) return Promise.resolve(new Response(release.artifact));
    return Promise.reject(new Error('unexpected_synthetic_request'));
  });
  try {
    const first = preparePriceBasis(store, now);
    expect(await refreshOnlinePriceCatalog(store, github, { fetch }, now)).toMatchObject({ status: 'updated' });
    expect(readPriceBasis(store, first.table.id)).toEqual(first);
    expect(fetch.mock.calls.map(call => requestUrl(call[0]))).toEqual([
      github.manifestUrl,
      tag + 'manifest.json',
      manifestCdn,
      tag + release.manifest.artifact_file,
      artifactCdn
    ]);
    expect(JSON.stringify(readOnlinePriceCatalogStatus(store, github, now))).not.toContain('signature');
    for (const location of [
      'http://release-assets.githubusercontent.com/file',
      'https://user:secret@release-assets.githubusercontent.com/file',
      'https://private.invalid/file',
      'https://github.com/another/repo/releases/download/tag/manifest.json',
      'https://github.com/Byuntil/harness-delta/releases/download/tag/manifest.json',
      'https://github.com/Qello-Labs/another-repo/releases/download/tag/manifest.json'
    ]) {
      const unsafe = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { location } }));
      expect(await refreshOnlinePriceCatalog(store, github, { fetch: unsafe }, now)).toMatchObject({ reason: 'catalog_http_error' });
      expect(unsafe).toHaveBeenCalledTimes(1);
      expect(readPriceCatalogStatus(store).catalog_version).toBe(2);
    }
  } finally {
    store.close();
  }
});
test('organization default is canonical and legacy source configuration is refused before any request', async () => {
  const store = new Store(':memory:');
  const fetch = vi.fn<typeof globalThis.fetch>();
  try {
    const first = preparePriceBasis(store, now);
    expect(readOnlinePriceCatalogStatus(store, undefined, now)).toMatchObject({
      online_source: { publisher_id: 'harness-delta', manifest_url: 'https://github.com/Qello-Labs/harness-delta/releases/latest/download/manifest.json' }
    });
    expect(
      await refreshOnlinePriceCatalog(
        store,
        { ...defaultPriceCatalogSource!, manifestUrl: 'https://github.com/Byuntil/harness-delta/releases/latest/download/manifest.json' },
        { fetch },
        now
      )
    ).toMatchObject({ status: 'failed', reason: 'invalid_catalog_source' });
    expect(fetch).not.toHaveBeenCalled();
    expect(preparePriceBasis(store, now)).toEqual(first);
  } finally {
    store.close();
  }
});
test('organization transport keeps the two-hop bound and accepted basis on an extra redirect', async () => {
  const store = new Store(':memory:');
  const target = 'https://github.com/Qello-Labs/harness-delta/releases/download/tag/manifest.json';
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { location: target } }));
  try {
    const first = preparePriceBasis(store, now);
    expect(await refreshOnlinePriceCatalog(store, undefined, { fetch }, now)).toMatchObject({ status: 'failed', reason: 'catalog_http_error' });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(preparePriceBasis(store, now)).toEqual(first);
  } finally {
    store.close();
  }
});
test('hash/schema/identity/downgrade/HTTP failures cannot replace accepted prices and reasons are sanitized', async () => {
  const store = new Store(':memory:');
  try {
    const basis = preparePriceBasis(store, now);
    const cases: [ReturnType<typeof transport>, string][] = [
      [transport(nextBytes(), m => ({ ...m, artifact_sha256: '0'.repeat(64), artifact_file: `catalog-${'0'.repeat(64)}.json` })), 'catalog_hash_mismatch'],
      [transport(nextBytes(), m => ({ ...m, catalog_id: 'different-id' })), 'catalog_release_mismatch'],
      [transport(nextBytes(), m => ({ ...m, publisher_id: 'other-publisher' })), 'invalid_catalog_manifest'],
      [transport(nextBytes(), m => ({ ...m, artifact_file: 'https://private.invalid/secret' })), 'invalid_catalog_manifest']
    ];
    for (const [{ fetch }, reason] of cases) expect(await refreshOnlinePriceCatalog(store, source, { fetch }, now)).toMatchObject({ status: 'failed', reason });
    const failed = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('/private/secret/token'));
    expect(await refreshOnlinePriceCatalog(store, source, { fetch: failed }, now)).toMatchObject({ reason: 'catalog_unavailable' });
    expect(JSON.stringify(readPriceCatalogStatus(store))).not.toContain('secret');
    const http = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('private producer text', { status: 503 }));
    expect(await refreshOnlinePriceCatalog(store, source, { fetch: http }, now)).toMatchObject({ reason: 'catalog_http_error' });
    expect(preparePriceBasis(store, now)).toEqual(basis);
    const { fetch } = transport();
    await refreshOnlinePriceCatalog(store, source, { fetch }, now);
    const old = transport(bundledCatalogBytes());
    expect(await refreshOnlinePriceCatalog(store, source, { fetch: old.fetch }, now)).toMatchObject({ reason: 'catalog_rollback' });
    expect(readPriceCatalogStatus(store).catalog_version).toBe(2);
  } finally {
    store.close();
  }
});
test('invalid transport sources and oversized streamed responses fail before acceptance', async () => {
  const store = new Store(':memory:');
  try {
    const { fetch } = transport();
    for (const manifestUrl of [
      'http://catalog.example.invalid/manifest.json',
      'https://user:secret@catalog.example.invalid/manifest.json',
      'https://catalog.example.invalid/manifest.json?token=secret'
    ]) {
      expect(await refreshOnlinePriceCatalog(store, { ...source, manifestUrl }, { fetch }, now)).toMatchObject({ reason: 'invalid_catalog_source' });
    }
    expect(fetch).not.toHaveBeenCalled();
    const large = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(Buffer.alloc(16385)));
    expect(await refreshOnlinePriceCatalog(store, source, { fetch: large }, now)).toMatchObject({ reason: 'catalog_too_large' });
  } finally {
    store.close();
  }
});
test('a stalled request is aborted at the existing refresh deadline, retaining the cache', async () => {
  vi.useFakeTimers();
  const store = new Store(':memory:');
  let signal: AbortSignal | undefined;
  try {
    const first = preparePriceBasis(store, now);
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((_url, options) => {
      signal = options?.signal ?? undefined;
      return new Promise<Response>(() => {});
    });
    const pending = refreshOnlinePriceCatalog(store, source, { fetch }, now);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toMatchObject({ reason: 'catalog_timeout' });
    expect(signal?.aborted).toBe(true);
    expect(preparePriceBasis(store, now)).toEqual(first);
  } finally {
    store.close();
    vi.useRealTimers();
  }
});
