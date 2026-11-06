import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, test, vi } from 'vitest';
import { Store } from '../src/store.js';
import { ordinaryWindowDigest, ordinaryWindowPolicies } from '../src/core/ordinary-window-policy.js';
import { ordinaryWindowDecisionStatus, readOrdinaryWindowDecision } from '../src/core/ordinary-window-activation.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'window-decision-migration-')));
  roots.push(root);
  const project = join(root, 'project');
  mkdirSync(project);
  const file = join(root, 'store.sqlite');
  const db = new Database(file);
  db.pragma('foreign_keys = ON');
  const migrations = new URL('../src/migrations/', import.meta.url);
  for (const name of readdirSync(migrations)
    .filter(name => name.endsWith('.sql'))
    .sort()
    .slice(0, 36)) {
    db.exec(readFileSync(new URL(name, migrations), 'utf8'));
  }
  db.pragma('user_version = 36');
  const policy = ordinaryWindowPolicies[0];
  if (!policy) throw new Error('fixture_policy_missing');
  const key = {
    project_id: 'project',
    product: policy.product,
    source: policy.source,
    policy_id: policy.policyId,
    policy_revision: policy.ruleRevision,
    policy_digest: ordinaryWindowDigest(policy),
    evidence_mode: policy.evidenceMode
  };
  db.prepare('INSERT INTO projects(id,local_root) VALUES (?,?)').run('project', project);
  db.prepare(
    `INSERT INTO ordinary_window_activations(project_id,product,source,policy_id,policy_revision,policy_digest,evidence_mode,
    accepted_risks,implementation_revision,evidence_ref,review_ref,decided_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    key.project_id,
    key.product,
    key.source,
    key.policy_id,
    key.policy_revision,
    key.policy_digest,
    key.evidence_mode,
    '[ "source_identity_limits", "root_ownership_unverified" ]',
    'ordinary-window-runtime-v2',
    'old-evidence',
    'old-review',
    '2026-11-06T01:00:00.000Z'
  );
  const before = db.prepare<[], Record<string, unknown>>('SELECT * FROM ordinary_window_activations').get();
  if (!before) throw new Error('fixture_activation_missing');
  const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  db.close();
  return { file, key, before, schema };
}

test('migration 037 preserves a v36 decision byte-for-byte but does not manufacture current authority', () => {
  const f = fixture();
  const store = new Store(f.file);
  try {
    expect(store.get<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(37);
    const row = store.get<Record<string, unknown>>('SELECT * FROM ordinary_window_activations');
    if (!row) throw new Error('migrated_activation_missing');
    expect(JSON.stringify(Object.fromEntries(Object.keys(f.before).map(key => [key, row[key]])))).toBe(JSON.stringify(f.before));
    expect(row).toMatchObject({
      decision_ref: null,
      decision_kind: null,
      trial_task_id: null,
      trial_tokens_consumed: 0
    });
    expect(readOrdinaryWindowDecision(store, f.key)).toBeNull();
    expect(ordinaryWindowDecisionStatus(store, f.key, '2026-11-06T02:00:00.000Z')).toMatchObject({
      state: 'unreviewed',
      decision: null,
      runtime_authority: false
    });
    expect(() => store.execute("UPDATE ordinary_window_activations SET decision_ref='invented',decision_kind='product'", [])).toThrow(
      'ordinary_configuration_changed'
    );
    expect(store.all('PRAGMA foreign_key_check')).toEqual([]);
    expect(store.get<{ integrity_check: string }>('PRAGMA integrity_check')?.integrity_check).toBe('ok');
  } finally {
    store.close();
  }
});

test('failure after migration 037 executes restores v36 schema, original decision and user_version', () => {
  const f = fixture();
  const exec: unknown = Reflect.get(Database.prototype, 'exec');
  if (typeof exec !== 'function') throw new Error('fixture_exec_missing');
  const injected = vi.spyOn(Database.prototype, 'exec').mockImplementation(function (this: Database.Database, sql: string) {
    Reflect.apply(exec, this, [sql]);
    if (sql.includes('ADD COLUMN decision_ref')) {
      throw new Error('fixture_migration_failed');
    }
    return this;
  });
  expect(() => new Store(f.file)).toThrow('fixture_migration_failed');
  injected.mockRestore();
  const db = new Database(f.file);
  try {
    expect(db.pragma('user_version', { simple: true })).toBe(36);
    expect(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()).toEqual(f.schema);
    expect(db.prepare('SELECT * FROM ordinary_window_activations').get()).toEqual(f.before);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally {
    db.close();
  }
});
