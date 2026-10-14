import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Lifecycle } from '../src/lifecycle.js';
import { Store } from '../src/store.js';
import {
  assertOrdinaryTaskPrepared, createOrdinaryTask, ordinaryProjectSettings,
  ordinaryTask, ordinaryTaskSettings, revokeOrdinaryObservation, saveOrdinaryProjectSettings,
} from '../src/ordinary-observation.js';
import { selectTaskPriceTable } from '../src/price-catalog-selection.js';

describe('ordinary observation preparation', () => {
  let store: Store;
  let root: string;
  const clock = () => '2026-10-13T09:00:00.000Z';
  const settings = {
    schema_version: 1, product: 'claude_code', product_version: '2.1.296',
    receipt_directory: '/synthetic/private/receipts',
    claude_projects_directory: '/synthetic/private/projects',
  };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ordinary-observation-'));
    store = new Store(':memory:');
    new Lifecycle(store, clock).registerProject('p1', root);
  });
  afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

  it('prepares task metadata and an immutable price pin without a comparison assignment', () => {
    saveOrdinaryProjectSettings(store, 'p1', settings, clock);
    const id = createOrdinaryTask(store, { project_id: 'p1', criterion_ids: ['accepted'] }, clock);
    expect(new Lifecycle(store).task(id)).toMatchObject({ state: 'registered', project_id: 'p1' });
    expect(JSON.parse(new Lifecycle(store).task(id).metadata)).toEqual({
      schema_version: 2, type: 'feature', expected_size: 'medium', assignee: 'local-user',
      product: 'claude_code', initial_model: null, criterion_ids: ['accepted'],
    });
    expect(store.all('SELECT * FROM comparison_protocols')).toEqual([]);
    expect(store.all('SELECT * FROM comparison_assignments')).toEqual([]);
    expect(store.all('SELECT * FROM comparison_confirmations')).toEqual([]);
    expect(assertOrdinaryTaskPrepared(store, id)).toEqual(settings);
    expect(selectTaskPriceTable(store, id, clock())).toEqual({
      tableId: ordinaryTask(store, id)?.price_table_id, selection: 'ordinary_task_pin',
    });
    expect(store.all('SELECT * FROM sessions')).toEqual([]);
    expect(store.eventCount()).toBe(0);
  });

  it('retains a task configuration when the project default changes', () => {
    saveOrdinaryProjectSettings(store, 'p1', settings, clock);
    const first = createOrdinaryTask(store, { project_id: 'p1', criterion_ids: ['accepted'] }, clock);
    const pin = ordinaryTask(store, first)?.price_table_id;
    const next = { ...settings, receipt_directory: '/synthetic/private/next-receipts' };
    saveOrdinaryProjectSettings(store, 'p1', next, clock);
    expect(ordinaryProjectSettings(store, 'p1')).toEqual(next);
    expect(ordinaryTaskSettings(store, first)).toEqual(settings);
    expect(selectTaskPriceTable(store, first, clock()).tableId).toBe(pin);
    const second = createOrdinaryTask(store, { project_id: 'p1', criterion_ids: ['reviewed'] }, clock);
    expect(ordinaryTaskSettings(store, second)).toEqual(next);
    expect(second).not.toBe(first);
  });

  it('requires registered project settings and explicit nonempty unique completion criteria', () => {
    expect(() => createOrdinaryTask(store, { project_id: 'p1', criterion_ids: ['accepted'] }, clock))
      .toThrow('ordinary_project_setup_required');
    expect(() => saveOrdinaryProjectSettings(store, 'missing', settings, clock)).toThrow('unknown_project');
    saveOrdinaryProjectSettings(store, 'p1', settings, clock);
    for (const criteria of [[], ['accepted', 'accepted']])
      expect(() => createOrdinaryTask(store, { project_id: 'p1', criterion_ids: criteria }, clock)).toThrow();
    expect(store.all('SELECT * FROM tasks')).toEqual([]);
  });

  it('rejects invalid settings and tampered task snapshots without activating observation', () => {
    expect(() => saveOrdinaryProjectSettings(store, 'p1',
      { ...settings, receipt_directory: 'relative/receipts' }, clock)).toThrow();
    expect(() => saveOrdinaryProjectSettings(store, 'p1', { ...settings, extra: true }, clock)).toThrow();
    saveOrdinaryProjectSettings(store, 'p1', settings, clock);
    const id = createOrdinaryTask(store, { project_id: 'p1', criterion_ids: ['accepted'] }, clock);
    store.execute('UPDATE ordinary_tasks SET settings=? WHERE task_id=?',
      [JSON.stringify({ ...settings, product_version: '2.1.294' }), id]);
    expect(() => assertOrdinaryTaskPrepared(store, id)).toThrow('ordinary_configuration_changed');
    expect(new Lifecycle(store).state(id)).toBe('registered');
  });

  it('revokes an ordinary task without finalizing the human outcome or changing its pins', () => {
    saveOrdinaryProjectSettings(store, 'p1', settings, clock);
    const id = createOrdinaryTask(store, { project_id: 'p1', criterion_ids: ['accepted'] }, clock);
    const pin = ordinaryTask(store, id)?.price_table_id;
    revokeOrdinaryObservation(store, id, clock);
    expect(() => assertOrdinaryTaskPrepared(store, id)).toThrow('binding_scope_revoked');
    expect(new Lifecycle(store).summary(id).outcome).toBeNull();
    expect(new Lifecycle(store).state(id)).toBe('registered');
    expect(ordinaryTask(store, id)?.price_table_id).toBe(pin);
  });

  it('uses the general lifecycle while keeping final human assessment immutable', () => {
    saveOrdinaryProjectSettings(store, 'p1', settings, clock);
    const id = createOrdinaryTask(store, { project_id: 'p1', criterion_ids: ['accepted'] }, clock);
    const life = new Lifecycle(store, clock);
    life.start(id); life.pause(id); life.resume(id);
    life.declareFirst(id); life.assessFirst(id, true); life.finalize(id, 'success', ['accepted']);
    expect(life.summary(id)).toMatchObject({ outcome: 'success', first_success: true });
    expect(() => assertOrdinaryTaskPrepared(store, id)).toThrow('binding_scope_revoked');
    expect(() => life.resume(id)).toThrow('invalid_transition');
    expect(store.all('SELECT * FROM comparison_assignments')).toEqual([]);
  });
});
