import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { Store } from '../src/store.js';
import { Deletion } from '../src/deletion.js';
import { EventSchema, type SourceCompatibility } from '../src/contracts.js';
import * as profiles from '../src/core/tool-version-profiles.js';
import { projectToolVersionPromotions, promotionRegistryDigest } from '../src/core/tool-version-promotion.js';
import { readToolVersionPromotionAuthority, toolVersionPromotionKey } from '../src/core/tool-version-promotion-store.js';
import { effectiveSourceCompatibility, overlayEventCompatibility, pinSessionCompatibility, resolveSourceCompatibility } from '../src/source-compatibility.js';
import { appendPromotionDecision, promotionFixture } from './helpers/tool-version-promotion.js';
import { ordinaryWindowFixture } from './helpers/ordinary-window-fixture.js';
import { resolveOrdinaryWindow } from '../src/core/ordinary-window-policy.js';

const original = { ...profiles.toolVersionPromotionProjection };
const descriptors = [...profiles.promotedToolVersionDescriptors];
const identityFor = profiles.toolVersionIdentity;
const stores: Store[] = [];
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  Object.assign(profiles.toolVersionPromotionProjection, original);
  Object.assign(profiles.promotedToolVersionDescriptors, { length: 0 }, descriptors);
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(product: 'codex' | 'claude_code' = 'codex', file = ':memory:') {
  const input = promotionFixture(product);
  vi.spyOn(profiles, 'toolVersionIdentity').mockImplementation(id =>
    id === 'synthetic-' + product + '-image'
      ? {
          id,
          product,
          version: product === 'codex' ? '0.169.0' : '2.1.318',
          kind: 'native_image',
          sha256: 'e'.repeat(64)
        }
      : identityFor(id)
  );
  appendPromotionDecision(input, { grants: ['admission', 'qualification'] });
  Object.assign(profiles.toolVersionPromotionProjection, projectToolVersionPromotions(input));
  Object.assign(profiles.promotedToolVersionDescriptors, { length: 0 }, input.descriptors);
  const facet = profiles.toolVersionPromotionProjection.facets[0];
  if (!facet) throw new Error('fixture_facet_missing');
  const key = toolVersionPromotionKey(facet);
  const compatibility = resolveSourceCompatibility(product, key.productVersion, key.source, key.profileId);
  if (!compatibility) throw new Error('fixture_pin_missing');
  const store = new Store(file);
  stores.push(store);
  store.execute("INSERT INTO projects(id) VALUES ('project')", []);
  store.execute("INSERT INTO tasks(id,project_id) VALUES ('task','project')", []);
  store.execute("INSERT INTO sessions(id,project_id,task_id,product,product_version) VALUES ('session','project','task',?,?)", [product, key.productVersion]);
  const capture = () => pinSessionCompatibility(store, 'session', compatibility);
  return { store, key, compatibility, capture, input };
}
function usage(compatibility: SourceCompatibility) {
  return EventSchema.parse({
    id: 'event',
    project_id: 'project',
    task_id: 'task',
    session_id: 'session',
    source_key: 'synthetic:origin',
    occurred_at: '2026-11-09T00:00:00.000Z',
    payload: {
      kind: 'usage',
      epoch: 'synthetic',
      product: compatibility.product,
      product_version: compatibility.product_version,
      model: 'synthetic-model',
      input_total: { status: 'observed', value: 10, reason: null },
      cached_input: { status: 'observed', value: 0, reason: null },
      output_total: { status: 'observed', value: 1, reason: null },
      reasoning_output: { status: 'observed', value: 0, reason: null },
      source_compatibility: compatibility
    }
  });
}
function removePromotionRecords() {
  Object.assign(profiles.toolVersionPromotionProjection, { facets: [], denials: [] });
  Object.assign(profiles.promotedToolVersionDescriptors, { length: 0 });
}

test.each(['codex', 'claude_code'] as const)('%s captured promoted pin must fail closed when both descriptor and grant records are missing', product => {
  const f = fixture(product);
  f.capture();
  removePromotionRecords();
  expect(readToolVersionPromotionAuthority(f.store, { key: f.key, requiredGrants: ['admission', 'qualification'] }).state).toBe('missing_grant');
  expect(resolveSourceCompatibility(product, f.key.productVersion, f.key.source, f.key.profileId)).toBeNull();
  expect(effectiveSourceCompatibility(f.store, f.compatibility).state).toBe('invalidated');
  expect(() => f.store.putEvent(usage(f.compatibility))).toThrow('compatibility_invalidated');
  expect(f.store.eventCount()).toBe(0);
  expect(f.store.all('SELECT event_id FROM event_receipts')).toEqual([]);
});

test('capturing a promoted pin persists an immutable snake_case origin once without changing its payload', () => {
  const f = fixture();
  f.capture();
  const rows = f.store.all<{ key_json: string; recorded_at: string; scope_key: string }>('SELECT * FROM tool_version_promotion_origins');
  expect(rows).toHaveLength(1);
  const row = rows[0];
  if (!row) throw new Error('fixture_origin_missing');
  expect(JSON.parse(row.key_json)).toEqual({
    product: 'codex',
    product_version: f.key.productVersion,
    source: f.key.source,
    profile_id: f.key.profileId,
    descriptor_lineage: f.key.descriptorLineage,
    operation: 'collect',
    topology: 'root',
    platform: f.key.platform,
    runtime: f.key.runtime
  });
  expect(row.scope_key).toBe(promotionRegistryDigest(f.key));
  f.capture();
  expect(f.store.all('SELECT * FROM tool_version_promotion_origins')).toEqual(rows);
  expect(f.store.get<{ payload: string }>('SELECT payload FROM session_source_compatibility')?.payload).toBe(JSON.stringify(f.compatibility));
  expect(() => f.store.execute("UPDATE tool_version_promotion_origins SET recorded_at='2026-11-10T00:00:00.000Z'", [])).toThrow('promotion_origin_immutable');
  expect(() => f.store.execute('DELETE FROM tool_version_promotion_origins', [])).toThrow('promotion_origin_immutable');
});

