import { afterEach, expect, test, vi } from 'vitest';
import { Store } from '../src/store.js';
import { EventSchema } from '../src/contracts.js';
import { promotedToolVersionDescriptors, toolVersionPromotionProjection } from '../src/core/tool-version-profiles.js';
import { projectToolVersionPromotions } from '../src/core/tool-version-promotion.js';
import { recordToolVersionPromotionDenial, toolVersionPromotionKey } from '../src/core/tool-version-promotion-store.js';
import {
  assertCompatibilityAllowed,
  effectiveSourceCompatibility,
  overlayEventCompatibility,
  resolveSourceCompatibility
} from '../src/source-compatibility.js';
import { appendPromotionDecision, promotionFixture } from './helpers/tool-version-promotion.js';
import { ordinaryWindowFixture } from './helpers/ordinary-window-fixture.js';
import { assertOrdinaryWindowAuthority } from '../src/core/ordinary-window-store.js';
import { importExchangePackage } from '../src/comparison/exchange/import.js';
import { paired, receivedAt } from './helpers/exchange-import-fixture.js';
import { createLocalWebBindingProviders } from '../src/web/local-web-binding-providers.js';

const original = { ...toolVersionPromotionProjection };
const originalDescriptors = [...promotedToolVersionDescriptors];
const stores: Store[] = [];
afterEach(() => {
  Object.assign(toolVersionPromotionProjection, original);
  Object.assign(promotedToolVersionDescriptors, { length: 0 }, originalDescriptors);
  for (const store of stores.splice(0)) store.close();
});
function fixture() {
  const input = promotionFixture();
  appendPromotionDecision(input, { grants: ['admission', 'qualification'] });
  Object.assign(toolVersionPromotionProjection, projectToolVersionPromotions(input));
  Object.assign(promotedToolVersionDescriptors, { length: 0 }, input.descriptors);
  const facet = toolVersionPromotionProjection.facets[0];
  if (!facet) throw new Error('fixture_facet_missing');
  const compatibility = resolveSourceCompatibility('codex', facet.descriptor.version, 'codex_binding', facet.descriptor.profileId);
  if (!compatibility) throw new Error('fixture_compatibility_missing');
  const store = new Store(':memory:');
  stores.push(store);
  const key = toolVersionPromotionKey(facet);
  const deny = () =>
    recordToolVersionPromotionDenial(store, {
      key,
      reason: 'revoke',
      recordedAt: '2026-11-09T01:00:00.000Z'
    });
  return { store, key, compatibility, deny, input };
}

test('local denial refuses promoted support and overlays historical usage without changing its bytes', () => {
  const f = fixture();
  expect(effectiveSourceCompatibility(f.store, f.compatibility).state).toBe('verified');
  const event = EventSchema.parse({
    id: 'event',
    project_id: 'project',
    task_id: 'task',
    session_id: 'session',
    source_key: 'synthetic:promotion',
    occurred_at: '2026-11-09T01:00:00.000Z',
    payload: {
      kind: 'usage',
      epoch: 'synthetic-epoch',
      product: 'codex',
      product_version: f.key.productVersion,
      model: 'gpt-6.1-sol',
      input_total: { status: 'observed', value: 10, reason: null },
      cached_input: { status: 'observed', value: 0, reason: null },
      output_total: { status: 'observed', value: 5, reason: null },
      reasoning_output: { status: 'observed', value: 0, reason: null },
      source_compatibility: f.compatibility
    }
  });
  const bytes = JSON.stringify(event);
  f.store.execute("INSERT INTO projects(id) VALUES ('project')", []);
  f.store.execute("INSERT INTO tasks(id,project_id) VALUES ('task','project')", []);
  f.store.execute("INSERT INTO sessions(id,project_id,task_id,product,product_version) VALUES ('session','project','task','codex',?)", [f.key.productVersion]);
  f.store.execute("INSERT INTO session_source_compatibility(session_id,payload) VALUES ('session',?)", [JSON.stringify(f.compatibility)]);
  expect(f.store.putEvent(event)).toBe(true);
  f.deny();
  expect(() => assertCompatibilityAllowed(f.store, f.compatibility)).toThrow('compatibility_invalidated');
  expect(overlayEventCompatibility(f.store, event).payload).toMatchObject({
    source_compatibility: { state: 'invalidated' }
  });
  expect(JSON.stringify(event)).toBe(bytes);
  expect(() =>
    f.store.putEvent({
      ...event,
      id: 'later-event',
      source_key: 'synthetic:later'
    })
  ).toThrow('compatibility_invalidated');
  expect(f.store.eventCount()).toBe(1);
  expect(f.store.all('SELECT event_id FROM event_receipts')).toEqual([
    {
      event_id: 'event'
    }
  ]);
});

