import { expect, test } from 'vitest';
import { teamFixture } from './helpers/team-fixture.js';
import { importExchangePackage } from '../src/exchange/import.js';
import { createTeamSnapshot } from './helpers/legacy-exchange.js';
const now = '2026-01-06T00:00:00.000Z';
test('eight original assignments produce independently calculated partial descriptive results', () => {
  const f = teamFixture();
  try {
    for (const p of [...f.packages].reverse()) importExchangePackage(f.dest, p, 'destination', () => f.request.as_of);
    const r = createTeamSnapshot(f.dest, f.request, () => now);
    expect(r.total.assigned_tasks).toBe(8);
    expect(r.arms.map(a => a.assigned_tasks)).toEqual([4, 4]);
    expect(r.total.deadline_counts).toEqual({ success: 3, failed: 2, aborted: 1, not_started: 1, outcome_missing: 1, pending_followup: 0 });
    expect(r.total.deadline_success).toMatchObject({ numerator: 3, denominator: 8, value: 3 / 8 });
    expect(r.total.usage).toMatchObject({
      complete_tasks: 0,
      partial_tasks: 6,
      missing_tasks: 2,
      partial_tokens: { task_denominator: 4, distribution: [0, 2, 4, 10], mean: 4, median: 3 },
      cost: null,
      change_rate: null,
      complete_tokens_mean: null,
      tokens_per_success: null
    });
    expect(r.total.rework).toMatchObject({ attempts: 1, task_rate: { numerator: 1, denominator: 8, value: 1 / 8 } });
    expect(r.total.first_attempt.success).toMatchObject({ numerator: 3, denominator: 6, value: 0.5 });
    expect(r.total.criteria.fulfillment).toMatchObject({ numerator: 3, denominator: 6, value: 0.5 });
    expect(r.tasks.map(t => t.task_id)).toEqual(Array.from({ length: 8 }, (_, i) => `task-${i + 1}`));
    expect(r.tasks[0]!.usage.cached_input.observed_sum).toBe(2);
    expect(r.tasks[0]!.usage.reasoning_output.observed_sum).toBe(1);
    expect(r.tasks[1]!.usage.partial_tokens).toBe(0);
    expect(r.tasks[2]!.usage.status).toBe('missing');
    expect(r.tasks[5]!.usage.input_total.status_counts.excluded).toBe(1);
    expect(r.confidence_interval).toBeNull();
    expect(r.p_value).toBeNull();
    expect(r.team_assignment_denominator).toBeNull();
    expect(r.team_completeness).toBe('unverified');
    expect(r.composition.filter(c => c.dimension === 'assignee').map(c => c.assigned_tasks)).toEqual([4, 4]);
    expect(r.blocks.map(b => b.assigned_tasks)).toEqual([4, 4]);
    expect(JSON.stringify(r)).not.toMatch(/PRIVATE_|code_base_commit|source_key|session_id|epoch|queue|seed/);
  } finally {
    f.close();
  }
});
test('missing writers stay unknown and early endpoints remain pending', () => {
  const f = teamFixture(undefined, undefined, '2026-01-01T00:30:00.000Z');
  try {
    importExchangePackage(f.dest, f.packages[0], 'destination', () => f.request.as_of);
    const r = createTeamSnapshot(f.dest, f.request, () => now);
    expect(r).toMatchObject({
      declared_writer_coverage: 'partial',
      missing_namespaces: [f.packages[1]!.namespace_id],
      team_assignment_denominator: null,
      team_completeness: 'unverified',
      provisional: true
    });
    expect(r.total.deadline_counts.pending_followup).toBe(4);
    expect(r.total.deadline_success.value).toBeNull();
    expect(r.total.assigned_tasks).toBe(4);
    expect(r.tasks[0]).toMatchObject({ current_outcome: 'success', deadline_status: 'pending_followup' });
  } finally {
    f.close();
  }
});
test('same block ID in different strata remains two blocks and import order preserves arithmetic', () => {
  const a = teamFixture();
  const b = teamFixture();
  try {
    // Original writer allocation IDs are opaque and may coincide across strata.
    for (const f of [a, b]) for (const p of f.packages) for (const t of p.assignments) t.block_id = 'same-block';
    for (const p of a.packages) importExchangePackage(a.dest, p, 'destination', () => a.request.as_of);
    for (const p of [...b.packages].reverse()) importExchangePackage(b.dest, p, 'destination', () => b.request.as_of);
    const ra = createTeamSnapshot(a.dest, a.request, () => now);
    const rb = createTeamSnapshot(b.dest, b.request, () => now);
    expect(ra.blocks).toEqual([
      { block_id: 'same-block', stratum_id: 'stratum-1', assigned_tasks: 4, a: 2, b: 2, planned_size: 4, status: 'complete' },
      { block_id: 'same-block', stratum_id: 'stratum-2', assigned_tasks: 4, a: 2, b: 2, planned_size: 4, status: 'complete' }
    ]);
    expect(ra.total).toEqual(rb.total);
    expect(ra.arms).toEqual(rb.arms);
    expect(ra.composition).toEqual(rb.composition);
  } finally {
    a.close();
    b.close();
  }
});

