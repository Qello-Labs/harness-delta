import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, expect, test, vi } from 'vitest';
import { registerOrdinaryWindowActivationCommands } from '../../src/cli/ordinary-window-activation-cli.js';
import { activateOrdinaryWindowDecision } from '../../src/core/ordinary-window-activation.js';
import { readOrdinaryWindowControl } from '../../src/core/ordinary-window-control.js';
import { publishOrdinaryWindowEmissionControl } from '../../src/ordinary-window-emission.js';
import { ordinaryWindowFixture } from '../helpers/ordinary-window-fixture.js';
import { windowTrialPacket } from '../helpers/ordinary-window-decision-fixture.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

test.each((['codex', 'claude_code'] as const).flatMap(product => (['expired', 'budget_exhausted'] as const).map(ending => ({ product, ending }))))(
  '$product status closes $ending trial emission without changing any database row',
  async ({ product, ending }) => {
    const f = ordinaryWindowFixture(product);
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'window-expiry-status-')));
    cleanups.push(() => {
      f.store.close();
      rmSync(root, { recursive: true, force: true });
    });
    f.store.execute('UPDATE projects SET local_root=?', [root]);
    f.life.start(f.taskId);
    activateOrdinaryWindowDecision(f.store, windowTrialPacket(f.selection), f.clock());
    publishOrdinaryWindowEmissionControl(f.store, windowTrialPacket(f.selection), f.clock());
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.parse(f.clock()) + (ending === 'expired' ? 60000 : 0)));
    if (ending === 'budget_exhausted') f.store.execute('UPDATE ordinary_window_activations SET trial_tokens_consumed=trial_token_limit', []);
    const snapshot = () =>
      f.store
        .all<{ name: string }>("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
        .map(row => ({ name: row.name, rows: f.store.all(`SELECT * FROM "${row.name}"`) }));
    const before = snapshot();
    const results: unknown[] = [];
    const command = new Command('window');
    registerOrdinaryWindowActivationCommands(
      command,
      () => f.store,
      result => results.push(result)
    );

    await command.parseAsync(['node', 'window', 'status', f.taskId, '--decision']);

    expect(results[0]).toMatchObject({ state: ending, emission_control_stale: false, decision: { revoked_at: null }, runtime_authority: false });
    expect(readOrdinaryWindowControl(root, product)?.state).toBe('inactive');
    expect(snapshot()).toEqual(before);
  }
);
