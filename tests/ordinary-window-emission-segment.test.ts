import { renameSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ordinaryWindowDecisionStatus, publishOrdinaryWindowEmissionControl } from '../src/core/ordinary-window-activation.js';
import { readOrdinaryWindowControl } from '../src/core/ordinary-window-control.js';
import { ordinaryWindowDecisionKeyForSelection } from '../src/core/ordinary-window-decision.js';
import { pauseOrdinaryWindowSegment } from '../src/core/ordinary-window-segment.js';
import { createClaudeWindowFixture } from './helpers/claude-window-fixture.js';
import { createCodexWindowProviderFixture } from './helpers/codex-window-provider-fixture.js';

vi.mock('node:fs', { spy: true });
const products = ['codex', 'claude_code'] as const;
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
async function fixture(product: (typeof products)[number]) {
  const f = product === 'codex' ? await createCodexWindowProviderFixture({ activate: false }) : createClaudeWindowFixture();
  cleanups.push(f.cleanup);
  vi.setSystemTime(new Date(f.clock()));
  f.activate();
  f.life.start(f.taskId);
  const key = ordinaryWindowDecisionKeyForSelection(f.selection);
  publishOrdinaryWindowEmissionControl(f.store, key, f.clock());
  return { ...f, key, control: () => readOrdinaryWindowControl(f.projectRoot, product) };
}

test.each(products)('%s direct segment pause waits for commit and closes recorded emission', async product => {
  const f = await fixture(product);
  await f.connect();

  f.store.transaction(() => {
    pauseOrdinaryWindowSegment(f.store, f.taskId, f.clock(), 'binding_scope_revoked');
    expect(f.control()?.state).toBe('active');
  });

  expect(f.life.state(f.taskId)).toBe('paused');
  expect(f.control()?.state).toBe('inactive');
  expect(ordinaryWindowDecisionStatus(f.store, f.key, f.clock()).state).toBe('recorded');
});

test.each(products)('%s connect keeps its source error after a committed segment-pause publication fails', async product => {
  const f = await fixture(product);
  writeFileSync(f.sourcePath, 'SYNTHETIC_INVALID_JSON\n');
  vi.mocked(renameSync).mockImplementation(() => {
    throw new Error('synthetic_control_write_failure');
  });

  await expect(f.connect()).rejects.toThrow(product === 'codex' ? 'binding_source_unavailable' : 'binding_contract_failed');

  expect(f.life.state(f.taskId)).toBe('paused');
  expect(f.control()?.state).toBe('active');
  expect(ordinaryWindowDecisionStatus(f.store, f.key, f.clock()).state).toBe('recorded');
  expect(f.store.eventCount()).toBe(0);
});

const rejectedRoots = ['resume', 'null-source'] as const;
const reservations = [false, true].flatMap(existing => rejectedRoots.flatMap(reason => [false, true].map(failedWrite => ({ existing, reason, failedWrite }))));
test.each(reservations)(
  'Codex $reason rejection preserves its error with existing=$existing and failedWrite=$failedWrite',
  async ({ existing, reason, failedWrite }) => {
    const f = await fixture('codex');
    if (!('emitLifecycle' in f)) throw new Error('synthetic_codex_fixture_required');
    if (existing) await f.connect();
    const pending = await f.emitLifecycle(reason === 'resume' ? 'resume' : 'startup', reason === 'null-source' ? null : f.sourcePath);
    const usage = { events: f.store.all('SELECT * FROM events'), requests: f.store.all('SELECT * FROM binding_requests') };
    if (failedWrite) {
      vi.mocked(renameSync).mockImplementation(() => {
        throw new Error('synthetic_control_write_failure');
      });
    }

    await expect(f.connect(pending.receipt)).rejects.toThrow('binding_fresh_root_required');

    expect(f.life.state(f.taskId)).toBe('paused');
    expect(ordinaryWindowDecisionStatus(f.store, f.key, f.clock()).state).toBe('recorded');
    expect({ events: f.store.all('SELECT * FROM events'), requests: f.store.all('SELECT * FROM binding_requests') }).toEqual(usage);
    expect(f.control()?.state).toBe(failedWrite ? 'active' : 'inactive');
  }
);

test.each(['synthetic_transaction_failure', 'binding_window_control_unavailable'])(
  'Codex rejected reservation propagates a pre-commit %s instead of converting it',
  async failure => {
    const f = await fixture('codex');
    if (!('emitLifecycle' in f)) throw new Error('synthetic_codex_fixture_required');
    const pending = await f.emitLifecycle('resume');
    f.store.execute(
      `CREATE TRIGGER synthetic_pause_failure BEFORE UPDATE OF state ON tasks
      WHEN NEW.state='paused' BEGIN SELECT RAISE(ABORT,'${failure}'); END`,
      []
    );

    await expect(f.connect(pending.receipt)).rejects.toThrow(failure);

    expect(f.life.state(f.taskId)).toBe('active');
    expect(ordinaryWindowDecisionStatus(f.store, f.key, f.clock()).state).toBe('recorded');
    expect(f.store.eventCount()).toBe(0);
    expect(f.store.all('SELECT * FROM binding_requests')).toEqual([]);
    expect(f.control()?.state).toBe('active');
  }
);
