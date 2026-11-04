import { expect, test } from 'vitest';
import { Store } from '../../src/store.js';
import { Lifecycle } from '../../src/lifecycle.js';
import { aggregateTask, tokensPerSuccess, changeRate } from '../../src/metrics.js';
import { freezePeriod, periodReport } from '../../src/comparison/reports/period.js';
const meta = { type: 'feature', expected_size: 'small', assignee: 'u1', product: 'synthetic', model: 'synthetic', criterion_ids: ['c1'] };
const config = {
  schema_version: 1,
  id: 'period1',
  project_id: 'p1',
  classification_version: 1,
  followup_hours: 24,
  before: { start: '2026-01-02T00:00:00Z', end: '2026-01-03T00:00:00Z' },
  after: { start: '2026-01-04T00:00:00Z', end: '2026-01-05T00:00:00Z' },
  types: ['feature'],
  sizes: ['small'],
  assignees: ['u1'],
  products: ['synthetic'],
  models: ['synthetic']
};
test('all eligible usage including failure and abandonment divides by successes; undefined stays null', () => {
  expect(
    tokensPerSuccess([
      { tokens: 100, outcome: 'success' },
      { tokens: 200, outcome: 'failed' },
      { tokens: 300, outcome: 'aborted' }
    ])
  ).toBe(600);
  expect(tokensPerSuccess([{ tokens: 100, outcome: 'failed' }])).toBeNull();
  expect(changeRate(0, 80)).toBeNull();
  expect(changeRate(100, 80)).toBe(-0.2);
});
test('time excludes pauses; missing usage/cost/model runtime and milestones stay null', () => {
  const store = new Store(':memory:');
  let now = '2026-01-01T00:00:00Z';
  const life = new Lifecycle(store, () => now);
  try {
    store.execute('INSERT INTO projects(id) VALUES (?)', ['p1']);
    life.createTask('p1', 't1', meta);
    life.start('t1');
    now = '2026-01-01T00:00:10Z';
    life.pause('t1');
    now = '2026-01-01T00:00:20Z';
    life.resume('t1');
    now = '2026-01-01T00:00:30Z';
    life.finalize('t1', 'success', ['c1']);
    const report = aggregateTask(store, 't1', now);
    expect(report.time).toMatchObject({ elapsed_ms: 30000, active_ms: 20000, model_runtime_ms: null });
    expect(report.usage).toMatchObject({ complete_tokens: null, partial_tokens: null, status: 'missing' });
    expect(report.cost).toBeNull();
    expect(report.tools.confirmed_execution_count).toBeNull();
  } finally {
    store.close();
  }
});
test('period settings freeze before enrollment, preserve empty groups and deterministic provisional snapshots', () => {
  const store = new Store(':memory:');
  let now = '2026-01-01T00:00:00Z';
  const life = new Lifecycle(store, () => now);
  try {
    store.execute('INSERT INTO projects(id) VALUES (?)', ['p1']);
    freezePeriod(store, config, now);
    expect(() => freezePeriod(store, { ...config, followup_hours: 12 }, now)).toThrow();
    life.createTask('p1', 't1', meta);
    now = '2026-01-02T12:00:00Z';
    life.start('t1');
    now = '2026-01-03T01:00:00Z';
    life.finalize('t1', 'failed', []);
    const report = periodReport(store, 'period1', '2026-01-04T00:00:00Z');
    expect(report.provisional).toBe(true);
    expect(report.before.tasks).toHaveLength(1);
    expect(report.before.outcomes.failed).toBe(1);
    expect(report.after.tasks).toHaveLength(0);
    expect(report.after.mean_complete_tokens).toBeNull();
    expect(report).toEqual(periodReport(store, 'period1', '2026-01-04T00:00:00Z'));
    expect(JSON.stringify(report)).not.toContain('local_root');
    expect(() => freezePeriod(store, { ...config, id: 'late' }, '2026-01-03T00:00:00Z')).toThrow('registration_too_late');
  } finally {
    store.close();
  }
});

