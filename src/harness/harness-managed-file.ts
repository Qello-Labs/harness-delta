import { createHash, randomUUID } from 'node:crypto';
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { IdSchema } from '../contracts.js';
import { selectedArtifactSnapshot } from '../configuration-evidence.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const ExternalPreparationSpecSchema = z
  .strictObject({
    schema_version: z.literal(1),
    common_artifacts: z.array(z.strictObject({ artifact_id: IdSchema, path: z.string().min(1).max(4096) })).max(256),
    common_manifest_hash: digest.nullable(),
    allowed_preimage_hashes: z.array(digest).max(256)
  })
  .refine(spec => (spec.common_artifacts.length === 0) === (spec.common_manifest_hash === null));
export type ExternalPreparationSpec = z.infer<typeof ExternalPreparationSpecSchema>;
export const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');

export function verifyCommonArtifacts(spec: ExternalPreparationSpec): void {
  if (
    spec.common_artifacts.length &&
    selectedArtifactSnapshot(spec.common_artifacts.map(a => ({ artifactId: a.artifact_id, path: a.path }))).hash !== spec.common_manifest_hash
  ) {
    throw new Error('external_common_drift');
  }
}

/** Fixed tool-owned surface; never patches AGENTS, native settings or hooks. */
export function managedHarnessTarget(projectRoot: string): string {
  if (realpathSync(projectRoot) !== projectRoot) throw new Error('external_unsafe_target');
  const directory = join(projectRoot, '.harness-delta-managed');
  if (existsSync(directory) && (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory() || realpathSync(directory) !== directory))
    throw new Error('external_unsafe_target');
  return join(directory, 'active-instructions.md');
}

function readManagedBytes(projectRoot: string): Buffer | null {
  const target = managedHarnessTarget(projectRoot);
  if (!existsSync(target)) {
    // Broken symlinks must not be interpreted as an absent, writable target.
    try {
      lstatSync(target);
      throw new Error('external_unsafe_target');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return null;
  }
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > 16 * 1048576) throw new Error('external_unsafe_target');
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    const current = lstatSync(target);
    if (
      current.isSymbolicLink() ||
      before.ino !== current.ino ||
      before.dev !== current.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    )
      throw new Error('external_unstable_target');
    return bytes;
  } finally {
    closeSync(fd);
  }
}

export function managedHarnessDigest(projectRoot: string): string | null {
  const bytes = readManagedBytes(projectRoot);
  return bytes === null ? null : sha256(bytes);
}
/** Private transient handoff contents from the same bounded no-follow reader. */
export function managedHarnessContent(projectRoot: string, expectedDigest: string): string {
  const bytes = readManagedBytes(projectRoot);
  if (bytes === null || bytes.length > 32768 || sha256(bytes) !== expectedDigest) throw new Error('external_configuration_drift');
  return bytes.toString('utf8');
}

export function applyManagedHarness(projectRoot: string, content: string, spec: ExternalPreparationSpec): void {
  const expected = sha256(content);
  const previous = managedHarnessDigest(projectRoot);
  if (previous === expected) return;
  if (previous !== null && !spec.allowed_preimage_hashes.includes(previous)) throw new Error('external_preimage_unapproved');
  verifyCommonArtifacts(spec);
  const target = managedHarnessTarget(projectRoot);
  const directory = join(projectRoot, '.harness-delta-managed');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  managedHarnessTarget(projectRoot);
  const temporary = join(directory, `.prepare-${randomUUID()}`);
  try {
    writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
    const fd = openSync(temporary, constants.O_RDONLY);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    verifyCommonArtifacts(spec);
    if (managedHarnessDigest(projectRoot) !== previous) throw new Error('external_preimage_changed');
    renameSync(temporary, target);
    if (managedHarnessDigest(projectRoot) !== expected) throw new Error('external_configuration_drift');
    verifyCommonArtifacts(spec);
  } finally {
    rmSync(temporary, { force: true });
  }
}
