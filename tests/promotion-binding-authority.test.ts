import { afterEach, expect, test, vi } from 'vitest';
import * as promotionCore from '../src/core/tool-version-promotion.js';
import { Store } from '../src/store.js';
import * as profiles from '../src/core/tool-version-profiles.js';
import { projectToolVersionPromotions } from '../src/core/tool-version-promotion.js';
import { recordToolVersionPromotionDenial, toolVersionPromotionKey } from '../src/core/tool-version-promotion-store.js';
import { appendPromotionDecision, promotionFixture } from './helpers/tool-version-promotion.js';
import { assertPromotionBindingCheckpoint, issuePromotionBindingAuthority, promotionBindingCheckpoint } from '../src/binding/session-binding-promotion.js';
import type { SessionBindingProvider } from '../src/session-binding-contract.js';

const original = { ...profiles.toolVersionPromotionProjection };
const stores: Store[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  Object.assign(profiles.toolVersionPromotionProjection, original);
  for (const store of stores.splice(0)) store.close();
});
function fixture() {
  const input = promotionFixture('claude_code');
  appendPromotionDecision(input, { grants: ['admission', 'qualification'] });
  Object.assign(profiles.toolVersionPromotionProjection, projectToolVersionPromotions(input));
  const facet = profiles.toolVersionPromotionProjection.facets[0];
  if (!facet) throw new Error('fixture_facet_missing');
  const store = new Store(':memory:');
  stores.push(store);
  store.execute("INSERT INTO projects(id,local_root) VALUES ('project','/synthetic/project')", []);
  store.execute("INSERT INTO tasks(id,project_id) VALUES ('task','project')", []);
  const key = toolVersionPromotionKey(facet);
  const authority = () =>
    issuePromotionBindingAuthority(store, {
      taskId: 'task',
      product: 'claude_code',
      productVersion: key.productVersion,
      topology: 'root',
      bundleContract: 'claude-promoted-bundle-v1'
    });
  return { store, key, authority };
}

test('a matching effective grant yields live stable-key authority without native access', () => {
  const f = fixture();
  const authority = f.authority();
  expect(authority.key).toEqual(f.key);
  expect(authority.producerContract).toBe('promoted-payload-v1');
  expect(authority.assertAuthorized('native')).toMatchObject({
    state: 'allowed',
    generation: 0
  });
});

test('revocation during producer verification cannot return a stale allowed authority', () => {
  const f = fixture();
  let revoke = false;
  const authority = issuePromotionBindingAuthority(f.store, {
    taskId: 'task',
    product: 'claude_code',
    productVersion: f.key.productVersion,
    topology: 'root',
    bundleContract: 'claude-promoted-bundle-v1',
    assertProducerContract: () => {
      if (revoke) {
        recordToolVersionPromotionDenial(f.store, {
          key: f.key,
          reason: 'revoke',
          recordedAt: '2026-11-09T00:00:00.000Z'
        });
      }
    }
  });
  revoke = true;
  expect(() => authority.assertAuthorized()).toThrow('promotion_authority_denied');
});

test.each(['finalize', 'generation', 'project', 'workspace', 'native'] as const)(
  '%s during producer verification cannot return stale lifecycle authority',
  change => {
    const f = fixture();
    let armed = false;
    const authority = issuePromotionBindingAuthority(f.store, {
      taskId: 'task',
      product: 'claude_code',
      productVersion: f.key.productVersion,
      topology: 'root',
      bundleContract: 'claude-promoted-bundle-v1',
      assertProducerContract: () => {
        if (!armed) return;
        switch (change) {
          case 'finalize':
            f.store.execute("UPDATE tasks SET state='finalized' WHERE id='task'", []);
            break;
          case 'generation':
            f.store.execute("UPDATE tasks SET generation=generation+1 WHERE id='task'", []);
            break;
          case 'project':
            f.store.execute("INSERT INTO tombstones(kind,id,deleted_at) VALUES ('project','project',?)", ['2026-11-09T00:00:00.000Z']);
            break;
          case 'workspace':
            f.store.execute("UPDATE projects SET local_root='/synthetic/other' WHERE id='project'", []);
            break;
          case 'native':
            f.store.execute("INSERT INTO binding_native_tombstones(product,native_session_id) VALUES ('claude_code','native')", []);
            break;
        }
      }
    });
    armed = true;
    expect(() => authority.assertAuthorized('native')).toThrow(change === 'project' || change === 'native' ? 'deleted_identifier' : 'binding_scope_revoked');
  }
);

