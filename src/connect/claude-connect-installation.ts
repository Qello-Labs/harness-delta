import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, unlinkSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

import { durablePrivateBytes, hashBytes, readRepositoryFile, readStrictJson, safeRelativePath } from '../core/repository-files.js';
import { packagedSkillPath } from '../package-paths.js';

const destination = '.claude/skills/harness-connect';
const metadata = '.harness-delta/claude-connect';
const manifestPath = `${metadata}/installation.json`;
const configPath = 'scripts/claude-connect-config.mjs';
const windowReceiptDirectory = '.harness-delta/claude-window-receipts';
const windowBundleRevision = 'claude-window-bundle-v1';
const promotedBundleRevision = 'claude-promoted-bundle-v1';
const promotedReceiptDirectory = '.harness-delta/claude-promoted-receipts';
const promotedConfigPath = 'scripts/claude-promoted-connect-config.mjs';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const relative = z.string().refine(safeRelativePath);
const manifestSchema = z.strictObject({
  schema_version: z.literal(1),
  package: z.literal('harness-connect'),
  root_identity: z.string(),
  files: z
    .array(
      z.strictObject({
        path: relative,
        shipped_sha256: digest.nullable(),
        installed_sha256: digest
      })
    )
    .min(1)
    .max(256)
});
const windowManifestSchema = manifestSchema.extend({
  schema_version: z.literal(2),
  bundle_mode: z.literal('ordinary_window'),
  bundle_revision: z.literal(windowBundleRevision)
});
const promotedManifestSchema = manifestSchema.extend({
  schema_version: z.literal(3),
  bundle_mode: z.literal('promoted'),
  bundle_revision: z.literal(promotedBundleRevision)
});
const installationManifestSchema = z.union([manifestSchema, windowManifestSchema, promotedManifestSchema]);
type Manifest = z.infer<typeof installationManifestSchema>;
const lockOwnerSchema = z.strictObject({ pid: z.number().int().positive() });
export interface ClaudeConnectInstallationOptions {
  readonly bundleMode?: 'exact' | 'ordinary_window';
  /** Trusted development seam, never a UI-selected destination. */
  readonly packageRoot?: string;
  readonly windowPackageRoot?: string;
  readonly promotedPackageRoot?: string;
  readonly productVersion?: string | undefined;
  readonly promotedInUse?: boolean | (() => boolean) | undefined;
  readonly quiescentBoundaryConfirmed?: boolean;
  /** Trusted backend proof; never discovers native processes or sources. */
  readonly windowInUse?: boolean | (() => boolean);
  readonly expectedPackageHash?: string | null;
  readonly expectedInstalledHash?: string | null;
}
export type ClaudePromotedConnectInstallationOptions = Omit<ClaudeConnectInstallationOptions, 'bundleMode'> & { readonly bundleMode: 'promoted' };
type InstallationOptions = ClaudeConnectInstallationOptions | ClaudePromotedConnectInstallationOptions;
export type ClaudeConnectInstallationPreviewOptions = InstallationOptions & {
  readonly operation?: 'install' | 'remove';
};
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
  readonly bundleMode?: 'ordinary_window' | 'promoted';
  readonly bundleRevision?: typeof windowBundleRevision | typeof promotedBundleRevision;
  readonly producerContract?: 'promoted_producer_contract_unverified';
  readonly requiresFreshRoots?: true;
  readonly hookRegistration: 'unverified';
  readonly blockers: readonly string[];
}
export interface ClaudeConnectInstallationPreview extends ClaudeConnectInstallationStatus {
  readonly operation: 'install' | 'remove';
  readonly changes: readonly ClaudeConnectInstallationChange[];
}
export class ClaudeConnectInstallationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ClaudeConnectInstallationError';
  }
}
const fail = (code: string): never => {
  throw new ClaudeConnectInstallationError(code);
};
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
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
    if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) fail('unsafe_path');
    if (
      stat.isDirectory() &&
      ((stat.mode & 0o022) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid() && !(source && stat.uid === 0)))
    ) {
      fail('unsafe_path');
    }
    if (index === parts.length - 1) return stat;
  }
  return null;
}
function rootIdentity(root: string, source = false): string {
  const stat = lstatSync(root, { bigint: true });
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    realpathSync(root) !== resolve(root) ||
    (stat.mode & 0o022n) !== 0n ||
    (typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid()) && !(source && stat.uid === 0n))
  ) {
    fail('unsafe_project_root');
  }
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
      if (!stat.isFile() || (!source && stat.nlink !== 1)) {
        fail('unsafe_path');
      }
      files.set(path, readRepositoryFile(root, path));
    }
    if (files.size > 256) fail('package_invalid');
  }
  return files;
}
const bundleHash = (files: Map<string, Buffer>, windowIdentity?: string) => {
  const hashes = [...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, bytes]) => [path, hashBytes(bytes)]);
  return hashBytes(
    JSON.stringify(
      windowIdentity === undefined
        ? hashes
        : {
            bundle_mode: 'ordinary_window',
            bundle_revision: windowBundleRevision,
            root_identity: windowIdentity,
            files: hashes
          }
    )
  );
};
function packageSource(options: InstallationOptions): { files: Map<string, Buffer>; shipped: Map<string, Buffer> } {
  const window = options.bundleMode === 'ordinary_window';
  const sourceRoot = options.packageRoot ?? packagedSkillPath('harness-connect');
  rootIdentity(sourceRoot, true);
  const shipped = tree(sourceRoot, '', true);
  for (const path of ['SKILL.md', 'scripts/connect.mjs', 'scripts/claude-session-hook.mjs']) {
    if (!shipped.has(path)) fail('package_invalid');
  }
  if (shipped.has(configPath)) fail('package_invalid');
  const files = new Map(shipped);
  files.set(
    configPath,
    Buffer.from(
      "import { fileURLToPath } from 'node:url';\n" +
        `process.env.HARNESS_DELTA_CLAUDE_RECEIPT_DIR = fileURLToPath(new URL('../../../../${metadata}/receipts/', import.meta.url));\n` +
        (window
          ? `process.env.HARNESS_DELTA_CLAUDE_WINDOW_RECEIPT_DIR = fileURLToPath(new URL('../../../../${windowReceiptDirectory}', import.meta.url));\n`
          : '')
    )
  );
  // Both recorder and locator must use the same project-local directory without settings edits.
  for (const path of ['scripts/connect.mjs', 'scripts/claude-session-hook.mjs']) {
    const bytes = shipped.get(path);
    if (!bytes) return fail('package_invalid');
    const text = bytes.toString('utf8');
    const split = text.startsWith('#!') ? text.indexOf('\n') + 1 : 0;
    files.set(path, Buffer.from(text.slice(0, split) + "import './claude-connect-config.mjs';\n" + text.slice(split)));
  }
  if (window) {
    const windowRoot = options.windowPackageRoot ?? packagedSkillPath('harness-connect-window-claude');
    const selected = tree(windowRoot, '', true);
    for (const path of ['SKILL.md', 'scripts/connect.mjs', 'scripts/claude-session-hook.mjs']) if (!selected.has(path)) fail('package_invalid');
    if (selected.has(configPath)) fail('package_invalid');
    for (const [path, bytes] of selected) {
      const installed =
        path === 'scripts/connect.mjs'
          ? 'scripts/connect-window.mjs'
          : path === 'scripts/claude-session-hook.mjs'
            ? 'scripts/claude-window-session-hook.mjs'
            : path;
      if (path !== 'SKILL.md' && shipped.has(installed)) {
        fail('package_invalid');
      }
      shipped.set(installed, bytes);
      if (path === 'scripts/claude-session-hook.mjs') {
        const text = bytes.toString('utf8');
        const split = text.startsWith('#!') ? text.indexOf('\n') + 1 : 0;
        files.set(installed, Buffer.from(text.slice(0, split) + "import './claude-connect-config.mjs';\n" + text.slice(split)));
      } else files.set(installed, bytes);
    }
    if (files.size > 256) fail('package_invalid');
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
      for (const name of readdirSync(join(projectRoot, path))) {
        pin(`${path}/${name}`);
      }
    }
  };
  for (const path of ['.claude', '.claude/skills', destination, '.harness-delta', metadata, manifestPath]) pin(path);
  const target = entry(projectRoot, destination);
  const privateDirectory = entry(projectRoot, metadata);
  if (
    privateDirectory &&
    (!privateDirectory.isDirectory() ||
      (privateDirectory.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && privateDirectory.uid !== process.getuid()))
  ) {
    fail('metadata_unsafe');
  }
  const manifestStat = entry(projectRoot, manifestPath);
  if (!manifestStat) {
    if (target) fail('package_unowned');
    return {
      identity,
      identities,
      manifest: null,
      bytes: null,
      files: new Map<string, Buffer>()
    };
  }
  if (
    !manifestStat.isFile() ||
    manifestStat.nlink !== 1 ||
    (manifestStat.mode & 0o077) !== 0 ||
    (typeof process.getuid === 'function' && manifestStat.uid !== process.getuid())
  ) {
    fail('manifest_unsafe');
  }
  const bytes = readRepositoryFile(projectRoot, manifestPath);
  const parsed = installationManifestSchema.safeParse(readStrictJson(bytes));
  if (!parsed.success) return fail('manifest_invalid');
  const manifest = parsed.data;
  if (manifest.root_identity !== identity) fail('changed_project_root');
  if (!target?.isDirectory()) fail('package_drift');
  const files = tree(join(projectRoot, destination));
  const names = new Set(manifest.files.map(file => file.path));
  if (names.size !== manifest.files.length || names.size !== files.size) {
    fail('package_drift');
  }
  for (const file of manifest.files) {
    const installed = files.get(file.path);
    if (!installed || hashBytes(installed) !== file.installed_sha256) {
      fail('package_drift');
    }
  }
  return { identity, identities, manifest, bytes, files };
}
function blocker(error: unknown): string {
  return error instanceof ClaudeConnectInstallationError ? error.code : 'installation_unavailable';
}
function assertWindowIdle(options: InstallationOptions): void {
  if (typeof options.windowInUse === 'function' ? options.windowInUse() : options.windowInUse) fail('ordinary_installation_in_use');
}
function metadataBlockers(projectRoot: string, window: boolean): string[] {
  const blockers: string[] = [];
  if (window) {
    try {
      const receipts = entry(projectRoot, windowReceiptDirectory);
      if (
        receipts &&
        (!receipts.isDirectory() || (receipts.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && receipts.uid !== process.getuid()))
      ) {
        fail('metadata_unsafe');
      }
    } catch (error) {
      blockers.push(blocker(error));
    }
  }
  try {
    if (entry(projectRoot, `${metadata}/installation-lock`)) {
      const ownerPath = `${metadata}/installation-lock/owner.json`;
      const owner = lockOwnerSchema.safeParse(entry(projectRoot, ownerPath) ? readStrictJson(readRepositoryFile(projectRoot, ownerPath)) : null);
      if (!owner.success) blockers.push('installation_recovery_required');
      else {
        try {
          process.kill(owner.data.pid, 0);
          blockers.push('installation_busy');
        } catch (error) {
          blockers.push(error instanceof Error && 'code' in error && error.code === 'ESRCH' ? 'installation_recovery_required' : 'installation_busy');
        }
      }
    }
  } catch (error) {
    blockers.push(blocker(error));
  }
  return blockers;
}
function assertPromotedIdle(options: InstallationOptions): void {
  const inUse = typeof options.promotedInUse === 'function' ? options.promotedInUse() : options.promotedInUse;
  if (inUse === undefined) fail('promoted_in_use_unverified');
  if (inUse !== false) fail('promoted_installation_in_use');
}
function promotedSettingsHash(projectRoot: string): string {
  const conflicting = (value: unknown): boolean => {
    if (typeof value === 'string') {
      return /harness-connect|claude-(?:window-)?session-hook\.mjs/.test(value);
    }
    if (Array.isArray(value)) return value.some(conflicting);
    return value !== null && typeof value === 'object' && Object.values(value).some(conflicting);
  };
  return hashBytes(
    JSON.stringify(
      ['.claude/settings.json', '.claude/settings.local.json'].map(path => {
        const stat = entry(projectRoot, path);
        if (!stat) return [path, null];
        if (!stat.isFile() || stat.nlink !== 1) {
          return fail('unsafe_path');
        }
        const bytes = readRepositoryFile(projectRoot, path);
        const settings = z.object({ hooks: z.unknown().optional() }).parse(readStrictJson(bytes));
        if (conflicting(settings.hooks)) {
          fail('promoted_registration_conflict');
        }
        return [path, hashBytes(bytes)];
      })
    )
  );
}
function promotedSource(options: InstallationOptions, owned: ReturnType<typeof inspectOwned>) {
  if (!options.productVersion || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(options.productVersion)) {
    return fail('promoted_product_version_invalid');
  }
  const base = owned.manifest ? { files: new Map(owned.files), shipped: new Map<string, Buffer>() } : packageSource({ ...options, bundleMode: 'exact' });
  const selected = tree(options.promotedPackageRoot ?? packagedSkillPath('harness-connect-promoted-claude'), '', true);
  const paths = ['SKILL.md', 'scripts/connect.mjs', 'scripts/claude-session-hook.mjs'];
  if (selected.size !== paths.length || paths.some(path => !selected.has(path))) return fail('package_invalid');
  for (const [path, bytes] of selected) {
    const installed =
      path === 'scripts/connect.mjs'
        ? 'scripts/connect-promoted.mjs'
        : path === 'scripts/claude-session-hook.mjs'
          ? 'scripts/claude-promoted-session-hook.mjs'
          : path;
    if (path !== 'SKILL.md' && owned.manifest?.schema_version !== 3 && base.files.has(installed)) fail('promoted_registration_conflict');
    base.shipped.set(installed, bytes);
    const text = bytes.toString('utf8');
    const split = text.startsWith('#!') ? text.indexOf('\n') + 1 : 0;
    base.files.set(
      installed,
      path === 'SKILL.md' ? bytes : Buffer.from(text.slice(0, split) + "import './claude-promoted-connect-config.mjs';\n" + text.slice(split))
    );
  }
  if (owned.manifest?.schema_version !== 3 && base.files.has(promotedConfigPath)) fail('promoted_registration_conflict');
  base.files.set(
    promotedConfigPath,
    Buffer.from(
      "import { fileURLToPath } from 'node:url';\n" +
        "import { resolve } from 'node:path';\n" +
        `process.env.HARNESS_DELTA_PROMOTED_RECEIPT_DIR = fileURLToPath(new URL('../../../../${promotedReceiptDirectory}', import.meta.url));\n` +
        "process.env.HARNESS_DELTA_PROMOTED_PROJECT_ROOT = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));\n" +
        `process.env.HARNESS_DELTA_PROMOTED_PRODUCT_VERSION = ${JSON.stringify(options.productVersion)};\n`
    )
  );
  if (base.files.size > 256) fail('package_invalid');
  return base;
}
function promotedReceiptIdentity(projectRoot: string): string | null {
  const receipts = entry(projectRoot, promotedReceiptDirectory);
  if (!receipts) return null;
  if (!receipts.isDirectory() || (receipts.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && receipts.uid !== process.getuid())) {
    fail('metadata_unsafe');
  }
  return `${receipts.dev}:${receipts.ino}:${receipts.birthtimeMs}`;
}
function promotedHash(
  files: Map<string, Buffer>,
  identity: string,
  localState: {
    readonly settingsHash: string | null;
    readonly receiptsIdentity: string | null;
  }
) {
  return hashBytes(
    JSON.stringify({
      bundle_mode: 'promoted',
      bundle_revision: promotedBundleRevision,
      root_identity: identity,
      settings_sha256: localState.settingsHash,
      receipts_identity: localState.receiptsIdentity,
      files_sha256: bundleHash(files)
    })
  );
}
function installationInputs(projectRoot: string, options: ClaudeConnectInstallationPreviewOptions) {
  const operation = options.operation ?? 'install';
  let owned: ReturnType<typeof inspectOwned> | undefined;
  let source: ReturnType<typeof packageSource> | undefined;
  const blockers: string[] = [];
  try {
    owned = inspectOwned(projectRoot);
  } catch (error) {
    blockers.push(blocker(error));
  }
  const installedWindow = owned?.manifest?.schema_version === 2;
  const installedPromoted = owned?.manifest?.schema_version === 3;
  const bundleMode = options.bundleMode ?? (installedWindow ? 'ordinary_window' : 'exact');
  const promoted = bundleMode === 'promoted';
  let settingsHash: string | null = null;
  let receiptsIdentity: string | null = null;
  if (installedPromoted && (!promoted || operation === 'remove')) {
    blockers.push('promoted_cutover_required');
  }
  if (promoted) {
    try {
      assertPromotedIdle(options);
      settingsHash = promotedSettingsHash(projectRoot);
      receiptsIdentity = promotedReceiptIdentity(projectRoot);
    } catch (error) {
      blockers.push(blocker(error));
    }
  }
  const window = bundleMode === 'ordinary_window';
  const guardedWindow = window || installedWindow;
  if (owned) blockers.push(...metadataBlockers(projectRoot, guardedWindow));
  try {
    source = promoted && owned ? promotedSource(options, owned) : packageSource({ ...options, bundleMode });
  } catch (error) {
    if (operation === 'install') {
      blockers.push(promoted && error instanceof ClaudeConnectInstallationError ? error.code : 'package_source_unavailable');
    }
  }
  const changes: ClaudeConnectInstallationChange[] = [];
  const wanted = operation === 'remove' ? new Map<string, Buffer>() : source?.files;
  if (owned && wanted && !blockers.length) {
    for (const path of [...new Set([...owned.files.keys(), ...wanted.keys()])].sort()) {
      const before = owned.files.get(path),
        after = wanted.get(path);
      const beforeHash = before ? hashBytes(before) : null,
        afterHash = after ? hashBytes(after) : null;
      if (beforeHash !== afterHash) {
        changes.push({
          path: `${destination}/${path}`,
          action: beforeHash === null ? 'create' : afterHash === null ? 'delete' : 'update',
          beforeHash,
          afterHash
        });
      }
    }
  }
  if (promoted && operation === 'install' && owned && !blockers.length && receiptsIdentity === null) {
    changes.push({
      path: promotedReceiptDirectory,
      action: 'create',
      beforeHash: null,
      afterHash: hashBytes('directory:0700')
    });
  }
  if (promoted && changes.length && options.quiescentBoundaryConfirmed !== true) blockers.push('promoted_quiescent_boundary_unconfirmed');
  if (guardedWindow && owned && !blockers.length && (changes.length || (operation === 'install' && window !== installedWindow))) {
    try {
      assertWindowIdle(options);
    } catch (error) {
      blockers.push(blocker(error));
    }
  }
  return {
    operation,
    owned,
    source,
    blockers,
    changes,
    window,
    guardedWindow,
    promoted,
    settingsHash,
    receiptsIdentity,
    installedWindow,
    installedPromoted
  };
}
function plan(projectRoot: string, options: ClaudeConnectInstallationPreviewOptions) {
  const { operation, owned, source, blockers, changes, window, guardedWindow, promoted, settingsHash, receiptsIdentity, installedWindow, installedPromoted } =
    installationInputs(projectRoot, options);
  const localState = { settingsHash, receiptsIdentity };
  const preview: ClaudeConnectInstallationPreview = {
    state: blockers.length
      ? 'blocked'
      : !owned?.manifest
        ? 'absent'
        : source &&
            (window !== installedWindow ||
              promoted !== installedPromoted ||
              (promoted && receiptsIdentity === null) ||
              bundleHash(source.files) !== bundleHash(owned.files))
          ? 'update_available'
          : 'installed',
    source: source ? 'available' : 'unavailable',
    packageHash:
      source && (!window || owned)
        ? promoted && owned
          ? promotedHash(source.files, owned.identity, localState)
          : bundleHash(source.files, window ? owned?.identity : undefined)
        : null,
    installedHash: owned?.manifest
      ? installedPromoted
        ? promotedHash(owned.files, owned.identity, localState)
        : bundleHash(owned.files, installedWindow ? owned.identity : undefined)
      : null,
    destination,
    receiptDirectory: promoted ? promotedReceiptDirectory : window ? windowReceiptDirectory : `${metadata}/receipts`,
    ...(window
      ? {
          bundleMode: 'ordinary_window' as const,
          bundleRevision: windowBundleRevision
        }
      : {}),
    ...(promoted
      ? {
          bundleMode: 'promoted' as const,
          bundleRevision: promotedBundleRevision,
          producerContract: 'promoted_producer_contract_unverified' as const,
          requiresFreshRoots: true as const
        }
      : {}),
    hookRegistration: 'unverified',
    operation,
    changes: blockers.length ? [] : changes,
    blockers
  };
  return {
    preview,
    owned,
    source,
    window,
    guardedWindow,
    promoted,
    settingsHash,
    receiptsIdentity
  };
}
export function previewClaudeConnectInstallation(projectRoot: string, options: ClaudeConnectInstallationPreviewOptions = {}): ClaudeConnectInstallationPreview {
  return plan(projectRoot, options).preview;
}
let verifiedPromotedInstallation: string | undefined;
function promotedInstallationInputs(projectRoot: string, options: ClaudePromotedConnectInstallationOptions): string | undefined {
  try {
    const entries = new Map<string, BigIntStats | undefined>();
    let cacheable = true;
    const pin = (path: string): BigIntStats | undefined => {
      if (entries.has(path)) return entries.get(path);
      const parent = dirname(path);
      if (!anchors.has(path) && parent !== path && !pin(parent)?.isDirectory()) {
        entries.set(path, undefined);
        return undefined;
      }
      const stat = lstatSync(path, {
        bigint: true,
        throwIfNoEntry: false
      });
      entries.set(path, stat);
      if (stat?.isSymbolicLink()) cacheable = false;
      return stat;
    };
    let count = 0;
    const visit = (path: string, depth = 0): void => {
      if (++count > 2048 || depth > 16) {
        cacheable = false;
        return;
      }
      const stat = pin(path);
      if (stat?.isDirectory()) {
        for (const name of readdirSync(path).sort()) {
          visit(join(path, name), depth + 1);
        }
      }
    };
    const promotedPackageRoot = options.promotedPackageRoot ?? packagedSkillPath('harness-connect-promoted-claude');
    const anchors = new Set([resolve(projectRoot), resolve(promotedPackageRoot)]);
    // External parent contents are unrelated, but their canonical path safety stays live.
    for (const path of anchors) {
      if (realpathSync(path) !== path) return undefined;
    }
    for (const path of [join(projectRoot, destination), promotedPackageRoot]) {
      visit(resolve(path));
    }
    // Receipt entries are not installer-owned; only their directory identity is relevant.
    for (const path of [manifestPath, '.claude/settings.json', '.claude/settings.local.json', promotedReceiptDirectory]) pin(resolve(projectRoot, path));
    return cacheable
      ? JSON.stringify([
          projectRoot,
          options.productVersion,
          options.bundleMode,
          options.packageRoot,
          promotedPackageRoot,
          [...entries].map(([path, stat]) => [
            path,
            stat
              ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.birthtimeNs}:${stat.mode}:${stat.uid}:${stat.gid}:${stat.nlink}`
              : null
          ])
        ])
      : undefined;
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error)) throw error;
    // Sampling failures must leave refusal semantics to the original verifier.
    return undefined;
  }
}
export function verifyClaudePromotedConnectContract(projectRoot: string, options: ClaudePromotedConnectInstallationOptions) {
  const inputs = promotedInstallationInputs(projectRoot, options);
  if (inputs === undefined || inputs !== verifiedPromotedInstallation) {
    verifiedPromotedInstallation = undefined;
    const owned = inspectOwned(projectRoot);
    if (owned.manifest?.schema_version !== 3) {
      fail('promoted_producer_contract_unverified');
    }
    promotedSettingsHash(projectRoot);
    if (promotedReceiptIdentity(projectRoot) === null) {
      fail('metadata_unsafe');
    }
    const source = promotedSource(options, owned);
    if (source.files.size !== owned.files.size) fail('package_drift');
    for (const [path, bytes] of source.files) {
      if (!owned.files.get(path)?.equals(bytes)) fail('package_drift');
    }
    if (inputs !== undefined && inputs === promotedInstallationInputs(projectRoot, options)) verifiedPromotedInstallation = inputs;
  }
  return {
    bundleContract: 'claude-promoted-bundle-v1' as const,
    producerContract: 'promoted-payload-v1' as const,
    receiptDirectory: join(projectRoot, promotedReceiptDirectory)
  };
}

export function statusClaudeConnectInstallation(
  projectRoot: string,
  options?: ClaudeConnectInstallationOptions
): Omit<ClaudeConnectInstallationStatus, 'bundleMode' | 'bundleRevision'> & {
  readonly bundleMode?: 'ordinary_window';
  readonly bundleRevision?: typeof windowBundleRevision;
};
export function statusClaudeConnectInstallation(projectRoot: string, options: ClaudePromotedConnectInstallationOptions): ClaudeConnectInstallationStatus;
export function statusClaudeConnectInstallation(projectRoot: string, options: InstallationOptions): ClaudeConnectInstallationStatus;
export function statusClaudeConnectInstallation(projectRoot: string, options: InstallationOptions = {}): ClaudeConnectInstallationStatus {
  const result = plan(projectRoot, options).preview;
  return {
    state: result.state,
    source: result.source,
    packageHash: result.packageHash,
    installedHash: result.installedHash,
    destination: result.destination,
    receiptDirectory: result.receiptDirectory,
    ...(result.bundleMode
      ? {
          bundleMode: result.bundleMode,
          bundleRevision: result.bundleRevision
        }
      : {}),
    ...(result.producerContract
      ? {
          producerContract: result.producerContract,
          requiresFreshRoots: result.requiresFreshRoots
        }
      : {}),
    hookRegistration: result.hookRegistration,
    blockers: result.blockers
  };
}
function assertPreviewMatches(options: ClaudeConnectInstallationPreviewOptions, preview: ClaudeConnectInstallationPreview): void {
  if (options.expectedPackageHash !== undefined && options.expectedPackageHash !== preview.packageHash) fail('installation_preview_changed');
  if (options.expectedInstalledHash !== undefined && options.expectedInstalledHash !== preview.installedHash) fail('installation_preview_changed');
}
function assertOwnedUnchanged(projectRoot: string, owned: ReturnType<typeof inspectOwned>): void {
  const current = inspectOwned(projectRoot);
  if (
    current.identity !== owned.identity ||
    bundleHash(current.files) !== bundleHash(owned.files) ||
    [...owned.identities].some(([path, identity]) => current.identities.get(path) !== identity) ||
    !((current.bytes === null && owned.bytes === null) || current.bytes?.equals(owned.bytes ?? Buffer.alloc(0)))
  ) {
    fail('changed_path');
  }
}
function installedManifest(
  owned: ReturnType<typeof inspectOwned>,
  source: ReturnType<typeof packageSource>,
  bundleMode: 'exact' | 'ordinary_window' | 'promoted'
): Manifest {
  const common = {
    package: 'harness-connect',
    root_identity: owned.identity,
    files: [...source.files]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, bytes]) => ({
        path,
        shipped_sha256: source.shipped.has(path)
          ? hashBytes(source.shipped.get(path) ?? Buffer.alloc(0))
          : bundleMode === 'promoted'
            ? (owned.manifest?.files.find(file => file.path === path)?.shipped_sha256 ?? null)
            : null,
        installed_sha256: hashBytes(bytes)
      }))
  } as const;
  if (bundleMode === 'promoted') {
    return {
      ...common,
      schema_version: 3,
      bundle_mode: 'promoted',
      bundle_revision: promotedBundleRevision
    };
  }
  if (bundleMode === 'ordinary_window') {
    return {
      ...common,
      schema_version: 2,
      bundle_mode: 'ordinary_window',
      bundle_revision: windowBundleRevision
    };
  }
  return { schema_version: 1, ...common };
}
function assertCutoverBoundary(projectRoot: string, options: ClaudeConnectInstallationPreviewOptions, planned: ReturnType<typeof plan>): void {
  if (planned.guardedWindow) assertWindowIdle(options);
  if (planned.promoted) {
    assertPromotedIdle(options);
    if (options.quiescentBoundaryConfirmed !== true) {
      fail('promoted_quiescent_boundary_unconfirmed');
    }
    if (promotedSettingsHash(projectRoot) !== planned.settingsHash) {
      fail('installation_preview_changed');
    }
    const currentReceipts = promotedReceiptIdentity(projectRoot);
    if (planned.receiptsIdentity !== null && currentReceipts !== planned.receiptsIdentity) fail('installation_preview_changed');
  }
}
function apply(projectRoot: string, options: ClaudeConnectInstallationPreviewOptions): ClaudeConnectInstallationStatus {
  const planned = plan(projectRoot, options);
  const { owned, source, preview, window, guardedWindow, promoted } = planned;
  assertPreviewMatches(options, preview);
  if (preview.blockers.length || !owned) return preview;
  if (preview.operation === 'remove' && !owned.manifest) return preview;
  if (preview.operation === 'install' && !source) return preview;
  if (
    preview.operation === 'install' &&
    owned.manifest &&
    !preview.changes.length &&
    window === (owned.manifest.schema_version === 2) &&
    promoted === (owned.manifest.schema_version === 3)
  ) {
    return preview;
  }
  if ((guardedWindow || promoted) && (options.expectedPackageHash === undefined || options.expectedInstalledHash === undefined)) {
    return fail('installation_preview_required');
  }
  const createdDirectories: string[] = [];
  const ensure = (path: string) => {
    if (rootIdentity(projectRoot) !== owned.identity) {
      fail('changed_project_root');
    }
    let relativePath = '';
    for (const part of path.split('/')) {
      relativePath = relativePath ? `${relativePath}/${part}` : part;
      const stat = entry(projectRoot, relativePath);
      if (stat) {
        if (!stat.isDirectory()) fail('unsafe_path');
      } else {
        mkdirSync(join(projectRoot, relativePath), { mode: 0o700 });
        createdDirectories.push(relativePath);
      }
    }
  };
  const transaction = `${metadata}/transaction-${randomUUID()}`;
  let moved = false,
    installed = false,
    committed = false,
    rollbackFailed = false,
    locked = false,
    staged = false;
  try {
    ensure(metadata);
    mkdirSync(join(projectRoot, metadata, 'installation-lock'), {
      mode: 0o700
    });
    locked = true;
    durablePrivateBytes(projectRoot, `${metadata}/installation-lock/owner.json`, Buffer.from(JSON.stringify({ pid: process.pid })));
    ensure('.claude/skills');
    ensure(transaction);
    staged = true;
    if (promoted) {
      ensure(promotedReceiptDirectory);
    }
    if (preview.operation === 'install' && source) {
      ensure(`${transaction}/package`);
      for (const [path, bytes] of source.files) {
        durablePrivateBytes(projectRoot, `${transaction}/package/${path}`, bytes);
      }
      const manifest = installedManifest(owned, source, promoted ? 'promoted' : window ? 'ordinary_window' : 'exact');
      durablePrivateBytes(projectRoot, `${transaction}/manifest.json`, Buffer.from(JSON.stringify(manifest) + '\n'));
    }
    assertOwnedUnchanged(projectRoot, owned);
    assertCutoverBoundary(projectRoot, options, planned);
    if (owned.manifest) {
      renameSync(join(projectRoot, destination), join(projectRoot, transaction, 'previous'));
      moved = true;
    }
    if (preview.operation === 'install') {
      renameSync(join(projectRoot, transaction, 'package'), join(projectRoot, destination));
      installed = true;
      renameSync(join(projectRoot, transaction, 'manifest.json'), join(projectRoot, manifestPath));
    } else unlinkSync(join(projectRoot, manifestPath));
    committed = true;
  } catch (error) {
    try {
      if (installed) {
        if (rootIdentity(projectRoot) !== owned.identity || !source || bundleHash(tree(join(projectRoot, destination))) !== bundleHash(source.files)) {
          fail('package_drift');
        }
        rmSync(join(projectRoot, destination), { recursive: true });
      }
      if (moved) {
        renameSync(join(projectRoot, transaction, 'previous'), join(projectRoot, destination));
      }
    } catch {
      rollbackFailed = true;
      throw new ClaudeConnectInstallationError('installation_rollback_failed');
    }
    throw new ClaudeConnectInstallationError(blocker(error));
  } finally {
    try {
      if (staged && !rollbackFailed) {
        if (rootIdentity(projectRoot) !== owned.identity) {
          fail('changed_project_root');
        }
        entry(projectRoot, transaction);
        if (committed && moved) {
          entry(projectRoot, `${transaction}/previous`);
        }
        if (committed && moved && bundleHash(tree(join(projectRoot, transaction, 'previous'))) !== bundleHash(owned.files)) {
          fail('installation_cleanup_failed');
        }
        rmSync(join(projectRoot, transaction), {
          recursive: true,
          force: true
        });
      }
    } finally {
      if (locked && !rollbackFailed) {
        if (entry(projectRoot, `${metadata}/installation-lock/owner.json`)) {
          unlinkSync(join(projectRoot, metadata, 'installation-lock/owner.json'));
        }
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
export function installClaudeConnectInstallation(projectRoot: string, options: InstallationOptions = {}): ClaudeConnectInstallationStatus {
  return apply(projectRoot, { ...options, operation: 'install' });
}
/** Receipts and transcripts are deliberately outside package ownership. */
export function removeClaudeConnectInstallation(projectRoot: string, options: InstallationOptions = {}): ClaudeConnectInstallationStatus {
  return apply(projectRoot, { ...options, operation: 'remove' });
}

/** Only a proved-dead, clean transaction can release its owned metadata lock. */
export function recoverClaudeConnectInstallationLock(projectRoot: string, options: InstallationOptions = {}): ClaudeConnectInstallationStatus {
  inspectOwned(projectRoot);
  const lock = `${metadata}/installation-lock`;
  if (!entry(projectRoot, lock)) {
    return statusClaudeConnectInstallation(projectRoot, options);
  }
  const ownerPath = `${lock}/owner.json`;
  if (!entry(projectRoot, ownerPath)) {
    return fail('installation_recovery_required');
  }
  const owner = lockOwnerSchema.parse(readStrictJson(readRepositoryFile(projectRoot, ownerPath)));
  try {
    process.kill(owner.pid, 0);
    return fail('installation_busy');
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error;
  }
  if (
    readdirSync(join(projectRoot, lock)).some(name => name !== 'owner.json') ||
    readdirSync(join(projectRoot, metadata)).some(name => name.startsWith('transaction-'))
  ) {
    return fail('installation_recovery_required');
  }
  unlinkSync(join(projectRoot, ownerPath));
  rmdirSync(join(projectRoot, lock));
  return statusClaudeConnectInstallation(projectRoot, options);
}
