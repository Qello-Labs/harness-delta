import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { IdSchema, TimestampSchema } from '../contracts.js';
import type { Store } from '../store.js';
import type { OrdinaryWindowDecisionKey } from './ordinary-window-activation.js';
import { assertOrdinaryWindowPrepared } from './ordinary-window-decision.js';

const controlFields = {
  schemaVersion: z.literal(1),
  projectRoot: z.string().min(1).max(4096),
  product: z.enum(['codex', 'claude_code']),
  policyId: IdSchema,
  policyRevision: IdSchema,
  evidenceMode: z.enum(['source_only', 'publisher_verified_local_pin'])
};
const ControlSchema = z.discriminatedUnion('state', [
  z.strictObject({ ...controlFields, state: z.literal('active') }),
  z.strictObject({ ...controlFields, state: z.literal('inactive') }),
  z.strictObject({
    ...controlFields,
    state: z.literal('receipt_only'),
    arming: z.strictObject({
      projectId: IdSchema,
      taskId: IdSchema,
      generation: z.number().int().nonnegative(),
      policyDigest: z.string().regex(/^[a-f0-9]{64}$/),
      armedAt: TimestampSchema,
      expiresAt: TimestampSchema
    })
  })
]);
export type OrdinaryWindowEmissionControl = z.infer<typeof ControlSchema>;

export function isCurrentOrdinaryWindowArming(
  store: Store,
  control: Extract<OrdinaryWindowEmissionControl, { state: 'receipt_only' }>,
  timestamp: number
): boolean {
  let selection: ReturnType<typeof assertOrdinaryWindowPrepared>;
  try {
    selection = assertOrdinaryWindowPrepared(store, control.arming.taskId);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (
      ![
        'binding_scope_revoked',
        'binding_scope_mismatch',
        'binding_ordinary_assignment_conflict',
        'ordinary_configuration_changed',
        'ordinary_preparation_required'
      ].includes(error.message)
    ) {
      throw error;
    }
    return false;
  }
  const task = store.get<{ state: string; generation: number }>('SELECT state,generation FROM tasks WHERE id=?', [control.arming.taskId]);
  return (
    task?.state === 'active' &&
    task.generation === control.arming.generation &&
    timestamp >= Date.parse(control.arming.armedAt) &&
    timestamp < Date.parse(control.arming.expiresAt) &&
    control.arming.projectId === selection.projectId &&
    control.arming.policyDigest === selection.policyDigest &&
    control.product === selection.policy.product &&
    control.policyId === selection.policy.policyId &&
    control.policyRevision === selection.policy.ruleRevision &&
    control.evidenceMode === selection.policy.evidenceMode &&
    control.projectRoot === store.get<{ local_root: string | null }>('SELECT local_root FROM projects WHERE id=?', [selection.projectId])?.local_root
  );
}

function controlDirectory(projectRoot: string, product: OrdinaryWindowDecisionKey['product'], create: boolean): string | null {
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
    if (!stat && !create) return null;
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

export function readOrdinaryWindowControl(projectRoot: string, product: OrdinaryWindowDecisionKey['product']): OrdinaryWindowEmissionControl | null {
  const directory = controlDirectory(projectRoot, product, false);
  if (!directory) return null;
  const target = join(directory, 'ordinary-window-control.json');
  if (!lstatSync(target, { throwIfNoEntry: false })) return null;
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > 4096) {
      throw new Error('binding_window_control_unavailable');
    }
    const buffer = Buffer.alloc(4097);
    const size = readSync(fd, buffer, 0, buffer.length, 0);
    if (size > 4096) throw new Error('binding_window_control_unavailable');
    const control = ControlSchema.parse(JSON.parse(buffer.subarray(0, size).toString('utf8')));
    if (control.projectRoot !== projectRoot || control.product !== product) throw new Error('binding_window_control_unavailable');
    return control;
  } finally {
    closeSync(fd);
  }
}

export function writeOrdinaryWindowControl(control: OrdinaryWindowEmissionControl): void {
  const directory = controlDirectory(control.projectRoot, control.product, true);
  if (!directory) throw new Error('binding_window_control_unavailable');
  const payload = JSON.stringify(control);
  if (Buffer.byteLength(payload) > 4096) {
    throw new Error('binding_window_control_unavailable');
  }
  const target = join(directory, 'ordinary-window-control.json');
  const current = lstatSync(target, { throwIfNoEntry: false });
  if (current && (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.uid !== process.getuid?.() || (current.mode & 0o077) !== 0)) {
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

export function clearOrdinaryWindowArming(projectRoot: string, taskId?: string, product: OrdinaryWindowDecisionKey['product'] = 'codex'): boolean {
  const control = readOrdinaryWindowControl(projectRoot, product);
  if (control?.state !== 'receipt_only') return false;
  const { arming, ...base } = control;
  if (taskId !== undefined && arming.taskId !== taskId) return false;
  writeOrdinaryWindowControl({ ...base, state: 'inactive' });
  return true;
}

export function clearTaskOrdinaryWindowArming(store: Store, taskId: string): void {
  const project = store.get<{ local_root: string | null; product: OrdinaryWindowDecisionKey['product'] }>(
    `SELECT p.local_root,json_extract(w.selection,'$.policy.product') AS product FROM projects p JOIN tasks t ON t.project_id=p.id
    JOIN ordinary_window_selections w ON w.task_id=t.id WHERE t.id=? AND json_extract(w.selection,'$.policy.product') IN ('codex','claude_code')`,
    [taskId]
  );
  if (project?.local_root) {
    clearOrdinaryWindowArming(project.local_root, taskId, project.product);
  }
}
