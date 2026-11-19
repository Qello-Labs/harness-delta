import '../helpers/claude-window-preservation.mjs';
import { writeFileSync } from 'node:fs';
import { afterEach, expect, test } from 'vitest';
import { armOrdinaryWindowTrial } from '../../src/cli/ordinary-window-activation-cli.js';
import { readOrdinaryWindowControl } from '../../src/core/ordinary-window-trial.js';
import { createClaudeWindowArmingFixture, runClaudeArmingHook } from '../helpers/claude-window-arming-fixture.js';

const fixtures: ReturnType<typeof createClaudeWindowArmingFixture>[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

test.each(['projectRoot', 'policyId', 'extra', 'arming-extra'] as const)(
  'rejects %s mismatch in an otherwise live receipt-only Claude control',
  async field => {
    const fixture = createClaudeWindowArmingFixture();
    fixtures.push(fixture);
    expect(armOrdinaryWindowTrial(fixture.store, fixture.taskId, 60000, fixture.options.clock()).state).toBe('receipt_only');
    const control = readOrdinaryWindowControl(fixture.projectRoot, 'claude_code');
    if (control?.state !== 'receipt_only') throw new Error('fixture_live_arming_required');
    const changed = {
      projectRoot: { ...control, projectRoot: '/synthetic/other-project' },
      policyId: { ...control, policyId: 'unselected-policy' },
      extra: { ...control, extra: true },
      'arming-extra': { ...control, arming: { ...control.arming, extra: true } }
    }[field];
    writeFileSync(fixture.controlPath, JSON.stringify(changed));

    const emitted = await runClaudeArmingHook(fixture);

    expect(emitted.code, emitted.stderr).toBe(0);
    expect([emitted.receipts, emitted.effects.metadataWrites, emitted.stdout]).toEqual([[], 0, '']);
    expect(emitted.effects).toMatchObject({ unauthorizedCalls: 0, nativeCalls: 0, processCalls: 0, operations: [] });
  },
  20000
);
