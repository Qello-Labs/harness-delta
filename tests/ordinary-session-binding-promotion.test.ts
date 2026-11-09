import { afterEach, expect, test, vi } from 'vitest';
import * as profiles from '../src/core/tool-version-profiles.js';
import { projectToolVersionPromotions } from '../src/core/tool-version-promotion.js';
import { recordToolVersionPromotionDenial } from '../src/core/tool-version-promotion-store.js';
import { issuePromotionBindingAuthority } from '../src/binding/session-binding-promotion.js';
import { appendPromotionDecision, promotionFixture } from './helpers/tool-version-promotion.js';
import { ordinaryBindingFixture } from './helpers/ordinary-session-binding-fixture.js';
import { Deletion } from '../src/deletion.js';

const projection = { ...profiles.toolVersionPromotionProjection };
const descriptors = [...profiles.promotedToolVersionDescriptors];
const originalIdentity = profiles.toolVersionIdentity;
const fixtures: ReturnType<typeof ordinaryBindingFixture>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.cleanup();
  vi.restoreAllMocks();
  Object.assign(profiles.toolVersionPromotionProjection, projection);
  Object.assign(profiles.promotedToolVersionDescriptors, { length: 0 }, descriptors);
});
function fixture() {
  const input = promotionFixture('claude_code');
  for (const operation of ['collect', 'link', 'restart'] as const) {
    appendPromotionDecision(input, {
      grants: ['admission', 'qualification'],
      scope: {
        target: { version: '2.1.318', commit: 'a'.repeat(40) },
        lane: {
          product: 'claude_code',
          route: 'claude_binding',
          profile_id: 'claude-binding-2-1-318-family-v1',
          operation,
          topology: 'root'
        },
        platform: 'darwin_arm64',
        runtime: Number(process.versions.node.split('.')[0]) === 24 ? 'node24' : 'node26'
      }
    });
  }
  Object.assign(profiles.toolVersionPromotionProjection, projectToolVersionPromotions(input));
  Object.assign(profiles.promotedToolVersionDescriptors, { length: 0 }, input.descriptors);
  vi.spyOn(profiles, 'toolVersionIdentity').mockImplementation(id =>
    id === 'synthetic-claude_code-image'
      ? {
          id,
          product: 'claude_code',
          version: '2.1.318',
          kind: 'native_image',
          sha256: 'e'.repeat(64)
        }
      : originalIdentity(id)
  );
  const f = ordinaryBindingFixture('2.1.318');
  fixtures.push(f);
  const authority = issuePromotionBindingAuthority(f.store, {
    taskId: f.taskId,
    product: 'claude_code',
    productVersion: '2.1.318',
    topology: 'root',
    bundleContract: 'claude-promoted-bundle-v1'
  });
  Object.defineProperty(f.provider, 'promotionAuthority', {
    value: authority
  });
  const deny = (unrelated = false) =>
    recordToolVersionPromotionDenial(f.store, {
      key: unrelated
        ? {
            ...authority.key,
            profileId: authority.key.profileId + '-other'
          }
        : authority.key,
      reason: 'revoke',
      recordedAt: f.clock()
    });
  return { ...f, deny };
}
function signal() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  if (!resolve) throw new Error('fixture_signal_missing');
  return { promise, resolve };
}

test('a promoted exact task connects prospectively and persists its origin without changing task pins', async () => {
  const f = fixture();
  const before = f.store.get('SELECT settings,settings_hash,price_table_id FROM ordinary_tasks WHERE task_id=?', [f.taskId]);
  const connected = await f.connect();
  expect(connected.automatic_children).toBe(false);
  expect(f.store.all('SELECT * FROM tool_version_promotion_origins')).toHaveLength(1);
  expect(f.store.get('SELECT settings,settings_hash,price_table_id FROM ordinary_tasks WHERE task_id=?', [f.taskId])).toEqual(before);
  expect(f.store.eventCount()).toBe(0);
});

test('denial before connect prevents receipt inspection and all native reads', async () => {
  const f = fixture();
  f.deny();
  await expect(f.connect()).rejects.toThrow('promotion_authority_denied');
  expect(f.inspections).toEqual([]);
  expect(f.bodyReads).toEqual([]);
  expect(f.store.all('SELECT * FROM sessions')).toEqual([]);
});