test.each(['static', 'factory', 'cached'] as const)('web %s provider selection refuses a denied pin before returning a provider', entry => {
  const f = fixture();
  f.store.execute("INSERT INTO projects(id) VALUES ('project')", []);
  f.store.execute("INSERT INTO tasks(id,project_id) VALUES ('task','project')", []);
  f.store.execute("INSERT INTO sessions(id,project_id,task_id,product,product_version) VALUES ('session','project','task','codex',?)", [f.key.productVersion]);
  f.store.execute("INSERT INTO session_source_compatibility(session_id,payload) VALUES ('session',?)", [JSON.stringify(f.compatibility)]);
  const factory = vi.fn(() => []);
  const readers = createLocalWebBindingProviders({
    options: {
      store: f.store,
      metadataFile: '/synthetic/unused.sqlite',
      bindingProviderFactory: factory,
      ...(entry === 'static' ? { bindingProviders: [] } : {})
    },
    recordFor: () => undefined,
    setupFor: () => {
      throw new Error('fixture_setup_forbidden');
    },
    profileFor: () => {
      throw new Error('fixture_profile_forbidden');
    },
    get codexProjects(): ReturnType<typeof import('../src/web/local-web-codex.js').createCodexProjectSetupManager> {
      throw new Error('fixture_setup_forbidden');
    },
    ordinaryBindings: () => {
      throw new Error('fixture_bindings_forbidden');
    },
    humanPilot: () => undefined
  });
  if (entry === 'cached') readers.providers.set('task', []);
  f.deny();
  expect(() => readers.providersForTask('task')).toThrow('compatibility_invalidated');
  expect(factory).not.toHaveBeenCalled();
});

test('qualification withdrawal cannot leave a verified promoted pin usable through a remaining admission', () => {
  const f = fixture();
  appendPromotionDecision(f.input, {
    decision: 'demote',
    reason: 'qualification_withdrawn',
    grants: ['admission']
  });
  Object.assign(toolVersionPromotionProjection, projectToolVersionPromotions(f.input));
  expect(effectiveSourceCompatibility(f.store, f.compatibility).state).toBe('invalidated');
  expect(resolveSourceCompatibility('codex', f.key.productVersion, 'codex_binding', f.key.profileId)?.state).toBe('compatibility_unverified');
  expect(f.compatibility.state).toBe('verified');
});

test('removing a required promoted facet refuses its frozen pin instead of selecting the eligible window', () => {
  const f = fixture();
  Object.assign(toolVersionPromotionProjection, { facets: [] });
  expect(effectiveSourceCompatibility(f.store, f.compatibility).state).toBe('invalidated');
  expect(resolveSourceCompatibility('codex', f.key.productVersion, 'codex_binding', f.key.profileId)).toBeNull();
  expect(f.compatibility.profile_id).toBe(f.key.profileId);
});

test('an explicit frozen window remains independently authorized after an exact-scope denial', () => {
  const f = fixture();
  const window = ordinaryWindowFixture();
  stores.push(window.store);
  window.activate();
  window.connect();
  recordToolVersionPromotionDenial(window.store, {
    key: f.key,
    reason: 'revoke',
    recordedAt: window.clock()
  });
  expect(
    assertOrdinaryWindowAuthority(window.store, {
      taskId: window.taskId,
      rootSessionId: window.rootId
    })
  ).toEqual(window.selection);
  expect(effectiveSourceCompatibility(window.store, f.compatibility).state).toBe('invalidated');
});

test.each(['local', 'shipped'] as const)('stale or new-ID exchange imports cannot clear a %s deny', kind => {
  const f = fixture();
  const exchange = paired();
  stores.push(exchange.source, exchange.dest);
  if (kind === 'local') {
    recordToolVersionPromotionDenial(exchange.dest, {
      key: f.key,
      reason: 'delete',
      recordedAt: receivedAt
    });
  } else {
    appendPromotionDecision(f.input, {
      decision: 'revoke',
      reason: 'authority_withdrawn',
      grants: []
    });
    Object.assign(toolVersionPromotionProjection, projectToolVersionPromotions(f.input));
  }
  const before = exchange.dest.all('SELECT * FROM tool_version_promotion_denials');
  for (const packageId of [exchange.pkg.package_id, '66666666-6666-4666-8666-666666666666']) {
    const candidate = { ...exchange.pkg, package_id: packageId };
    expect(() => importExchangePackage(exchange.dest, { ...candidate, promotion_denials: [] }, 'destination', () => receivedAt)).toThrow(
      'invalid_exchange_package'
    );
  }
  expect(importExchangePackage(exchange.dest, exchange.pkg, 'destination', () => receivedAt).status).toBe('imported');
  expect(exchange.dest.all('SELECT * FROM tool_version_promotion_denials')).toEqual(before);
  expect(effectiveSourceCompatibility(exchange.dest, f.compatibility).state).toBe('invalidated');
});
