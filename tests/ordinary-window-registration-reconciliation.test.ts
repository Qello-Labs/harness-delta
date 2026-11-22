import { mkdtempSync, openSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { main } from '../src/cli.js';
import { Lifecycle } from '../src/core/lifecycle.js';
import { Store } from '../src/store.js';
import { createLocalWebDomain } from '../src/web/local-web-domain.js';
import { projectBaseline } from '../src/web/local-web-native.js';
import { publishOrdinaryWindowEmissionControl } from '../src/core/ordinary-window-activation.js';
import { readOrdinaryWindowControl, writeOrdinaryWindowControl } from '../src/core/ordinary-window-control.js';
import { ordinaryWindowPolicies } from '../src/core/ordinary-window-policy.js';
import { Deletion } from '../src/deletion.js';
import { ordinaryWindowFixture } from './helpers/ordinary-window-fixture.js';
import { windowDecisionPacket } from './helpers/ordinary-window-decision-fixture.js';

vi.mock('node:fs', { spy: true });
vi.mock('../src/web/local-web-native.js', { spy: true });
beforeEach(async () => {
  const native = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(renameSync).mockImplementation(native.renameSync);
  vi.mocked(projectBaseline).mockReturnValue('a'.repeat(40));
});
const products = ['codex', 'claude_code'] as const;
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function fixture(product: (typeof products)[number]) {
  const f = ordinaryWindowFixture(product);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'window-registration-reconciliation-')));
  cleanups.push(() => {
    f.store.close();
    rmSync(root, { recursive: true, force: true });
  });
  f.store.execute('UPDATE projects SET local_root=? WHERE id=?', [root, 'project']);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(f.clock()));
  f.activate();
  publishOrdinaryWindowEmissionControl(f.store, windowDecisionPacket(f.selection), f.clock());
  const cli = async (id: string, directory = root) => {
    const database = join(root, 'measurement.sqlite');
    f.store.execute('VACUUM INTO ?', [database]);
    const code = await main(['--db', database, 'project', 'add', id, '--root', directory]);
    const store = new Store(database);
    cleanups.push(() => store.close());
    return { code, store };
  };
  const web = () => {
    const domain = createLocalWebDomain({ store: f.store, metadataFile: join(root, 'metadata.sqlite') });
    cleanups.push(() => domain.close?.());
    return domain;
  };
  return { ...f, root, cli, web, emission: () => readOrdinaryWindowControl(root, product) };
}

test.each(products)('%s registration repairs a deleted project root after its failed inactive write', async product => {
  const f = fixture(product);
  const native = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(renameSync).mockImplementation(() => {
    throw new Error('synthetic_control_write_failure');
  });
  expect(() => new Deletion(f.store, f.clock).deleteProject('project')).toThrow('binding_window_control_unavailable');
  expect(f.emission()?.state).toBe('active');
  vi.mocked(renameSync).mockImplementation(native.renameSync);

  const result = await f.cli('replacement');

  expect(result.code).toBe(0);
  expect(result.store.get('SELECT id,local_root FROM projects')).toEqual({ id: 'replacement', local_root: f.root });
  expect(result.store.all('SELECT * FROM ordinary_window_activations')).toEqual([]);
  expect(result.store.get("SELECT id FROM tombstones WHERE kind='project' AND id='project'")).toEqual({ id: 'project' });
  expect(f.emission()?.state).toBe('inactive');
});

test.each(products)('%s failed CLI registration keeps its root error while repairing a live project', async product => {
  const f = fixture(product);
  f.store.execute("UPDATE ordinary_window_activations SET revoked_at=?,revocation_reason='operator_revoked'", [f.clock()]);

  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const result = await f.cli('project', join(f.root, 'absent'));

  expect(result.code).toBe(2);
  expect(stderr).toHaveBeenCalledWith('input_or_state_error\n');
  expect(result.store.get('SELECT id,local_root FROM projects')).toEqual({ id: 'project', local_root: f.root });
  expect(f.emission()?.state).toBe('inactive');
});

test.each(products)('%s registration success survives a repeated reconciliation write failure', async product => {
  const f = fixture(product);
  vi.mocked(renameSync).mockImplementation(() => {
    throw new Error('synthetic_control_write_failure');
  });
  expect(() => new Deletion(f.store, f.clock).deleteProject('project')).toThrow('binding_window_control_unavailable');

  const result = await f.cli('replacement');

  expect(result.code).toBe(0);
  expect(result.store.get('SELECT id FROM projects')).toEqual({ id: 'replacement' });
  expect(result.store.all('SELECT * FROM ordinary_window_activations')).toEqual([]);
  expect(f.emission()?.state).toBe('active');
});

test.each(products)('%s CLI registration at the same root preserves another live project recorded control', async product => {
  const f = fixture(product);
  vi.mocked(renameSync).mockClear();

  const result = await f.cli('same-root-project');

  expect(result.code).toBe(0);
  expect(result.store.all('SELECT id FROM projects ORDER BY id')).toEqual([{ id: 'project' }, { id: 'same-root-project' }]);
  expect(f.emission()?.state).toBe('active');
  expect(result.store.get('SELECT project_id,revoked_at FROM ordinary_window_activations')).toEqual({ project_id: 'project', revoked_at: null });
  expect(renameSync).not.toHaveBeenCalled();
});