test.each(['deny', 'generation', 'missing', 'task'] as const)('%s during receipt inspection prevents root reservation', async race => {
  const f = fixture();
  f.onInspect(() => {
    if (race === 'missing') {
      Object.assign(profiles.toolVersionPromotionProjection, {
        facets: []
      });
    } else if (race === 'task') {
      new Deletion(f.store, f.clock).deleteTask(f.taskId);
    } else f.deny(race === 'generation');
    return Promise.resolve();
  });
  await expect(f.connect()).rejects.toThrow();
  expect(f.bodyReads).toEqual([]);
  expect(f.store.all('SELECT * FROM sessions')).toEqual([]);
  expect(f.store.all('SELECT * FROM binding_root_segments')).toEqual([]);
});

test('baseline exclusions remain staged when promotion is revoked during the provider await', async () => {
  const f = fixture();
  f.usage();
  const entered = signal();
  const release = signal();
  f.onRead(async boundary => {
    boundary?.baselineLedger?.add('synthetic-early-exclusion');
    entered.resolve();
    await release.promise;
  });
  const connecting = f.connect();
  const rejected = expect(connecting).rejects.toThrow('promotion_authority_denied');
  await entered.promise;
  const staged = f.store.all('SELECT * FROM binding_baseline_exclusions');
  f.deny();
  release.resolve();
  await rejected;
  expect(staged).toEqual([]);
  expect(f.store.all('SELECT * FROM binding_baseline_exclusions')).toEqual([]);
  expect(f.store.eventCount()).toBe(0);
  expect(f.store.all('SELECT * FROM binding_requests')).toEqual([]);
});

test.each(['deny', 'generation', 'native'] as const)('%s during usage leaves the committed cursor and history unchanged', async race => {
  const f = fixture();
  await f.connect();
  f.usage();
  const before = f.store.get('SELECT cursor FROM session_bindings');
  f.onRead(() => {
    if (race === 'native') {
      f.store.execute('INSERT INTO binding_native_tombstones(product,native_session_id) VALUES (?,?)', [
        'claude_code',
        f.current().nativeMapping?.nativeSessionId ?? ''
      ]);
    } else f.deny(race === 'generation');
    return Promise.resolve();
  });
  await expect(f.binding.tick(f.taskId)).rejects.toThrow();
  expect(f.store.get('SELECT cursor FROM session_bindings')).toEqual(before);
  expect(f.store.eventCount()).toBe(0);
  expect(f.store.all('SELECT * FROM runtime_evidence')).toEqual([]);
  expect(f.store.all('SELECT * FROM binding_requests')).toEqual([]);
});

test('a denial inserted before the final cursor write rolls back every staged event', async () => {
  const f = fixture();
  await f.connect();
  f.usage();
  const before = f.store.get('SELECT cursor FROM session_bindings');
  const execute = f.store.execute.bind(f.store);
  let armed = true;
  vi.spyOn(f.store, 'execute').mockImplementation((sql, parameters) => {
    if (armed && sql.startsWith('UPDATE session_bindings SET cursor=')) {
      armed = false;
      f.deny();
    }
    return execute(sql, parameters);
  });
  await expect(f.binding.tick(f.taskId)).rejects.toThrow('promotion_authority_denied');
  expect(f.store.get('SELECT cursor FROM session_bindings')).toEqual(before);
  expect(f.store.eventCount()).toBe(0);
  expect(f.store.all('SELECT * FROM runtime_evidence')).toEqual([]);
  expect(f.store.all('SELECT * FROM binding_requests')).toEqual([]);
});

test('a queued connect cannot inspect a receipt after the preceding operation observes revocation', async () => {
  const f = fixture();
  const entered = signal();
  const release = signal();
  f.onInspect(async () => {
    entered.resolve();
    await release.promise;
  });
  const first = f.connect();
  const firstRejected = expect(first).rejects.toThrow('promotion_authority_denied');
  await entered.promise;
  const second = f.connect();
  const secondRejected = expect(second).rejects.toThrow('promotion_authority_denied');
  f.deny();
  release.resolve();
  await Promise.all([firstRejected, secondRejected]);
  expect(f.inspections).toHaveLength(1);
  expect(f.store.all('SELECT * FROM sessions')).toEqual([]);
});
