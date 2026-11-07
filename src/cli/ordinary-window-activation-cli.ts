import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import type { Command } from 'commander';
import type { Store } from '../store.js';
import { readOrdinaryWindowStatus } from '../core/ordinary-window-evidence.js';
import { activateOrdinaryWindowDecision, ordinaryWindowDecisionKeyForSelection, ordinaryWindowDecisionStatus } from '../core/ordinary-window-activation.js';
import { ordinaryWindowSelection, revokeOrdinaryWindowDecision } from '../core/ordinary-window-store.js';
import { publishOrdinaryWindowEmissionControl } from '../ordinary-window-emission.js';
import { ordinaryWindowTrialBudgetBasis } from '../core/ordinary-window-decision.js';

function readDecisionPacket(path: string): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096) {
      throw new Error('binding_window_packet_invalid');
    }
    const buffer = Buffer.alloc(4097);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (count === 0) break;
      bytes += count;
    }
    if (bytes > 4096) throw new Error('binding_window_packet_invalid');
    return JSON.parse(buffer.subarray(0, bytes).toString('utf8')) as unknown;
  } finally {
    closeSync(fd);
  }
}
export function registerOrdinaryWindowActivationCommands(window: Command, db: () => Store, print: (value: unknown) => void): void {
  window
    .command('status <task-id>')
    .option('--decision', 'Describe the fixed local decision; never authorize collection')
    .action((taskId: string, options: { decision?: boolean }) => {
      const store = db();
      print(
        store.transaction(() => {
          const report = readOrdinaryWindowStatus(store, taskId);
          if (!options.decision) return report;
          const selection = ordinaryWindowSelection(store, taskId);
          if (!selection) {
            throw new Error('ordinary_preparation_required');
          }
          return ordinaryWindowDecisionStatus(store, ordinaryWindowDecisionKeyForSelection(selection), new Date().toISOString());
        })
      );
    });
  for (const operation of ['activate', 'revoke'] as const) {
    window.command(`${operation} <packet-file>`).action((path: string) => {
      const store = db();
      const packet = readDecisionPacket(path);
      const at = new Date().toISOString();
      const decision = operation === 'activate' ? activateOrdinaryWindowDecision(store, packet, at) : revokeOrdinaryWindowDecision(store, packet, at);
      const emission = publishOrdinaryWindowEmissionControl(store, decision, new Date().toISOString());
      print({
        schema_version: 1,
        kind: 'ordinary_window_decision_result',
        decision,
        emission_control: emission,
        trial_budget_basis: decision.decision_kind === 'trial' ? ordinaryWindowTrialBudgetBasis : null,
        runtime_authority: false
      });
    });
  }
}
