import { expect, test, vi } from 'vitest';
import { Store } from '../../src/store.js';
import { compilePriceBasis, bundledPriceCatalog, digest } from '../../src/pricing/price-catalog.js';
import { ensureBundledCatalog, preparePriceBasis, readPriceBasis, readPriceCatalogStatus, refreshPriceCatalog } from '../../src/pricing/price-catalog-store.js';
import { registerProtocol, registerVariant, freezeProtocol } from '../../src/comparison/comparison.js';
import { showProtocol } from '../../src/readiness-store.js';
import { makeFlexibleFixture } from '../helpers/flexible-fixture.js';
import { seedProject, beforeRecruitment } from '../helpers/comparison-fixture.js';

const now = '2026-10-06T15:00:00Z';
const artifact = (version: number) => Buffer.from(JSON.stringify({ ...bundledPriceCatalog(), catalog_id: `catalog-${version}`, catalog_version: version }));
test('bounded refresh timeout retains the accepted catalog without producer diagnostics', async () => {
  vi.useFakeTimers();
  const store = new Store(':memory:');
  try {
    const first = preparePriceBasis(store, now);
    const result = refreshPriceCatalog(store, () => new Promise<Uint8Array>(() => {}), '0'.repeat(64), now);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await result).toMatchObject({ status: 'failed', reason: 'catalog_timeout' });
    expect(preparePriceBasis(store, now).table.id).toBe(first.table.id);
  } finally {
    store.close();
    vi.useRealTimers();
  }
});
test('bundle bootstrap and a validated later artifact change only the future default', async () => {
  const store = new Store(':memory:');
  try {
    ensureBundledCatalog(store, now);
    const first = preparePriceBasis(store, now);
    const bytes = artifact(2);
    expect(await refreshPriceCatalog(store, () => Promise.resolve(bytes), digest(bytes), now)).toMatchObject({ status: 'updated' });
    const second = preparePriceBasis(store, now);
    expect(second.table.id).not.toBe(first.table.id);
    expect(readPriceBasis(store, first.table.id)).toEqual(first);
    expect(readPriceCatalogStatus(store)).toMatchObject({ catalog_version: 2, verified_at: '2026-10-06T00:00:00Z', last_success_at: now });
    expect(await refreshPriceCatalog(store, () => Promise.resolve(artifact(1)), digest(artifact(1)), now)).toMatchObject({
      status: 'failed',
      reason: 'catalog_rollback'
    });
    expect(preparePriceBasis(store, now).table.id).toBe(second.table.id);
  } finally {
    store.close();
  }
});

test('bad hashes, conflicting IDs, transport failures and oversized catalogs retain cached rates', async () => {
  const store = new Store(':memory:');
  try {
    const first = preparePriceBasis(store, now);
    const bytes = artifact(2);
    expect(await refreshPriceCatalog(store, () => Promise.resolve(bytes), '0'.repeat(64), now)).toMatchObject({ reason: 'catalog_hash_mismatch' });
    expect(await refreshPriceCatalog(store, () => Promise.reject(new Error('/private/secret')), digest(bytes), now)).toMatchObject({
      reason: 'catalog_unavailable'
    });
    const large = Buffer.alloc(1024 * 1024 + 1);
    expect(await refreshPriceCatalog(store, () => Promise.resolve(large), digest(large), now)).toMatchObject({ reason: 'catalog_too_large' });
    const conflict = Buffer.from(
      JSON.stringify({ ...bundledPriceCatalog(), models: bundledPriceCatalog().models.map(row => ({ ...row, rates: { output: '99' } })) })
    );
    expect(await refreshPriceCatalog(store, () => Promise.resolve(conflict), digest(conflict), now)).toMatchObject({ reason: 'catalog_conflict' });
    expect(preparePriceBasis(store, now).table.id).toBe(first.table.id);
    expect(JSON.stringify(readPriceCatalogStatus(store))).not.toContain('secret');
  } finally {
    store.close();
  }
});

test('racing refresh cannot roll back a newer catalog and a frozen protocol retains its reviewed pin', async () => {
  const store = new Store(':memory:');
  try {
    const first = preparePriceBasis(store, now);
    const f = makeFlexibleFixture();
    seedProject(store);
    f.variants.forEach(v => registerVariant(store, v));
    registerProtocol(store, { ...f.protocol, price_table_id: first.table.id });
    let release: (bytes: Uint8Array) => void = () => {
      throw new Error('uninitialized');
    };
    const older = artifact(2);
    const newer = artifact(3);
    const pending = refreshPriceCatalog(
      store,
      () =>
        new Promise<Uint8Array>(resolve => {
          release = resolve;
        }),
      digest(older),
      now
    );
    await refreshPriceCatalog(store, () => Promise.resolve(newer), digest(newer), now);
    freezeProtocol(store, f.protocol.id, beforeRecruitment);
    release(older);
    expect(await pending).toMatchObject({ reason: 'catalog_rollback' });
    expect(showProtocol(store, f.protocol.id)).toMatchObject({ configuration: { price_table_id: first.table.id } });
    expect(readPriceCatalogStatus(store).catalog_version).toBe(3);
    expect(compilePriceBasis(bundledPriceCatalog()).table.id).toBe(first.table.id);
  } finally {
    store.close();
  }
});
