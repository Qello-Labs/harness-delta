import { expect, test } from 'vitest';
import { teamFixture } from '../helpers/team-fixture.js';
import { importExchangePackage } from '../../src/comparison/exchange/import.js';
import { createTeamSnapshot, readTeamSnapshot } from '../helpers/legacy-exchange.js';
import { deleteImportedTask } from '../../src/comparison/exchange/retention.js';
import { renderTeamReport } from '../../src/comparison/reports/team-render.js';
import { renderComparisonReport } from '../../src/comparison/reports/comparison-render.js';
import { createComparisonSnapshot } from '../helpers/legacy-snapshot.js';
import { reportStore, request, evaluation } from '../helpers/comparison-report-fixture.js';
const now = '2026-01-06T00:00:00.000Z';

test('readable team output preserves component populations, observed zero, event units and original assignment', () => {
  const f = teamFixture();
  try {
    for (const p of f.packages) importExchangePackage(f.dest, p, 'destination', () => f.request.as_of);
    const report = createTeamSnapshot(f.dest, f.request, () => now);
    const before = JSON.stringify(report);
    const persisted = f.dest.all('SELECT * FROM exchange_team_snapshots');
    const text = renderTeamReport(report, 'markdown-readable');
    expect(text).toContain('| Imported cohort | 8 | 6 | 2 | 0 |');
    expect(text).toContain('| Imported cohort | Partial combined tokens | 4 | 4 | 3 | 0, 2, 4, 10 |');
    expect(text).toContain('| Imported cohort | Partial input tokens | 5 | 3 | 2 | 0, 1, 2, 5, 7 |');
    expect(text).toContain('| Imported cohort | Partial output tokens | 4 | 1.5 | 1.5 | 0, 1, 2, 3 |');
    expect(text).toContain('| task-2 | variant-b | partial | 0 | 0 | 0 |');
    expect(text).toContain('| task-3 | variant-a | missing | unavailable | unavailable | unavailable |');
    expect(text).toContain('| task-4 | variant-b | partial | unavailable | 5 | unavailable |');
    expect(text).toContain('Reading states below count events, not tasks.');
    expect(text).toContain('| task-6 | input\\_total | unavailable | 0 | 0 | 0 | 1 | 0 | paused: 1 |');
    expect(text).toContain('| Imported cohort | Deadline success | 3 | 8 | 0.375 | none |');
    expect(text).toContain('| Imported cohort | Criterion fulfillment | 3 | 6 | 0.5 | none |');
    expect(text).toContain('| Imported cohort | Tasks with rework | 1 | 8 | 0.125 | none |');
    expect(text).toContain('Team assignment denominator: unavailable');
    expect(text).toContain('Declared writer coverage: complete');
    expect(text).toContain('not task or token collection completeness');
    expect(text).toContain('| declared\\_a\\_only | 3 |');
    expect(text).toContain('| unknown | 1 |');
    expect(text).toContain('Complete token mean: unavailable');
    expect(text).toContain('Change rate: unavailable');
    expect(text).toContain('Adoption: inconclusive (analysis\\_not\\_validated)');
    expect(text).not.toMatch(/PRIVATE_|session_id|source_key/);
    expect(JSON.stringify(report)).toBe(before);
    expect(f.dest.all('SELECT * FROM exchange_team_snapshots')).toEqual(persisted);
    expect(renderTeamReport(report, 'json')).toBe(JSON.stringify(report, null, 2) + '\n');
    expect(renderTeamReport(report, 'markdown')).toBe(
      '# Synthetic team comparison report\n\nTeam completeness: unverified. Declared writer coverage: complete. Partial observations are not complete task totals. Adoption remains inconclusive.\n\n```json\n' +
        JSON.stringify(report, null, 2) +
        '\n```\n'
    );
  } finally {
    f.close();
  }
});

test('readable incomplete writer output keeps pending quality and unequal received arm sizes', () => {
  const f = teamFixture(undefined, undefined, '2026-01-01T00:30:00.000Z');
  try {
    const p = f.packages[0]!;
    p.assignments = p.assignments.slice(0, 3);
    importExchangePackage(f.dest, p, 'destination', () => f.request.as_of);
    const text = renderTeamReport(
      createTeamSnapshot(f.dest, f.request, () => now),
      'markdown-readable'
    );
    expect(text).toContain('| variant-a | 2 | 1 | 1 | 0 |');
    expect(text).toContain('| variant-b | 1 | 1 | 0 | 0 |');
    expect(text).toContain('Provisional: true');
    expect(text).toContain('| Imported cohort | Deadline success | 0 | 3 | unavailable | pending\\_followup |');
    expect(text).toContain('Declared writer coverage: partial');
    expect(text).toContain(f.packages[1]!.namespace_id);
    expect(text).toContain('Team assignment denominator: unavailable');
  } finally {
    f.close();
  }
});

