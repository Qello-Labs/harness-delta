import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { durablePrivateBytes } from './harness-application-files.js';
import { hashBytes, readRepositoryFile, readStrictJson, safeRelativePath } from './harness-config.js';

const destination = '.agents/skills/harness-connect';
const metadata = '.harness-delta/codex-connect';
const receiptDirectory = `${metadata}/receipts`;
const recorder = `${metadata}/session-binding-codex-hook.mjs`;
const manifestPath = `${metadata}/installation.json`;
const hooksPath = '.codex/hooks.json';
const lockPath = `${metadata}/installation-lock`;
const events = ['SessionStart', 'SubagentStart'] as const;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const hookEntrySchema = z.strictObject({
  matcher: z.string().optional(),
  hooks: z.array(z.strictObject({ type: z.literal('command'), command: z.string() })).length(1),
});
const manifestSchema = z.strictObject({
  schema_version: z.literal(1),
  package: z.literal('harness-connect'),
  root_identity: z.string(),
  files: z.array(z.strictObject({
    path: z.string().refine(path => safeRelativePath(path) &&
      (path.startsWith(`${destination}/`) || path === recorder)),
    sha256: digest,
  })).min(2).max(257),
  hooks: z.strictObject({ SessionStart: hookEntrySchema, SubagentStart: hookEntrySchema }),
});
const lockOwnerSchema = z.strictObject({ pid: z.number().int().positive(), root_identity: z.string() });
type Manifest = z.infer<typeof manifestSchema>;
type HookEntries = Manifest['hooks'];
type JsonObject = Record<string, unknown>;

export interface CodexConnectInstallationOptions {
  readonly sourceRoots: readonly string[];
  readonly productVersion: string;
  /** Trusted development seams, never user-selected destinations. */
  readonly packageRoot?: string;
  readonly hookSource?: string;
  readonly expectedPackageHash?: string | null;
  readonly expectedInstalledHash?: string | null;
}
export interface CodexConnectInstallationPreviewOptions extends CodexConnectInstallationOptions {
  readonly operation?: 'install' | 'remove';
}
export interface CodexConnectInstallationChange {
  readonly path: string;
  readonly action: 'create' | 'update' | 'delete';
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
}
export interface CodexConnectInstallationStatus {
  readonly state: 'absent' | 'installed' | 'update_available' | 'blocked';
  readonly source: 'available' | 'unavailable';
  /** Review token includes the full current hooks hash and project identity. */
  readonly packageHash: string | null;
  readonly installedHash: string | null;
  readonly destination: typeof destination;
  readonly receiptDirectory: typeof receiptDirectory;
  readonly hookRegistration: 'unverified';
  readonly blockers: readonly string[];
}
export interface CodexConnectInstallationPreview extends CodexConnectInstallationStatus {
  readonly operation: 'install' | 'remove';
  readonly changes: readonly CodexConnectInstallationChange[];
  readonly beforeHooksHash: string | null;
}
export class CodexConnectInstallationError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'CodexConnectInstallationError'; }
}
const fail = (code: string): never => { throw new CodexConnectInstallationError(`codex_connect_${code}`); };
const blocker = (error: unknown) => error instanceof CodexConnectInstallationError
  ? error.code : 'codex_connect_installation_unavailable';
