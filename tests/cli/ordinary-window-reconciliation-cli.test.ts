import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { Store } from '../../src/store.js';
import { activateOrdinaryWindowDecision } from '../../src/core/ordinary-window-activation.js';
import { readOrdinaryWindowControl } from '../../src/core/ordinary-window-control.js';
import { publishOrdinaryWindowEmissionControl } from '../../src/ordinary-window-emission.js';
import { ordinaryWindowFixture } from '../helpers/ordinary-window-fixture.js';
import { prepareOrdinaryWindowDecisionCliFixture } from '../helpers/ordinary-window-decision-cli-fixture.js';
import { windowDecisionPacket, windowRevocationPacket } from '../helpers/ordinary-window-decision-fixture.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture(product: 'codex' | 'claude_code') {
  const base = ordinaryWindowFixture(product);
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'window-reconciliation-cli-')));
  cleanups.push(() => {
    base.store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const f = prepareOrdinaryWindowDecisionCliFixture(base, directory);
  const store = new Store(f.database);
  try {
    activateOrdinaryWindowDecision(store, windowDecisionPacket(f.selection), f.clock());
    publishOrdinaryWindowEmissionControl(store, windowDecisionPacket(f.selection), f.clock());
    store.execute("UPDATE ordinary_window_activations SET revoked_at=?,revocation_reason='operator_revoked'", [f.clock()]);
  } finally {
    store.close();
  }
  return f;
}

test.each(
  (['codex', 'claude_code'] as const).flatMap(product => (['arm', 'disarm', 'activate', 'revoke'] as const).map(operation => ({ product, operation })))
)('real $product $operation CLI repairs stale emission while preserving its existing result', async ({ product, operation }) => {
  const f = fixture(product);
  const argumentsForOperation =
    operation === 'arm'
      ? [f.taskId, '--duration-ms', '60000']
      : operation === 'disarm'
        ? [f.taskId]
        : [f.packet(operation === 'activate' ? windowDecisionPacket(f.selection) : windowRevocationPacket(f.selection))];

  const result = await f.run(['compatibility', 'ordinary-window', operation, ...argumentsForOperation]);

  expect(result.effects).toEqual({ nativeCalls: 0, processCalls: 0, operations: [] });
  const rejected = operation === 'arm' || operation === 'activate';
  expect(result.code).toBe(rejected ? 2 : 0);
  if (rejected) expect(result.stderr).toBe('binding_window_decision_exists\n');
  else expect(JSON.parse(result.stdout) as unknown).toMatchObject({ runtime_authority: false });
  expect(readOrdinaryWindowControl(f.projectRoot, product)?.state).toBe('inactive');
  expect(f.rows().decisions).toMatchObject([{ revoked_at: f.clock(), revocation_reason: 'operator_revoked' }]);
});