test('readable empty accepted contributions retain empty denominators and complete writer declarations', () => {
  const f = teamFixture();
  try {
    for (const p of f.packages) {
      p.assignments = [];
      importExchangePackage(f.dest, p, 'destination', () => f.request.as_of);
    }
    const text = renderTeamReport(
      createTeamSnapshot(f.dest, f.request, () => now),
      'markdown-readable'
    );
    expect(text).toContain('| Imported cohort | 0 | 0 | 0 | 0 |');
    expect(text).toContain('| Imported cohort | Partial combined tokens | 0 | unavailable | unavailable | none |');
    expect(text).toContain('| Imported cohort | Deadline success | 0 | 0 | unavailable | empty\\_denominator |');
    expect(text).toContain('Declared writer coverage: complete');
    expect(text).toContain('Missing namespaces: none');
  } finally {
    f.close();
  }
});

test('readable invalidation never reconstructs removed task identities or aggregates', () => {
  const f = teamFixture();
  try {
    for (const p of f.packages) importExchangePackage(f.dest, p, 'destination', () => f.request.as_of);
    createTeamSnapshot(f.dest, f.request, () => now);
    deleteImportedTask(f.dest, { local_project_id: 'destination', shared_project_id: f.mapping.shared_project_id, task_id: 'task-1' }, () => now);
    const text = renderTeamReport(readTeamSnapshot(f.dest, f.request.snapshot_id), 'markdown-readable');
    expect(text).toContain('Original cohort: unavailable\\_due\\_to\\_deletion');
    expect(text).toContain('Reason: deletion');
    expect(text).not.toContain('task-1');
    expect(text).not.toContain('| Imported cohort |');
    expect(text).not.toContain('Snapshot hash:');
  } finally {
    f.close();
  }
});

test('readable local output retains registration uncertainty and legacy rendering bytes', () => {
  const store = reportStore();
  try {
    const report = createComparisonSnapshot(store, request, () => evaluation);
    const pretty = JSON.stringify(report, null, 2) + '\n';
    const persisted = store.all('SELECT * FROM comparison_report_snapshots');
    const text = renderComparisonReport(report, 'markdown-readable');
    expect(text).toContain('| Assigned cohort | 1 | 0 | 1 | 0 |');
    expect(text).toContain('Unassigned eligibility: unknown');
    expect(text).toContain('Snapshot hash: ' + report.snapshot_hash);
    expect(text).toContain('Follow-up seconds: 3600');
    expect(store.all('SELECT * FROM comparison_report_snapshots')).toEqual(persisted);
    expect(renderComparisonReport(report, 'json')).toBe(pretty);
    expect(renderComparisonReport(report, 'markdown')).toBe(
      '# Assignment comparison report\n\nSynthetic descriptions only. Partial observations are not complete task totals. No inferential adoption decision.\n\n```json\n' +
        pretty +
        '```\n'
    );
    expect(() => renderComparisonReport(report, 'bad')).toThrow('invalid_format');
  } finally {
    store.close();
  }
});

test('metadata cannot inject table columns, HTML or Markdown into readable output', () => {
  const store = reportStore();
  try {
    const report = createComparisonSnapshot(store, request, () => evaluation);
    // Consumer-boundary presentation test: IDs and metadata may contain punctuation.
    report.composition[0]!.value = 'user|<script>\n**heading**';
    const text = renderComparisonReport(report, 'markdown-readable');
    expect(text).toContain('user\\|&lt;script&gt; \\*\\*heading\\*\\*');
    expect(text).not.toContain('<script>');
    expect(text).not.toContain('\n**heading**');
  } finally {
    store.close();
  }
});

test('readable errors, unmeasurable components and configuration deviations retain their distinct frozen states', () => {
  const f = teamFixture();
  try {
    const task = f.packages[1]!.assignments.find(a => a.task_id === 'task-6')!;
    task.evidence.usage.input_total.status_counts = { observed: 0, missing: 0, error: 1, excluded: 0, unmeasurable: 0 };
    task.evidence.usage.input_total.reason_counts = { source_error: 1 };
    task.evidence.usage.output_total.status_counts = { observed: 0, missing: 0, error: 0, excluded: 0, unmeasurable: 1 };
    task.evidence.usage.output_total.reason_counts = { unsupported: 1 };
    task.evidence.actual_configuration.has_runtime_drift = true;
    task.evidence.deviations = [{ occurred_at: '2026-01-01T00:03:00.000Z', recorded_at: '2026-01-01T00:04:00.000Z', reason_code: 'version_drift' }];
    for (const p of f.packages) importExchangePackage(f.dest, p, 'destination', () => f.request.as_of);
    const text = renderTeamReport(
      createTeamSnapshot(f.dest, f.request, () => now),
      'markdown-readable'
    );
    expect(text).toContain('| task-6 | input\\_total | unavailable | 0 | 0 | 1 | 0 | 0 | source\\_error: 1 |');
    expect(text).toContain('| task-6 | output\\_total | unavailable | 0 | 0 | 0 | 0 | 1 | unsupported: 1 |');
    expect(text).toContain('| task-6 | version\\_drift | 2026-01-01T00:03:00.000Z | 2026-01-01T00:04:00.000Z |');
    expect(text).toContain('| task-6 | variant-b | declared\\_b\\_only | variant-b | false | false | true | 1 | 0 |');
  } finally {
    f.close();
  }
});