test('mixed reading states, denied tools, observed zero and cutoff clipping survive reports', () => {
  const store = new Store(':memory:');
  let now = '2026-01-01T00:00:00Z';
  const life = new Lifecycle(store, () => now);
  try {
    store.execute('INSERT INTO projects(id) VALUES (?)', ['p1']);
    life.createTask('p1', 't1', meta);
    life.start('t1');
    store.execute('INSERT INTO sessions(id,project_id,task_id) VALUES (?,?,?)', ['s1', 'p1', 't1']);
    const base = { id: 'e1', source_key: 'k1', project_id: 'p1', task_id: 't1', session_id: 's1', occurred_at: '2026-01-01T00:00:01Z' };
    store.putEvent({
      ...base,
      payload: {
        kind: 'usage',
        product: 'synthetic',
        product_version: '1.0.0',
        model: 'synthetic',
        epoch: 'epoch1',
        input_total: { status: 'observed', value: 0, reason: null },
        output_total: { status: 'observed', value: 0, reason: null },
        cached_input: { status: 'error', value: null, reason: 'source_error' },
        reasoning_output: { status: 'unmeasurable', value: null, reason: 'unsupported' }
      }
    });
    store.putEvent({
      ...base,
      id: 'e2',
      source_key: 'k2',
      payload: { kind: 'tool', call_id: 'call1', boundary: 'codex_command', execution: 'unknown', outcome: 'denied', category: 'unclassified' }
    });
    store.execute('INSERT INTO observations(id,task_id,started_at,ended_at,status,reason) VALUES (?,?,?,?,?,?)', [
      'o1',
      't1',
      '2026-01-01T00:00:00Z',
      '2026-01-01T00:00:20Z',
      'error',
      'source_error'
    ]);
    now = '2026-01-01T00:00:30Z';
    life.finalize('t1', 'success', ['c1']);
    const report = aggregateTask(store, 't1', '2026-01-01T00:00:10Z');
    expect(report.outcome).toBeNull();
    expect(report.usage.partial_tokens).toBe(0);
    expect(report.usage.complete_tokens).toBeNull();
    expect(report.usage.cached_input.status_counts.error).toBe(1);
    expect(report.usage.reasoning_output.reason_counts.unsupported).toBe(1);
    expect(report.tools).toMatchObject({ confirmed_execution_count: 0, denied_count: 1, observed_failure_count: 0, failed_tool_call_count: null });
    expect(report.observation_windows).toEqual([
      { started_at: '2026-01-01T00:00:00.000Z', ended_at: '2026-01-01T00:00:10.000Z', status: 'unmeasurable', reason: 'incomplete' }
    ]);
  } finally {
    store.close();
  }
});
test('cohorts exclude outcomes after follow-up and report quality/stratum denominators', () => {
  const store = new Store(':memory:');
  let now = '2026-01-01T00:00:00Z';
  const life = new Lifecycle(store, () => now);
  try {
    store.execute('INSERT INTO projects(id) VALUES (?)', ['p1']);
    freezePeriod(store, config, now);
    life.createTask('p1', 't1', meta);
    now = '2026-01-02T00:00:00Z';
    life.start('t1');
    life.declareFirst('t1');
    life.assessFirst('t1', false);
    life.rework('t1');
    now = '2026-01-04T00:00:00Z';
    life.finalize('t1', 'success', ['c1']);
    const report = periodReport(store, 'period1', '2026-01-07T00:00:00Z');
    expect(report.provisional).toBe(false);
    expect(report.before.outcomes.pending).toBe(1);
    expect(report.before.first_attempt.failed).toBe(1);
    expect(report.before.criteria.pending_tasks).toBe(1);
    expect(report.before.rework).toMatchObject({ tasks_with_rework: 1, eligible_tasks: 1, rate: 1 });
    expect(report.before.strata.find(s => s.dimension === 'assignee' && s.value === 'u1')?.eligible_count).toBe(1);
  } finally {
    store.close();
  }
});

test('productionReportsRemainPartial: finalized success with observed usage cannot certify completeness', () => {
  const store = new Store(':memory:');
  let now = '2026-01-01T00:00:00Z';
  const life = new Lifecycle(store, () => now);
  try {
    store.execute('INSERT INTO projects(id) VALUES (?)', ['p1']);
    freezePeriod(store, config, now);
    life.createTask('p1', 't1', meta);
    now = '2026-01-02T00:00:00Z';
    life.start('t1');
    store.execute('INSERT INTO sessions(id,project_id,task_id) VALUES (?,?,?)', ['s1', 'p1', 't1']);
    store.putEvent({
      id: 'e1',
      source_key: 'k1',
      project_id: 'p1',
      task_id: 't1',
      session_id: 's1',
      occurred_at: '2026-01-02T00:00:01Z',
      payload: {
        kind: 'usage',
        product: 'synthetic',
        product_version: '1.0.0',
        model: 'synthetic',
        epoch: 'epoch1',
        input_total: { status: 'observed', value: 60, reason: null },
        cached_input: { status: 'observed', value: 30, reason: null },
        output_total: { status: 'observed', value: 7, reason: null },
        reasoning_output: { status: 'observed', value: 0, reason: null }
      }
    });
    now = '2026-01-02T00:00:02Z';
    life.finalize('t1', 'success', ['c1']);
    const task = aggregateTask(store, 't1', now);
    expect(task.outcome).toBe('success');
    expect(task.usage).toMatchObject({ status: 'partial', partial_tokens: 67, complete_tokens: null });
    expect(task.usage.reasons).toContain('incomplete');
    const period = periodReport(store, 'period1', '2026-01-07T00:00:00Z');
    expect(period.before).toMatchObject({ complete_usage_count: 0, partial_usage_count: 1, mean_complete_tokens: null, tokens_per_success: null });
    expect(period.change_rate).toBeNull();
  } finally {
    store.close();
  }
});
