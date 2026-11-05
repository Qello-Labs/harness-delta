import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { ChildDiscovery } from './session-binding-contract.js';
import type { Store } from './store.js';

const reason = z.enum([
  'source_replaced',
  'child_receipt_untrusted',
  'child_receipt_invalid',
  'child_receipt_mismatch',
  'child_source_mismatch',
  'child_source_missing',
  'child_readiness_timeout',
  'ownership_unverified',
  'child_relation_unverified',
  'relation_mismatch',
  'descendants_present',
  'claude_family_scope_limit',
  'claude_bound_identity_changed',
  'claude_process_absent',
  'claude_source_untrusted',
  'claude_source_missing',
  'claude_source_replaced',
  'binding_pilot_family_scope',
  'pilot_source_identity_changed',
  'pilot_duplicate_root',
  'pilot_source_time_invalid',
  'pilot_root_predates_observer',
  'pilot_root_unlinked',
  'pilot_native_session_mismatch',
  'pilot_family_limit',
  'pilot_member_predates_root',
  'pilot_identity_mismatch'
]);
const phase = z.enum(['baseline_discovery', 'baseline_relation', 'baseline_descendants', 'tick_discovery', 'tick_relation']);
export const FamilyDiagnosticSchema = z.strictObject({ schema_version: z.literal(1), phase, reason_codes: z.array(reason).max(32) });
export type FamilyDiagnostic = z.infer<typeof FamilyDiagnosticSchema>;
export type FamilyPhase = z.infer<typeof phase>;
interface Attempt {
  taskId: string;
  projectId: string;
  projectRoot: string;
  rootId: string;
  sessionId: string;
  generation: number;
  identity: string;
}
const discoveries = new WeakMap<ChildDiscovery, string[]>();
const providerErrors = new WeakMap<Error, string[]>();
const rejections = new WeakMap<Error, { attempt: Attempt; diagnostic: FamilyDiagnostic }>();
const codes = (values: Iterable<string>) =>
  [
    ...new Set(
      [...values].flatMap(value => {
        const parsed = reason.safeParse(value);
        return parsed.success ? [parsed.data] : [];
      })
    )
  ].sort();

/** Internal provenance only: no new fields in shared discovery/error contracts. */
export function familyDiscovery(value: ChildDiscovery, reasons: Iterable<string>): ChildDiscovery {
  discoveries.set(value, codes(reasons));
  return value;
}
export function familyProviderError(error: Error, code: string): Error {
  providerErrors.set(error, codes([code]));
  return error;
}
export function familyRejection(error: unknown, at: FamilyPhase, attempt: Attempt, discovery?: ChildDiscovery, extra: string[] = []): unknown {
  const previous = error instanceof Error ? rejections.get(error) : undefined;
  const sameAttempt =
    previous &&
    previous.attempt.taskId === attempt.taskId &&
    previous.attempt.sessionId === attempt.sessionId &&
    previous.attempt.generation === attempt.generation &&
    previous.attempt.identity === attempt.identity &&
    previous.attempt.projectId === attempt.projectId &&
    previous.attempt.projectRoot === attempt.projectRoot &&
    previous.attempt.rootId === attempt.rootId;
  if (error instanceof Error && !sameAttempt)
    rejections.set(error, {
      attempt: { ...attempt },
      diagnostic: {
        schema_version: 1,
        phase: at,
        reason_codes: codes([...(discovery ? (discoveries.get(discovery) ?? []) : (providerErrors.get(error) ?? [])), ...extra])
      }
    });
  return error;
}
/** Capture eligibility before the automatic pause; consume this single attempt only. */
export function takeFamilyDiagnostic(error: unknown, taskId: string, store: Store): FamilyDiagnostic | null {
  try {
    if (!(error instanceof Error)) return null;
    const value = rejections.get(error);
    rejections.delete(error);
    if (!value || value.attempt.taskId !== taskId) return null;
    const a = value.attempt;
    const task = store.get<{ state: string; generation: number; project_id: string; local_root: string }>(
      'SELECT t.state,t.generation,t.project_id,p.local_root FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=?',
      [taskId]
    );
    const binding = store.get<{ state: string; generation: number; identity: string; root_id: string }>(
      'SELECT state,generation,identity,root_id FROM session_bindings WHERE task_id=? AND session_id=?',
      [taskId, a.sessionId]
    );
    if (
      task?.state !== 'active' ||
      task.generation !== a.generation ||
      task.project_id !== a.projectId ||
      task.local_root !== a.projectRoot ||
      binding?.state !== 'observing' ||
      binding.generation !== a.generation ||
      binding.identity !== a.identity ||
      binding.root_id !== a.rootId
    )
      return null;
    return value.diagnostic;
  } catch {
    return null;
  }
}

/** Dedicated owner-private bounded sink. Failure never changes a collector fence. */
export function appendFamilyDiagnostic(path: string, input: unknown): void {
  let fd: number | undefined;
  let lockFd: number | undefined;
  try {
    const parsed = FamilyDiagnosticSchema.safeParse(input);
    if (!parsed.success) return;
    const parent = lstatSync(dirname(path));
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0) return;
    lockFd = openSync(path + '.lock', constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0 || st.nlink !== 1 || st.size > 65536) return;
    const buf = Buffer.alloc(65537);
    const size = readSync(fd, buf, 0, buf.length, 0);
    if (size > 65536) return;
    const text = buf.subarray(0, size).toString('utf8');
    if (text && !text.endsWith('\n')) return;
    const rows = text.trim().split('\n').filter(Boolean);
    if (rows.length >= 64 || rows.some(row => !FamilyDiagnosticSchema.safeParse(JSON.parse(row) as unknown).success)) return;
    const line = JSON.stringify(parsed.data) + '\n';
    if (size + Buffer.byteLength(line) > 65536) return;
    writeSync(fd, line);
  } catch {
    /* No retry, fallback, error text or changes to the original rejection. */
  } finally {
    if (fd !== undefined)
      try {
        closeSync(fd);
      } catch {
        /* Preserve the rejection. */
      }
    if (lockFd !== undefined) {
      try {
        const owned = fstatSync(lockFd);
        const current = lstatSync(path + '.lock');
        if (current.isFile() && owned.dev === current.dev && owned.ino === current.ino) unlinkSync(path + '.lock');
      } catch {
        /* Do not remove another writer's lock or retry. */
      }
      try {
        closeSync(lockFd);
      } catch {
        /* Preserve the rejection. */
      }
    }
  }
}
