import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, openSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { publishOrdinaryWindowEmissionControl } from '../src/core/ordinary-window-activation.js';
import { readOrdinaryWindowControl, writeOrdinaryWindowControl } from '../src/core/ordinary-window-control.js';
import { Deletion } from '../src/deletion.js';
import { createLocalWebDomain } from '../src/web/local-web-domain.js';
import { projectBaseline } from '../src/web/local-web-native.js';
import { createLocalWebServer } from '../src/web/local-web-server.js';
import { ordinaryWindowFixture } from './helpers/ordinary-window-fixture.js';
import { windowDecisionPacket } from './helpers/ordinary-window-decision-fixture.js';

const products = ['codex', 'claude_code'] as const;
const cleanups: (() => Promise<void>)[] = [];
vi.mock('node:fs', { spy: true });
vi.mock('../src/web/local-web-native.js', { spy: true });
beforeEach(async () => {
  const native = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(renameSync).mockImplementation(native.renameSync);
  vi.mocked(projectBaseline).mockReturnValue('a'.repeat(40));
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function fixture(product: (typeof products)[number]) {
  const f = ordinaryWindowFixture(product);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'window-registration-http-')));
  f.store.execute('UPDATE projects SET local_root=? WHERE id=?', [root, 'project']);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(f.clock());
  f.activate();
  publishOrdinaryWindowEmissionControl(f.store, windowDecisionPacket(f.selection), f.clock());
  const active = readOrdinaryWindowControl(root, product);
  if (active?.state !== 'active') throw new Error('synthetic_control_missing');
  f.store.execute("UPDATE ordinary_window_activations SET revoked_at=?,revocation_reason='operator_revoked'", [f.clock()]);
  const domain = createLocalWebDomain({ store: f.store, metadataFile: join(root, 'domain.sqlite') });
  const app = createLocalWebServer({ origin: 'http://127.0.0.1:4327', domain, metadataFile: join(root, 'transport.sqlite') });
  cleanups.push(async () => {
    await app.close();
    await domain.close?.();
    expect(f.calls).toEqual([]);
    f.store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const bootstrap = await app.inject({ url: '/api/bootstrap', headers: { host: '127.0.0.1:4327' } });
  expect(bootstrap.statusCode, bootstrap.body).toBe(200);
  const csrf = bootstrap.json<{ csrf: string }>().csrf;
  const post = (payload: Record<string, unknown>, key: string = randomUUID(), headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/projects',
      payload,
      headers: { host: '127.0.0.1:4327', origin: 'http://127.0.0.1:4327', 'x-harness-csrf': csrf, 'idempotency-key': key, ...headers }
    });
  return {
    ...f,
    root,
    post,
    emission: () => readOrdinaryWindowControl(root, product),
    makeStale: () => writeOrdinaryWindowControl(active),
    state: () => ({
      projects: f.store.all('SELECT * FROM projects ORDER BY id'),
      tasks: f.store.all('SELECT * FROM tasks ORDER BY id'),
      decisions: f.store.all('SELECT * FROM ordinary_window_activations'),
      tombstones: f.store.all('SELECT * FROM tombstones')
    })
  };
}

test.each(products.flatMap(product => (['body', 'idempotency', 'conflict'] as const).map(rejection => ({ product, rejection }))))(
  '$product HTTP registration $rejection rejection repairs the supplied root without changing authority',
  async ({ product, rejection }) => {
    const f = await fixture(product);
    const key = randomUUID();
    if (rejection === 'conflict') {
      const other = join(f.root, 'other');
      mkdirSync(other);
      const seed = await f.post({ directory: other }, key);
      expect(seed.statusCode, seed.body).toBe(200);
    }
    const before = f.state();

    const response = await f.post({ directory: f.root, ...(rejection === 'body' ? { unexpected: true } : {}) }, rejection === 'idempotency' ? 'invalid' : key);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: rejection === 'conflict' ? 'ui_action_conflict' : 'local_operation_failed' });
    expect(f.emission()?.state).toBe('inactive');
    expect(f.state()).toEqual(before);
  }
);

