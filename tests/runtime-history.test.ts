import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { Store } from '../src/store.js';
import { Lifecycle } from '../src/lifecycle.js';
import { Deletion } from '../src/deletion.js';
import { seedLinkedTask } from './helpers/store-fixture.js';
import { makeFlexibleFixture } from './helpers/flexible-fixture.js';
function seed(store: Store) {
  seedLinkedTask(store, { projectId: 'project-1', taskId: 'task-1', sessionId: 'session-1' });
  store.execute("UPDATE tasks SET state='active',metadata=? WHERE id='task-1'", [JSON.stringify(makeFlexibleFixture().metadata)]);
}
test('runtime_and_usage_commit_atomically', async () => {
  const store = new Store(':memory:');
  try {
    seed(store);
    expect(store.get("SELECT name FROM sqlite_master WHERE name='runtime_evidence'")).toBeDefined();
    const { putUsageWithEvidence } = await import('../src/runtime-history.js');
    const { events, runtime } = makeFlexibleFixture();
    expect(() => putUsageWithEvidence(store, events[0]!, { ...runtime[0]!, session_id: 'other-session' })).toThrow();
    expect(store.eventCount()).toBe(0);
    expect(store.all('SELECT * FROM runtime_evidence')).toHaveLength(0);
    expect(putUsageWithEvidence(store, events[0]!, runtime[0]!)).toBe(true);
  } finally { store.close(); }
});
test('replay_is_idempotent_conflict_is_rejected', async () => {
  const store = new Store(':memory:');
  try {
    seed(store); const { events, runtime } = makeFlexibleFixture();
    const { putUsageWithEvidence, readRuntimeHistory } = await import('../src/runtime-history.js');
    expect(putUsageWithEvidence(store, events[0]!, runtime[0]!)).toBe(true);
    expect(putUsageWithEvidence(store, events[0]!, { ...runtime[0]!, recorded_at: '2026-01-02T00:00:00Z' })).toBe(false);
    expect(readRuntimeHistory(store, 'task-1', '2026-01-01T01:00:00Z')[0]).toEqual(runtime[0]!);
    expect(() => putUsageWithEvidence(store, events[0]!, { ...runtime[0]!, model: 'other-model' })).toThrow('runtime_conflict');
    expect(() => store.execute("UPDATE runtime_evidence SET payload='{}'", [])).toThrow('immutable_runtime');
  } finally { store.close(); }
});
test('deletion_cascades_runtime', async () => {
  const store = new Store(':memory:');
  try {
    seed(store); const { events, runtime, metadata } = makeFlexibleFixture();
    const { putUsageWithEvidence } = await import('../src/runtime-history.js');
    putUsageWithEvidence(store, events[0]!, runtime[0]!);
    new Deletion(store, () => '2026-01-03T00:00:00Z').deleteTask('task-1');
    expect(store.all('SELECT * FROM runtime_evidence')).toHaveLength(0); expect(store.eventCount()).toBe(0);
    expect(() => new Lifecycle(store).createTask('project-1', 'task-1', metadata)).toThrow('deleted_identifier');
    expect(() => putUsageWithEvidence(store, events[0]!, runtime[0]!)).toThrow('inactive_scope');
  } finally { store.close(); }
});
test('migration_preserves_v1_events_and_reports', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flexible-migration-')); const file = join(root, 'db.sqlite');
  try {
    const db = new Database(file); db.pragma('foreign_keys=ON');
    for (const name of ['001_initial', '002_lifecycle', '003_assessment_time', '004_managed_observation', '005_otel_receiver', '006_task_comparison', '007_comparison_reports', '008_file_exchange_source', '009_file_exchange_import', '010_team_snapshots']) {
      db.exec(readFileSync(new URL(`../src/migrations/${name}.sql`, import.meta.url), 'utf8'));
    }
    db.pragma('user_version=10');
    db.exec("INSERT INTO projects(id) VALUES ('p'); INSERT INTO tasks(id,project_id) VALUES ('t','p'); INSERT INTO sessions(id,project_id,task_id) VALUES ('s','p','t'); INSERT INTO events VALUES ('e','p','t','s','e','2026-01-01T00:00:00Z','{\"kind\":\"session_linked\"}');");
    const bytes = db.prepare('SELECT payload FROM events').get(); db.close();
    const store = new Store(file);
    try {
      expect(store.get('SELECT payload FROM events')).toEqual(bytes);
      const { readRuntimeHistory } = await import('../src/runtime-history.js');
      expect(readRuntimeHistory(store, 't', '2026-01-02T00:00:00Z')).toEqual([]);
    } finally { store.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('event_failure_after_evidence_insertion_rolls_back_both', async () => {
  const store = new Store(':memory:'); try {
    seed(store); const { putUsageWithEvidence } = await import('../src/runtime-history.js'); const f = makeFlexibleFixture();
    expect(() => putUsageWithEvidence(store, f.events[0]!, { ...f.runtime[0]!, model: 'wrong-model' })).toThrow('runtime_attribution_mismatch');
    expect(store.all('SELECT * FROM runtime_evidence')).toEqual([]); expect(store.eventCount()).toBe(0);
  } finally { store.close(); }
});

test('migration_preserves_v1_snapshot_bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legacy-snapshot-migration-')); const file = join(root, 'db.sqlite');
  try {
    const { reportStore, request, evaluation } = await import('./helpers/comparison-report-fixture.js');
    const { createComparisonSnapshot, readComparisonSnapshot } = await import('../src/reports/comparison-snapshot.js');
    const legacy = reportStore(); const report = createComparisonSnapshot(legacy, request, () => evaluation);
    const bytes = legacy.get('SELECT input_json,report_json,snapshot_hash FROM comparison_report_snapshots');
    const db = new Database(file);
    try {
      const migrations = new URL('../src/migrations/', import.meta.url);
      for (const name of readdirSync(migrations).sort().slice(0, 10)) {
        db.exec(readFileSync(new URL(name, migrations), 'utf8'));
      }
      for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]) {
        const columns = (db.prepare('PRAGMA table_info("' + name + '")').all() as { name: string }[]).map(column => column.name);
        const statement = db.prepare('INSERT INTO "' + name + '" (' + columns.map(column => '"' + column + '"').join(',') + ') VALUES (' + columns.map(() => '?').join(',') + ')');
        for (const row of legacy.all<Record<string, unknown>>('SELECT * FROM "' + name + '"')) {
          statement.run(...columns.map(column => row[column]));
        }
      }
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      db.pragma('user_version=10');
    } finally { db.close(); legacy.close(); }
    const upgraded = new Store(file);
    try {
      expect(upgraded.get('SELECT input_json,report_json,snapshot_hash FROM comparison_report_snapshots')).toEqual(bytes);
      expect(readComparisonSnapshot(upgraded, report.report_id)).toEqual(report);
    } finally { upgraded.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
