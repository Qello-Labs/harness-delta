import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { createComparisonSnapshot, readComparisonSnapshot } from './helpers/legacy-snapshot.js';
import { Store } from '../src/store.js';
import { reportStore, request, evaluation, syntheticUsage, unassigned } from './helpers/comparison-report-fixture.js';

test('captures immutable inputs, preserves retries and accepts late observed arrivals only in a new revision', () => {
  const store = reportStore();
  try {
    unassigned(store);
    const first = createComparisonSnapshot(store, request, () => evaluation);
    expect(first.total.assigned_tasks).toBe(1);
    expect(first.recruitment_context.unassigned).toBe(1);
    syntheticUsage(store);
    expect(createComparisonSnapshot(store, request, () => '2026-01-05T00:00:00Z')).toEqual(first);
    expect(readComparisonSnapshot(store, request.reportId)).toEqual(first);
    const next = createComparisonSnapshot(
      store,
      { ...request, reportId: 'report-2', supersedesReportId: request.reportId, revisionReason: 'late_arrival' },
      () => evaluation
    );
    expect(next.tasks[0]?.usage.partial_tokens).toBe(10);
    expect(next.snapshot_sequence).toBe(2);
    expect(next.data_revision).toBe(0);
    expect(next.snapshot_hash).not.toBe(first.snapshot_hash);
    expect(next.tasks[0]?.usage.known_late_arrivals).toBe(1);
    expect(readComparisonSnapshot(store, request.reportId)).toEqual(first);
    expect(() => createComparisonSnapshot(store, { ...request, cutoff: '2026-01-02T00:00:00Z' }, () => evaluation)).toThrow('report_conflict');
    expect(() => store.execute('UPDATE comparison_report_snapshots SET input_json = ?', ['{}'])).toThrow('immutable_comparison_snapshot');
    expect(store.all('SELECT task_id FROM comparison_report_dependencies')).toHaveLength(4);
  } finally {
    store.close();
  }
});

test('rejects future cutoffs, incompatible revisions and incomplete/non-synthetic protocols', () => {
  const store = reportStore();
  try {
    expect(() => createComparisonSnapshot(store, request, () => '2026-01-01T12:00:00Z')).toThrow('invalid_cutoff');
    expect(() => createComparisonSnapshot(store, { ...request, revisionReason: 'late_arrival' }, () => evaluation)).toThrow('invalid_revision');
    createComparisonSnapshot(store, request, () => evaluation);
    expect(() =>
      createComparisonSnapshot(store, { ...request, reportId: 'report-2', supersedesReportId: 'report-1', revisionReason: 'cutoff_advanced' }, () => evaluation)
    ).toThrow('invalid_revision');
    expect(() =>
      createComparisonSnapshot(
        store,
        { ...request, reportId: 'report-2', supersedesReportId: 'report-1', cutoff: '2026-01-02T00:00:00Z', revisionReason: 'evidence_updated' },
        () => evaluation
      )
    ).toThrow('invalid_revision');
    expect(() => createComparisonSnapshot(store, { ...request, secret: 'PRIVATE_SENTINEL' } as typeof request, () => evaluation)).toThrow(
      /^invalid_snapshot_request$/
    );
    expect(() => readComparisonSnapshot(store, 'missing')).toThrow('unknown_report');
  } finally {
    store.close();
  }
});

test('v6 migration preserves rows with unknown historical receipts, replay fixes no fake dates and failed upgrade rolls back', () => {
  const root = mkdtempSync(join(tmpdir(), 'comparison-report-migration-'));
  try {
    for (const failure of [false, true]) {
      const file = join(root, failure ? 'failure.db' : 'success.db');
      const db = new Database(file);
      for (const name of ['001_initial', '002_lifecycle', '003_assessment_time', '004_managed_observation', '005_otel_receiver', '006_task_comparison']) {
        db.exec(readFileSync(new URL(`../src/migrations/${name}.sql`, import.meta.url), 'utf8'));
      }
      db.pragma('user_version = 6');
      db.exec(
        "INSERT INTO projects(id) VALUES ('p'); INSERT INTO tasks(id,project_id) VALUES ('t','p'); INSERT INTO sessions(id,task_id,project_id) VALUES ('s','t','p')"
      );
      const payload = { kind: 'session_linked' as const };
      const event = { id: 'old', project_id: 'p', task_id: 't', session_id: 's', source_key: 'old', occurred_at: '2026-01-01T00:00:00Z', payload };
      db.prepare('INSERT INTO events(id,project_id,task_id,session_id,source_key,occurred_at,payload) VALUES (?,?,?,?,?,?,?)').run(
        'old',
        'p',
        't',
        's',
        'old',
        event.occurred_at,
        JSON.stringify(payload)
      );
      if (failure) db.exec('CREATE TABLE comparison_report_snapshots(id TEXT)');
      db.close();
      if (failure) {
        expect(() => new Store(file)).toThrow();
        const check = new Database(file);
        expect(check.pragma('user_version', { simple: true })).toBe(6);
        expect(check.prepare("SELECT name FROM sqlite_master WHERE name = 'event_receipts'").get()).toBeUndefined();
        check.close();
      } else {
        const store = new Store(file, () => evaluation);
        expect(store.putEvent(event)).toBe(false);
        expect(store.all('SELECT * FROM event_receipts')).toEqual([]);
        expect(store.putEvent({ ...event, id: 'new', source_key: 'new' })).toBe(true);
        expect(store.get('SELECT recorded_at FROM event_receipts WHERE event_id=?', ['new'])).toEqual({ recorded_at: evaluation });
        expect(store.putEvent({ ...event, id: 'new', source_key: 'new' })).toBe(false);
        store.close();
        const reopened = new Store(file);
        expect(reopened.eventCount()).toBe(2);
        reopened.close();
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reopens stored sanitized snapshots and rolls back partially written snapshot/dependencies', () => {
  const root = mkdtempSync(join(tmpdir(), 'snapshot-reopen-'));
  const file = join(root, 'local.db');
  try {
    const store = reportStore(file);
    store.execute("UPDATE projects SET local_root = ? WHERE id='project-1'", ['/PRIVATE_SENTINEL']);
    syntheticUsage(store);
    const first = createComparisonSnapshot(store, request, () => evaluation);
    expect(JSON.stringify(first)).not.toContain('PRIVATE_SENTINEL');
    expect(JSON.stringify(store.all('SELECT * FROM comparison_report_snapshots'))).not.toContain('source_key');
    store.execute("CREATE TRIGGER fail_dependency BEFORE INSERT ON comparison_report_dependencies BEGIN SELECT RAISE(ABORT,'forced_failure'); END", []);
    expect(() =>
      createComparisonSnapshot(
        store,
        { ...request, reportId: 'report-2', supersedesReportId: 'report-1', revisionReason: 'evidence_updated' },
        () => evaluation
      )
    ).toThrow('forced_failure');
    expect(store.all('SELECT report_id FROM comparison_report_snapshots')).toHaveLength(1);
    store.close();
    const reopen = new Store(file);
    expect(readComparisonSnapshot(reopen, 'report-1')).toEqual(first);
    reopen.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
