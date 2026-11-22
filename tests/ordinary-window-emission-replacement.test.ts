import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { publishOrdinaryWindowEmissionControl } from '../src/core/ordinary-window-activation.js';
import { readOrdinaryWindowControl } from '../src/core/ordinary-window-control.js';
import { ordinaryWindowDecisionKeyForSelection } from '../src/core/ordinary-window-decision.js';
import { createOrdinaryWindowTask } from '../src/ordinary-observation.js';
import { ordinaryWindowFixture } from './helpers/ordinary-window-fixture.js';

const products = ['codex', 'claude_code'] as const;
const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function fixture(product: (typeof products)[number]) {
  const f = ordinaryWindowFixture(product);
  const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'window-replacement-')));
  cleanups.push(() => {
    f.store.close();
    rmSync(projectRoot, { recursive: true, force: true });
  });
  f.store.execute('UPDATE projects SET local_root=? WHERE id=?', [projectRoot, 'project']);
  vi.setSystemTime(new Date(f.clock()));
  f.activate();
  publishOrdinaryWindowEmissionControl(f.store, ordinaryWindowDecisionKeyForSelection(f.selection), f.clock());
  const decisions = f.store.all('SELECT * FROM ordinary_window_activations');
  f.life.finalize(f.taskId, 'aborted', []);
  const prepare = () =>
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
  return { ...f, prepare, decisions, control: () => readOrdinaryWindowControl(projectRoot, product) };
}

test.each(products)('%s replacement preparation reopens the retained decision before its first start', product => {
  const f = fixture(product);
  expect(f.control()?.state).toBe('inactive');

  const replacement = f.prepare();

  expect(f.life.state(replacement)).toBe('registered');
  expect(f.control()?.state).toBe('active');
  f.life.start(replacement);
  expect(f.life.state(replacement)).toBe('active');
  expect(f.control()?.state).toBe('active');
  expect(f.store.all('SELECT * FROM ordinary_window_activations')).toEqual(f.decisions);
});

test.each(products.flatMap(product => [false, true].map(rollback => ({ product, rollback }))))(
  '$product replacement publication follows the outer commit with rollback=$rollback',
  ({ product, rollback }) => {
    const f = fixture(product);
    const prepare = () =>
      f.store.transaction(() => {
        const replacement = f.prepare();
        f.life.start(replacement);
        expect(f.control()?.state).toBe('inactive');
        if (rollback) throw new Error('synthetic_rollback');
      });

    if (rollback) expect(prepare).toThrow('synthetic_rollback');
    else prepare();

    expect(f.control()?.state).toBe(rollback ? 'inactive' : 'active');
    expect(f.store.all('SELECT id FROM tasks')).toHaveLength(rollback ? 1 : 2);
    expect(f.store.all('SELECT * FROM ordinary_window_activations')).toEqual(f.decisions);
  }
);
