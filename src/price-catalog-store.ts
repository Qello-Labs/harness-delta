import { canonicalJson } from './canonical-json.js';
import { TimestampSchema } from './contracts.js';
import { registerPriceTable } from './pricing.js';
import {
  bundledCatalogBytes,
  bundledPriceCatalog,
  catalogByteLimit,
  compilePriceBasis,
  digest,
  parsePriceCatalog,
  type PriceBasis,
  type PriceCatalog
} from './price-catalog.js';
import type { Store } from './store.js';

function registerCatalog(store: Store, catalog: PriceCatalog, artifactHash: string): void {
  const payload = canonicalJson(catalog);
  const hash = digest(payload);
  const existing = store.get<{ payload: string; artifact_hash: string }>('SELECT payload,artifact_hash FROM price_catalogs WHERE id=?', [catalog.catalog_id]);
  if (existing) {
    if (existing.payload !== payload || existing.artifact_hash !== artifactHash) throw new Error('catalog_conflict');
    return;
  }
  if (store.get('SELECT id FROM price_catalogs WHERE version=?', [catalog.catalog_version])) throw new Error('catalog_conflict');
  store.execute('INSERT INTO price_catalogs(id,version,hash,artifact_hash,payload) VALUES (?,?,?,?,?)', [
    catalog.catalog_id,
    catalog.catalog_version,
    hash,
    artifactHash,
    payload
  ]);
}
export function ensureBundledCatalog(store: Store, now = new Date().toISOString()): void {
  TimestampSchema.parse(now);
  store.immediateTransaction(() => {
    if (store.get('SELECT singleton FROM price_catalog_default')) return;
    const catalog = bundledPriceCatalog();
    registerCatalog(store, catalog, digest(bundledCatalogBytes()));
    store.execute("INSERT INTO price_catalog_default(singleton,catalog_id,last_checked_at,last_success_at,status,reason) VALUES (1,?,?,?,'bundled',NULL)", [
      catalog.catalog_id,
      now,
      now
    ]);
  });
}
export function readPriceCatalogStatus(store: Store) {
  const row = store.get<{ payload: string; artifact_hash: string; last_checked_at: string; last_success_at: string; status: string; reason: string | null }>(
    'SELECT c.payload,c.artifact_hash,d.last_checked_at,d.last_success_at,d.status,d.reason FROM price_catalog_default d JOIN price_catalogs c ON c.id=d.catalog_id'
  );
  if (!row)
    return {
      status: 'not_initialized',
      catalog_id: null,
      catalog_version: null,
      verified_at: null,
      last_checked_at: null,
      last_success_at: null,
      reason: null
    };
  const catalog = parsePriceCatalog(JSON.parse(row.payload) as unknown);
  return {
    status: row.status,
    catalog_id: catalog.catalog_id,
    catalog_version: catalog.catalog_version,
    verified_at: catalog.verified_at,
    policy_id: catalog.policy_id,
    last_checked_at: row.last_checked_at,
    last_success_at: row.last_success_at,
    artifact_sha256: row.artifact_hash,
    reason: row.reason,
    update_channel: 'bundled_or_verified_local_artifact',
    limitations: ['reference_cost_not_actual_billing', 'no_deployed_network_feed']
  };
}
export function preparePriceBasis(store: Store, now = new Date().toISOString()): PriceBasis {
  ensureBundledCatalog(store, now);
  return store.immediateTransaction(() => {
    const row = store.get<{ payload: string }>('SELECT c.payload FROM price_catalog_default d JOIN price_catalogs c ON c.id=d.catalog_id')!;
    const basis = compilePriceBasis(parsePriceCatalog(JSON.parse(row.payload) as unknown), now);
    const payload = canonicalJson(basis);
    const existing = store.get<{ payload: string }>('SELECT payload FROM price_catalog_bases WHERE price_table_id=?', [basis.table.id]);
    if (existing && existing.payload !== payload) throw new Error('price_basis_conflict');
    registerPriceTable(store, basis.table);
    if (!existing) store.execute('INSERT INTO price_catalog_bases(price_table_id,payload) VALUES (?,?)', [basis.table.id, payload]);
    return basis;
  });
}
export function readPriceBasis(store: Store, tableId: string): PriceBasis {
  const row = store.get<{ payload: string }>('SELECT payload FROM price_catalog_bases WHERE price_table_id=?', [tableId]);
  if (!row) throw new Error('unknown_price_basis');
  // Stored basis was produced by our compiler. Verify semantic hash/table identity on every read.
  const stored = JSON.parse(row.payload) as PriceBasis;
  const times = [
    stored.catalog.verified_at,
    ...stored.catalog.models.flatMap(model => [model.effective_from, model.effective_until].filter((value): value is string => value !== null))
  ];
  if (
    !times.some(at => {
      try {
        return canonicalJson(compilePriceBasis(stored.catalog, at)) === row.payload;
      } catch {
        return false;
      }
    })
  )
    throw new Error('invalid_price_basis');
  return stored;
}
const failures = new Set([
  'invalid_price_catalog',
  'catalog_conflict',
  'catalog_rollback',
  'catalog_hash_mismatch',
  'catalog_too_large',
  'catalog_no_current_rates',
  'catalog_future_version',
  'catalog_timeout',
  'catalog_source_not_configured',
  'invalid_catalog_source',
  'invalid_catalog_manifest',
  'catalog_release_mismatch',
  'catalog_http_error'
]);
export async function refreshPriceCatalog(
  store: Store,
  load: () => Promise<Uint8Array>,
  expectedHash: string | (() => string),
  now = new Date().toISOString()
) {
  TimestampSchema.parse(now);
  ensureBundledCatalog(store, now);
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let bytes: Uint8Array;
    try {
      bytes = await Promise.race([
        load(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('catalog_timeout')), 5000);
        })
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (bytes.byteLength > catalogByteLimit) throw new Error('catalog_too_large');
    const hash = typeof expectedHash === 'string' ? expectedHash : expectedHash();
    if (!/^[a-f0-9]{64}$/.test(hash) || digest(bytes) !== hash) throw new Error('catalog_hash_mismatch');
    let input: unknown;
    try {
      input = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
    } catch {
      throw new Error('invalid_price_catalog');
    }
    const catalog = parsePriceCatalog(input);
    if (Date.parse(catalog.published_at) > Date.parse(now)) throw new Error('catalog_future_version');
    compilePriceBasis(catalog, now);
    return store.immediateTransaction(() => {
      const current = readPriceCatalogStatus(store);
      if (catalog.catalog_version < (current.catalog_version ?? 0)) throw new Error('catalog_rollback');
      registerCatalog(store, catalog, hash);
      store.execute("UPDATE price_catalog_default SET catalog_id=?,last_checked_at=?,last_success_at=?,status='current',reason=NULL WHERE singleton=1", [
        catalog.catalog_id,
        now,
        now
      ]);
      return { status: current.catalog_id === catalog.catalog_id ? 'unchanged' : 'updated', catalog_id: catalog.catalog_id } as const;
    });
  } catch (error) {
    const reason = error instanceof Error && failures.has(error.message) ? error.message : 'catalog_unavailable';
    store.execute("UPDATE price_catalog_default SET last_checked_at=?,status='failed',reason=? WHERE singleton=1", [now, reason]);
    return { status: 'failed', reason } as const;
  }
}
