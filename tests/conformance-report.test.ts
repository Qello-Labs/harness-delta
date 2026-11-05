import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { admissionCatalog, traverseCatalog } from '../scripts/conformance/catalog.js';
import { classifyCounters, classifyTopology, type CheckMap, type CounterVector } from '../scripts/conformance/checks.js';
import { projectReport, writeRestrictedReport } from '../scripts/conformance/report.js';

const vector = (values: Partial<CounterVector> = {}): CounterVector => ({
  input: null,
  cached: null,
  output: null,
  reasoning: null,
  cacheWrite: null,
  totalTokens: null,
  ...values
});
const counters = (values: {
  total?: CounterVector | null;
  last?: CounterVector | null;
  exec?: CounterVector | null;
  priorTotal?: CounterVector | null;
  inputIncludesCacheWrite?: boolean;
}) =>
  classifyCounters({
    total: values.total ?? null,
    last: values.last ?? null,
    exec: values.exec ?? null,
    priorTotal: values.priorTotal ?? null,
    inputIncludesCacheWrite: values.inputIncludesCacheWrite ?? false
  });

test('catalog traversal keeps approved paths and drops private names and values', () => {
  const row = traverseCatalog(
    {
      type: 'session_meta',
      payload: { id: 's1', session_id: 's1', creator_account_id: 'SECRET_ACCOUNT', private_note: 'SECRET_NOTE' }
    },
    admissionCatalog
  );
  expect(row.matchedPaths).toEqual(['session_meta.id', 'session_meta.session_id', 'session_meta.creator_account_id']);
  expect(row.unknownNameCount).toBeGreaterThanOrEqual(1);
  expect(row.recordCounts).toEqual({ session_meta: 1 });
  const body = JSON.stringify(row);
  expect(body).not.toContain('SECRET_ACCOUNT');
  expect(body).not.toContain('SECRET_NOTE');
  expect(body).not.toContain('private_note');
  const nested = traverseCatalog(
    {
      type: 'token_usage_record',
      payload: { amount: 99999, note: 'SECRET_NESTED' }
    },
    admissionCatalog
  );
  expect(nested.matchedPaths).toEqual(['token_usage_record']);
  const nestedBody = JSON.stringify(nested);
  expect(nestedBody).not.toContain('amount');
  expect(nestedBody).not.toContain('99999');
  expect(nestedBody).not.toContain('note');
  expect(nestedBody).not.toContain('SECRET_NESTED');
  const limited = traverseCatalog(
    {
      type: 'session_meta',
      payload: { id: 's1', private_overflow: 'SECRET_OVER' }
    },
    admissionCatalog,
    { maxDepth: 8, maxNodes: 1 }
  );
  expect(limited.limitExceeded).toBe(true);
  expect(JSON.stringify(limited)).not.toContain('private_overflow');
  expect(JSON.stringify(limited)).not.toContain('SECRET_OVER');
  const turns = Array.from({ length: 60 }, (_, index) => [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: `turn${index}` } },
    { type: 'turn_context', payload: { model: 'synthetic', turn_id: `turn${index}`, root_turn_id: `turn${index}` } },
    {
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: index,
            cached_input_tokens: 0,
            output_tokens: 1,
            reasoning_output_tokens: 0,
            cache_write_input_tokens: 0
          }
        }
      }
    },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: `turn${index}` } }
  ]).flat();
  expect(traverseCatalog(turns, admissionCatalog).limitExceeded).toBe(false);
  const wide = { type: 'session_meta', payload: Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`k${index}`, 'x'])) };
  expect(traverseCatalog(wide, admissionCatalog).limitExceeded).toBe(true);
});

