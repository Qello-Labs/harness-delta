import { expect, test } from 'vitest';
import { aggregateOrdinaryWindowMetrics as aggregateOrdinaryWindowReport } from '../../src/pricing/metrics-ordinary-window.js';
import { emptyOrdinaryWindowCoverage } from '../../src/core/ordinary-window-policy.js';
import { revokeOrdinaryWindowActivation } from '../../src/core/ordinary-window-store.js';
import { windowReportCutoff, windowReportFixture } from '../helpers/ordinary-window-report-fixture.js';

test('retains invalidation in task coverage when another retained segment is partial', () => {
  const f = windowReportFixture();
  try {
    f.activate();
    f.connect();
    f.store.execute('UPDATE ordinary_window_segments SET coverage=? WHERE root_session_id=?', [
      JSON.stringify({ ...emptyOrdinaryWindowCoverage(), status: 'partial' }),
      f.rootId
    ]);
    f.store.execute('INSERT INTO sessions(id,project_id,task_id,product,product_version) VALUES (?,?,?,?,?)', [
      'historic-root',
      'project',
      f.taskId,
      'codex',
      f.selection.declaredVersion
    ]);
    f.store.execute(
      `INSERT INTO binding_root_segments(root_session_id,task_id,product,native_root_id,project_root,state,opened_at,closed_at)
       VALUES (?,?,?,?,?,'closed',?,?)`,
      ['historic-root', f.taskId, 'codex', 'native-historic', f.proof.cwd, f.clock(), f.clock()]
    );
    f.store.execute(
      `INSERT INTO ordinary_window_segments(root_session_id,selection_hash,proof,coverage)
       SELECT ?,selection_hash,?,? FROM ordinary_window_segments WHERE root_session_id=?`,
      [
        'historic-root',
        JSON.stringify({ ...f.proof, nativeSessionId: 'native-historic' }),
        JSON.stringify({ ...emptyOrdinaryWindowCoverage(), status: 'invalidated', reason: 'compatibility_invalidated' }),
        f.rootId
      ]
    );
    const report = aggregateOrdinaryWindowReport(f.store, f.taskId, windowReportCutoff);
    expect(report.coverage).toMatchObject({ status: 'invalidated', reason: 'compatibility_invalidated' });
    expect(report.coverage.segments.map(segment => segment.coverage.status)).toEqual(['invalidated', 'partial']);
    expect(report.selection.compatibility.state).toBe('compatibility_unverified');
  } finally {
    f.store.close();
  }
});

test.each(['preparation', 'activation'] as const)('reports retained evidence after %s revocation without changing its Store', kind => {
  const f = windowReportFixture();
  try {
    f.activate();
    f.connect();
    f.put('reference', 'compatibility_unverified');
    const revokedAt = '2026-11-06T01:05:00.000Z';
    if (kind === 'preparation') {
      f.store.execute('UPDATE ordinary_tasks SET revoked_at=? WHERE task_id=?', [revokedAt, f.taskId]);
    } else revokeOrdinaryWindowActivation(f.store, f.taskId, revokedAt);
    const snapshot = () => ({
      ...f.snapshot(),
      activations: f.store.all('SELECT * FROM ordinary_window_activations'),
      prepared: f.store.all('SELECT * FROM ordinary_tasks'),
      tasks: f.store.all('SELECT * FROM tasks'),
      coverage: f.store.all('SELECT * FROM ordinary_window_segments'),
      segments: f.store.all('SELECT * FROM binding_root_segments')
    });
    const before = snapshot();
    const report = aggregateOrdinaryWindowReport(f.store, f.taskId, windowReportCutoff);
    expect(report).toMatchObject({
      collection: { state: 'disabled', reason: 'binding_scope_revoked' },
      usage: { compatibility_unverified: { partial_tokens: 15 } }
    });
    expect(snapshot()).toEqual(before);
    expect(f.calls).toEqual([]);
  } finally {
    f.store.close();
  }
});
