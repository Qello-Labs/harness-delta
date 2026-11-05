import { expect, test } from 'vitest';
import { applyHarness } from './application-actions';
import type { Task } from './types';

function task(version: string): Task {
  return {
    id: 'synthetic/task',
    name: 'Synthetic application',
    project_id: 'project',
    setup_id: 'setup',
    version,
    state: 'draft',
    status: 'draft',
    attempt: 1,
    measurement: { state: 'waiting_connection', active_ms: null, requests: null, window: { started_at: null, ends_at: null } },
    outcome: null,
    source: null,
    startup: null,
    reason: null,
    criteria: ['criterion'],
    preparation: {
      state: 'registered',
      configuration_evidence: 'unverified',
      native_context_evidence: 'unverified',
      freshness_evidence: 'unverified',
      tool_use_evidence: 'unverified',
      assigned_variant_id: 'variant-a'
    },
    price: { partial_amount: null, currency: 'USD', unpriced_events: 0, basis: null },
    actions: [
      { code: 'application-prepare', enabled: true, reason: null },
      { code: 'application-open', enabled: true, reason: null }
    ],
    application: {
      product: 'codex',
      launchState: 'not_requested',
      identity: 'unavailable',
      state: 'awaiting_session',
      jobId: 'attempt',
      epoch: 1,
      reason: null,
      workspace: '/synthetic/project',
      baseline: 'baseline',
      capabilities: [{ id: 'codex', product: 'codex', available: true, reason: null }]
    }
  };
}
const choice = { workspace: '/synthetic/project', workspaceDigest: 'a'.repeat(64), product: 'codex' };

test('opens only after preparation succeeds using the returned task version', async () => {
  const initial = task('before'),
    prepared = task('prepared'),
    opened = task('opened');
  const requests: { route: string; body: unknown; version: string }[] = [];
  const result = await applyHarness(initial, choice, (route, body, version) => {
    requests.push({ route, body, version });
    return Promise.resolve(requests.length === 1 ? prepared : opened);
  });
  expect(requests).toEqual([
    { route: '/api/tasks/synthetic%2Ftask/application-prepare', body: choice, version: 'before' },
    { route: '/api/tasks/synthetic%2Ftask/application-open', body: {}, version: 'prepared' }
  ]);
  expect(result).toBe(opened);
});

test('does not open an agent when preparation fails', async () => {
  const requests: string[] = [];
  const result = await applyHarness(task('before'), choice, route => {
    requests.push(route);
    return Promise.resolve(null);
  });
  expect(requests).toEqual(['/api/tasks/synthetic%2Ftask/application-prepare']);
  expect(result).toBeNull();
});

test('does not prepare when the action is disabled', async () => {
  const initial = task('before');
  initial.actions[0] = { code: 'application-prepare', enabled: false, reason: 'application_required' };
  const requests: string[] = [];
  const result = await applyHarness(initial, choice, route => {
    requests.push(route);
    return Promise.resolve(task('unexpected'));
  });
  expect(requests).toEqual([]);
  expect(result).toBeNull();
});

test.each(['unavailable', 'disabled'] as const)('retains manual context without launching when opening is %s', async reason => {
  const prepared = task('prepared');
  if (!prepared.application) throw new Error('Missing application fixture');
  if (reason === 'unavailable')
    prepared.application.capabilities[0] = { id: 'codex', product: 'codex', available: false, reason: 'application_launch_unavailable' };
  else prepared.actions[1] = { code: 'application-open', enabled: false, reason: 'application_required' };
  const requests: string[] = [];
  const result = await applyHarness(task('before'), choice, route => {
    requests.push(route);
    return Promise.resolve(prepared);
  });
  expect(requests).toEqual(['/api/tasks/synthetic%2Ftask/application-prepare']);
  expect(result).toBe(prepared);
});

test('returns a failed open without retrying or claiming application completed', async () => {
  const requests: string[] = [];
  const result = await applyHarness(task('before'), choice, route => {
    requests.push(route);
    return Promise.resolve(requests.length === 1 ? task('prepared') : null);
  });
  expect(requests).toHaveLength(2);
  expect(result).toBeNull();
});
