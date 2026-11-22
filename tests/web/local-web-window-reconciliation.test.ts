import { mkdtempSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ZodError } from 'zod';
import { activateOrdinaryWindowDecision, publishOrdinaryWindowEmissionControl } from '../../src/core/ordinary-window-activation.js';
import { readOrdinaryWindowControl } from '../../src/core/ordinary-window-control.js';
import { ordinaryWindowSelectionHash } from '../../src/core/ordinary-window-store.js';
import { createClaudeWindowControl } from '../../src/web/local-web-claude-window-control.js';
import { createCodexWindowControl } from '../../src/web/local-web-codex-window-control.js';
import { registerCodexWindowRoutes } from '../../src/web/local-web-codex-window-http.js';
import { registerClaudeWindowRoutes } from '../../src/web/local-web-claude-window-http.js';
import { localWebError } from '../../src/web/local-web-server.js';
import { createLocalWebMetadata } from '../../src/web/local-web-metadata-store.js';
import { ordinaryWindowFixture } from '../helpers/ordinary-window-fixture.js';
import { windowDecisionPacket, windowTrialPacket } from '../helpers/ordinary-window-decision-fixture.js';

const products = ['codex', 'claude_code'] as const;
const cleanups: (() => void)[] = [];
const apps: FastifyInstance[] = [];
vi.mock('node:fs', { spy: true });
beforeEach(async () => {
  const native = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(renameSync).mockImplementation(native.renameSync);
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture(product: (typeof products)[number], authority: 'revoked' | 'expired' | 'budget_exhausted' = 'revoked') {
  const f = ordinaryWindowFixture(product);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'web-window-reconciliation-')));
  const metadata = createLocalWebMetadata(f.store, join(root, 'metadata.sqlite'));
  cleanups.push(() => {
    metadata.close();
    f.store.close();
    rmSync(root, { recursive: true, force: true });
  });
  metadata.initialize();
  f.store.execute('UPDATE projects SET local_root=? WHERE id=?', [root, 'project']);
  const codexConfiguration = {
    schema_version: 2 as const,
    mode: 'ordinary_window' as const,
    product: 'codex' as const,
    product_version: f.selection.declaredVersion,
    source_roots: [join(root, 'synthetic-source')],
    project_root: root,
    receipt_directory: join(root, '.harness-delta/window-receipts')
  };
  metadata.insertTask({
    id: f.taskId,
    name: 'Synthetic window',
    profileId: product === 'codex' ? 'ordinary-codex-window-v1' : 'ordinary-claude-window-v1',
    projectId: 'project',
    setup: {
      schema_version: 1,
      kind: product === 'codex' ? 'codex_window_setup' : 'claude_window_setup',
      selection_hash: ordinaryWindowSelectionHash(f.selection),
      configuration:
        product === 'codex'
          ? codexConfiguration
          : {
              product_version: f.selection.declaredVersion,
              project_root: root,
              receipt_directory: join(root, '.harness-delta/claude-window-receipts'),
              claude_projects_directory: join(root, 'synthetic-source')
            }
    }
  });
  const codex = createCodexWindowControl(f.store, metadata, { windowConfiguration: () => codexConfiguration });
  const claude = createClaudeWindowControl(f.store, metadata);
  const control = product === 'codex' ? codex : claude;
  const connect = (receipt: string) =>
    product === 'codex'
      ? codex.connect(f.taskId, { project_id: 'project', product: 'codex', receipt })
      : claude.connect(f.taskId, { project_id: 'project', product: 'claude_code', receipt });
  f.life.start(f.taskId);
  if (authority === 'revoked') f.activate();
  else activateOrdinaryWindowDecision(f.store, windowTrialPacket(f.selection), f.clock());
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(f.clock()));
  publishOrdinaryWindowEmissionControl(f.store, windowDecisionPacket(f.selection), f.clock());
  switch (authority) {
    case 'revoked':
      f.store.execute("UPDATE ordinary_window_activations SET revoked_at=?,revocation_reason='operator_revoked'", [f.clock()]);
      break;
    case 'expired':
      vi.setSystemTime(Date.parse(f.clock()) + 60000);
      break;
    case 'budget_exhausted':
      f.store.execute('UPDATE ordinary_window_activations SET trial_tokens_consumed=trial_token_limit', []);
      break;
  }
  const http = () => {
    const app = Fastify();
    apps.push(app);
    app.setErrorHandler((error, _request, reply) => reply.code(400).send({ error: localWebError(error) }));
    const options = {
      csrf: 'synthetic-csrf',
      mutation: async <T>(request: { body: unknown }, parse: (input: unknown) => T, execute: (input: T) => Promise<unknown>) => ({
        status: 200,
        result: await execute(parse(request.body))
      }),
      errorCode: localWebError
    };
    if (product === 'codex') registerCodexWindowRoutes(app, codex, options);
    else registerClaudeWindowRoutes(app, claude, options);
    return { app, path: `/api/tasks/${f.taskId}/${product === 'codex' ? 'codex' : 'claude'}-window` };
  };
  return { ...f, control, connect, metadata, http, emission: () => readOrdinaryWindowControl(root, product) };
}

