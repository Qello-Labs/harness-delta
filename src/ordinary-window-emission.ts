import { randomUUID } from 'node:crypto';
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Store } from './store.js';
import { type OrdinaryWindowDecisionKey, ordinaryWindowDecisionStatus } from './core/ordinary-window-activation.js';

interface OrdinaryWindowEmissionControl {
  readonly schemaVersion: 1;
  readonly projectRoot: string;
  readonly product: OrdinaryWindowDecisionKey['product'];
  readonly policyId: OrdinaryWindowDecisionKey['policy_id'];
  readonly policyRevision: string;
  readonly evidenceMode: OrdinaryWindowDecisionKey['evidence_mode'];
  readonly state: 'active' | 'inactive';
}

function controlDirectory(projectRoot: string, product: OrdinaryWindowDecisionKey['product']): string {
  if (!projectRoot || projectRoot.length > 4096 || resolve(projectRoot) !== projectRoot) throw new Error('binding_window_control_unavailable');
  const parent = join(projectRoot, '.harness-delta');
  const directory = join(parent, product === 'codex' ? 'window-receipts' : 'claude-window-receipts');
  const ancestors: string[] = [];
  for (let current = directory; ; current = dirname(current)) {
    ancestors.push(current);
    if (current === dirname(current)) break;
  }
  for (const current of ancestors.reverse()) {
    let stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat && (current === parent || current === directory)) {
      mkdirSync(current, { mode: 0o700 });
      stat = lstatSync(current);
    }
    if (!stat?.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('binding_window_control_unavailable');
    }
    if (current === directory && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)) {
      throw new Error('binding_window_control_unavailable');
    }
  }
  return directory;
}
function writeControl(directory: string, control: OrdinaryWindowEmissionControl): void {
  const payload = JSON.stringify(control);
  if (Buffer.byteLength(payload) > 4096) {
    throw new Error('binding_window_control_unavailable');
  }
  const target = join(directory, 'ordinary-window-control.json');
  const current = lstatSync(target, { throwIfNoEntry: false });
  if (current && (!current.isFile() || current.isSymbolicLink() || current.uid !== process.getuid?.() || (current.mode & 0o077) !== 0)) {
    throw new Error('binding_window_control_unavailable');
  }
  const temporary = join(directory, `ordinary-window-control-${randomUUID()}.json`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try {
      writeFileSync(fd, payload, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, target);
  } catch (error) {
    unlinkSync(temporary);
    throw error;
  }
}

export function publishOrdinaryWindowEmissionControl(store: Store, key: OrdinaryWindowDecisionKey, at: string) {
  const status = ordinaryWindowDecisionStatus(store, key, at);
  const project = store.get<{ local_root: string | null }>('SELECT local_root FROM projects WHERE id=?', [key.project_id]);
  if (!project?.local_root) {
    throw new Error('binding_window_control_unavailable');
  }
  const state =
    status.state === 'recorded' && (status.decision?.decision_kind !== 'trial' || status.decision.trial_project_root === project.local_root)
      ? 'active'
      : 'inactive';
  const control: OrdinaryWindowEmissionControl = {
    schemaVersion: 1,
    projectRoot: project.local_root,
    product: key.product,
    policyId: key.policy_id,
    policyRevision: key.policy_revision,
    evidenceMode: key.evidence_mode,
    state
  };
  try {
    writeControl(controlDirectory(project.local_root, key.product), control);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    throw new Error('binding_window_control_unavailable', { cause: error });
  }
  return {
    schema_version: 1,
    kind: 'ordinary_window_emission_status',
    product: key.product,
    policy_id: key.policy_id,
    state,
    runtime_authority: false
  };
}
