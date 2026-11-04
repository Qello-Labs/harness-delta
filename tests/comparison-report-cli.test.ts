import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test, vi } from 'vitest';
import { main } from '../src/cli.js';
import { assignTask } from '../src/allocation.js';
import { assignmentInput } from './helpers/comparison-fixture.js';
import { reportStore, evaluation, request } from './helpers/comparison-report-fixture.js';
import { Collector } from '../src/collection.js';
import { Lifecycle } from '../src/lifecycle.js';
import { renderComparisonReport } from '../src/reports/comparison-render.js';

test('synthetic CLI creates and renders a frozen report with no collection and discloses invalidated IDs on delete', async () => {
  const root = mkdtempSync(join(tmpdir(), 'report-cli-'));
  const file = join(root, 'local.db');
  reportStore(file).close();
  const run = (args: string[]) => main(['--db', file, ...args]);
  let output = '';
  let errors = '';
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(value => {
    output += String(value);
    return true;
  });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(value => {
    errors += String(value);
    return true;
  });
  // Guard only the external scope entry points; assertions inspect real persisted report behavior.
  const collect = vi.spyOn(Collector.prototype, 'tick').mockImplementation(() => {
    throw new Error('collection_forbidden');
  });
  const link = vi.spyOn(Lifecycle.prototype, 'linkSession').mockImplementation(() => {
    throw new Error('source_read_forbidden');
  });
  vi.useFakeTimers();
  vi.setSystemTime(new Date(evaluation));
  try {
    expect(
      await run(['comparison', 'snapshot', 'create', request.protocolId, '--id', request.reportId, '--cutoff', request.cutoff, '--reason', 'initial'])
    ).toBe(0);
    const created = JSON.parse(output) as { snapshot_hash: string; report_id: string };
    expect(created.report_id).toBe('report-1');
    output = '';
    expect(await run(['comparison', 'report', 'report-1', '--format', 'json'])).toBe(0);
    expect(JSON.parse(output) as unknown).toMatchObject({
      snapshot_hash: created.snapshot_hash,
      total: { assigned_tasks: 1 },
      adoption: { status: 'inconclusive' }
    });
    expect(output).not.toContain(root);
    expect(output).not.toMatch(/source_path|source_key|pending_variants|next_index/);
    const report = JSON.parse(output) as Parameters<typeof renderComparisonReport>[0];
    expect(renderComparisonReport(report, 'markdown')).toContain(created.snapshot_hash);
    output = '';
    expect(await run(['comparison', 'report', 'report-1', '--format', 'markdown'])).toBe(0);
    expect(output).toContain('# Assignment comparison report');
    output = '';
    expect(await run(['comparison', 'report', 'report-1', '--format', 'markdown-readable'])).toBe(0);
    expect(output).toContain('| Assigned cohort | 1 | 0 | 1 | 0 |');
    expect(output).toContain('Unassigned eligibility: unknown');
    output = '';
    expect(await run(['delete', 'task', 'task-1'])).toBe(0);
    expect(JSON.parse(output) as unknown).toEqual({ invalidating_reports: ['report-1'] });
    output = '';
    expect(await run(['comparison', 'report', 'report-1'])).toBe(0);
    expect(JSON.parse(output) as unknown).toMatchObject({ validity_status: 'invalidated', original_cohort: 'unavailable_due_to_deletion' });
    output = '';
    expect(await run(['comparison', 'report', 'report-1', '--format', 'markdown-readable'])).toBe(0);
    expect(output).toContain('Original cohort: unavailable\\_due\\_to\\_deletion');
    expect(output).not.toContain('| Assigned cohort |');
    expect(
      await run(['comparison', 'snapshot', 'create', request.protocolId, '--id', request.reportId, '--cutoff', request.cutoff, '--reason', 'initial'])
    ).toBe(2);
    expect(await run(['comparison', 'report', 'PRIVATE_SENTINEL?', '--format', 'bad'])).toBe(2);
    expect(errors).toBe('invalidated_report\ninvalid_report_id\n');
  } finally {
    vi.useRealTimers();
    stdout.mockRestore();
    stderr.mockRestore();
    collect.mockRestore();
    link.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

test('identity-conflict CLI discloses affected opaque report IDs before purging their snapshots', async () => {
  const root = mkdtempSync(join(tmpdir(), 'report-conflict-cli-'));
  const file = join(root, 'local.db');
  const store = reportStore(file);
  assignTask(store, { ...assignmentInput, task_id: 'task-2', logical_task_id: 'logical-2' }, { clock: () => '2026-01-01T00:30:00Z' });
  store.close();
  let output = '';
  let errors = '';
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(value => {
    output += String(value);
    return true;
  });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(value => {
    errors += String(value);
    return true;
  });
  vi.useFakeTimers();
  vi.setSystemTime(new Date(evaluation));
  try {
    expect(
      await main([
        '--db',
        file,
        'comparison',
        'snapshot',
        'create',
        request.protocolId,
        '--id',
        request.reportId,
        '--cutoff',
        request.cutoff,
        '--reason',
        'initial'
      ])
    ).toBe(0);
    output = '';
    const config = join(root, 'conflict.json');
    writeFileSync(config, JSON.stringify({ ...assignmentInput, alias_ids: ['logical-2'] }));
    expect(await main(['--db', file, 'comparison', 'assign', '--config', config])).toBe(2);
    expect(JSON.parse(output) as unknown).toEqual({ invalidating_reports: ['report-1'] });
    expect(errors).toBe('identity_conflict\n');
    output = '';
    expect(await main(['--db', file, 'comparison', 'report', 'report-1'])).toBe(0);
    expect(JSON.parse(output) as unknown).toMatchObject({ validity_status: 'invalidated', reason: 'identity_conflict' });
  } finally {
    vi.useRealTimers();
    stdout.mockRestore();
    stderr.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
