import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { Store } from '../src/store.js';
import { Deletion } from '../src/deletion.js';
import { readToolVersionPromotionAuthority, recordToolVersionPromotionDenial, toolVersionPromotionKey } from '../src/core/tool-version-promotion-store.js';
import { projectToolVersionPromotions } from '../src/core/tool-version-promotion.js';
import { appendPromotionDecision, promotionFixture } from './helpers/tool-version-promotion.js';

const stores: Store[] = [];
const roots: string[] = [];
const at = '2026-11-09T01:00:00.000Z';
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture(product: 'codex' | 'claude_code' = 'codex', file = ':memory:') {
  const store = new Store(file);
  stores.push(store);
  const input = promotionFixture(product);
  appendPromotionDecision(input);
  const projection = projectToolVersionPromotions(input);
  const facet = projection.facets[0];
  if (!facet) throw new Error('fixture_facet_missing');
  const key = toolVersionPromotionKey(facet);
  const read = () =>
    readToolVersionPromotionAuthority(
      store,
      {
        key,
        requiredGrants: ['admission']
      },
      projection
    );
  return { store, input, projection, facet, key, read };
}

test('persisted denial keys use snake_case without changing the TypeScript scope identity', () => {
  const f = fixture();
  recordToolVersionPromotionDenial(f.store, {
    key: f.key,
    reason: 'revoke',
    recordedAt: at
  });
  const row = f.store.get<{ key_json: string }>('SELECT key_json FROM tool_version_promotion_denials');
  if (!row) throw new Error('fixture_denial_missing');
  expect(JSON.parse(row.key_json)).toEqual({
    product: 'codex',
    product_version: '0.169.0',
    source: 'codex_binding',
    profile_id: 'codex-binding-01690-direct-family-v1',
    operation: 'collect',
    topology: 'root',
    descriptor_lineage: 'a'.repeat(40),
    platform: 'darwin_arm64',
    runtime: f.key.runtime
  });
  expect(f.read()).toMatchObject({ state: 'denied', generation: 1 });
});

test.each(['codex', 'claude_code'] as const)('%s local denial survives reopen, removed evidence and a new grant content ID', product => {
  const directory = mkdtempSync(join(tmpdir(), 'promotion-denial-'));
  roots.push(directory);
  const file = join(directory, 'store.sqlite');
  const f = fixture(product, file);
  expect(f.read()).toMatchObject({
    state: 'allowed',
    generation: 0,
    denialIds: []
  });
  const id = recordToolVersionPromotionDenial(f.store, {
    key: f.key,
    reason: 'revoke',
    recordedAt: at
  });
  const replacement = promotionFixture(product);
  replacement.descriptors = replacement.descriptors.map(descriptor => ({
    ...descriptor,
    nativeIdentity: 'replacement-image'
  }));
  appendPromotionDecision(replacement, { proposal_id: '9'.repeat(64) });
  expect(replacement.ledger.records[0]?.id).not.toBe(f.input.ledger.records[0]?.id);
  f.store.close();
  stores.splice(stores.indexOf(f.store), 1);
  const reopened = new Store(file);
  stores.push(reopened);
  for (const projection of [
    projectToolVersionPromotions(replacement),
    {
      ...f.projection,
      facets: [],
      denials: []
    }
  ]) {
    expect(
      readToolVersionPromotionAuthority(
        reopened,
        {
          key: f.key,
          requiredGrants: ['admission']
        },
        projection
      )
    ).toMatchObject({
      state: 'denied',
      generation: 1,
      denialIds: [id]
    });
  }
});

test('denial identity and generation are durable, immutable and idempotent without task or evidence foreign keys', () => {
  const f = fixture();
  const input = { key: f.key, reason: 'revoke', recordedAt: at } as const;
  const first = recordToolVersionPromotionDenial(f.store, input);
  expect(recordToolVersionPromotionDenial(f.store, input)).toBe(first);
  expect(f.read()).toMatchObject({ generation: 1, denialIds: [first] });
  expect(() => f.store.execute('DELETE FROM tool_version_promotion_denials', [])).toThrow('promotion_denial_immutable');
  expect(() => f.store.execute("UPDATE tool_version_promotion_denials SET reason='delete'", [])).toThrow('promotion_denial_immutable');
  const deletion = new Deletion(f.store, () => at);
  deletion.deletePromotionGrant(f.key);
  expect(f.read()).toMatchObject({ state: 'denied', generation: 2 });
  expect(f.store.all('SELECT reason FROM tool_version_promotion_denials ORDER BY reason')).toEqual([{ reason: 'delete' }, { reason: 'revoke' }]);
});