test.each(['codex', 'claude_code'] as const)('%s legacy pins remain usable and do not record promoted origins', product => {
  const f = fixture(product);
  removePromotionRecords();
  const version = product === 'codex' ? '0.163.0' : '2.1.306';
  const legacy = resolveSourceCompatibility(product, version, f.key.source);
  if (!legacy) throw new Error('fixture_legacy_missing');
  f.store.execute("UPDATE sessions SET product_version=? WHERE id='session'", [version]);
  pinSessionCompatibility(f.store, 'session', legacy);
  expect(effectiveSourceCompatibility(f.store, legacy)).toEqual(legacy);
  expect(f.store.putEvent(usage(legacy))).toBe(true);
  expect(f.store.all('SELECT * FROM tool_version_promotion_origins')).toEqual([]);
});

test.each(['codex', 'claude_code'] as const)('%s frozen window capture is usable without promoted records or origins', product => {
  removePromotionRecords();
  const f = ordinaryWindowFixture(product);
  stores.push(f.store);
  f.activate();
  f.connect();
  const window = resolveOrdinaryWindow(product, f.selection.declaredVersion, f.selection.policy.policyId);
  if (!window) throw new Error('fixture_window_missing');
  pinSessionCompatibility(f.store, f.rootId, window.compatibility);
  expect(effectiveSourceCompatibility(f.store, window.compatibility)).toEqual(window.compatibility);
  expect(f.store.all('SELECT session_id FROM session_source_compatibility')).toEqual([{ session_id: f.rootId }]);
  expect(f.store.all('SELECT * FROM tool_version_promotion_origins')).toEqual([]);
});

test('historical non-promoted data without an origin keeps its existing non-authorizing behavior', () => {
  const f = fixture();
  removePromotionRecords();
  const historical = {
    ...f.compatibility,
    parser_revision: 'synthetic-report-parser',
    profile_id: 'synthetic-report-profile',
    rule_revision: 'synthetic-report-rule'
  };
  f.store.execute("INSERT INTO session_source_compatibility(session_id,payload) VALUES ('session',?)", [JSON.stringify(historical)]);
  expect(effectiveSourceCompatibility(f.store, historical)).toEqual(historical);
  expect(resolveSourceCompatibility('codex', f.key.productVersion, f.key.source, historical.profile_id)).toBeNull();
  expect(f.store.putEvent(usage(historical))).toBe(true);
  expect(f.store.all('SELECT * FROM tool_version_promotion_origins')).toEqual([]);
});

test('origin insertion failure rolls back the session pin and leaves no promoted origin', () => {
  const f = fixture();
  f.store.execute("CREATE TRIGGER fail_origin BEFORE INSERT ON tool_version_promotion_origins BEGIN SELECT RAISE(ABORT,'fixture_origin_failed'); END", []);
  expect(f.capture).toThrow('fixture_origin_failed');
  expect(f.store.all('SELECT * FROM session_source_compatibility')).toEqual([]);
  expect(f.store.all('SELECT * FROM tool_version_promotion_origins')).toEqual([]);
});

test('origin survives task and project deletion, missing evidence and database reopen', () => {
  const directory = mkdtempSync(join(tmpdir(), 'promotion-origin-'));
  roots.push(directory);
  const file = join(directory, 'store.sqlite');
  const f = fixture('codex', file);
  f.capture();
  const origins = f.store.all('SELECT * FROM tool_version_promotion_origins');
  const deletion = new Deletion(f.store, () => '2026-11-09T00:00:00.000Z');
  deletion.deleteTask('task');
  expect(f.store.all('SELECT * FROM tool_version_promotion_origins')).toEqual(origins);
  deletion.deleteProject('project');
  expect(f.store.all('SELECT * FROM tool_version_promotion_origins')).toEqual(origins);
  f.store.close();
  stores.splice(stores.indexOf(f.store), 1);
  const reopened = new Store(file);
  stores.push(reopened);
  removePromotionRecords();
  expect(reopened.all('SELECT * FROM tool_version_promotion_origins')).toEqual(origins);
  expect(effectiveSourceCompatibility(reopened, f.compatibility).state).toBe('invalidated');
});

test('missing only the declared descriptor refuses an origin even if a stale facet remains', () => {
  const f = fixture();
  f.capture();
  Object.assign(profiles.promotedToolVersionDescriptors, { length: 0 });
  expect(effectiveSourceCompatibility(f.store, f.compatibility).state).toBe('invalidated');
});

test('missing promotion records invalidates history without rewriting captured event bytes', () => {
  const f = fixture();
  f.capture();
  const event = usage(f.compatibility);
  f.store.putEvent(event);
  const rows = f.store.all('SELECT * FROM events');
  removePromotionRecords();
  expect(overlayEventCompatibility(f.store, event).payload).toMatchObject({ source_compatibility: { state: 'invalidated' } });
  expect(f.store.all('SELECT * FROM events')).toEqual(rows);
});
