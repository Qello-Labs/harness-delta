import { mkdtempSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { registerOrdinaryWindowActivationCommands } from '../src/cli/ordinary-window-activation-cli.js';
import { activateOrdinaryWindowDecision, ordinaryWindowDecisionStatus } from '../src/core/ordinary-window-activation.js';
import { isCurrentOrdinaryWindowArming, readOrdinaryWindowControl, writeOrdinaryWindowControl } from '../src/core/ordinary-window-control.js';
import { ordinaryWindowDecisionKeyForSelection } from '../src/core/ordinary-window-decision.js';
import { createOrdinaryWindowTask, revokeOrdinaryObservation } from '../src/ordinary-observation.js';
import { ordinaryWindowEmissionControlStale, publishOrdinaryWindowEmissionControl } from '../src/ordinary-window-emission.js';
import { ordinaryWindowFixture } from './helpers/ordinary-window-fixture.js';
import { windowDecisionPacket, windowTrialPacket } from './helpers/ordinary-window-decision-fixture.js';

vi.mock('node:fs', { spy: true });
const products = ['codex', 'claude_code'] as const;
const paths = ['pause', 'finalize', 'revoke'] as const;
const cleanups: (() => void)[] = [];
beforeEach(async () => {
  const native = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(renameSync).mockImplementation(native.renameSync);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture(product: (typeof products)[number], trial = false, activate = true) {
  const f = ordinaryWindowFixture(product);
  const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'window-lifecycle-')));
  cleanups.push(() => {
    f.store.close();
    rmSync(projectRoot, { recursive: true, force: true });
  });
  f.store.execute('UPDATE projects SET local_root=? WHERE id=?', [projectRoot, 'project']);
  vi.setSystemTime(new Date(f.clock()));
  f.life.start(f.taskId);
  const key = ordinaryWindowDecisionKeyForSelection(f.selection);
  if (activate) activateOrdinaryWindowDecision(f.store, trial ? windowTrialPacket(f.selection) : windowDecisionPacket(f.selection), f.clock());
  publishOrdinaryWindowEmissionControl(f.store, key, f.clock());
  const transition = (path: (typeof paths)[number]) => {
    switch (path) {
      case 'pause':
        return f.life.pause(f.taskId);
      case 'finalize':
        return f.life.finalize(f.taskId, 'aborted', []);
      case 'revoke':
        return revokeOrdinaryObservation(f.store, f.taskId, f.clock);
    }
  };
  const addTask = () =>
    createOrdinaryWindowTask(
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
  return { ...f, key, projectRoot, transition, addTask, control: () => readOrdinaryWindowControl(projectRoot, product) };
}

const cases = products.flatMap(product => paths.map(path => ({ product, path })));
test.each(cases)('$product $path closes emission without revoking the decision', ({ product, path }) => {
  const f = fixture(product);

  f.transition(path);

  expect(f.control()?.state).toBe('inactive');
  expect(ordinaryWindowDecisionStatus(f.store, f.key, f.clock()).state).toBe('recorded');
});

test.each(products)('%s resume reopens emission for a recorded decision', product => {
  const f = fixture(product);
  f.life.pause(f.taskId);
  expect(f.control()?.state).toBe('inactive');

  f.life.resume(f.taskId);

  expect(f.control()?.state).toBe('active');
});

test.each(cases)('$product $path waits for the outer commit and discards rollback publication', ({ product, path }) => {
  const f = fixture(product);
  expect(() =>
    f.store.transaction(() => {
      f.transition(path);
      expect(f.control()?.state).toBe('active');
      throw new Error('synthetic_rollback');
    })
  ).toThrow('synthetic_rollback');
  expect(f.life.state(f.taskId)).toBe('active');
  expect(f.control()?.state).toBe('active');

  f.store.transaction(() => {
    f.transition(path);
    expect(f.control()?.state).toBe('active');
  });

  expect(f.control()?.state).toBe('inactive');
});

test.each(products)('%s another prepared registered task keeps shared product emission active', product => {
  const f = fixture(product);
  const survivor = f.addTask();

  f.life.pause(f.taskId);
  expect(f.control()?.state).toBe('active');
  f.life.finalize(survivor, 'aborted', []);

  expect(f.control()?.state).toBe('inactive');
});

test.each(products)('%s a different task cannot keep a paused trial emitting', product => {
  const f = fixture(product, true);
  f.addTask();

  f.life.pause(f.taskId);

  expect(f.control()?.state).toBe('inactive');
});

test.each(cases)('$product failed $path publication preserves committed state and repairs on the next touch', async ({ product, path }) => {
  const f = fixture(product);
  vi.mocked(renameSync).mockImplementation(() => {
    throw new Error('synthetic_control_write_failure');
  });

  expect(() => f.transition(path)).toThrow('binding_window_control_unavailable');

  expect(f.life.state(f.taskId)).toBe(path === 'pause' ? 'paused' : path === 'finalize' ? 'finalized' : 'active');
  expect(f.store.get('SELECT revoked_at FROM ordinary_tasks WHERE task_id=?', [f.taskId])).toEqual({ revoked_at: path === 'revoke' ? f.clock() : null });
  expect(ordinaryWindowDecisionStatus(f.store, f.key, f.clock()).state).toBe('recorded');
  expect(f.control()?.state).toBe('active');
  expect(ordinaryWindowEmissionControlStale(f.store, { taskId: f.taskId, clock: f.clock })).toBe(true);
  const native = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(renameSync).mockImplementation(native.renameSync);

  const results: unknown[] = [];
  const program = new Command('window');
  registerOrdinaryWindowActivationCommands(
    program,
    () => f.store,
    result => results.push(result)
  );
  await program.parseAsync(['node', 'window', 'status', f.taskId, '--decision']);

  expect(results).toEqual([expect.objectContaining({ state: 'recorded', emission_control_stale: false, runtime_authority: false })]);
  expect(f.control()?.state).toBe('inactive');
  expect(ordinaryWindowEmissionControlStale(f.store, { taskId: f.taskId, clock: f.clock })).toBe(false);
});

test.each(products)('%s queued pause publication rechecks a newer resumed task', async product => {
  const f = fixture(product);
  const native = await vi.importActual<typeof import('node:fs')>('node:fs');
  const states: (string | undefined)[] = [];
  vi.mocked(renameSync).mockImplementation((from, to) => {
    native.renameSync(from, to);
    states.push(f.control()?.state);
  });

  f.store.transaction(() => {
    f.store.afterCommit(() => f.life.resume(f.taskId));
    f.life.pause(f.taskId);
  });

  expect(states).toEqual(['active', 'active']);
  expect(f.life.state(f.taskId)).toBe('active');
  expect(f.control()?.state).toBe('active');
});

test.each(cases)('$product $path publication preserves valid surviving-task receipt_only arming', ({ product, path }) => {
  const f = fixture(product, false, false);
  const survivor = f.addTask();
  f.life.start(survivor);
  const base = f.control();
  if (!base) throw new Error('synthetic_control_missing');
  const control = {
    ...base,
    state: 'receipt_only',
    arming: {
      projectId: 'project',
      taskId: survivor,
      generation: f.life.task(survivor).generation,
      policyDigest: f.selection.policyDigest,
      armedAt: f.clock(),
      expiresAt: new Date(Date.parse(f.clock()) + 60_000).toISOString()
    }
  } as const;
  writeOrdinaryWindowControl(control);
  expect(isCurrentOrdinaryWindowArming(f.store, control, Date.parse(f.clock()))).toBe(true);

  f.transition(path);

  expect(f.control()).toEqual(control);
  expect(isCurrentOrdinaryWindowArming(f.store, control, Date.parse(f.clock()))).toBe(true);
});

const invalidPreparations = [
  ["UPDATE ordinary_tasks SET settings_hash='invalid' WHERE task_id=?", 'settings hash'],
  ["UPDATE ordinary_tasks SET settings='{}' WHERE task_id=?", 'settings bytes'],
  ["UPDATE tasks SET metadata=json_set(metadata,'$.product','other-product') WHERE id=?", 'task product'],
  ["INSERT INTO tombstones(kind,id,deleted_at) VALUES ('task',?,'2026-11-06T01:00:00.000Z')", 'task tombstone'],
  ["INSERT INTO tombstones(kind,id,deleted_at) SELECT 'project',project_id,'2026-11-06T01:00:00.000Z' FROM tasks WHERE id=?", 'project tombstone'],
  ['DELETE FROM ordinary_tasks WHERE task_id=?', 'missing preparation']
] as const;
test.each(products.flatMap(product => invalidPreparations.map(([sql, invalid]) => ({ product, sql, invalid }))))(
  '$product publisher closes emission for $invalid',
  ({ product, sql }) => {
    const f = fixture(product);
    f.store.execute(sql, [f.taskId]);

    publishOrdinaryWindowEmissionControl(f.store, f.key, f.clock());

    expect(f.control()?.state).toBe('inactive');
  }
);
