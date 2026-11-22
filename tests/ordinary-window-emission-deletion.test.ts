import { mkdtempSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { activateOrdinaryWindowDecision } from '../src/core/ordinary-window-activation.js';
import { readOrdinaryWindowControl } from '../src/core/ordinary-window-control.js';
import { ordinaryWindowSelection } from '../src/core/ordinary-window-store.js';
import { Deletion } from '../src/deletion.js';
import { createOrdinaryWindowTask } from '../src/ordinary-observation.js';
import { publishOrdinaryWindowEmissionControl, withOrdinaryWindowReconciliation } from '../src/ordinary-window-emission.js';
import { ordinaryWindowFixture } from './helpers/ordinary-window-fixture.js';
import { windowDecisionPacket, windowTrialPacket } from './helpers/ordinary-window-decision-fixture.js';

vi.mock('node:fs', { spy: true });
beforeEach(async () => {
  const native = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(renameSync).mockImplementation(native.renameSync);
  vi.clearAllMocks();
});
const products = ['codex', 'claude_code'] as const;
const operations = ['task', 'project', 'retention'] as const;
const cases = products.flatMap(product => operations.map(operation => ({ product, operation })));
const cleanups: (() => void)[] = [];
function fixture(product: (typeof products)[number], kind: 'trial' | 'product' = 'trial', publish = true) {
  const f = ordinaryWindowFixture(product);
  const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'window-deletion-')));
  cleanups.push(() => {
    f.store.close();
    rmSync(projectRoot, { recursive: true, force: true });
  });
  f.store.execute('UPDATE projects SET local_root=? WHERE id=?', [projectRoot, 'project']);
  vi.setSystemTime(new Date(f.clock()));
  const packet = kind === 'trial' ? windowTrialPacket(f.selection) : windowDecisionPacket(f.selection);
  activateOrdinaryWindowDecision(f.store, packet, f.clock());
  if (publish) publishOrdinaryWindowEmissionControl(f.store, packet, f.clock());
  const deletion = new Deletion(f.store, f.clock);
  const prepare = (operation: (typeof operations)[number]) => {
    if (operation === 'retention') {
      f.life.finalize(f.taskId, 'aborted', []);
      deletion.configureRetention('project', 1);
    }
  };
  return {
    ...f,
    projectRoot,
    deletion,
    prepare,
    control: () => readOrdinaryWindowControl(projectRoot, product),
    remove: (operation: (typeof operations)[number]) => {
      switch (operation) {
        case 'task':
          return deletion.deleteTask(f.taskId);
        case 'project':
          return deletion.deleteProject('project');
        case 'retention':
          return deletion.applyRetention('project', '2026-11-08T01:00:00.000Z');
      }
    }
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

test.each(cases)('$product $operation deletion closes a cascaded trial decision', ({ product, operation }) => {
  const f = fixture(product);
  expect(f.control()?.state).toBe('active');
  f.prepare(operation);
  if (operation === 'retention') expect(f.control()?.state).toBe('inactive');

  const deleted = f.remove(operation);

  if (operation === 'retention') expect(deleted).toBe(1);
  expect(f.store.all('SELECT * FROM ordinary_window_activations')).toEqual([]);
  expect(f.deletion.isDeleted('task', f.taskId)).toBe(true);
  expect(f.control()?.state).toBe('inactive');
});

test.each(products)('%s final task deletion reports a committed publication failure for a surviving product decision', async product => {
  const f = fixture(product, 'product');
  vi.mocked(renameSync).mockImplementation(() => {
    throw new Error('synthetic_control_write_failure');
  });

  expect(() => f.deletion.deleteTask(f.taskId)).toThrow('binding_window_control_unavailable');

  expect(f.store.get('SELECT decision_kind,revoked_at FROM ordinary_window_activations')).toEqual({ decision_kind: 'product', revoked_at: null });
  expect(f.deletion.isDeleted('task', f.taskId)).toBe(true);
  expect(f.control()?.state).toBe('active');
  const native = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(renameSync).mockImplementation(native.renameSync);

  withOrdinaryWindowReconciliation(f.store, { projectId: 'project', product, clock: f.clock }, () => undefined);

  expect(f.control()?.state).toBe('inactive');
});

test.each(products)('%s project deletion closes a product decision with no remaining tasks', product => {
  const f = fixture(product, 'product');
  f.deletion.deleteTask(f.taskId);
  expect(f.store.all('SELECT id FROM tasks')).toEqual([]);

  f.deletion.deleteProject('project');

  expect(f.store.all('SELECT * FROM ordinary_window_activations')).toEqual([]);
  expect(f.control()?.state).toBe('inactive');
});

test('project deletion closes both products when their product decisions have no tasks', () => {
  const f = fixture('codex', 'product');
  const second = ordinaryWindowFixture('claude_code');
  try {
    const packet = windowDecisionPacket(second.selection);
    activateOrdinaryWindowDecision(f.store, packet, f.clock());
    publishOrdinaryWindowEmissionControl(f.store, packet, f.clock());
  } finally {
    second.store.close();
  }
  f.deletion.deleteTask(f.taskId);
  expect(f.store.all('SELECT id FROM tasks')).toEqual([]);

  f.deletion.deleteProject('project');

  expect(products.map(product => readOrdinaryWindowControl(f.projectRoot, product)?.state)).toEqual(['inactive', 'inactive']);
});

test.each(cases)('$product $operation nested deletion waits for the actual outer commit', ({ product, operation }) => {
  const f = fixture(product);
  vi.clearAllMocks();

  f.store.transaction(() => {
    f.prepare(operation);
    f.remove(operation);
    expect(f.control()?.state).toBe('active');
  });

  expect(f.control()?.state).toBe('inactive');
});

test.each(cases)('$product $operation rollback discards nested deletion publication', ({ product, operation }) => {
  const f = fixture(product);
  vi.clearAllMocks();

  f.store.transaction(() => {
    expect(() =>
      f.store.immediateTransaction(() => {
        f.prepare(operation);
        f.remove(operation);
        throw new Error('synthetic_rollback');
      })
    ).toThrow('synthetic_rollback');
  });

  expect(f.deletion.isDeleted('task', f.taskId)).toBe(false);
  expect(f.store.get('SELECT decision_kind,revoked_at FROM ordinary_window_activations')).toEqual({ decision_kind: 'trial', revoked_at: null });
  expect(f.control()?.state).toBe('active');
});

test.each(cases)('$product $operation control write failure reports committed deletion', ({ product, operation }) => {
  const f = fixture(product);
  vi.mocked(renameSync).mockImplementation(() => {
    throw new Error('synthetic_control_write_failure');
  });

  expect(() =>
    f.store.transaction(() => {
      f.prepare(operation);
      f.remove(operation);
    })
  ).toThrow('binding_window_control_unavailable');

  expect(f.store.all('SELECT * FROM ordinary_window_activations')).toEqual([]);
  expect(f.deletion.isDeleted('task', f.taskId)).toBe(true);
  if (operation === 'project') expect(f.deletion.isDeleted('project', 'project')).toBe(true);
  expect(f.control()?.state).toBe('active');
});

test.each(cases)('$product $operation deletion does not create an absent control', ({ product, operation }) => {
  const f = fixture(product, 'trial', false);
  f.prepare(operation);

  f.remove(operation);

  expect(f.control()).toBeNull();
});

test.each(products)('%s old deletion publication preserves a newer recorded activation', async product => {
  const f = fixture(product);
  const native = await vi.importActual<typeof import('node:fs')>('node:fs');
  const publications: (string | undefined)[] = [];
  vi.mocked(renameSync).mockImplementation((from, to) => {
    native.renameSync(from, to);
    publications.push(f.control()?.state);
  });

  f.store.transaction(() => {
    f.store.afterCommit(() => {
      const taskId = createOrdinaryWindowTask(
        f.store,
        {
          schema_version: 2,
          mode: 'ordinary_window',
          project_id: 'project',
          product,
          declared_version: f.selection.declaredVersion,
          policy_id: f.selection.policy.policyId,
          criterion_ids: ['accepted']
        },
        f.clock
      );
      const selection = ordinaryWindowSelection(f.store, taskId);
      if (!selection) throw new Error('synthetic_selection_missing');
      const packet = { ...windowTrialPacket(selection), decision_ref: 'newer-decision' };
      activateOrdinaryWindowDecision(f.store, packet, f.clock());
      publishOrdinaryWindowEmissionControl(f.store, packet, f.clock());
    });
    f.deletion.deleteTask(f.taskId);
  });

  expect(f.store.get('SELECT decision_ref,revoked_at FROM ordinary_window_activations')).toEqual({ decision_ref: 'newer-decision', revoked_at: null });
  expect(publications).not.toContain('inactive');
  expect(f.control()?.state).toBe('active');
});