test.each(products)('%s task status repairs stale emission after its read transaction', product => {
  const f = fixture(product);

  const status = f.control.task(f.taskId);

  expect(status).toMatchObject({ task_id: f.taskId, connection_enabled: false, reason: 'binding_window_activation_required' });
  expect(f.emission()?.state).toBe('inactive');
});

test.each(products)('%s authorization failure retains its error and repairs stale emission', async product => {
  const f = fixture(product);

  await expect(f.connect('00000000-0000-4000-8000-000000000001')).rejects.toThrow('binding_window_activation_required');

  expect(f.emission()?.state).toBe('inactive');
  expect(f.store.all('SELECT * FROM sessions')).toEqual([]);
});

test.each(products)('%s connect parse rejection still repairs stale emission', async product => {
  const f = fixture(product);

  await expect(f.connect('invalid')).rejects.toBeInstanceOf(ZodError);

  expect(f.emission()?.state).toBe('inactive');
});

test.each(products)('%s action rollback keeps the scope error and reconciles outside the transaction', async product => {
  const f = fixture(product);

  await expect(f.control.action(f.taskId, { project_id: 'other-project', operation: 'pause' })).rejects.toThrow('binding_scope_mismatch');

  expect(f.life.state(f.taskId)).toBe('active');
  expect(f.emission()?.state).toBe('inactive');
});

test.each(products)('%s prepare parse rejection reconciles the project without creating a task', product => {
  const f = fixture(product);

  expect(() => f.control.prepare('project', { name: '', criterion_ids: [] })).toThrow(ZodError);

  expect(f.emission()?.state).toBe('inactive');
  expect(f.store.all('SELECT id FROM tasks')).toEqual([{ id: f.taskId }]);
});

test.each(products)('%s replay parse rejection still repairs stale emission', product => {
  const f = fixture(product);

  expect(() => f.control.validateReplay(f.taskId, {})).toThrow(ZodError);

  expect(f.emission()?.state).toBe('inactive');
});

test.each(products)('%s failed task status repairs stale emission without requiring web metadata', product => {
  const f = fixture(product);
  f.metadata.database.prepare('DELETE FROM web_tasks WHERE id=?').run(f.taskId);

  expect(() => f.control.task(f.taskId)).toThrow('ordinary_preparation_required');

  expect(f.emission()?.state).toBe('inactive');
});

test.each(products)('%s nested task read skips publication until a subsequent outer boundary', product => {
  const f = fixture(product);

  f.store.immediateTransaction(() => {
    expect(f.control.task(f.taskId).connection_enabled).toBe(false);
    expect(f.emission()?.state).toBe('active');
  });
  expect(f.emission()?.state).toBe('active');
  f.control.task(f.taskId);

  expect(f.emission()?.state).toBe('inactive');
});

test.each(products.flatMap(product => ['query', 'body'].map(rejection => ({ product, rejection }))))(
  '$product HTTP $rejection rejection repairs before returning the original transport error',
  async ({ product, rejection }) => {
    const f = fixture(product);
    const { app, path } = f.http();

    const response =
      rejection === 'query'
        ? await app.inject({ url: `${path}-v1?unexpected=true` })
        : await app.inject({ method: 'POST', url: `${path}-connect-v1`, payload: {} });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'local_operation_failed' });
    expect(f.emission()?.state).toBe('inactive');
    expect(f.store.all('SELECT * FROM sessions')).toEqual([]);
  }
);

test.each(products)('%s HTTP status attempts a failing repair only once across nested control calls', async product => {
  const f = fixture(product);
  const { app, path } = f.http();
  vi.mocked(renameSync).mockClear();
  vi.mocked(renameSync).mockImplementation(() => {
    throw new Error('synthetic_control_write_failure');
  });

  const response = await app.inject({ url: `${path}-v1` });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ task: { connection_enabled: false, reason: 'binding_window_activation_required' } });
  expect(vi.mocked(renameSync)).toHaveBeenCalledTimes(1);
  expect(f.emission()?.state).toBe('active');
});

test.each(products.flatMap(product => (['expired', 'budget_exhausted'] as const).map(ending => ({ product, ending }))))(
  '$product HTTP status closes $ending emission without changing database rows',
  async ({ product, ending }) => {
    const f = fixture(product, ending);
    const { app, path } = f.http();
    const snapshot = () =>
      f.store
        .all<{ name: string }>("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
        .map(row => ({ name: row.name, rows: f.store.all(`SELECT * FROM "${row.name}"`) }));
    const before = snapshot();

    const response = await app.inject({ url: `${path}-v1` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ task: { connection_enabled: false, reason: `binding_window_trial_${ending}` } });
    expect(f.emission()?.state).toBe('inactive');
    expect(snapshot()).toEqual(before);
  }
);