test('registration repairs the other product even when the first product write keeps failing', async () => {
  const f = fixture('codex');
  const policy = ordinaryWindowPolicies.find(row => row.product === 'claude_code');
  if (!policy) throw new Error('synthetic_policy_missing');
  writeOrdinaryWindowControl({
    schemaVersion: 1,
    projectRoot: f.root,
    product: policy.product,
    policyId: policy.policyId,
    policyRevision: policy.ruleRevision,
    evidenceMode: policy.evidenceMode,
    state: 'active'
  });
  const native = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(renameSync).mockImplementation((source, target) => {
    if (String(target).includes('/window-receipts/')) throw new Error('synthetic_control_write_failure');
    native.renameSync(source, target);
  });
  expect(() => new Deletion(f.store, f.clock).deleteProject('project')).toThrow('binding_window_control_unavailable');

  const domain = f.web();
  const result = z.object({ id: z.string() }).parse(await domain.registerProject(f.root));

  expect(f.store.get('SELECT id,local_root FROM projects')).toEqual({ id: result.id, local_root: f.root });
  expect(f.store.all('SELECT * FROM ordinary_window_activations')).toEqual([]);
  expect(f.emission()?.state).toBe('active');
  expect(readOrdinaryWindowControl(f.root, 'claude_code')?.state).toBe('inactive');
});

test.each(products)('%s web existing-root return repairs stale control without changing registration', async product => {
  const f = fixture(product);
  const domain = f.web();
  f.store.execute("UPDATE ordinary_window_activations SET revoked_at=?,revocation_reason='operator_revoked'", [f.clock()]);
  const before = f.store.all('SELECT * FROM ordinary_window_activations');

  expect(await domain.registerProject(f.root)).toEqual({ id: 'project' });

  expect(f.store.all('SELECT id,local_root FROM projects')).toEqual([{ id: 'project', local_root: f.root }]);
  expect(f.store.all('SELECT * FROM ordinary_window_activations')).toEqual(before);
  expect(f.emission()?.state).toBe('inactive');
});

test.each(products)('%s web existing-root return preserves recorded control without writes', async product => {
  const f = fixture(product);
  const domain = f.web();
  vi.mocked(renameSync).mockClear();

  expect(await domain.registerProject(f.root)).toEqual({ id: 'project' });

  expect(f.store.all('SELECT id FROM projects')).toEqual([{ id: 'project' }]);
  expect(f.emission()?.state).toBe('active');
  expect(renameSync).not.toHaveBeenCalled();
});

test.each(products)('%s web baseline failure keeps its error while repairing a resolvable project', product => {
  const f = fixture(product);
  const domain = f.web();
  f.store.execute("UPDATE ordinary_window_activations SET revoked_at=?,revocation_reason='operator_revoked'", [f.clock()]);
  const before = f.store.all('SELECT * FROM ordinary_window_activations');
  vi.mocked(projectBaseline).mockImplementationOnce(() => {
    throw new Error('git_baseline_unavailable');
  });

  expect(() => domain.registerProject(f.root)).toThrow('git_baseline_unavailable');

  expect(f.store.all('SELECT id FROM projects')).toEqual([{ id: 'project' }]);
  expect(f.store.all('SELECT * FROM ordinary_window_activations')).toEqual(before);
  expect(f.emission()?.state).toBe('inactive');
});

test.each(products)('%s failed web re-registration repairs its explicit root without restoring deleted metadata', product => {
  const f = fixture(product);
  vi.mocked(renameSync).mockImplementationOnce(() => {
    throw new Error('synthetic_control_write_failure');
  });
  expect(() => new Deletion(f.store, f.clock).deleteProject('project')).toThrow('binding_window_control_unavailable');
  const domain = f.web();
  vi.mocked(projectBaseline).mockImplementationOnce(() => {
    throw new Error('git_baseline_unavailable');
  });

  expect(() => domain.registerProject(f.root)).toThrow('git_baseline_unavailable');

  expect(f.store.all('SELECT * FROM projects')).toEqual([]);
  expect(f.store.all('SELECT * FROM ordinary_window_activations')).toEqual([]);
  expect(f.emission()?.state).toBe('inactive');
});

test.each(products)('%s rejected CLI re-registration repairs its explicit root and preserves the deletion fence', async product => {
  const f = fixture(product);
  vi.mocked(renameSync).mockImplementationOnce(() => {
    throw new Error('synthetic_control_write_failure');
  });
  expect(() => new Deletion(f.store, f.clock).deleteProject('project')).toThrow('binding_window_control_unavailable');
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

  const result = await f.cli('project');

  expect(result.code).toBe(2);
  expect(stderr).toHaveBeenCalledWith('deleted_identifier\n');
  expect(result.store.all('SELECT * FROM projects')).toEqual([]);
  expect(result.store.get("SELECT id FROM tombstones WHERE kind='project'")).toEqual({ id: 'project' });
  expect(f.emission()?.state).toBe('inactive');
});

test.each(products.flatMap(product => [false, true].map(fresh => ({ product, fresh }))))(
  '$product internal registration stays inert with fresh Store=$fresh',
  ({ product, fresh }) => {
    const f = fixture(product);
    f.store.execute("UPDATE ordinary_window_activations SET revoked_at=?,revocation_reason='operator_revoked'", [f.clock()]);
    const store = fresh ? new Store(':memory:', f.clock) : f.store;
    if (fresh) cleanups.push(() => store.close());
    const life = new Lifecycle(store, f.clock);
    vi.mocked(openSync).mockClear();
    vi.mocked(renameSync).mockClear();

    life.registerProject('internal', f.root);

    expect(store.get('SELECT id,local_root FROM projects WHERE id=?', ['internal'])).toEqual({ id: 'internal', local_root: f.root });
    expect(openSync).not.toHaveBeenCalled();
    expect(renameSync).not.toHaveBeenCalled();
    expect(f.emission()?.state).toBe('active');
  }
);
