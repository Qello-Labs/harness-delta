import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { Lifecycle } from '../src/lifecycle.js';
import { Store } from '../src/store.js';
import { EventSchema } from '../src/contracts.js';

test.each([['codex', '0.161.0'], ['codex', '0.162.1'], ['claude_code', '2.1.292'], ['claude_code', '2.1.293'], ['claude_code', '2.1.296']])('recent regular %s can enroll without opening its source', (product, version) => {
  const root = mkdtempSync(join(tmpdir(), 'compatibility-'));
  const store = new Store(':memory:');
  try {
    const life = new Lifecycle(store);
    life.registerProject('p', root);
    life.createTask('p', 't', { type: 'feature', expected_size: 'small', assignee: 'u', product, model: 'synthetic', criterion_ids: ['c'] });
    expect(() => life.linkSession('t', 's', join(root, 'absent.jsonl'), product, version)).not.toThrow();
    expect(store.get('SELECT product_version FROM sessions WHERE id=?', ['s'])).toEqual({ product_version: version });
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

import { collectionFixture, products } from './helpers/collection-fixture.js';

test.each(products)('%s latest stable reuses its parser, counts only new turns and persists trust', product => {
  const version = product === 'codex' ? '0.162.1' : '2.1.296';
  const f = collectionFixture(product, version);
  try {
    f.life.start('t1');
    f.rows(...f.turn(1, 2)); f.set(3); f.collector.tick('t1');
    f.rows(...f.turn(1, 2), ...f.turn(4, 5, 2, 'new')); f.set(6);
    expect(f.collector.tick('t1')).toEqual([]);
    f.collector.tick('t1');
    expect(f.events()).toHaveLength(1);
    expect(f.events()).toMatchObject([{ product_version: version, input_total: { value: 100 }, source_compatibility: {
      state: 'compatibility_unverified', product_version: version, parser_version: product === 'codex' ? '0.158.0' : '2.1.283',
      source: 'file', rule_revision: 'forward-version-v1',
    } }]);
  } finally { f.cleanup(); }
});

import { Collector } from '../src/collection.js';
import { effectiveSourceCompatibility, invalidateCompatibility, overlayEventCompatibility, resolveSourceCompatibility, sessionCompatibility } from '../src/source-compatibility.js';

test('finite source windows prefer exact verified profiles and reject suffixes and boundary transitions', () => {
  expect(resolveSourceCompatibility('codex', '0.158.0', 'file')?.state).toBe('verified');
  expect(resolveSourceCompatibility('codex', '0.160.0', 'codex_workflow')?.state).toBe('verified');
  expect(resolveSourceCompatibility('claude_code', '2.1.291', 'claude_workflow')?.state).toBe('verified');
  for (const version of ['0.158.1', '0.159.0', '0.163.999']) expect(resolveSourceCompatibility('codex', version, 'file')?.state).toBe('compatibility_unverified');
  for (const version of ['0.157.0', '0.164.0', '1.0.0', '0.161.0-rc.1', '0.161.0+build', '00.161.0', '0.161.0 ', '0.161.1000000000']) {
    expect(resolveSourceCompatibility('codex', version, 'file')).toBeNull();
  }
  for (const version of ['2.1.282', '2.2.0', '3.0.0', '2.1.292-rc.1', '2.1.0292']) expect(resolveSourceCompatibility('claude_code', version, 'file')).toBeNull();
  expect(resolveSourceCompatibility('claude_code', '2.1.290', 'claude_workflow')).toBeNull();
  expect(resolveSourceCompatibility('codex', '0.161.0', 'claude_workflow')).toBeNull();
  expect(resolveSourceCompatibility('codex', '0.161.0', 'codex_workflow', 'unknown')).toBeNull();
});

test.each(products)('%s parser failure blocks the cohort persistently, before further access, without changing event bytes', product => {
  const f = collectionFixture(product, product === 'codex' ? '0.161.0' : '2.1.292');
  try {
    f.life.start('t1'); f.collector.tick('t1');
    f.rows(...f.turn(1, 2)); f.set(3); f.collector.tick('t1');
    const original = f.store.all('SELECT * FROM events');
    expect(original).toHaveLength(1);
    f.replace([f.header(), ...f.turn(1, 2)].map(row => JSON.stringify(row)).join('\n') + '\n{"invalid":"SYNTHETIC_PRIVATE"\n'); f.set(4);
    expect(f.collector.tick('t1')).toMatchObject([{ category: 'invalid_json' }]);
    const compatibility = sessionCompatibility(f.store, 's1')!;
    expect(compatibility.state).toBe('compatibility_unverified');
    expect(effectiveSourceCompatibility(f.store, compatibility).state).toBe('invalidated');
    const reads = f.reads();
    expect(new Collector(f.store, f.clock, f.read).tick('t1')).toMatchObject([{ category: 'compatibility_invalidated' }]);
    expect(f.reads()).toBe(reads);
    expect(f.store.all('SELECT * FROM events')).toEqual(original);
    expect(JSON.stringify(f.store.all('SELECT * FROM source_compatibility_blocks'))).not.toContain('SYNTHETIC_PRIVATE');
    expect(() => f.link('s2')).toThrow('compatibility_invalidated');
  } finally { f.cleanup(); }
});

test('source version drift cannot select a new parser or read under an old pin', () => {
  const f = collectionFixture('codex', '0.161.0');
  try {
    f.life.start('t1'); f.collector.tick('t1');
    const pin = sessionCompatibility(f.store, 's1');
    f.store.execute("UPDATE sessions SET product_version='0.162.0' WHERE id='s1'", []);
    const reads = f.reads();
    expect(f.collector.tick('t1')).toMatchObject([{ category: 'unsupported_source' }]);
    expect(f.reads()).toBe(reads);
    expect(sessionCompatibility(f.store, 's1')).toEqual(pin);
  } finally { f.cleanup(); }
});

test('deletion removes session provenance while version blocks remain durable', () => {
  const f = collectionFixture('claude_code', '2.1.292');
  try {
    const compatibility = sessionCompatibility(f.store, 's1')!;
    invalidateCompatibility(f.store, compatibility, 'semantic_incompatibility');
    f.store.execute('DELETE FROM tasks WHERE id=?', ['t1']);
    expect(sessionCompatibility(f.store, 's1')).toBeNull();
    expect(effectiveSourceCompatibility(f.store, compatibility).state).toBe('invalidated');
  } finally { f.cleanup(); }
});

test('pins and incompatibility blocks survive database reopen without backfill or provenance upgrade', () => {
  const root = mkdtempSync(join(tmpdir(), 'compatibility-reopen-')); const file = join(root, 'db.sqlite');
  const store = new Store(file);
  let pinned;
  try {
    const life = new Lifecycle(store); life.registerProject('p', root);
    life.createTask('p', 't', { type: 'feature', expected_size: 'small', assignee: 'u', product: 'codex', model: 'synthetic', criterion_ids: ['c'] });
    life.linkSession('t', 's', join(root, 'absent.jsonl'), 'codex', '0.161.0');
    pinned = sessionCompatibility(store, 's')!;
    invalidateCompatibility(store, pinned, 'semantic_incompatibility');
  } finally { store.close(); }
  const reopened = new Store(file);
  try {
    expect(sessionCompatibility(reopened, 's')).toEqual(pinned);
    expect(effectiveSourceCompatibility(reopened, pinned).state).toBe('invalidated');
    expect(reopened.eventCount()).toBe(0);
    expect(() => new Lifecycle(reopened).linkSession('t', 'new', join(root, 'absent.jsonl'), 'codex', '0.161.0')).toThrow('compatibility_invalidated');
  } finally { reopened.close(); rmSync(root, { recursive: true, force: true }); }
});

test('a verified legacy-file pin cannot qualify usage from an injected flexible parser', () => {
  const f = collectionFixture('codex', '0.158.0');
  try {
    f.life.start('t1');
    const reading = { status: 'observed' as const, value: 1, reason: null };
    const event = { id: 'candidate', source_key: 'candidate', project_id: 'p1', task_id: 't1', session_id: 's1', occurred_at: f.clock(),
      payload: { kind: 'usage' as const, product: 'codex' as const, product_version: '0.158.0', epoch: 'candidate',
        input_total: reading, cached_input: reading, output_total: reading, reasoning_output: reading,
        schema_version: 2 as const, model: null, runtime_evidence_id: null, attribution: 'unknown' as const, billing_components: [] } };
    expect(f.store.putEvent(event)).toBe(true);
    const payload = f.store.get<{payload:string}>('SELECT payload FROM events')!.payload;
    expect(payload).not.toContain('source_compatibility');
    expect(f.store.putEvent(event)).toBe(false);
    expect(() => f.store.putEvent({ ...event, id: 'false-proof', source_key: 'false-proof', payload: {
      ...event.payload, source_compatibility: sessionCompatibility(f.store, 's1')!,
    } })).toThrow('compatibility_scope_mismatch');
    expect(() => f.store.execute("UPDATE session_source_compatibility SET payload='{}' WHERE session_id='s1'", [])).toThrow('immutable_source_compatibility');
  } finally { f.cleanup(); }
});

test('known incompatible exact versions stop pre-migration unpinned sessions before access', () => {
  const f = collectionFixture('codex');
  try {
    f.store.execute('DELETE FROM session_source_compatibility WHERE session_id=?', ['s1']);
    f.life.start('t1');
    invalidateCompatibility(f.store, resolveSourceCompatibility('codex', '0.156.1', 'file')!, 'semantic_incompatibility');
    const reads = f.reads();
    expect(f.collector.tick('t1')).toMatchObject([{ category: 'compatibility_invalidated' }]);
    expect(f.reads()).toBe(reads);
    expect(sessionCompatibility(f.store, 's1')).toBeNull();
  } finally { f.cleanup(); }
});

test('binding-only invalidation leaves unpinned historical usage unchanged', () => {
  const store = new Store(':memory:');
  const reading = {status:'observed',value:1,reason:null};
  const historical = EventSchema.parse({
    id:'historical',project_id:'p',task_id:'t',session_id:'s',source_key:'historical',
    occurred_at:'2026-01-01T00:00:00Z',payload:{kind:'usage',product:'codex',product_version:'0.162.1',
      epoch:'legacy',model:'gpt-6.1-sol',input_total:reading,cached_input:reading,output_total:reading,reasoning_output:reading},
  });
  try {
    const compatibility = resolveSourceCompatibility('codex','0.162.1','codex_binding');
    if(!compatibility)throw new Error('binding_profile_missing');

    invalidateCompatibility(store,compatibility,'contract_failed');

    expect(overlayEventCompatibility(store,historical)).toEqual(historical);
    expect(resolveSourceCompatibility('codex','0.162.1','file')).toMatchObject({state:'compatibility_unverified'});
  } finally {store.close();}
});