test('maintained grant deletion is atomic when denial persistence fails', () => {
  const f = fixture();
  f.store.execute("CREATE TRIGGER fail_denial BEFORE INSERT ON tool_version_promotion_denials BEGIN SELECT RAISE(ABORT,'fixture_denial_failed'); END", []);
  expect(() => new Deletion(f.store, () => at).deletePromotionGrant(f.key)).toThrow('fixture_denial_failed');
  expect(f.read()).toMatchObject({
    state: 'allowed',
    generation: 0,
    denialIds: []
  });
});

test('task and project tombstones remain independent from the stable promotion denial', () => {
  const f = fixture();
  recordToolVersionPromotionDenial(f.store, {
    key: f.key,
    reason: 'revoke',
    recordedAt: at
  });
  f.store.execute("INSERT INTO projects(id) VALUES ('project')", []);
  f.store.execute("INSERT INTO tasks(id,project_id) VALUES ('task','project')", []);
  new Deletion(f.store, () => at).deleteProject('project');
  expect(f.read()).toMatchObject({ state: 'denied', generation: 1 });
  expect(f.store.all('SELECT kind,id FROM tombstones ORDER BY kind')).toEqual([
    { kind: 'project', id: 'project' },
    { kind: 'task', id: 'task' }
  ]);
});

test.each(['operation', 'topology', 'profileId', 'descriptorLineage', 'platform', 'runtime'] as const)(
  'denial does not borrow authority from a different %s scope',
  field => {
    const f = fixture();
    const other = {
      ...f.key,
      ...(field === 'operation' ? { operation: 'link' as const } : {}),
      ...(field === 'topology' ? { topology: 'bounded_family' as const } : {}),
      ...(field === 'profileId' ? { profileId: 'different-profile' } : {}),
      ...(field === 'descriptorLineage' ? { descriptorLineage: 'e'.repeat(40) } : {}),
      ...(field === 'platform' ? { platform: 'linux_arm64' as const } : {}),
      ...(field === 'runtime'
        ? {
            runtime: f.key.runtime === 'node24' ? ('node26' as const) : ('node24' as const)
          }
        : {})
    };
    recordToolVersionPromotionDenial(f.store, {
      key: other,
      reason: 'revoke',
      recordedAt: at
    });
    expect(f.read()).toMatchObject({
      state: 'allowed',
      generation: 1,
      denialIds: []
    });
  }
);

test('missing grant, requested qualification, descriptor drift and missing generation fail closed', () => {
  const f = fixture();
  expect(
    readToolVersionPromotionAuthority(
      f.store,
      {
        key: f.key,
        requiredGrants: ['qualification']
      },
      f.projection
    ).state
  ).toBe('missing_grant');
  expect(
    readToolVersionPromotionAuthority(
      f.store,
      {
        key: f.key,
        requiredGrants: ['admission']
      },
      { ...f.projection, facets: [] }
    ).state
  ).toBe('missing_grant');
  const changed = {
    ...f.facet,
    descriptor: { ...f.facet.descriptor, model: 'gpt-changed' }
  };
  expect(
    readToolVersionPromotionAuthority(
      f.store,
      {
        key: f.key,
        requiredGrants: ['admission']
      },
      { ...f.projection, facets: [changed] }
    ).state
  ).toBe('missing_grant');
  f.store.execute('DELETE FROM tool_version_promotion_generation', []);
  expect(() => f.read()).toThrow('promotion_generation_missing');
});

test.each([
  ['revoke', 'authority_withdrawn'],
  ['retire', 'maintenance_ended'],
  ['invalidate', 'confirmed_incompatibility'],
  ['delete', 'authority_deleted']
] as const)('shipped %s wins over stale grants even without a local row', (decision, reason) => {
  const f = fixture();
  appendPromotionDecision(f.input, {
    decision,
    reason,
    grants: []
  });
  const revoked = projectToolVersionPromotions(f.input);
  const stale = { ...revoked, facets: f.projection.facets };
  expect(
    readToolVersionPromotionAuthority(
      f.store,
      {
        key: f.key,
        requiredGrants: ['admission']
      },
      stale
    )
  ).toMatchObject({
    state: 'denied',
    generation: 0
  });
  expect(f.store.all('SELECT * FROM tool_version_promotion_denials')).toEqual([]);
});