test.each(products)('%s completed HTTP registration replay repairs the supplied stale control', async product => {
  const f = await fixture(product);
  const key = randomUUID();
  const first = await f.post({ directory: f.root }, key);
  expect(first.statusCode, first.body).toBe(200);
  f.makeStale();
  const before = f.state();
  vi.mocked(projectBaseline).mockClear();

  const response = await f.post({ directory: f.root }, key);

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual(first.json());
  expect(f.emission()?.state).toBe('inactive');
  expect(f.state()).toEqual(before);
  expect(projectBaseline).not.toHaveBeenCalled();
});

test.each(products)('%s deleted registration replay stays denied while repairing its explicit root', async product => {
  const f = await fixture(product);
  const key = randomUUID();
  const first = await f.post({ directory: f.root }, key);
  expect(first.statusCode, first.body).toBe(200);
  new Deletion(f.store, f.clock).deleteProject('project');
  f.makeStale();
  const before = f.state();

  const response = await f.post({ directory: f.root }, key);

  expect(response.statusCode).toBe(400);
  expect(response.json()).toEqual({ error: 'deleted_identifier' });
  expect(f.emission()?.state).toBe('inactive');
  expect(f.state()).toEqual(before);
  expect(f.store.all('SELECT * FROM projects')).toEqual([]);
});

test.each(products.flatMap(product => (['relative', 'unnormalized', 'absent', 'overlong', 'empty'] as const).map(kind => ({ product, kind }))))(
  '$product HTTP registration does not reconcile an unsafe $kind supplied root',
  async ({ product, kind }) => {
    const f = await fixture(product);
    const directory = {
      relative: relative(process.cwd(), f.root),
      unnormalized: `${f.root}/.`,
      absent: join(f.root, 'absent'),
      overlong: f.root + 'x'.repeat(4096),
      empty: ''
    }[kind];
    const before = f.state();
    vi.mocked(openSync).mockClear();
    vi.mocked(renameSync).mockClear();

    const response = await f.post({ directory });

    expect(response.statusCode).toBe(kind === 'relative' || kind === 'unnormalized' ? 200 : 400);
    expect(openSync).not.toHaveBeenCalled();
    expect(renameSync).not.toHaveBeenCalled();
    expect(f.emission()?.state).toBe('active');
    expect(f.state()).toEqual(before);
  }
);

test.each(products.flatMap(product => (['origin', 'csrf'] as const).map(gate => ({ product, gate }))))(
  '$product unauthorized HTTP registration fails the $gate gate before control I/O',
  async ({ product, gate }) => {
    const f = await fixture(product);
    const before = f.state();
    vi.mocked(openSync).mockClear();
    vi.mocked(renameSync).mockClear();

    const response = await f.post(
      { directory: f.root },
      randomUUID(),
      gate === 'origin' ? { origin: 'http://untrusted.invalid' } : { 'x-harness-csrf': 'invalid' }
    );

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: gate === 'origin' ? 'local_origin_required' : 'local_authorization_required' });
    expect(openSync).not.toHaveBeenCalled();
    expect(renameSync).not.toHaveBeenCalled();
    expect(f.emission()?.state).toBe('active');
    expect(f.state()).toEqual(before);
  }
);

test.each(products)('%s HTTP registration deduplicates a failed repair with its nested domain boundary', async product => {
  const f = await fixture(product);
  const before = f.state();
  vi.mocked(renameSync)
    .mockClear()
    .mockImplementation(() => {
      throw new Error('synthetic_control_write_failure');
    });

  const response = await f.post({ directory: f.root });

  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toEqual({ id: 'project' });
  expect(renameSync).toHaveBeenCalledTimes(1);
  expect(f.emission()?.state).toBe('active');
  expect(f.state()).toEqual(before);
});
