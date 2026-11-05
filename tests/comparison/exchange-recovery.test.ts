import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { Store } from '../../src/store.js';
import { assignTask } from '../../src/comparison/allocation.js';
import { Deletion } from '../../src/deletion.js';
import { buildExchangePackage } from '../helpers/legacy-exchange.js';
import { registerExchangeSource } from '../../src/comparison/exchange/source.js';
import { publishExchangeFile } from '../../src/comparison/exchange/files.js';
import { parseExchangePackage } from '../../src/comparison/exchange/contracts.js';
import { freshSource, assignAndSnapshot, dataPackage, sourceConfig, namespaceId, exportTime, packageId } from '../helpers/exchange-fixture.js';
import { reportStore, syntheticUsage } from '../helpers/comparison-report-fixture.js';
import { assignmentInput, protocol } from '../helpers/comparison-fixture.js';
import { createComparisonSnapshot } from '../../src/comparison/reports/comparison-snapshot.js';

test('unbound historical state and unowned strata are refused', () => {
  const historical = reportStore();
  const fresh = freshSource();
  try {
    expect(() => registerExchangeSource(historical, sourceConfig)).toThrow('source_scope_not_empty');
    fresh.execute('DELETE FROM exchange_sources', []);
    expect(() => registerExchangeSource(fresh, { ...sourceConfig, owned_strata: ['unknown'] })).toThrow('authority_conflict');
    expect(() => registerExchangeSource(fresh, { ...sourceConfig, local_project_id: 'unknown' })).toThrow('authority_conflict');
  } finally {
    historical.close();
    fresh.close();
  }
});
test('receipt committed before output regenerates the identical package after restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'exchange-recovery-'));
  const path = join(dir, 'source.db');
  let store = freshSource(path);
  try {
    assignAndSnapshot(store);
    const pkg = dataPackage(store);
    store.close();
    store = new Store(path);
    expect(dataPackage(store)).toEqual(pkg);
    expect(() => assignTask(store, assignmentInput)).not.toThrow();
    const next = dataPackage(store, '55555555-5555-4555-8555-555555555555');
    expect(next.export_revision).toBe(pkg.export_revision + 1);
    expect(() =>
      buildExchangePackage(store, { kind: 'assignment_metadata', protocolId: protocol.id, snapshotId: 'different', packageId }, () => exportTime)
    ).toThrow('package_conflict');
    expect(() => publishExchangeFile(join(dir, 'missing', 'out.json'), pkg)).toThrow('exchange_io_error');
    expect(readdirSync(dir).some(n => n.endsWith('.tmp'))).toBe(false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('project deletion before the first export remains transmissible after restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'exchange-delete-'));
  const path = join(dir, 'source.db');
  let store = freshSource(path);
  try {
    new Deletion(store, () => exportTime).deleteProject('project-1');
    store.close();
    store = new Store(path);
    const pkg = buildExchangePackage(store, { kind: 'deletion_metadata', namespaceId, packageId }, () => exportTime);
    expect(pkg.tombstones).toMatchObject([{ kind: 'project', reason: 'deletion' }]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('a failed conflict notice write rolls back source invalidation, snapshot and queue', () => {
  const store = freshSource();
  try {
    assignAndSnapshot(store);
    const pkg = dataPackage(store);
    assignTask(store, { ...assignmentInput, task_id: 'task-2', logical_task_id: 'logical-2' }, { clock: () => protocol.recruitment_start });
    const queue = store.all('SELECT * FROM comparison_allocation_state');
    store.execute("CREATE TRIGGER fail_notice BEFORE INSERT ON exchange_scope_notices BEGIN SELECT RAISE(ABORT,'forced_failure'); END", []);
    expect(() => assignTask(store, { ...assignmentInput, alias_ids: ['logical-2'] })).toThrow('forced_failure');
    expect(dataPackage(store)).toEqual(pkg);
    expect(store.all('SELECT * FROM comparison_allocation_state')).toEqual(queue);
  } finally {
    store.close();
  }
});
test('configured source retention retires export scope; no policy cannot silently clean up', () => {
  const store = freshSource();
  try {
    assignAndSnapshot(store);
    const deletion = new Deletion(store, () => exportTime);
    expect(() => deletion.applyRetention('project-1', exportTime)).toThrow('retention_not_configured');
    store.execute("UPDATE tasks SET state='finalized',finalized_at='2026-01-01T00:30:00.000Z' WHERE id='task-1'", []);
    deletion.configureRetention('project-1', 1);
    expect(deletion.applyRetention('project-1', exportTime)).toBe(1);
    expect(store.all('SELECT * FROM exchange_scope_notices')).toHaveLength(1);
  } finally {
    store.close();
  }
});
test('usage-bearing export excludes source evidence and rejects aggregate overflow', () => {
  const store = freshSource();
  try {
    assignAndSnapshot(store);
    syntheticUsage(store, 'PRIVATE_SOURCE_SENTINEL');
    createComparisonSnapshot(
      store,
      { reportId: 'report-2', protocolId: protocol.id, cutoff: '2026-01-03T00:00:00Z', revisionReason: 'evidence_updated', supersedesReportId: 'report-1' },
      () => '2026-01-04T00:00:00Z'
    );
    const pkg = buildExchangePackage(store, { kind: 'assignment_metadata', protocolId: protocol.id, snapshotId: 'report-2', packageId }, () => exportTime);
    if (pkg.kind !== 'assignment_metadata') throw new Error('wrong_kind');
    expect(pkg.assignments[0]!.evidence.usage).toMatchObject({
      partial_tokens: 10,
      input_total: { observed_sum: 7 },
      cached_input: { observed_sum: 2 },
      reasoning_output: { observed_sum: 1 }
    });
    expect(JSON.stringify(pkg)).not.toContain('PRIVATE_SOURCE_SENTINEL');
    const bad = structuredClone(pkg);
    bad.assignments[0]!.evidence.usage.input_total.observed_sum = Number.MAX_SAFE_INTEGER;
    expect(() => parseExchangePackage(bad)).toThrow('invalid_exchange_package');
  } finally {
    store.close();
  }
});
