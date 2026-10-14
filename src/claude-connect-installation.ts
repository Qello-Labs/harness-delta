import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { durablePrivateBytes } from './harness-application-files.js';
import { hashBytes, readRepositoryFile, readStrictJson, safeRelativePath } from './harness-config.js';

const destination = '.claude/skills/harness-connect';
const metadata = '.harness-delta/claude-connect';
const manifestPath = `${metadata}/installation.json`;
const configPath = 'scripts/claude-connect-config.mjs';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const relative = z.string().refine(safeRelativePath);
const manifestSchema = z.strictObject({
  schema_version: z.literal(1),
  package: z.literal('harness-connect'),
  root_identity: z.string(),
  files: z.array(z.strictObject({ path: relative, shipped_sha256: digest.nullable(), installed_sha256: digest })).min(1).max(256),
});
type Manifest = z.infer<typeof manifestSchema>;
const lockOwnerSchema = z.strictObject({ pid: z.number().int().positive() });
export interface ClaudeConnectInstallationOptions {
  /** Trusted development seam, never a UI-selected destination. */
  readonly packageRoot?: string;
  readonly expectedPackageHash?: string | null;
  readonly expectedInstalledHash?: string | null;
}
export interface ClaudeConnectInstallationPreviewOptions extends ClaudeConnectInstallationOptions {
  readonly operation?: 'install' | 'remove';
}
export interface ClaudeConnectInstallationChange {
  readonly path: string;
  readonly action: 'create' | 'update' | 'delete';
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
}
export interface ClaudeConnectInstallationStatus {
  readonly state: 'absent' | 'installed' | 'update_available' | 'blocked';
  readonly source: 'available' | 'unavailable';
  readonly packageHash: string | null;
  readonly installedHash: string | null;
  readonly destination: typeof destination;
  readonly receiptDirectory: string;
  readonly hookRegistration: 'unverified';
  readonly blockers: readonly string[];
}
export interface ClaudeConnectInstallationPreview extends ClaudeConnectInstallationStatus {
  readonly operation: 'install' | 'remove';
  readonly changes: readonly ClaudeConnectInstallationChange[];
}
export class ClaudeConnectInstallationError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'ClaudeConnectInstallationError'; }
}
const fail = (code: string): never => { throw new ClaudeConnectInstallationError(code); };
function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
function entry(root: string, path: string, source = false) {
  if (!safeRelativePath(path)) return fail('unsafe_path');
  let current = root;
  const parts = path.split('/');
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    let stat;
    try { stat = lstatSync(current); } catch (error) { if (missing(error)) return null; throw error; }
    if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) fail('unsafe_path');
    if (stat.isDirectory() && ((stat.mode & 0o022) !== 0 ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid() && !(source && stat.uid === 0)))) fail('unsafe_path');
    if (index === parts.length - 1) return stat;
  }
  return null;
}
function rootIdentity(root: string, source = false): string {
  const stat = lstatSync(root, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(root) !== resolve(root) || (stat.mode & 0o022n) !== 0n ||
    (typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid()) && !(source && stat.uid === 0n))) fail('unsafe_project_root');
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
}
function tree(root: string, prefix = '', source = false): Map<string, Buffer> {
  if (!prefix) rootIdentity(root, source);
  const files = new Map<string, Buffer>();
  const directory = prefix ? join(root, prefix) : root;
  for (const name of readdirSync(directory).sort()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (!safeRelativePath(path)) fail('unsafe_path');
    const stat = entry(root, path, source);
    if (!stat) return fail('changed_path');
    if (stat.isDirectory()) {
      const children = tree(root, path, source);
      if (!children.size) fail('unowned_directory');
      for (const [child, bytes] of children) files.set(child, bytes);
    } else {
      if (!stat.isFile() || (!source && stat.nlink !== 1)) fail('unsafe_path');
      files.set(path, readRepositoryFile(root, path));
    }
    if (files.size > 256) fail('package_invalid');
  }
  return files;
}
const bundleHash = (files: Map<string, Buffer>) => hashBytes(JSON.stringify(
  [...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, bytes]) => [path, hashBytes(bytes)]),
));
function packageSource(options: ClaudeConnectInstallationOptions): { files: Map<string, Buffer>; shipped: Map<string, Buffer> } {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const sourceRoot = options.packageRoot ?? fileURLToPath(new URL(
    basename(moduleDirectory) === 'src' ? '../skills/harness-connect/' : './skills/harness-connect/', import.meta.url,
  ));
  rootIdentity(sourceRoot, true);
  const shipped = tree(sourceRoot, '', true);
  for (const path of ['SKILL.md', 'scripts/connect.mjs', 'scripts/claude-session-hook.mjs']) {
    if (!shipped.has(path)) fail('package_invalid');
  }
  if (shipped.has(configPath)) fail('package_invalid');
  const files = new Map(shipped);
  files.set(configPath, Buffer.from(
    "import { fileURLToPath } from 'node:url';\n" +
    "process.env.HARNESS_DELTA_CLAUDE_RECEIPT_DIR = fileURLToPath(new URL('../../../../.harness-delta/claude-connect/receipts/', import.meta.url));\n",
  ));
  // Both recorder and locator must use the same project-local directory without settings edits.
  for (const path of ['scripts/connect.mjs', 'scripts/claude-session-hook.mjs']) {
    const bytes = shipped.get(path);
    if (!bytes) return fail('package_invalid');
    const text = bytes.toString('utf8');
    const split = text.startsWith('#!') ? text.indexOf('\n') + 1 : 0;
    files.set(path, Buffer.from(text.slice(0, split) + "import './claude-connect-config.mjs';\n" + text.slice(split)));
  }
  return { files, shipped };
}
function inspectOwned(projectRoot: string) {
  const identity = rootIdentity(projectRoot);
  const identities = new Map<string, string>();
  const pin = (path: string) => {
    const stat = entry(projectRoot, path);
    if (!stat) return;
    identities.set(path, `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`);
    if (stat.isDirectory() && path.startsWith(destination)) {
      for (const name of readdirSync(join(projectRoot, path))) pin(`${path}/${name}`);
    }
  };
  for (const path of ['.claude', '.claude/skills', destination, '.harness-delta', metadata, manifestPath]) pin(path);
  const target = entry(projectRoot, destination);
  const privateDirectory = entry(projectRoot, metadata);
  if (privateDirectory && (!privateDirectory.isDirectory() || (privateDirectory.mode & 0o077) !== 0 ||
    (typeof process.getuid === 'function' && privateDirectory.uid !== process.getuid()))) fail('metadata_unsafe');
  const manifestStat = entry(projectRoot, manifestPath);
  if (!manifestStat) {
    if (target) fail('package_unowned');
    return { identity, identities, manifest: null, bytes: null, files: new Map<string, Buffer>() };
  }
  if (!manifestStat.isFile() || manifestStat.nlink !== 1 || (manifestStat.mode & 0o077) !== 0 ||
    (typeof process.getuid === 'function' && manifestStat.uid !== process.getuid())) fail('manifest_unsafe');
  const bytes = readRepositoryFile(projectRoot, manifestPath);
  const parsed = manifestSchema.safeParse(readStrictJson(bytes));
  if (!parsed.success) return fail('manifest_invalid');
  const manifest = parsed.data;
  if (manifest.root_identity !== identity) fail('changed_project_root');
  if (!target?.isDirectory()) fail('package_drift');
  const files = tree(join(projectRoot, destination));
  const names = new Set(manifest.files.map(file => file.path));
  if (names.size !== manifest.files.length || names.size !== files.size) fail('package_drift');
  for (const file of manifest.files) {
    const installed = files.get(file.path);
    if (!installed || hashBytes(installed) !== file.installed_sha256) fail('package_drift');
  }
  return { identity, identities, manifest, bytes, files };
}
function blocker(error: unknown): string {
  return error instanceof ClaudeConnectInstallationError ? error.code : 'installation_unavailable';
}
function plan(projectRoot: string, options: ClaudeConnectInstallationPreviewOptions) {
  const operation = options.operation ?? 'install';
  let owned: ReturnType<typeof inspectOwned> | undefined;
  let source: ReturnType<typeof packageSource> | undefined;
  const blockers: string[] = [];
  try { owned = inspectOwned(projectRoot); } catch (error) { blockers.push(blocker(error)); }
  if (owned) {
    try {
      if (entry(projectRoot, `${metadata}/installation-lock`)) {
        const ownerPath = `${metadata}/installation-lock/owner.json`;
        const owner = lockOwnerSchema.safeParse(entry(projectRoot, ownerPath) ? readStrictJson(readRepositoryFile(projectRoot, ownerPath)) : null);
        if (!owner.success) blockers.push('installation_recovery_required');
        else {
          try { process.kill(owner.data.pid, 0); blockers.push('installation_busy'); }
          catch (error) {
            blockers.push(error instanceof Error && 'code' in error && error.code === 'ESRCH'
              ? 'installation_recovery_required' : 'installation_busy');
          }
        }
      }
    }
    catch (error) { blockers.push(blocker(error)); }
  }
  try { source = packageSource(options); } catch { if (operation === 'install') blockers.push('package_source_unavailable'); }
  const changes: ClaudeConnectInstallationChange[] = [];
  const wanted = operation === 'remove' ? new Map<string, Buffer>() : source?.files;
  if (owned && wanted && !blockers.length) {
    for (const path of [...new Set([...owned.files.keys(), ...wanted.keys()])].sort()) {
      const before = owned.files.get(path), after = wanted.get(path);
      const beforeHash = before ? hashBytes(before) : null, afterHash = after ? hashBytes(after) : null;
      if (beforeHash !== afterHash) changes.push({ path: `${destination}/${path}`,
        action: beforeHash === null ? 'create' : afterHash === null ? 'delete' : 'update', beforeHash, afterHash });
    }
  }
  const preview: ClaudeConnectInstallationPreview = {
    state: blockers.length ? 'blocked' : !owned?.manifest ? 'absent' :
      source && bundleHash(source.files) !== bundleHash(owned.files) ? 'update_available' : 'installed',
    source: source ? 'available' : 'unavailable',
    packageHash: source ? bundleHash(source.files) : null,
    installedHash: owned?.manifest ? bundleHash(owned.files) : null,
    destination, receiptDirectory: `${metadata}/receipts`, hookRegistration: 'unverified',
    operation, changes, blockers,
  };
  return { preview, owned, source };
}
export function previewClaudeConnectInstallation(projectRoot: string, options: ClaudeConnectInstallationPreviewOptions = {}): ClaudeConnectInstallationPreview {
  return plan(projectRoot, options).preview;
}
export function statusClaudeConnectInstallation(projectRoot: string, options: ClaudeConnectInstallationOptions = {}): ClaudeConnectInstallationStatus {
  const result = plan(projectRoot, options).preview;
  return { state: result.state, source: result.source, packageHash: result.packageHash, installedHash: result.installedHash,
    destination: result.destination, receiptDirectory: result.receiptDirectory, hookRegistration: result.hookRegistration, blockers: result.blockers };
}
function apply(projectRoot: string, options: ClaudeConnectInstallationPreviewOptions): ClaudeConnectInstallationStatus {
  const planned = plan(projectRoot, options);
  const { owned, source, preview } = planned;
  if (options.expectedPackageHash !== undefined && options.expectedPackageHash !== preview.packageHash)
    return fail('installation_preview_changed');
  if (options.expectedInstalledHash !== undefined && options.expectedInstalledHash !== preview.installedHash)
    return fail('installation_preview_changed');
  if (preview.blockers.length || !owned) return preview;
  if (preview.operation === 'remove' && !owned.manifest) return preview;
  if (preview.operation === 'install' && !source) return preview;
  if (preview.operation === 'install' && owned.manifest && !preview.changes.length) return preview;
  const createdDirectories: string[] = [];
  const ensure = (path: string) => {
    let relativePath = '';
    for (const part of path.split('/')) {
      relativePath = relativePath ? `${relativePath}/${part}` : part;
      const stat = entry(projectRoot, relativePath);
      if (stat) { if (!stat.isDirectory()) fail('unsafe_path'); }
      else { mkdirSync(join(projectRoot, relativePath), { mode: 0o700 }); createdDirectories.push(relativePath); }
    }
  };
  const transaction = `${metadata}/transaction-${randomUUID()}`;
  let moved = false, installed = false, committed = false, rollbackFailed = false, locked = false, staged = false;
  try {
    ensure(metadata);
    mkdirSync(join(projectRoot, metadata, 'installation-lock'), { mode: 0o700 }); locked = true;
    durablePrivateBytes(projectRoot, `${metadata}/installation-lock/owner.json`, Buffer.from(JSON.stringify({ pid: process.pid })));
    ensure('.claude/skills');
    ensure(transaction);
    staged = true;
    if (preview.operation === 'install' && source) {
      ensure(`${transaction}/package`);
      for (const [path, bytes] of source.files) durablePrivateBytes(projectRoot, `${transaction}/package/${path}`, bytes);
      const manifest: Manifest = { schema_version: 1, package: 'harness-connect', root_identity: owned.identity,
        files: [...source.files].sort(([a], [b]) => a.localeCompare(b)).map(([path, bytes]) => ({
          path, shipped_sha256: source.shipped.has(path) ? hashBytes(source.shipped.get(path) ?? Buffer.alloc(0)) : null,
          installed_sha256: hashBytes(bytes),
        })) };
      durablePrivateBytes(projectRoot, `${transaction}/manifest.json`, Buffer.from(JSON.stringify(manifest) + '\n'));
    }
    const current = inspectOwned(projectRoot);
    if (current.identity !== owned.identity || bundleHash(current.files) !== bundleHash(owned.files) ||
      [...owned.identities].some(([path, identity]) => current.identities.get(path) !== identity) ||
      !((current.bytes === null && owned.bytes === null) || current.bytes?.equals(owned.bytes ?? Buffer.alloc(0)))) fail('changed_path');
    if (owned.manifest) { renameSync(join(projectRoot, destination), join(projectRoot, transaction, 'previous')); moved = true; }
    if (preview.operation === 'install') {
      renameSync(join(projectRoot, transaction, 'package'), join(projectRoot, destination)); installed = true;
      renameSync(join(projectRoot, transaction, 'manifest.json'), join(projectRoot, manifestPath));
    } else unlinkSync(join(projectRoot, manifestPath));
    committed = true;
  } catch (error) {
    try {
      if (installed) {
        if (rootIdentity(projectRoot) !== owned.identity || !source ||
          bundleHash(tree(join(projectRoot, destination))) !== bundleHash(source.files)) fail('package_drift');
        rmSync(join(projectRoot, destination), { recursive: true });
      }
      if (moved) renameSync(join(projectRoot, transaction, 'previous'), join(projectRoot, destination));
    } catch { rollbackFailed = true; throw new ClaudeConnectInstallationError('installation_rollback_failed'); }
    throw new ClaudeConnectInstallationError(blocker(error));
  } finally {
    try {
      if (staged && !rollbackFailed) {
        if (committed && moved && bundleHash(tree(join(projectRoot, transaction, 'previous'))) !== bundleHash(owned.files)) {
          fail('installation_cleanup_failed');
        }
        rmSync(join(projectRoot, transaction), { recursive: true, force: true });
      }
    } finally {
      if (locked && !rollbackFailed) {
        if (entry(projectRoot, `${metadata}/installation-lock/owner.json`))
          unlinkSync(join(projectRoot, metadata, 'installation-lock/owner.json'));
        rmdirSync(join(projectRoot, metadata, 'installation-lock'));
      }
    }
    if (!committed && !rollbackFailed) {
      for (const path of createdDirectories.reverse()) {
        if (entry(projectRoot, path)?.isDirectory() && readdirSync(join(projectRoot, path)).length === 0) rmdirSync(join(projectRoot, path));
      }
    }
  }
  return plan(projectRoot, options).preview;
}
/** Caller must resolve projectRoot from its registered project before this explicit apply. */
export function installClaudeConnectInstallation(projectRoot: string, options: ClaudeConnectInstallationOptions = {}): ClaudeConnectInstallationStatus {
  return apply(projectRoot, { ...options, operation: 'install' });
}
/** Receipts and transcripts are deliberately outside package ownership. */
export function removeClaudeConnectInstallation(projectRoot: string, options: ClaudeConnectInstallationOptions = {}): ClaudeConnectInstallationStatus {
  return apply(projectRoot, { ...options, operation: 'remove' });
}

/** Only a proved-dead, clean transaction can release its owned metadata lock. */
export function recoverClaudeConnectInstallationLock(
  projectRoot: string, options: ClaudeConnectInstallationOptions = {},
): ClaudeConnectInstallationStatus {
  inspectOwned(projectRoot);
  const lock = `${metadata}/installation-lock`;
  if (!entry(projectRoot, lock)) return statusClaudeConnectInstallation(projectRoot, options);
  const ownerPath = `${lock}/owner.json`;
  if (!entry(projectRoot, ownerPath)) return fail('installation_recovery_required');
  const owner = lockOwnerSchema.parse(readStrictJson(readRepositoryFile(projectRoot, ownerPath)));
  try { process.kill(owner.pid, 0); return fail('installation_busy'); }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error;
  }
  if (readdirSync(join(projectRoot, lock)).some(name => name !== 'owner.json') ||
    readdirSync(join(projectRoot, metadata)).some(name => name.startsWith('transaction-')))
    return fail('installation_recovery_required');
  unlinkSync(join(projectRoot, ownerPath));
  rmdirSync(join(projectRoot, lock));
  return statusClaudeConnectInstallation(projectRoot, options);
}