const missing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';
const identity = (stat: Stats) => `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
function rootIdentity(root: string, source = false): string {
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(root) !== resolve(root) ||
    (stat.mode & 0o022) !== 0 || (typeof process.getuid === 'function' &&
      stat.uid !== process.getuid() && !(source && stat.uid === 0))) fail('unsafe_project_root');
  return identity(stat);
}
function entry(root: string, path: string) {
  if (!safeRelativePath(path)) return fail('unsafe_path');
  let current = root;
  const parts = path.split('/');
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    let stat;
    try { stat = lstatSync(current); } catch (error) { if (missing(error)) return null; throw error; }
    if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory()) ||
      (stat.mode & 0o022) !== 0 || (typeof process.getuid === 'function' &&
        stat.uid !== process.getuid() && stat.uid !== 0) ||
      (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) fail('unsafe_path');
    if (index === parts.length - 1) return stat;
  }
  return null;
}
function privateDirectory(root: string, path: string) {
  const stat = entry(root, path);
  if (stat && (!stat.isDirectory() || (stat.mode & 0o077) !== 0 ||
    (typeof process.getuid === 'function' && stat.uid !== process.getuid()))) fail('metadata_unsafe');
  return stat;
}
function bytesAt(root: string, path: string): Buffer | null {
  const stat = entry(root, path);
  if (!stat) return null;
  if (!stat.isFile()) return fail('unsafe_path');
  return readRepositoryFile(root, path);
}
function tree(root: string): Map<string, Buffer> {
  rootIdentity(root, true);
  const files = new Map<string, Buffer>();
  let count = 0, size = 0;
  const visit = (prefix: string, depth: number) => {
    if (depth > 16) fail('package_limit');
    const names = readdirSync(join(root, prefix)).sort();
    if (prefix && names.length === 0) fail('unowned_directory');
    for (const name of names) {
      if (++count > 512) fail('package_limit');
      const path = prefix ? `${prefix}/${name}` : name;
      const stat = entry(root, path);
      if (!stat) return fail('changed_path');
      if (stat.isDirectory()) visit(path, depth + 1);
      else {
        const bytes = readRepositoryFile(root, path);
        size += bytes.length;
        if (files.size >= 256 || size > 8 * 1048576) fail('package_limit');
        files.set(path, bytes);
      }
    }
  };
  visit('', 0);
  return files;
}
const bundleHash = (files: Map<string, Buffer>, hooks: HookEntries | null) => hashBytes(JSON.stringify({
  files: [...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, bytes]) => [path, hashBytes(bytes)]), hooks,
}));
const object = (value: unknown): JsonObject => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('hooks_invalid');
  return z.custom<JsonObject>().parse(value);
};
const equal = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equal(v, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const left = object(a), right = object(b);
    return Object.keys(left).length === Object.keys(right).length &&
      Object.keys(left).every(key => Object.hasOwn(right, key) && equal(left[key], right[key]));
  }
  return false;
};
function hookDocument(bytes: Buffer | null) {
  // Unlike shared configuration, hook documents permit arbitrary JSON keys.
  const parse = (input: Buffer): unknown => {
    if (input.length > 1048576 || !Buffer.from(input.toString('utf8')).equals(input)) return fail('hooks_invalid');
    const text = input.toString('utf8');
    let offset = 0;
    const ws = () => { while (offset < text.length && /[ \t\r\n]/.test(text[offset] ?? '')) offset++; };
    const string = (): string => {
      const start = offset++;
      while (offset < text.length) {
        if (text[offset] === '\\') offset += 2;
        else if (text[offset++] === '"') return z.string().parse(JSON.parse(text.slice(start, offset)));
      }
      return fail('hooks_invalid');
    };
    const value = (depth: number): unknown => {
      if (depth > 64) return fail('hooks_invalid');
      ws();
      const ch = text[offset];
      if (ch === '"') return string();
      if (ch === '{') {
        offset++; ws();
        const out: JsonObject = {}, keys = new Set<string>();
        if (text[offset] === '}') { offset++; return out; }
        for (;;) {
          ws(); if (text[offset] !== '"') return fail('hooks_invalid');
          const key = string();
          if (keys.has(key)) return fail('hooks_invalid');
          keys.add(key); ws(); if (text[offset++] !== ':') return fail('hooks_invalid');
          Object.defineProperty(out, key, { value: value(depth + 1), enumerable: true, writable: true, configurable: true });
          ws(); const end = text[offset++];
          if (end === '}') return out;
          if (end !== ',') return fail('hooks_invalid');
        }
      }
      if (ch === '[') {
        offset++; ws();
        const out: unknown[] = [];
        if (text[offset] === ']') { offset++; return out; }
        for (;;) {
          out.push(value(depth + 1)); ws();
          const end = text[offset++];
          if (end === ']') return out;
          if (end !== ',') return fail('hooks_invalid');
        }
      }
      const token = text.slice(offset).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/)?.[0];
      if (!token) return fail('hooks_invalid');
      offset += token.length;
      const parsed: unknown = JSON.parse(token);
      if (typeof parsed === 'number' && (!Number.isFinite(parsed) || (Number.isInteger(parsed) && !Number.isSafeInteger(parsed))))
        return fail('hooks_invalid');
      return parsed;
    };
    try {
      const result = value(0); ws();
      if (offset !== text.length) return fail('hooks_invalid');
      return result;
    } catch { return fail('hooks_invalid'); }
  };
  const document = bytes ? object(parse(bytes)) : {};
  const hooks = document.hooks === undefined ? {} : object(document.hooks);
  for (const event of events) {
    if (hooks[event] !== undefined && !Array.isArray(hooks[event])) fail('hooks_invalid');
  }
  return { document, hooks };
}
function mergeHooks(bytes: Buffer | null, before: HookEntries | null, after: HookEntries | null): Buffer {
  const { document, hooks } = hookDocument(bytes);
  for (const event of events) {
    const entries = z.array(z.unknown()).parse(hooks[event] ?? []);
    if (before && entries.filter(value => equal(value, before[event])).length !== 1) fail('hooks_drift');
    const remaining = before ? entries.filter(value => !equal(value, before[event])) : entries;
    if (after && remaining.some(value => equal(value, after[event]) ||
      JSON.stringify(value).includes(recorder))) fail('hooks_unowned');
    if (after) remaining.push(after[event]);
    if (hooks[event] !== undefined || after) hooks[event] = remaining;
  }
  return Buffer.from(JSON.stringify({ ...document, hooks }, null, 2) + '\n');
}
const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
function packageSource(root: string, options: CodexConnectInstallationOptions) {
  if (options.productVersion !== '0.162.1') fail('product_version_unsupported');
  if (!Array.isArray(options.sourceRoots) || options.sourceRoots.length === 0 || options.sourceRoots.length > 32)
    fail('source_roots_invalid');
  for (const sourceRoot of options.sourceRoots) {
    if (!isAbsolute(sourceRoot) || sourceRoot.length > 4096 || sourceRoot.includes('\0') || resolve(sourceRoot) === '/')
      fail('source_roots_invalid');
    try { rootIdentity(sourceRoot, true); }
    catch (error) { if (missing(error)) fail('source_root_missing'); throw error; }
  }
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const sourceRoot = options.packageRoot ?? fileURLToPath(new URL(
    basename(moduleDirectory) === 'src' ? '../skills/harness-connect/' : './skills/harness-connect/', import.meta.url,
  ));
  const files = new Map([...tree(sourceRoot)].map(([path, bytes]) => [`${destination}/${path}`, bytes]));
  for (const path of ['SKILL.md', 'scripts/connect.mjs']) {
    if (!files.has(`${destination}/${path}`)) fail('package_invalid');
  }
  const hookSource = options.hookSource ?? fileURLToPath(new URL('../scripts/session-binding-codex-hook.mjs', import.meta.url));
  rootIdentity(dirname(hookSource), true);
  const hookBytes = bytesAt(dirname(hookSource), basename(hookSource));
  if (!hookBytes) return fail('package_source_unavailable');
  files.set(recorder, hookBytes);
  const runtime = realpathSync(process.execPath), runtimeStat = lstatSync(runtime);
  if (!isAbsolute(runtime) || !runtimeStat.isFile() || (runtimeStat.mode & 0o022) !== 0 ||
    !/^node(?:\.exe)?$/.test(basename(runtime))) fail('node_runtime_unavailable');
  const command = [runtime, join(resolve(root), recorder), '--receipt-directory', join(resolve(root), receiptDirectory),
    '--product-version', options.productVersion,
    ...options.sourceRoots.flatMap(path => ['--source-root', path])].map(quote).join(' ');
  const hook = { hooks: [{ type: 'command' as const, command }] };
  const hooks: HookEntries = { SessionStart: { matcher: 'startup|resume|clear|compact', ...hook }, SubagentStart: hook };
  return { files, hooks };
}
function inspectOwned(root: string) {
  const rootId = rootIdentity(root);
  const pins = new Map<string, string | null>();
  const pin = (path: string) => { const stat = entry(root, path); pins.set(path, stat ? identity(stat) : null); };
  for (const path of ['.agents', '.agents/skills', destination, '.harness-delta', metadata, receiptDirectory,
    manifestPath, recorder, '.codex', hooksPath]) pin(path);
  privateDirectory(root, metadata);
  privateDirectory(root, receiptDirectory);
  const bytes = bytesAt(root, manifestPath), hookBytes = bytesAt(root, hooksPath);
  hookDocument(hookBytes);
  const files = new Map<string, Buffer>();
  if (!bytes) {
    if (entry(root, destination) || entry(root, recorder)) fail('package_unowned');
    return { rootId, pins, bytes, hookBytes, files, manifest: null };
  }
  const stat = entry(root, manifestPath);
  if (!stat || (stat.mode & 0o077) !== 0) fail('manifest_unsafe');
  const parsed = manifestSchema.safeParse(readStrictJson(bytes));
  if (!parsed.success) return fail('manifest_invalid');
  const manifest = parsed.data;
  if (manifest.root_identity !== rootId) fail('changed_project_root');
  if (!entry(root, destination)?.isDirectory()) fail('package_drift');
  for (const [path, value] of tree(join(root, destination))) files.set(`${destination}/${path}`, value);
  const hook = bytesAt(root, recorder);
  if (!hook) return fail('package_drift');
  files.set(recorder, hook);
  const names = new Set(manifest.files.map(file => file.path));
  if (names.size !== files.size || names.size !== manifest.files.length) fail('package_drift');
  for (const file of manifest.files) {
    const value = files.get(file.path);
    if (!value || hashBytes(value) !== file.sha256) fail('package_drift');
    pin(file.path);
    let parent = dirname(file.path);
    while (parent !== '.') { pin(parent); parent = dirname(parent); }
  }
  mergeHooks(hookBytes, manifest.hooks, null);
  return { rootId, pins, bytes, hookBytes, files, manifest };
}
function plan(root: string, options: CodexConnectInstallationPreviewOptions) {
  const operation = options.operation ?? 'install';
  const blockers: string[] = [];
  let owned: ReturnType<typeof inspectOwned> | undefined;
  let source: ReturnType<typeof packageSource> | undefined;
  try {
    owned = inspectOwned(root);
    if (entry(root, lockPath)) fail('installation_busy');
  } catch (error) { blockers.push(blocker(error)); }
  try { source = packageSource(root, options); }
  catch (error) { if (operation === 'install') blockers.push(blocker(error)); }
  const wanted = operation === 'install' ? source?.files : new Map<string, Buffer>();
  const changes: CodexConnectInstallationChange[] = [];
  let afterHooks: Buffer | null = null;
  if (owned && wanted && blockers.length === 0) {
    try {
      if (operation === 'install' || owned.manifest) {
        afterHooks = mergeHooks(owned.hookBytes, owned.manifest?.hooks ?? null,
          operation === 'install' ? source?.hooks ?? null : null);
        // An idempotent install must not rewrite formatting or reorder existing hooks.
        if (operation === 'install' && owned.manifest && source && equal(owned.manifest.hooks, source.hooks))
          afterHooks = owned.hookBytes;
      }
      for (const path of [...new Set([...owned.files.keys(), ...wanted.keys()])].sort()) {
        const before = owned.files.get(path), after = wanted.get(path);
        const beforeHash = before ? hashBytes(before) : null, afterHash = after ? hashBytes(after) : null;
        if (beforeHash !== afterHash) changes.push({ path,
          action: beforeHash === null ? 'create' : afterHash === null ? 'delete' : 'update', beforeHash, afterHash });
      }
      if (afterHooks && !afterHooks.equals(owned.hookBytes ?? Buffer.alloc(0))) changes.push({ path: hooksPath,
        action: owned.hookBytes ? 'update' : 'create', beforeHash: owned.hookBytes ? hashBytes(owned.hookBytes) : null,
        afterHash: hashBytes(afterHooks) });
      if (operation === 'install' && owned.pins.get(receiptDirectory) === null)
        changes.push({ path: receiptDirectory, action: 'create', beforeHash: null, afterHash: hashBytes('directory:0700') });
    } catch (error) { blockers.push(blocker(error)); }
  }
  const beforeHooksHash = owned?.hookBytes ? hashBytes(owned.hookBytes) : null;
  const preview: CodexConnectInstallationPreview = {
    state: blockers.length ? 'blocked' : !owned?.manifest ? 'absent' :
      source && (owned.pins.get(receiptDirectory) === null || bundleHash(source.files, source.hooks) !== bundleHash(owned.files, owned.manifest.hooks))
        ? 'update_available' : 'installed',
    source: source ? 'available' : 'unavailable',
    packageHash: source && owned ? hashBytes(JSON.stringify([bundleHash(source.files, source.hooks), owned.rootId, beforeHooksHash, owned.pins.get(receiptDirectory) !== null])) : null,
    installedHash: owned?.manifest
      ? hashBytes(JSON.stringify([bundleHash(owned.files, owned.manifest.hooks), owned.rootId, beforeHooksHash, owned.pins.get(receiptDirectory) !== null])) : null,
    destination, receiptDirectory, hookRegistration: 'unverified', blockers,
    operation, changes: blockers.length ? [] : changes, beforeHooksHash,
  };
  return { preview, owned, source, wanted, afterHooks };
}
export function previewCodexConnectInstallation(root: string, options: CodexConnectInstallationPreviewOptions): CodexConnectInstallationPreview {
  return plan(root, options).preview;
}
export function statusCodexConnectInstallation(root: string, options: CodexConnectInstallationOptions): CodexConnectInstallationStatus {
  const result = plan(root, options).preview;
  return { state: result.state, source: result.source, packageHash: result.packageHash, installedHash: result.installedHash,
    destination, receiptDirectory, hookRegistration: 'unverified', blockers: result.blockers };
}
function apply(root: string, options: CodexConnectInstallationPreviewOptions): CodexConnectInstallationStatus {
  const planned = plan(root, options);
  const { preview, owned, source, wanted, afterHooks } = planned;
  if (preview.blockers.length || !owned || !wanted) return preview;
  if ((options.expectedPackageHash !== undefined && options.expectedPackageHash !== preview.packageHash) ||
    (options.expectedInstalledHash !== undefined && options.expectedInstalledHash !== preview.installedHash))
    fail('installation_preview_changed');
  if (!preview.changes.length) return preview;
  if (options.expectedPackageHash === undefined || options.expectedInstalledHash === undefined) fail('installation_preview_required');
  const transaction = `${metadata}/transaction-${randomUUID()}`;
  const created: string[] = [];
  const ensure = (path: string) => {
    if (rootIdentity(root) !== owned.rootId) fail('changed_project_root');
    let parent = '';
    for (const part of path.split('/')) {
      parent = parent ? `${parent}/${part}` : part;
      const stat = entry(root, parent);
      if (stat) { if (!stat.isDirectory()) fail('unsafe_path'); }
      else { mkdirSync(join(root, parent), { mode: 0o700 }); created.push(parent); }
      if (rootIdentity(root) !== owned.rootId) fail('changed_project_root');
    }
  };
  const actions: { path: string; before: Buffer | null; after: Buffer | null; moved: boolean; installed: boolean }[] = [];
  let locked = false, committed = false, rollbackFailed = false;
  try {
    ensure(metadata);
    mkdirSync(join(root, lockPath), { mode: 0o700 }); locked = true;
    durablePrivateBytes(root, `${lockPath}/owner.json`, Buffer.from(JSON.stringify({ pid: process.pid, root_identity: owned.rootId })));
    ensure(transaction);
    if (preview.operation === 'install') ensure(receiptDirectory);
    const recheck = () => {
      const current = inspectOwned(root);
      if (current.rootId !== owned.rootId || bundleHash(current.files, current.manifest?.hooks ?? null) !==
        bundleHash(owned.files, owned.manifest?.hooks ?? null) ||
        !equal(current.bytes ? hashBytes(current.bytes) : null, owned.bytes ? hashBytes(owned.bytes) : null) ||
        !equal(current.hookBytes ? hashBytes(current.hookBytes) : null, owned.hookBytes ? hashBytes(owned.hookBytes) : null) ||
        [...owned.pins].some(([path, pin]) => pin !== null && current.pins.get(path) !== pin)) fail('installation_preview_changed');
    };
    recheck();
    for (const change of preview.changes.filter(change => change.path !== receiptDirectory)) actions.push({ path: change.path,
      before: change.path === hooksPath ? owned.hookBytes : owned.files.get(change.path) ?? null,
      after: change.path === hooksPath ? afterHooks : wanted.get(change.path) ?? null, moved: false, installed: false });
    const manifest: Manifest | null = preview.operation === 'install' && source ? {
      schema_version: 1, package: 'harness-connect', root_identity: owned.rootId,
      files: [...source.files].map(([path, bytes]) => ({ path, sha256: hashBytes(bytes) })), hooks: source.hooks,
    } : null;
    actions.push({ path: manifestPath, before: owned.bytes,
      after: manifest ? Buffer.from(JSON.stringify(manifest) + '\n') : null, moved: false, installed: false });
    for (const [index, action] of actions.entries()) {
      if (action.after) {
        if (rootIdentity(root) !== owned.rootId) fail('changed_project_root');
        durablePrivateBytes(root, `${transaction}/new-${index}`, action.after);
      }
    }
    recheck();
    let hooksApplied = false;
    for (const [index, action] of actions.entries()) {
      ensure(dirname(action.path));
      const expectedHooks = hooksApplied ? afterHooks : owned.hookBytes;
      const currentHooks = bytesAt(root, hooksPath);
      if ((currentHooks === null) !== (expectedHooks === null) ||
        (currentHooks && !currentHooks.equals(expectedHooks ?? Buffer.alloc(0)))) fail('installation_preview_changed');
      const before = bytesAt(root, action.path);
      if ((before === null) !== (action.before === null) ||
        (before && !before.equals(action.before ?? Buffer.alloc(0)))) fail('installation_preview_changed');
      if (action.before) {
        renameSync(join(root, action.path), join(root, transaction, `old-${index}`)); action.moved = true;
      }
      if (action.after) {
        renameSync(join(root, transaction, `new-${index}`), join(root, action.path)); action.installed = true;
      }
      if (action.path === hooksPath) hooksApplied = true;
    }
    committed = true;
  } catch (error) {
    try {
      if (rootIdentity(root) !== owned.rootId) fail('changed_project_root');
      for (const action of [...actions].reverse()) {
        if (action.installed) {
          if (!bytesAt(root, action.path)?.equals(action.after ?? Buffer.alloc(0))) fail('package_drift');
          unlinkSync(join(root, action.path));
        }
        if (action.moved) {
          if (entry(root, action.path)) fail('changed_path');
          renameSync(join(root, transaction, `old-${actions.indexOf(action)}`), join(root, action.path));
        }
      }
    } catch { rollbackFailed = true; fail('installation_rollback_failed'); }
    throw new CodexConnectInstallationError(blocker(error));
  } finally {
    if (!rollbackFailed && locked) {
      if (rootIdentity(root) !== owned.rootId) fail('changed_project_root');
      if (entry(root, transaction)) {
        for (const [index, action] of actions.entries()) {
          for (const [name, bytes] of [[`new-${index}`, action.after], [`old-${index}`, action.before]] as const) {
            const path = `${transaction}/${name}`, value = bytesAt(root, path);
            if (value) { if (!bytes || !value.equals(bytes)) fail('installation_cleanup_failed'); unlinkSync(join(root, path)); }
          }
        }
        rmdirSync(join(root, transaction));
      }
      if (entry(root, `${lockPath}/owner.json`)) unlinkSync(join(root, lockPath, 'owner.json'));
      rmdirSync(join(root, lockPath));
      const directories = new Set(created);
      for (const action of actions) {
        let path = dirname(action.path);
        while (path.startsWith(destination)) { directories.add(path); path = dirname(path); }
      }
      for (const path of [...directories].sort((a, b) => b.length - a.length)) {
        if (committed && !path.startsWith(destination)) continue;
        if (entry(root, path)?.isDirectory() && readdirSync(join(root, path)).length === 0) rmdirSync(join(root, path));
      }
    }
  }
  return plan(root, options).preview;
}
export function installCodexConnectInstallation(root: string, options: CodexConnectInstallationOptions): CodexConnectInstallationStatus {
  return apply(root, { ...options, operation: 'install' });
}
/** Only unchanged owned files and hook entries are removed; receipts are never traversed. */
export function removeCodexConnectInstallation(root: string, options: CodexConnectInstallationOptions): CodexConnectInstallationStatus {
  return apply(root, { ...options, operation: 'remove' });
}

export function recoverCodexConnectInstallationLock(root: string, options: CodexConnectInstallationOptions): CodexConnectInstallationStatus {
  const owned = inspectOwned(root);
  if (!privateDirectory(root, lockPath)) return statusCodexConnectInstallation(root, options);
  const bytes = bytesAt(root, `${lockPath}/owner.json`);
  if (!bytes) return fail('installation_recovery_required');
  const owner = lockOwnerSchema.parse(readStrictJson(bytes));
  if (owner.root_identity !== owned.rootId) return fail('changed_project_root');
  try { process.kill(owner.pid, 0); return fail('installation_busy'); }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
  }
  if (readdirSync(join(root, lockPath)).some(name => name !== 'owner.json') ||
    readdirSync(join(root, metadata)).some(name => name.startsWith('transaction-')))
    return fail('installation_recovery_required');
  unlinkSync(join(root, lockPath, 'owner.json'));
  rmdirSync(join(root, lockPath));
  return statusCodexConnectInstallation(root, options);
}