test('counter classification stores outcomes only', () => {
  const missing = counters({ total: vector({ input: 10, cached: 0, output: 1, reasoning: 0 }) });
  expect(missing.cache_write_subset_of_input).toBe('invalid');
  expect(missing.total_equals_input_plus_output).toBe('not_observed');
  const absent = counters({});
  expect(absent.total_equals_input_plus_output).toBe('not_observed');
  expect(absent.exec_equals_rollout_total).toBe('not_observed');
  expect(absent.resume_total_equals_prior_plus_last).toBe('not_observed');
  const total = vector({ input: 10, cached: 8, output: 1, reasoning: 0, cacheWrite: 5, totalTokens: 11 });
  const bounded = counters({ total });
  expect(bounded.total_equals_input_plus_output).toBe('pass');
  expect(bounded.cached_subset_of_input).toBe('pass');
  expect(bounded.cache_write_subset_of_input).toBe('pass');
  expect(bounded.cache_write_not_added_to_input).toBe('pass');
  expect(counters({ total, inputIncludesCacheWrite: true }).cache_write_not_added_to_input).toBe('fail');
  expect(counters({ total: vector({ ...total, totalTokens: 99 }) }).total_equals_input_plus_output).toBe('fail');
  const execMatch = counters({ total, exec: total });
  expect(execMatch.exec_equals_rollout_total).toBe('pass');
  const execMiss = counters({ total, exec: vector({ ...total, input: 11 }) });
  expect(execMiss.exec_equals_rollout_total).toBe('fail');
  expect(JSON.stringify(execMiss)).not.toMatch(/\d/);
  // `codex exec --json` usage reports no total_tokens; compare the fields it reports.
  const execStream = vector({ ...total, totalTokens: null });
  expect(counters({ total, exec: execStream }).exec_equals_rollout_total).toBe('pass');
  expect(counters({ total, exec: vector({ ...execStream, output: 2 }) }).exec_equals_rollout_total).toBe('fail');
  expect(counters({ total, exec: vector({ ...execStream, cacheWrite: null }) }).exec_equals_rollout_total).toBe('pass');
  expect(counters({ total, exec: vector({ ...execStream, reasoning: null }) }).exec_equals_rollout_total).toBe('invalid');
  expect(counters({ total: vector({ ...total, cached: null }), exec: execStream }).exec_equals_rollout_total).toBe('fail');
  const prior = vector({ input: 4, output: 1, cached: 0, reasoning: 0, cacheWrite: 0, totalTokens: 5 });
  const last = vector({ input: 6, output: 0, cached: 0, reasoning: 0, cacheWrite: 0, totalTokens: 6 });
  expect(counters({ total, priorTotal: prior, last }).resume_total_equals_prior_plus_last).toBe('pass');
  expect(counters({ total, last }).resume_total_equals_prior_plus_last).toBe('not_observed');
  const huge = vector({ input: Number.MAX_SAFE_INTEGER, output: 0, cached: 0, reasoning: 0, cacheWrite: 0 });
  const one = vector({ input: 1, output: 0, cached: 0, reasoning: 0, cacheWrite: 0 });
  expect(counters({ total: huge, priorTotal: huge, last: one }).resume_total_equals_prior_plus_last).toBe('invalid');
  expect(counters({ total: vector({ ...total, reasoning: 3 }) }).nonzero_reasoning).toBe('pass');
  expect(counters({ total }).nonzero_reasoning).toBe('not_observed');
  expect(absent.nonzero_reasoning).toBe('not_observed');
});

test('topology classification does not retain identity values', () => {
  expect(
    classifyTopology({
      taskStartedTurnId: 'turn1',
      taskCompleteTurnId: 'turn1',
      turnId: 'turn1',
      rootTurnId: null,
      collaborationModePresent: false,
      multiAgentVersionPresent: false,
      threadSettingsApplied: 'absent',
      sessionMetaId: 'SECRET_SESSION',
      sessionMetaSessionId: 'SECRET_SESSION',
      linkedSessionId: 'SECRET_SESSION'
    })
  ).toMatchObject({
    paired_turn_ids: 'pass',
    root_turn_topology: 'not_observed',
    thread_settings_applied: 'not_observed',
    session_id_matches_id: 'pass'
  });
  const secret = classifyTopology({
    taskStartedTurnId: null,
    taskCompleteTurnId: 'turn1',
    turnId: 'turn1',
    rootTurnId: 'turn1',
    collaborationModePresent: false,
    multiAgentVersionPresent: false,
    threadSettingsApplied: 'ambiguous',
    sessionMetaId: 'SECRET_SESSION',
    sessionMetaSessionId: 'OTHER',
    linkedSessionId: 'SECRET_SESSION'
  });
  expect(secret).toMatchObject({
    paired_turn_ids: 'fail',
    root_turn_topology: 'pass',
    thread_settings_applied: 'fail',
    session_id_matches_id: 'fail'
  });
  expect(JSON.stringify(secret)).not.toContain('SECRET_SESSION');
  expect(
    classifyTopology({
      taskStartedTurnId: '',
      taskCompleteTurnId: '',
      turnId: null,
      rootTurnId: 'root',
      collaborationModePresent: true,
      multiAgentVersionPresent: false,
      threadSettingsApplied: 'absent',
      sessionMetaId: null,
      sessionMetaSessionId: null,
      linkedSessionId: null
    })
  ).toMatchObject({ paired_turn_ids: 'invalid', root_turn_topology: 'fail', session_id_matches_id: 'not_observed' });
});

test('the projector reports labels and outcome differences without token numbers', () => {
  const traversal = traverseCatalog({ type: 'session_meta', payload: { id: 's1' } }, admissionCatalog);
  const checks = counters({ total: vector({ input: 1, output: 1, cached: 0, reasoning: 0, cacheWrite: 0, totalTokens: 2 }) });
  const priorChecks: CheckMap = { ...checks, nonzero_reasoning: 'pass' };
  const report = projectReport({
    version: '0.158.0',
    scenario: 'initial-resume',
    traversal,
    checks,
    expectations: { total_equals_input_plus_output: 'fail' },
    prior: { checks: priorChecks },
    blocked: false
  });
  expect(report.version).toBe('0.158.0');
  expect(report.scenario).toBe('initial-resume');
  expect(report.expectationDifferences).toEqual([
    {
      check: 'total_equals_input_plus_output',
      expected: 'fail',
      actual: 'pass'
    }
  ]);
  expect(report.priorDifferences).toEqual([{ check: 'nonzero_reasoning', expected: 'pass', actual: 'not_observed' }]);
  expect(JSON.stringify(report)).not.toContain('SECRET_');
  expect(JSON.stringify(report)).not.toContain('99999');
  const directory = mkdtempSync(join(tmpdir(), 'conformance-report-'));
  try {
    writeRestrictedReport(directory, report);
    const path = join(directory, 'conformance-report.json');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8')).toBe(`${JSON.stringify(report)}\n`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
