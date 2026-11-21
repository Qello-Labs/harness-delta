import { renameSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { activateOrdinaryWindowDecision } from '../src/core/ordinary-window-activation.js';
import { revokeOrdinaryWindowDecision } from '../src/core/ordinary-window-store.js';
import { readOrdinaryWindowControl } from '../src/core/ordinary-window-control.js';
import { publishOrdinaryWindowEmissionControl } from '../src/ordinary-window-emission.js';
import { createClaudeWindowFixture } from './helpers/claude-window-fixture.js';
import { createCodexWindowProviderFixture } from './helpers/codex-window-provider-fixture.js';
import { windowRevocationPacket, windowTrialPacket } from './helpers/ordinary-window-decision-fixture.js';

vi.mock('node:fs', { spy: true });
beforeEach(async () => {
  const native = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(renameSync).mockImplementation(native.renameSync);
});
const products = ['codex', 'claude_code'] as const;
const totals = { codex: 120, claude_code: 26 } as const;
const fixtures: { cleanup: () => void }[] = [];
async function fixture(product: (typeof products)[number], tokenLimit = 32_000) {
  const f = product === 'codex' ? await createCodexWindowProviderFixture({ activate: false }) : createClaudeWindowFixture();
  fixtures.push(f);
  f.life.start(f.taskId);
  activateOrdinaryWindowDecision(f.store, windowTrialPacket(f.selection, { nativeRootId: f.nativeSessionId, tokenLimit }), f.clock());
  publishOrdinaryWindowEmissionControl(f.store, windowTrialPacket(f.selection), f.clock());
  vi.setSystemTime(new Date(f.clock()));
  return {
    ...f,
    control: () => readOrdinaryWindowControl(f.projectRoot, product),
    decision: () =>
      f.store.get<{ revoked_at: string | null; revocation_reason: string | null }>('SELECT revoked_at,revocation_reason FROM ordinary_window_activations'),
    appendUsage: () => {
      if ('appendResponse' in f) f.appendResponse('synthetic-request');
      else f.append([f.assistant('synthetic-request')]);
    }
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const f of fixtures.splice(0)) f.cleanup();
});

const cases = products.flatMap(product =>
  (['connect', 'collect'] as const).flatMap(phase =>
    (['trial_failed', 'trial_expired', 'trial_budget_exhausted'] as const).map(reason => ({ product, phase, reason }))
  )
);
test.each(cases)('$product $phase $reason closes active emission after termination', async ({ product, phase, reason }) => {
  const f = await fixture(product, reason === 'trial_budget_exhausted' ? 1 : 32_000);
  expect(f.control()?.state).toBe('active');
  if (phase === 'collect') await f.connect();
  switch (reason) {
    case 'trial_failed':
      writeFileSync(f.sourcePath, '{}\n');
      break;
    case 'trial_expired':
      f.advance(60_000);
      break;
    case 'trial_budget_exhausted':
      f.appendUsage();
      break;
  }
  vi.setSystemTime(new Date(f.clock()));
  await expect(phase === 'connect' ? f.connect() : f.collect()).rejects.toThrow();
  expect(f.decision()).toEqual({ revoked_at: f.clock(), revocation_reason: reason });
  expect(f.control()?.state).toBe('inactive');
});

test.each(products)('%s exact-limit commit closes emission without losing accepted usage', async product => {
  const f = await fixture(product, totals[product]);
  await f.connect();
  f.advance();
  f.appendUsage();
  vi.setSystemTime(new Date(f.clock()));
  await f.collect();
  expect(f.decision()).toEqual({ revoked_at: f.clock(), revocation_reason: 'trial_budget_exhausted' });
  expect(f.store.eventCount()).toBe(1);
  expect(f.control()?.state).toBe('inactive');
});

test.each(products)('%s exact-limit control failure is reported after usage and revocation commit', async product => {
  const f = await fixture(product, totals[product]);
  await f.connect();
  f.advance();
  f.appendUsage();
  vi.setSystemTime(new Date(f.clock()));
  vi.mocked(renameSync).mockImplementation(() => {
    throw new Error('synthetic_control_write_failure');
  });
  await expect(f.collect()).rejects.toThrow('binding_window_control_unavailable');
  expect(f.decision()).toEqual({ revoked_at: f.clock(), revocation_reason: 'trial_budget_exhausted' });
  expect(f.store.eventCount()).toBe(1);
  expect(f.control()?.state).toBe('active');
});

test.each(products)('%s preserves an original connect error when termination publication also fails', async product => {
  const f = await fixture(product);
  f.advance(60_000);
  vi.setSystemTime(new Date(f.clock()));
  vi.mocked(renameSync).mockImplementation(() => {
    throw new Error('synthetic_control_write_failure');
  });
  await expect(f.connect()).rejects.toThrow('binding_window_trial_expired');
  expect(f.decision()?.revocation_reason).toBe('trial_expired');
  expect(f.control()?.state).toBe('active');
});

test.each(products)('%s preserves an original collect error when termination publication also fails', async product => {
  const f = await fixture(product, 1);
  await f.connect();
  f.appendUsage();
  vi.mocked(renameSync).mockImplementation(() => {
    throw new Error('synthetic_control_write_failure');
  });
  await expect(f.collect()).rejects.toThrow('binding_window_trial_budget_exhausted');
  expect(f.decision()?.revocation_reason).toBe('trial_budget_exhausted');
  expect(f.store.eventCount()).toBe(0);
  expect(f.control()?.state).toBe('active');
});

test.each(products)('%s direct revoke publishes inactive after explicit active publication', async product => {
  const f = await fixture(product);
  expect(f.control()?.state).toBe('active');
  revokeOrdinaryWindowDecision(f.store, windowRevocationPacket(f.selection), f.clock());
  expect(f.decision()?.revocation_reason).toBe('operator_revoked');
  expect(f.control()?.state).toBe('inactive');
});

test.each(products)('%s idempotent revoke repairs a previously reported control write failure', async product => {
  const f = await fixture(product);
  const native = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(renameSync).mockImplementation(() => {
    throw new Error('synthetic_control_write_failure');
  });
  expect(() => revokeOrdinaryWindowDecision(f.store, windowRevocationPacket(f.selection), f.clock())).toThrow('binding_window_control_unavailable');
  expect(f.decision()).toEqual({ revoked_at: f.clock(), revocation_reason: 'operator_revoked' });
  vi.mocked(renameSync).mockImplementation(native.renameSync);

  revokeOrdinaryWindowDecision(f.store, windowRevocationPacket(f.selection), f.clock());

  expect(f.control()?.state).toBe('inactive');
  expect(f.decision()).toEqual({ revoked_at: f.clock(), revocation_reason: 'operator_revoked' });
});
