import { expect, test } from 'vitest';
import { assignTask } from '../../src/comparison/allocation.js';
import { registerProtocol, freezeProtocol } from '../../src/comparison/comparison.js';
import { Deletion } from '../../src/deletion.js';
import { createComparisonSnapshot, readComparisonSnapshot } from '../../src/comparison/reports/comparison-snapshot.js';
import { assignmentInput, beforeRecruitment, protocol } from '../helpers/comparison-fixture.js';
import { reportStore, request, evaluation, unassigned, syntheticUsage } from '../helpers/comparison-report-fixture.js';

for (const target of ['task', 'unassigned', 'project', 'retention', 'identity_conflict']) {
  test(`${target} invalidates every dependent snapshot and purges evidence without an arm-count archive`, () => {
    const store = reportStore();
    try {
      unassigned(store);
      syntheticUsage(store);
      const first = createComparisonSnapshot(store, request, () => evaluation);
      createComparisonSnapshot(
        store,
        { ...request, reportId: 'report-2', supersedesReportId: 'report-1', revisionReason: 'evidence_updated' },
        () => evaluation
      );
      const deletion = new Deletion(store, () => evaluation);
      if (target === 'task') deletion.deleteTask('task-1');
      if (target === 'unassigned') deletion.deleteTask('unassigned');
      if (target === 'project') deletion.deleteProject('project-1');
      if (target === 'retention') {
        store.execute("UPDATE tasks SET state='finalized', finalized_at='2026-01-01T00:30:00Z' WHERE id='task-1'", []);
        deletion.configureRetention('project-1', 1);
        expect(deletion.applyRetention('project-1', evaluation)).toBe(1);
      }
      if (target === 'identity_conflict') {
        assignTask(store, { ...assignmentInput, task_id: 'task-2', logical_task_id: 'logical-2' }, { clock: () => '2026-01-01T00:30:00Z' });
        expect(() => assignTask(store, { ...assignmentInput, alias_ids: ['logical-2'] }, { clock: () => evaluation })).toThrow('identity_conflict');
      }
      const reason = target === 'identity_conflict' ? 'identity_conflict' : 'deletion';
      expect(readComparisonSnapshot(store, 'report-1')).toMatchObject({ validity_status: 'invalidated', reason, adoption: { status: 'inconclusive' } });
      for (const table of ['comparison_report_snapshots', 'comparison_report_dependencies', 'comparison_report_sequences', 'comparison_allocation_state']) {
        expect(store.all(`SELECT * FROM ${table}`)).toEqual([]);
      }
      expect(store.all('SELECT * FROM comparison_report_tombstones')).toEqual([
        { report_id: 'report-1', deleted_at: evaluation, reason_code: reason },
        { report_id: 'report-2', deleted_at: evaluation, reason_code: reason }
      ]);
      expect(JSON.stringify(store.all('SELECT * FROM comparison_report_tombstones'))).not.toContain(first.snapshot_hash);
      expect(() => createComparisonSnapshot(store, request, () => evaluation)).toThrow('invalidated_report');
      if (target !== 'project')
        expect(() => assignTask(store, { ...assignmentInput, logical_task_id: 'new', task_id: 'new' }, { clock: () => '2026-01-01T00:45:00Z' })).toThrow(
          'protocol_not_active'
        );
    } finally {
      store.close();
    }
  });
}

test('deleting a contributor assigned elsewhere invalidates both protocols and preserves an unrelated project', () => {
  const store = reportStore();
  try {
    const other = { ...protocol, id: 'other-protocol' };
    registerProtocol(store, other);
    freezeProtocol(store, other.id, beforeRecruitment);
    assignTask(
      store,
      { ...assignmentInput, protocol_id: other.id, logical_task_id: 'other-logical', task_id: 'other-task' },
      { clock: () => '2026-01-01T00:10:00Z' }
    );
    createComparisonSnapshot(store, request, () => evaluation);
    createComparisonSnapshot(store, { ...request, reportId: 'other-report', protocolId: other.id }, () => evaluation);
    store.execute("INSERT INTO projects(id) VALUES ('other-project')", []);
    const isolated = { ...protocol, id: 'isolated', project_id: 'other-project' };
    registerProtocol(store, isolated);
    freezeProtocol(store, isolated.id, beforeRecruitment);
    assignTask(
      store,
      { ...assignmentInput, protocol_id: isolated.id, project_id: 'other-project', logical_task_id: 'isolated-logical', task_id: 'isolated-task' },
      { clock: () => '2026-01-01T00:10:00Z' }
    );
    const independent = createComparisonSnapshot(store, { ...request, reportId: 'isolated-report', protocolId: isolated.id }, () => evaluation);
    new Deletion(store, () => evaluation).deleteTask('other-task');
    expect(readComparisonSnapshot(store, 'report-1')).toMatchObject({ validity_status: 'invalidated' });
    expect(readComparisonSnapshot(store, 'other-report')).toMatchObject({ validity_status: 'invalidated' });
    expect(readComparisonSnapshot(store, 'isolated-report')).toEqual(independent);
  } finally {
    store.close();
  }
});

test('a failure during purge rolls back task, snapshots, queues and tombstones atomically', () => {
  const store = reportStore();
  try {
    const first = createComparisonSnapshot(store, request, () => evaluation);
    store.execute("CREATE TRIGGER fail_delete BEFORE DELETE ON tasks BEGIN SELECT RAISE(ABORT,'forced_failure'); END", []);
    expect(() => new Deletion(store, () => evaluation).deleteTask('task-1')).toThrow('forced_failure');
    expect(readComparisonSnapshot(store, 'report-1')).toEqual(first);
    expect(store.all('SELECT * FROM comparison_report_tombstones')).toEqual([]);
    expect(store.all('SELECT * FROM comparison_allocation_state')).toHaveLength(1);
    expect(store.get('SELECT status FROM comparison_protocols')).toEqual({ status: 'frozen' });
  } finally {
    store.close();
  }
});
