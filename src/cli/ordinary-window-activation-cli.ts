import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { z } from 'zod';
import { IdSchema, TimestampSchema } from '../contracts.js';
import { statusCodexConnectInstallation } from '../connect/codex-connect-installation.js';
import { statusClaudeConnectInstallation } from '../connect/claude-connect-installation.js';
import { readOrdinaryWindowControl, writeOrdinaryWindowControl } from '../core/ordinary-window-trial.js';
import type { Command } from 'commander';
import type { Store } from '../store.js';
import { readOrdinaryWindowStatus } from '../core/ordinary-window-evidence.js';
import { activateOrdinaryWindowDecision, ordinaryWindowDecisionKeyForSelection, ordinaryWindowDecisionStatus } from '../core/ordinary-window-activation.js';
import { assertOrdinaryWindowPrepared, ordinaryWindowSelection, revokeOrdinaryWindowDecision } from '../core/ordinary-window-store.js';
import {
  disarmOrdinaryWindowTrial,
  ordinaryWindowArmingStatus,
  ordinaryWindowEmissionControlStale,
  publishOrdinaryWindowEmissionControl,
  withOrdinaryWindowReconciliation
} from '../ordinary-window-emission.js';
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
    .command('arm <task-id>')
    .description('Arm only pending receipt emission for a Codex or Claude trial; never authorize collection')
    .requiredOption('--duration-ms <milliseconds>', 'Finite receipt-only arming lifetime')
    .action((taskId: string, options: { durationMs: string }) => {
      const store = db();
      print(
        withOrdinaryWindowReconciliation(store, { taskId }, () => armOrdinaryWindowTrial(store, taskId, Number(options.durationMs), new Date().toISOString()))
      );
    });
  window.command('disarm <task-id>').action((taskId: string) => {
    const store = db();
    print(withOrdinaryWindowReconciliation(store, { taskId }, () => disarmOrdinaryWindowTrial(store, taskId, new Date().toISOString())));
  });
  window
    .command('status <task-id>')
    .option('--decision', 'Describe the fixed local decision; never authorize collection')
    .option('--arming', 'Describe receipt-only trial arming; never authorize collection')
    .action((taskId: string, options: { decision?: boolean; arming?: boolean }) => {
      const store = db();
      const result = withOrdinaryWindowReconciliation(store, { taskId }, () => {
        if (options.arming) {
          return store.immediateTransaction(() => ordinaryWindowArmingStatus(store, taskId, new Date().toISOString()));
        }
        return store.transaction(() => {
          const report = readOrdinaryWindowStatus(store, taskId);
          if (!options.decision) return report;
          const selection = ordinaryWindowSelection(store, taskId);
          if (!selection) {
            throw new Error('ordinary_preparation_required');
          }
          return ordinaryWindowDecisionStatus(store, ordinaryWindowDecisionKeyForSelection(selection), new Date().toISOString());
        });
      });
      print({ ...result, emission_control_stale: ordinaryWindowEmissionControlStale(store, { taskId }) });
    });
  for (const operation of ['activate', 'revoke'] as const) {
    window.command(`${operation} <packet-file>`).action((path: string) => {
      const store = db();
      const packet = readDecisionPacket(path);
      const scope = z.object({ project_id: IdSchema, product: z.enum(['codex', 'claude_code']) }).safeParse(packet);
      const execute = () => {
        const at = new Date().toISOString();
        const decision = operation === 'activate' ? activateOrdinaryWindowDecision(store, packet, at) : revokeOrdinaryWindowDecision(store, packet, at);
        const emission = publishOrdinaryWindowEmissionControl(store, decision, new Date().toISOString());
        return {
          schema_version: 1,
          kind: 'ordinary_window_decision_result',
          decision,
          emission_control: emission,
          trial_budget_basis: decision.decision_kind === 'trial' ? ordinaryWindowTrialBudgetBasis : null,
          runtime_authority: false
        };
      };
      print(scope.success ? withOrdinaryWindowReconciliation(store, { projectId: scope.data.project_id, product: scope.data.product }, execute) : execute());
    });
  }
}

export function armOrdinaryWindowTrial(store: Store, taskId: string, durationMs: number, at: string) {
  const duration = z.number().int().positive().max(2_147_483_647).parse(durationMs);
  const timestamp = new Date(TimestampSchema.parse(at)).toISOString();
  return store.immediateTransaction(() => {
    const selection = assertOrdinaryWindowPrepared(store, taskId);
    const task = store.get<{ state: string; generation: number }>('SELECT state,generation FROM tasks WHERE id=?', [taskId]);
    if (task?.state !== 'active') {
      throw new Error('binding_scope_revoked');
    }
    const key = ordinaryWindowDecisionKeyForSelection(selection);
    if (ordinaryWindowDecisionStatus(store, key, at).state !== 'absent') {
      throw new Error('binding_window_decision_exists');
    }
    const project = store.get<{ local_root: string }>('SELECT local_root FROM projects WHERE id=?', [selection.projectId]);
    if (!project?.local_root) throw new Error('binding_scope_revoked');
    const installation =
      selection.policy.product === 'codex'
        ? statusCodexConnectInstallation(project.local_root, {
            bundleMode: 'ordinary_window',
            productVersion: selection.declaredVersion,
            sourceRoots: [project.local_root]
          })
        : statusClaudeConnectInstallation(project.local_root, {
            bundleMode: 'ordinary_window',
            productVersion: selection.declaredVersion
          });
    if (installation.state !== 'installed' || installation.bundleMode !== 'ordinary_window') throw new Error('binding_window_package_required');
    const current = readOrdinaryWindowControl(project.local_root, selection.policy.product);
    if (current?.state === 'receipt_only') {
      const status = ordinaryWindowArmingStatus(store, current.arming.taskId, timestamp);
      if (status.state === 'receipt_only') {
        throw new Error('binding_window_arming_exists');
      }
    }
    writeOrdinaryWindowControl({
      schemaVersion: 1,
      projectRoot: project.local_root,
      product: selection.policy.product,
      policyId: selection.policy.policyId,
      policyRevision: selection.policy.ruleRevision,
      evidenceMode: selection.policy.evidenceMode,
      state: 'receipt_only',
      arming: {
        projectId: selection.projectId,
        taskId,
        generation: task.generation,
        policyDigest: selection.policyDigest,
        armedAt: timestamp,
        expiresAt: new Date(Date.parse(timestamp) + duration).toISOString()
      }
    });
    return ordinaryWindowArmingStatus(store, taskId, timestamp);
  });
}