test('immutable projection derivations are reused while every guard still observes fresh local denials', () => {
  const f = fixture();
  const digest = vi.spyOn(promotionCore, 'promotionProjectionDigest');
  const authority = f.authority();
  const initial = authority.assertAuthorized();
  authority.assertAuthorized();
  recordToolVersionPromotionDenial(f.store, {
    key: { ...f.key, profileId: f.key.profileId + '-other' },
    reason: 'revoke',
    recordedAt: '2026-11-09T00:00:00.000Z'
  });
  const changed = authority.assertAuthorized();
  expect(changed.generation).toBe(initial.generation + 1);
  recordToolVersionPromotionDenial(f.store, {
    key: f.key,
    reason: 'revoke',
    recordedAt: '2026-11-09T00:00:00.000Z'
  });
  expect(() => authority.assertAuthorized()).toThrow('promotion_authority_denied');
  expect(digest).toHaveBeenCalledTimes(1);
});

test.each(['revoke', 'delete'] as const)('%s denies authority independently of cached success', reason => {
  const f = fixture();
  const authority = f.authority();
  authority.assertAuthorized();
  recordToolVersionPromotionDenial(f.store, {
    key: f.key,
    reason,
    recordedAt: '2026-11-09T00:00:00.000Z'
  });
  expect(() => authority.assertAuthorized()).toThrow('promotion_authority_denied');
});

test('required grant removal invalidates an existing authority object', () => {
  const f = fixture();
  const authority = f.authority();
  Object.assign(profiles.toolVersionPromotionProjection, { facets: [] });
  expect(() => authority.assertAuthorized()).toThrow('promotion_authority_missing');
});

test.each(['task', 'project', 'native'] as const)('%s lifecycle fence wins over effective promotion grants', fence => {
  const f = fixture();
  const authority = f.authority();
  if (fence === 'native') {
    f.store.execute("INSERT INTO binding_native_tombstones(product,native_session_id) VALUES ('claude_code','native')", []);
  } else {
    f.store.execute('INSERT INTO tombstones(kind,id,deleted_at) VALUES (?,?,?)', [fence, fence, '2026-11-09T00:00:00.000Z']);
  }
  expect(() => authority.assertAuthorized('native')).toThrow('deleted_identifier');
});

test('a generation change between live checks refuses an otherwise still eligible grant', () => {
  const f = fixture();
  const authority = f.authority();
  const provider: Pick<SessionBindingProvider, 'promotionAuthority'> = {
    promotionAuthority: authority
  };
  const checkpoint = promotionBindingCheckpoint(provider);
  recordToolVersionPromotionDenial(f.store, {
    key: { ...f.key, profileId: f.key.profileId + '-other' },
    reason: 'revoke',
    recordedAt: '2026-11-09T00:00:00.000Z'
  });
  expect(() => assertPromotionBindingCheckpoint(provider, checkpoint)).toThrow('promotion_generation_changed');
});

test('projection drift between live checks cannot reuse an old checkpoint', () => {
  const f = fixture();
  const provider: Pick<SessionBindingProvider, 'promotionAuthority'> = {
    promotionAuthority: f.authority()
  };
  const checkpoint = promotionBindingCheckpoint(provider);
  Object.assign(profiles.toolVersionPromotionProjection, {
    registry_digest: 'f'.repeat(64)
  });
  expect(() => assertPromotionBindingCheckpoint(provider, checkpoint)).toThrow('promotion_generation_changed');
});

test('an unavailable bundle contract does not authorize a promoted provider', () => {
  const f = fixture();
  expect(() =>
    issuePromotionBindingAuthority(f.store, {
      taskId: 'task',
      product: 'claude_code',
      productVersion: f.key.productVersion,
      topology: 'root',
      bundleContract: 'codex-promoted-bundle-v1'
    })
  ).toThrow('promoted_producer_contract_unverified');
});

test('the empty shipped projection leaves promoted providers unavailable', () => {
  const f = fixture();
  Object.assign(profiles.toolVersionPromotionProjection, original);
  expect(f.authority).toThrow('promoted_provider_unavailable');
});
