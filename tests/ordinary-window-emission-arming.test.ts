import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { armOrdinaryWindowTrial } from '../src/cli/ordinary-window-activation-cli.js';
import { installClaudeConnectInstallation, previewClaudeConnectInstallation } from '../src/connect/claude-connect-installation.js';
import { installCodexConnectInstallation, previewCodexConnectInstallation } from '../src/connect/codex-connect-installation.js';
import { activateOrdinaryWindowDecision } from '../src/core/ordinary-window-activation.js';
import { readOrdinaryWindowControl, writeOrdinaryWindowControl } from '../src/core/ordinary-window-control.js';
import { terminateOrdinaryWindowTrial } from '../src/core/ordinary-window-trial.js';
import { Deletion } from '../src/deletion.js';
import { createOrdinaryWindowTask } from '../src/ordinary-observation.js';
import { ordinaryWindowArmingStatus, publishOrdinaryWindowEmissionControl } from '../src/ordinary-window-emission.js';
import { ordinaryWindowFixture } from './helpers/ordinary-window-fixture.js';
import { windowTrialPacket } from './helpers/ordinary-window-decision-fixture.js';

const products = ['codex', 'claude_code'] as const;
const paths = ['task', 'retention', 'termination'] as const;
const cleanups: (() => void)[] = [];

function fixture(product: (typeof products)[number]) {
  const f = ordinaryWindowFixture(product);
  const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'window-emission-arming-')));
  cleanups.push(() => {
    f.store.close();
    rmSync(projectRoot, { recursive: true, force: true });
  });
  f.store.execute('UPDATE projects SET local_root=? WHERE id=?', [projectRoot, 'project']);
  vi.setSystemTime(new Date(f.clock()));
  if (product === 'codex') {
    const options = { bundleMode: 'ordinary_window', productVersion: f.selection.declaredVersion, sourceRoots: [projectRoot] } as const;
    const preview = previewCodexConnectInstallation(projectRoot, options);
    const installed = installCodexConnectInstallation(projectRoot, {
      ...options,
      expectedPackageHash: preview.packageHash,
      expectedInstalledHash: preview.installedHash
    });
    expect(installed.state).toBe('installed');
  } else {
    const options = { bundleMode: 'ordinary_window' } as const;
    const preview = previewClaudeConnectInstallation(projectRoot, options);
    const installed = installClaudeConnectInstallation(projectRoot, {
      ...options,
      expectedPackageHash: preview.packageHash,
      expectedInstalledHash: preview.installedHash
    });
    expect(installed.state).toBe('installed');
  }
  f.life.start(f.taskId);
  const packet = windowTrialPacket(f.selection);
  activateOrdinaryWindowDecision(f.store, packet, f.clock());
  publishOrdinaryWindowEmissionControl(f.store, packet, f.clock());
  const survivor = createOrdinaryWindowTask(
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
  f.life.start(survivor);
  const deletion = new Deletion(f.store, f.clock);
  const control = () => readOrdinaryWindowControl(projectRoot, product);
  const remove = (path: (typeof paths)[number]) => {
    switch (path) {
      case 'task':
        deletion.deleteTask(f.taskId);
        break;
      case 'retention':
        deletion.applyRetention('project', '2026-11-08T01:00:00.000Z');
        break;
      case 'termination':
        expect(
          terminateOrdinaryWindowTrial(
            f.store,
            { taskId: f.taskId, generation: f.life.task(f.taskId).generation, decisionRef: packet.decision_ref },
            { at: f.clock(), reason: 'trial_failed' }
          )
        ).toBe(true);
        deletion.deleteTask(f.taskId);
        break;
    }
  };
  return { ...f, survivor, deletion, control, remove };
}

afterEach(() => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

test.each(products.flatMap(product => paths.map(path => ({ product, path }))))(
  '$product $path publication preserves real surviving-task arming completed after commit',
  ({ product, path }) => {
    const f = fixture(product);
    if (path === 'retention') {
      f.life.finalize(f.taskId, 'aborted', []);
      f.deletion.configureRetention('project', 1);
    }
    f.store.transaction(() => {
      f.store.afterCommit(() => {
        expect(armOrdinaryWindowTrial(f.store, f.survivor, 60000, f.clock()).state).toBe('receipt_only');
      });
      f.remove(path);
    });

    expect(f.control()).toMatchObject({ state: 'receipt_only', arming: { taskId: f.survivor } });
    expect(ordinaryWindowArmingStatus(f.store, f.survivor, f.clock()).state).toBe('receipt_only');
  }
);

const staleKinds = ['generation', 'expired', 'future', 'project', 'product', 'policy', 'revision', 'digest', 'evidence', 'revoked', 'deleted'] as const;
test.each(products.flatMap(product => staleKinds.map(stale => ({ product, stale }))))(
  '$product deletion publication still closes $stale arming',
  ({ product, stale }) => {
    const f = fixture(product);
    f.store.transaction(() => {
      f.store.afterCommit(() => {
        armOrdinaryWindowTrial(f.store, f.survivor, 60000, f.clock());
        const control = f.control();
        if (control?.state !== 'receipt_only') throw new Error('synthetic_arming_missing');
        switch (stale) {
          case 'generation':
            f.store.execute('UPDATE tasks SET generation=generation+1 WHERE id=?', [f.survivor]);
            break;
          case 'expired':
            vi.setSystemTime(new Date(control.arming.expiresAt));
            break;
          case 'future':
            vi.setSystemTime(Date.parse(control.arming.armedAt) - 1);
            break;
          case 'project':
            writeOrdinaryWindowControl({ ...control, arming: { ...control.arming, projectId: 'other-project' } });
            break;
          case 'product':
            f.store.execute("UPDATE tasks SET metadata=json_set(metadata,'$.product',?) WHERE id=?", [
              product === 'codex' ? 'claude_code' : 'codex',
              f.survivor
            ]);
            break;
          case 'policy':
            writeOrdinaryWindowControl({ ...control, policyId: 'other-policy' });
            break;
          case 'revision':
            writeOrdinaryWindowControl({ ...control, policyRevision: 'other-revision' });
            break;
          case 'digest':
            writeOrdinaryWindowControl({ ...control, arming: { ...control.arming, policyDigest: 'f'.repeat(64) } });
            break;
          case 'evidence':
            writeOrdinaryWindowControl({ ...control, evidenceMode: product === 'codex' ? 'publisher_verified_local_pin' : 'source_only' });
            break;
          case 'revoked':
            f.store.execute('UPDATE ordinary_tasks SET revoked_at=? WHERE task_id=?', [f.clock(), f.survivor]);
            break;
          case 'deleted':
            f.deletion.deleteTask(f.survivor);
            writeOrdinaryWindowControl(control);
            break;
        }
      });
      f.remove('task');
    });

    expect(f.control()?.state).toBe('inactive');
  }
);
