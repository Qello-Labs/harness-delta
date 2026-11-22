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
