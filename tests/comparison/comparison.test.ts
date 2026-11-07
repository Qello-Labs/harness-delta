import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { Store } from '../../src/store.js';
import { registerVariant, registerProtocol, freezeProtocol, showVariant } from '../../src/comparison/comparison.js';
import { showProtocol } from '../../src/readiness-store.js';
import { beforeRecruitment, protocol, seedProject, variantA, variantB } from '../helpers/comparison-fixture.js';

function registered(store: Store): void {
  seedProject(store);
  registerVariant(store, variantA);
  registerVariant(store, variantB);
}

test('configuration registration is immutable and canonical retries are idempotent', () => {
  const store = new Store(':memory:');
  try {
    registered(store);
    registerVariant(store, { ...variantA, schema_version: 1 });
    expect(store.all('SELECT id FROM comparison_variants')).toHaveLength(2);
    expect(showVariant(store, 'variant-a')).toMatchObject({ configuration: variantA, file_adapter_status: 'not_applicable' });
    expect(() => registerVariant(store, { ...variantA, model: 'changed-model' })).toThrow('configuration_conflict');
    registerProtocol(store, protocol);
    registerProtocol(store, protocol);
    expect(() => registerProtocol(store, { ...protocol, block_size: 8 })).toThrow('protocol_conflict');
    freezeProtocol(store, protocol.id, beforeRecruitment);
    freezeProtocol(store, protocol.id, beforeRecruitment);
    expect(showProtocol(store, protocol.id)).toMatchObject({
      status: 'frozen',
      real_allocation_enabled: false,
      experiment_readiness: 'synthetic_only',
      data_revision: 0
    });
    expect(() => store.execute('UPDATE comparison_variants SET configuration = ? WHERE id = ?', ['{}', 'variant-a'])).toThrow('immutable_comparison_variant');
  } finally {
    store.close();
  }
});

test('incomplete drafts cannot freeze and private input never enters storage or errors', () => {
  const store = new Store(':memory:');
  try {
    registered(store);
    registerProtocol(store, { schema_version: 1, id: 'draft', project_id: 'project-1', mode: 'randomized_task', purpose: 'real_experiment' });
    expect(() => freezeProtocol(store, 'draft', beforeRecruitment)).toThrow('incomplete_protocol');
    expect(() => registerProtocol(store, { ...protocol, criterion_text: 'PRIVATE_SENTINEL' })).toThrow(/^invalid_comparison_input$/);
    expect(() => registerVariant(store, { ...variantA, local_path: '/PRIVATE_SENTINEL' })).toThrow(/^invalid_comparison_input$/);
    expect(() => registerVariant(store, { ...variantA, product: 'PRIVATE_SENTINEL' })).toThrow(/^invalid_comparison_input$/);
    expect(JSON.stringify(store.all('SELECT * FROM comparison_protocols'))).not.toContain('PRIVATE_SENTINEL');
    expect(showProtocol(store, 'draft')).toMatchObject({ status: 'draft', real_allocation_enabled: false });
  } finally {
    store.close();
  }
});

test('freeze validates block design, eligibility, variants, recruitment and policy without invented defaults', () => {
  const store = new Store(':memory:');
  try {
    registered(store);
    const cases = [
      { ...protocol, block_size: 3 },
      { ...protocol, allocation_ratio: [2, 1] },
      { ...protocol, followup_seconds: 0 },
      { ...protocol, quality_margin: -1 },
      { ...protocol, variant_ids: ['variant-a', 'variant-a'] },
      { ...protocol, strata: [...protocol.strata, { ...protocol.strata[0], id: 'overlap' }] },
      { ...protocol, participants: ['user-1'] },
      { ...protocol, analysis_plan_version: undefined }
    ];
    for (const [index, value] of cases.entries()) {
      const id = `invalid-${index}`;
      try {
        registerProtocol(store, { ...value, id });
      } catch {
        continue;
      }
      expect(() => freezeProtocol(store, id, beforeRecruitment)).toThrow();
      expect(showProtocol(store, id)).toMatchObject({ status: 'draft' });
    }
    registerProtocol(store, protocol);
    expect(() => freezeProtocol(store, protocol.id, protocol.recruitment_start)).toThrow('registration_too_late');
    registerVariant(store, { ...variantB, id: 'different-model', model: 'different-model' });
    registerProtocol(store, { ...protocol, id: 'mixed', variant_ids: ['variant-a', 'different-model'] });
    expect(() => freezeProtocol(store, 'mixed', beforeRecruitment)).toThrow('configuration_mismatch');
    registerVariant(store, { ...variantB, id: 'ineligible', policy_status: 'ineligible' });
    registerProtocol(store, { ...protocol, id: 'policy', variant_ids: ['variant-a', 'ineligible'] });
    expect(() => freezeProtocol(store, 'policy', beforeRecruitment)).toThrow('ineligible_variant');
  } finally {
    store.close();
  }
});

test('version-five upgrade preserves data and failed comparison migration is atomic', () => {
  const root = mkdtempSync(join(tmpdir(), 'comparison-migrate-'));
  try {
    for (const failure of [false, true]) {
      const file = join(root, failure ? 'failed.db' : 'upgraded.db');
      const db = new Database(file);
      for (const migration of ['001_initial', '002_lifecycle', '003_assessment_time', '004_managed_observation', '005_otel_receiver']) {
        db.exec(readFileSync(new URL(`../../src/migrations/${migration}.sql`, import.meta.url), 'utf8'));
      }
      db.pragma('user_version = 5');
      db.prepare('INSERT INTO projects(id) VALUES (?)').run('project-1');
      db.prepare('INSERT INTO tasks(id,project_id) VALUES (?,?)').run('old-task', 'project-1');
      if (failure) db.exec('CREATE TABLE comparison_variants(id TEXT)');
      db.close();
      if (failure) {
        expect(() => new Store(file)).toThrow();
        const check = new Database(file);
        try {
          expect(check.pragma('user_version', { simple: true })).toBe(5);
          expect(check.prepare("SELECT name FROM sqlite_master WHERE name = 'comparison_protocols'").get()).toBeUndefined();
          expect(check.prepare('SELECT id FROM tasks').all()).toEqual([{ id: 'old-task' }]);
        } finally {
          check.close();
        }
      } else {
        const store = new Store(file);
        try {
          expect(store.get('SELECT id FROM tasks')).toEqual({ id: 'old-task' });
          registerVariant(store, variantA);
          expect(store.get('SELECT id FROM comparison_variants')).toEqual({ id: 'variant-a' });
        } finally {
          store.close();
        }
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
