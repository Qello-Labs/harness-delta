import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, renameSync, unlinkSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { join } from 'node:path';
import { durablePrivateBytes, hashBytes, readRepositoryFile } from '../core/repository-files.js';
import { inspectWindowHookRegistration, planWindowHookRegistration, WindowHookRegistrationError } from './claude-window-registration.js';
import type { WindowHookRegistration } from './claude-window-registration.js';

export const windowRegistrationPath = '.claude/settings.local.json';
export class WindowRegistrationFileError extends Error {
  constructor(readonly code: 'unsafe_path' | 'changed_path' | 'installation_preview_changed' | 'installation_rollback_failed') {
    super(code);
    this.name = 'WindowRegistrationFileError';
  }
}
export interface WindowRegistrationFile {
  readonly bytes: Buffer | null;
  readonly mode: number;
  readonly identity: string | null;
}

export function readWindowRegistrationFile(projectRoot: string): WindowRegistrationFile {
  const directory = lstatSync(join(projectRoot, '.claude'), { bigint: true, throwIfNoEntry: false });
  if (
    directory &&
    (!directory.isDirectory() ||
      directory.isSymbolicLink() ||
      (directory.mode & 0o022n) !== 0n ||
      (typeof process.getuid === 'function' && directory.uid !== BigInt(process.getuid())))
  ) {
    throw new WindowRegistrationFileError('unsafe_path');
  }
  const path = join(projectRoot, windowRegistrationPath);
  const stat = directory ? lstatSync(path, { bigint: true, throwIfNoEntry: false }) : undefined;
  if (!stat) return { bytes: null, mode: 0o600, identity: null };
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || (typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid()))) {
    throw new WindowRegistrationFileError('unsafe_path');
  }
  const identity = (value: BigIntStats) =>
    `${value.dev}:${value.ino}:${value.size}:${value.mode}:${value.uid}:${value.gid}:${value.nlink}:${value.mtimeNs}:${value.ctimeNs}`;
  const bytes = readRepositoryFile(projectRoot, windowRegistrationPath);
  if (identity(stat) !== identity(lstatSync(path, { bigint: true }))) {
    throw new WindowRegistrationFileError('changed_path');
  }
  return { bytes, mode: Number(stat.mode & 0o777n), identity: identity(stat) };
}

export function restoreWindowRegistrationFile(projectRoot: string, before: WindowRegistrationFile, after: Buffer | null): void {
  const current = readWindowRegistrationFile(projectRoot);
  if (windowRegistrationFileHash(current) === windowRegistrationFileHash(before)) return;
  if (!(after === null ? current.bytes === null : current.bytes?.equals(after)) || (current.bytes !== null && current.mode !== before.mode)) {
    throw new WindowRegistrationFileError('installation_rollback_failed');
  }
  replaceWindowRegistrationFile(projectRoot, current, before.bytes, before.mode);
}

export function windowRegistrationFileHash(file: WindowRegistrationFile): string {
  return hashBytes(JSON.stringify([file.identity, file.mode, file.bytes === null ? null : hashBytes(file.bytes)]));
}

export function planWindowRegistrationFile(
  projectRoot: string,
  enabled: boolean,
  owned: WindowHookRegistration | undefined,
  window: boolean,
  operation: 'install' | 'remove'
) {
  let file: WindowRegistrationFile | undefined;
  let registration: ReturnType<typeof planWindowHookRegistration> | undefined;
  let sourceHash: string | null = null;
  let installedHash: string | null = null;
  let state: ReturnType<typeof inspectWindowHookRegistration> = 'absent';
  const blockers: string[] = [];
  const changes: { path: string; action: 'create' | 'update' | 'delete'; beforeHash: string | null; afterHash: string | null }[] = [];
  if (enabled) {
    try {
      file = readWindowRegistrationFile(projectRoot);
      const quote = (path: string) => '"' + path.replace(/["\\$`]/g, '\\$&') + '"';
      const command = window
        ? `${quote(process.execPath)} ${quote(join(projectRoot, '.claude/skills/harness-connect/scripts/claude-window-session-hook.mjs'))} record`
        : null;
      state = inspectWindowHookRegistration(file.bytes, owned);
      registration = planWindowHookRegistration(file.bytes, owned, operation === 'install' ? command : null);
      const desired = operation === 'install' ? registration : planWindowHookRegistration(file.bytes, owned, command);
      sourceHash = hashBytes(JSON.stringify([desired.registration ?? null, file.mode, desired.after === null ? null : hashBytes(desired.after)]));
      installedHash = hashBytes(JSON.stringify([owned ?? null, file.mode, file.bytes === null ? null : hashBytes(file.bytes)]));
      const beforeHash = file.bytes === null ? null : hashBytes(file.bytes);
      const afterHash = registration.after === null ? null : hashBytes(registration.after);
      if (beforeHash !== afterHash) {
        changes.push({
          path: windowRegistrationPath,
          action: beforeHash === null ? 'create' : afterHash === null ? 'delete' : 'update',
          beforeHash,
          afterHash
        });
      }
    } catch (error) {
      if (owned && state === 'absent') state = 'mismatched';
      blockers.push(error instanceof WindowHookRegistrationError || error instanceof WindowRegistrationFileError ? error.code : 'installation_unavailable');
    }
  }
  return { file, registration, sourceHash, installedHash, state, blockers, changes };
}

export function windowRegistrationTransaction(
  projectRoot: string,
  file: WindowRegistrationFile | undefined,
  registration: ReturnType<typeof planWindowHookRegistration> | undefined
) {
  let mutated = false;
  return {
    ownership: registration?.registration,
    apply() {
      if (!file || !registration) return;
      replaceWindowRegistrationFile(projectRoot, file, registration.after, file.mode, () => {
        mutated = true;
      });
    },
    rollback() {
      if (mutated && file && registration) restoreWindowRegistrationFile(projectRoot, file, registration.after);
    }
  };
}

export function replaceWindowRegistrationFile(
  projectRoot: string,
  expected: WindowRegistrationFile,
  after: Buffer | null,
  mode = expected.mode,
  onMutation?: () => void
): WindowRegistrationFile {
  const assertUnchanged = () => {
    if (windowRegistrationFileHash(readWindowRegistrationFile(projectRoot)) !== windowRegistrationFileHash(expected)) {
      throw new WindowRegistrationFileError('installation_preview_changed');
    }
  };
  assertUnchanged();
  if (after === null) {
    if (expected.bytes !== null) {
      unlinkSync(join(projectRoot, windowRegistrationPath));
      onMutation?.();
    }
    return readWindowRegistrationFile(projectRoot);
  }
  if (expected.bytes?.equals(after) && mode === expected.mode) return expected;
  const temporary = `.claude/.window-hook-settings-${randomUUID()}.json`;
  let staged = false;
  try {
    durablePrivateBytes(projectRoot, temporary, after);
    staged = true;
    chmodSync(join(projectRoot, temporary), mode);
    assertUnchanged();
    renameSync(join(projectRoot, temporary), join(projectRoot, windowRegistrationPath));
    staged = false;
    // Readback can fail after the replacement already became visible.
    onMutation?.();
    return readWindowRegistrationFile(projectRoot);
  } finally {
    if (staged) unlinkSync(join(projectRoot, temporary));
  }
}
