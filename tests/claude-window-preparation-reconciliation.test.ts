import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { readOrdinaryWindowControl, writeOrdinaryWindowControl } from '../src/core/ordinary-window-control.js';
import { resolveOrdinaryWindow } from '../src/core/ordinary-window-policy.js';
import { claudeWindowSetupHttpFixture } from './helpers/claude-window-setup-http-fixture.js';

const fixtures: Awaited<ReturnType<typeof claudeWindowSetupHttpFixture>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});

async function fixture(mode: 'ordinary_window' | 'exact' = 'ordinary_window') {
  const f = await claudeWindowSetupHttpFixture();
  fixtures.push(f);
  const configured = await f.configure({
    bundle_mode: mode,
    product_version: mode === 'ordinary_window' ? '2.1.318' : '2.1.306',
    claude_projects_directory: join(f.directory, 'native-denied')
  });
  expect(configured.statusCode, configured.body).toBe(200);
  const scope = resolveOrdinaryWindow('claude_code', '2.1.318');
  if (!scope) throw new Error('fixture_policy_missing');
  writeOrdinaryWindowControl({
    schemaVersion: 1,
    projectRoot: f.project,
    product: 'claude_code',
    policyId: scope.policy.policyId,
    policyRevision: scope.policy.ruleRevision,
    evidenceMode: scope.policy.evidenceMode,
    state: 'active'
  });
  return { ...f, emission: () => readOrdinaryWindowControl(f.project, 'claude_code') };
}

test.each(['name', 'idempotency'] as const)('Claude preparation %s rejection repairs stale control at the HTTP boundary', async rejection => {
  const f = await fixture();
  const bootstrap = await f.app.inject({ url: '/api/bootstrap', headers: { host: '127.0.0.1:4327' } });
  const csrf = bootstrap.json<{ csrf: string }>().csrf;

  const response = await f.app.inject({
    method: 'POST',
    url: '/api/tasks',
    payload: { mode: 'ordinary', name: rejection === 'name' ? '' : 'Synthetic window', project_id: 'project', criterion_ids: ['accepted'] },
    headers: {
      host: '127.0.0.1:4327',
      origin: 'http://127.0.0.1:4327',
      'x-harness-csrf': csrf,
      'idempotency-key': rejection === 'idempotency' ? 'invalid' : randomUUID()
    }
  });

  expect(response.statusCode).toBe(400);
  expect(response.json()).toEqual({ error: 'local_operation_failed' });
  expect(f.emission()?.state).toBe('inactive');
  expect(f.store.all('SELECT * FROM tasks')).toEqual([]);
  expect(f.store.all('SELECT * FROM ordinary_window_activations')).toEqual([]);
});

test('successful Claude preparation repairs emission without granting collection authority', async () => {
  const f = await fixture();

  const response = await f.post('/api/tasks', { mode: 'ordinary', name: 'Synthetic window', project_id: 'project', criterion_ids: ['accepted'] });

  expect(response.statusCode, response.body).toBe(200);
  expect(f.emission()?.state).toBe('inactive');
  expect(f.store.all('SELECT id FROM tasks')).toHaveLength(1);
  expect(f.store.all('SELECT * FROM ordinary_window_activations')).toEqual([]);
});

test.each(['exact', 'comparison'] as const)('unrelated %s preparation rejection does not reconcile window control', async mode => {
  const f = await fixture(mode === 'exact' ? 'exact' : 'ordinary_window');
  const payload =
    mode === 'exact'
      ? { mode: 'ordinary', name: '', project_id: 'project', criterion_ids: ['accepted'] }
      : { name: '', project_id: 'project', setup_id: 'synthetic-setup' };

  const response = await f.post('/api/tasks', payload);

  expect(response.statusCode).toBe(400);
  expect(f.emission()?.state).toBe('active');
  expect(f.store.all('SELECT * FROM tasks')).toEqual([]);
});