test('different source cutoffs cannot be merged or silently trimmed', () => {
  const f = teamFixture();
  try {
    importExchangePackage(f.dest, f.packages[0], 'destination', () => f.request.as_of);
    const second = structuredClone(f.packages[1]!);
    second.cutoff = '2026-01-02T00:00:00.000Z';
    importExchangePackage(f.dest, second, 'destination', () => f.request.as_of);
    expect(() => createTeamSnapshot(f.dest, f.request, () => now)).toThrow('cutoff_mismatch');
    expect(f.dest.all('SELECT * FROM exchange_team_snapshots')).toEqual([]);
  } finally {
    f.close();
  }
});

test('later imported evidence appears only in a new frozen report', async () => {
  const { createComparisonSnapshot } = await import('../src/reports/comparison-snapshot.js');
  const { buildExchangePackage } = await import('../src/exchange/source.js');
  const { readTeamSnapshot } = await import('./helpers/legacy-exchange.js');
  const f = teamFixture();
  try {
    for (const p of f.packages) importExchangePackage(f.dest, p, 'destination', () => f.request.as_of);
    const old = createTeamSnapshot(f.dest, f.request, () => now);
    const source = f.sources[0]!;
    const observed = { status: 'observed' as const, value: 1, reason: null };
    const missing = { status: 'missing' as const, value: null, reason: 'not_available' as const };
    source.putEvent({
      id: 'late-synthetic-event',
      project_id: 'project-1',
      task_id: 'task-1',
      session_id: 'PRIVATE_SESSION_1',
      source_key: 'PRIVATE_LATE_SOURCE',
      occurred_at: '2026-01-01T00:08:00.000Z',
      payload: {
        kind: 'usage',
        input_total: observed,
        output_total: observed,
        cached_input: missing,
        reasoning_output: missing,
        product: 'synthetic',
        product_version: '1.0.0',
        model: 'synthetic-model',
        epoch: 'PRIVATE_EPOCH'
      }
    });
    createComparisonSnapshot(
      source,
      {
        reportId: 'source-late',
        protocolId: f.request.protocol_id,
        cutoff: f.request.cutoff,
        revisionReason: 'late_arrival',
        supersedesReportId: 'source-snapshot'
      },
      () => now
    );
    const updated = buildExchangePackage(
      source,
      { kind: 'assignment_metadata', protocolId: f.request.protocol_id, snapshotId: 'source-late', packageId: '99999999-9999-4999-8999-999999999999' },
      () => now
    );
    const arrival = '2026-01-07T00:00:00.000Z';
    importExchangePackage(f.dest, updated, 'destination', () => arrival);
    expect(readTeamSnapshot(f.dest, f.request.snapshot_id)).toEqual(old);
    expect(() => createTeamSnapshot(f.dest, { ...f.request, snapshot_id: 'historical' }, () => arrival)).toThrow('snapshot_as_of_unavailable');
    const fresh = createTeamSnapshot(f.dest, { ...f.request, snapshot_id: 'updated', as_of: arrival }, () => arrival);
    expect(old.total.usage.partial_tokens.mean).toBe(4);
    expect(fresh.total.usage.partial_tokens).toMatchObject({ distribution: [0, 2, 4, 12], mean: 4.5 });
    expect(fresh.source_vector.map(v => v.export_revision)).toEqual([2, 1]);
  } finally {
    f.close();
  }
});
