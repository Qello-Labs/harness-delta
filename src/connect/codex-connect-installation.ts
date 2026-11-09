import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, resolve } from 'node:path';
import { z } from 'zod';
import { getCodexBindingAdmission } from '../codex-binding-admission.js';
import { resolveOrdinaryWindow } from '../core/ordinary-window-policy.js';

import { durablePrivateBytes, hashBytes, readRepositoryFile, readStrictJson, safeRelativePath } from '../core/repository-files.js';
import { implementationExtension, implementationPath, packagedSkillPath, packagePath } from '../package-paths.js';

const destination = '.agents/skills/harness-connect';
const metadata = '.harness-delta/codex-connect';
const receiptDirectory = `${metadata}/receipts`;
const recorder = `${metadata}/session-binding-codex-hook.mjs`;
const windowReceiptDirectory = '.harness-delta/window-receipts';
const windowRecorder = `${metadata}/session-binding-codex-window-hook.mjs`;
const promotedReceiptDirectory = '.harness-delta/codex-promoted-receipts';
const promotedRecorder = `${metadata}/session-binding-codex-promoted-hook.mjs`;
const manifestPath = `${metadata}/installation.json`;
const hooksPath = '.codex/hooks.json';
const lockPath = `${metadata}/installation-lock`;
const events = ['SessionStart', 'SubagentStart'] as const;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const hookEntrySchema = z.strictObject({
  matcher: z.string().optional(),
  hooks: z.array(z.strictObject({ type: z.literal('command'), command: z.string() })).length(1)
});
const manifestSchema = z.strictObject({
  schema_version: z.literal(1),
  package: z.literal('harness-connect'),
  root_identity: z.string(),
  files: z
    .array(
      z.strictObject({
        path: z.string().refine(path => safeRelativePath(path) && (path.startsWith(`${destination}/`) || path === recorder)),
        sha256: digest
      })
    )
    .min(2)
    .max(257),
  hooks: z.strictObject({
    SessionStart: hookEntrySchema,
    SubagentStart: hookEntrySchema
  })
});
const windowManifestSchema = manifestSchema.extend({
  schema_version: z.literal(2),
  bundle_mode: z.literal('ordinary_window'),
  bundle_revision: z.literal('codex-window-bundle-v1'),
  files: z
    .array(
      z.strictObject({
        path: z.string().refine(path => safeRelativePath(path) && (path.startsWith(destination + '/') || path === recorder || path === windowRecorder)),
        sha256: digest
      })
    )
    .min(2)
    .max(257),
  hooks: manifestSchema.shape.hooks.nullable(),
  window_hooks: manifestSchema.shape.hooks
});
const promotedManifestSchema = windowManifestSchema.extend({
  schema_version: z.literal(3),
  bundle_mode: z.literal('promoted'),
  bundle_revision: z.literal('codex-promoted-bundle-v1'),
  files: z
    .array(
      z.strictObject({
        path: z
          .string()
          .refine(path => safeRelativePath(path) && (path.startsWith(destination + '/') || [recorder, windowRecorder, promotedRecorder].includes(path))),
        sha256: digest
      })
    )
    .min(2)
    .max(257),
  hooks: z.null(),
  window_hooks: z.null(),
  promoted_hooks: manifestSchema.shape.hooks
});
const installationManifestSchema = z.union([manifestSchema, windowManifestSchema, promotedManifestSchema]);
const lockOwnerSchema = z.strictObject({
  pid: z.number().int().positive(),
  root_identity: z.string()
});
type Manifest = z.infer<typeof installationManifestSchema>;
type HookEntries = z.infer<typeof manifestSchema>['hooks'];
type PackageSource = {
  readonly files: Map<string, Buffer>;
  hooks: HookEntries | null;
  readonly windowHooks: HookEntries | null;
  readonly promoted?: true;
};
type JsonObject = Record<string, unknown>;
type InstallationAction = {
  readonly path: string;
  readonly before: Buffer | null;
  readonly after: Buffer | null;
  moved: boolean;
  installed: boolean;
};

export interface CodexConnectInstallationOptions {
  readonly sourceRoots: readonly string[];
  readonly productVersion: string;
  readonly bundleMode?: 'exact' | 'ordinary_window' | 'promoted';
  readonly promotedPackageRoot?: string;
  readonly promotedHookSource?: string;
  /** Trusted task-state proof; absence does not establish quiescence. */
  readonly promotedInUse?: boolean | (() => boolean) | undefined;
  readonly quiescentBoundaryConfirmed?: boolean;
  readonly windowPackageRoot?: string;
  readonly windowHookSource?: string;
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
  readonly receiptDirectory: typeof receiptDirectory | typeof windowReceiptDirectory | typeof promotedReceiptDirectory;
  readonly bundleMode?: 'ordinary_window' | 'promoted';
  readonly bundleRevision?: 'codex-window-bundle-v1' | 'codex-promoted-bundle-v1';
  readonly producerContract?: 'promoted_producer_contract_unverified';
  readonly requiresFreshRoots?: true;
  readonly hookRegistration: 'unverified';
  readonly blockers: readonly string[];
}
export interface CodexConnectInstallationPreview extends CodexConnectInstallationStatus {
  readonly operation: 'install' | 'remove';
  readonly changes: readonly CodexConnectInstallationChange[];
  readonly beforeHooksHash: string | null;
}
export class CodexConnectInstallationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'CodexConnectInstallationError';
  }
}
const fail = (code: string): never => {
  throw new CodexConnectInstallationError(`codex_connect_${code}`);
};
const blocker = (error: unknown) => (error instanceof CodexConnectInstallationError ? error.code : 'codex_connect_installation_unavailable');
const missing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';
const identity = (stat: Stats) => `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
function rootIdentity(root: string, source = false): string {
  const stat = lstatSync(root);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    realpathSync(root) !== resolve(root) ||
    (stat.mode & 0o022) !== 0 ||
    (typeof process.getuid === 'function' && stat.uid !== process.getuid() && !(source && stat.uid === 0))
  ) {
    fail('unsafe_project_root');
  }
  return identity(stat);
}
function entry(root: string, path: string) {
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
    if (
      stat.isSymbolicLink() ||
      (index < parts.length - 1 && !stat.isDirectory()) ||
      (stat.mode & 0o022) !== 0 ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid() && stat.uid !== 0) ||
      (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))
    ) {
      fail('unsafe_path');
    }
    if (index === parts.length - 1) return stat;
  }
  return null;
}
function privateDirectory(root: string, path: string) {
  const stat = entry(root, path);
  if (stat && (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid()))) {
    fail('metadata_unsafe');
  }
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
  let count = 0,
    size = 0;
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
        if (files.size >= 256 || size > 8 * 1048576) {
          fail('package_limit');
        }
        files.set(path, bytes);
      }
    }
  };
  visit('', 0);
  return files;
}
const bundleHash = (files: Map<string, Buffer>, hooks: HookEntries | null, windowHooks: HookEntries | null = null) =>
  hashBytes(
    JSON.stringify({
      files: [...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, bytes]) => [path, hashBytes(bytes)]),
      hooks,
      ...(windowHooks
        ? {
            bundle_mode: 'ordinary_window',
            bundle_revision: 'codex-window-bundle-v1',
            window_hooks: windowHooks
          }
        : {})
    })
  );
const object = (value: unknown): JsonObject => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail('hooks_invalid');
  }
  return z.custom<JsonObject>().parse(value);
};
const equal = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => equal(v, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const left = object(a),
      right = object(b);
    return Object.keys(left).length === Object.keys(right).length && Object.keys(left).every(key => Object.hasOwn(right, key) && equal(left[key], right[key]));
  }
  return false;
};
function hookDocument(bytes: Buffer | null) {
  // Unlike shared configuration, hook documents permit arbitrary JSON keys.
  const parse = (input: Buffer): unknown => {
    if (input.length > 1048576 || !Buffer.from(input.toString('utf8')).equals(input)) return fail('hooks_invalid');
    const text = input.toString('utf8');
    let offset = 0;
    const ws = () => {
      while (offset < text.length && /[ \t\r\n]/.test(text[offset] ?? '')) offset++;
    };
    const string = (): string => {
      const start = offset++;
      while (offset < text.length) {
        if (text[offset] === '\\') offset += 2;
        else if (text[offset++] === '"') {
          return z.string().parse(JSON.parse(text.slice(start, offset)));
        }
      }
      return fail('hooks_invalid');
    };
    const value = (depth: number): unknown => {
      if (depth > 64) return fail('hooks_invalid');
      ws();
      const ch = text[offset];
      if (ch === '"') return string();
      if (ch === '{') {
        offset++;
        ws();
        const out: JsonObject = {},
          keys = new Set<string>();
        if (text[offset] === '}') {
          offset++;
          return out;
        }
        for (;;) {
          ws();
          if (text[offset] !== '"') return fail('hooks_invalid');
          const key = string();
          if (keys.has(key)) return fail('hooks_invalid');
          keys.add(key);
          ws();
          if (text[offset++] !== ':') return fail('hooks_invalid');
          Object.defineProperty(out, key, {
            value: value(depth + 1),
            enumerable: true,
            writable: true,
            configurable: true
          });
          ws();
          const end = text[offset++];
          if (end === '}') return out;
          if (end !== ',') return fail('hooks_invalid');
        }
      }
      if (ch === '[') {
        offset++;
        ws();
        const out: unknown[] = [];
        if (text[offset] === ']') {
          offset++;
          return out;
        }
        for (;;) {
          out.push(value(depth + 1));
          ws();
          const end = text[offset++];
          if (end === ']') return out;
          if (end !== ',') return fail('hooks_invalid');
        }
      }
      const token = text.slice(offset).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/)?.[0];
      if (!token) return fail('hooks_invalid');
      offset += token.length;
      const parsed: unknown = JSON.parse(token);
      if (typeof parsed === 'number' && (!Number.isFinite(parsed) || (Number.isInteger(parsed) && !Number.isSafeInteger(parsed)))) return fail('hooks_invalid');
      return parsed;
    };
    try {
      const result = value(0);
      ws();
      if (offset !== text.length) return fail('hooks_invalid');
      return result;
    } catch {
      return fail('hooks_invalid');
    }
  };
  const document = bytes ? object(parse(bytes)) : {};
  const hooks = document.hooks === undefined ? {} : object(document.hooks);
  for (const event of events) {
    if (hooks[event] !== undefined && !Array.isArray(hooks[event])) {
      fail('hooks_invalid');
    }
  }
  return { document, hooks };
}
function mergeHooks(bytes: Buffer | null, before: HookEntries | null, after: HookEntries | null): Buffer {
  const { document, hooks } = hookDocument(bytes);
  for (const event of events) {
    const entries = z.array(z.unknown()).parse(hooks[event] ?? []);
    if (before && entries.filter(value => equal(value, before[event])).length !== 1) fail('hooks_drift');
    const remaining = before ? entries.filter(value => !equal(value, before[event])) : entries;
    if (after && remaining.some(value => equal(value, after[event]) || JSON.stringify(value).includes(recorder))) fail('hooks_unowned');
    if (after) remaining.push(after[event]);
    if (hooks[event] !== undefined || after) hooks[event] = remaining;
  }
  return Buffer.from(JSON.stringify({ ...document, hooks }, null, 2) + '\n');
}
const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
function manifestWindowHooks(manifest: Manifest | null): HookEntries | null {
  return manifest?.schema_version === 3 ? manifest.promoted_hooks : manifest?.schema_version === 2 ? manifest.window_hooks : null;
}
function mergeWindowHooks(
  bytes: Buffer | null,
  before: { exact: HookEntries | null; window: HookEntries | null },
  after: { exact: HookEntries | null; window: HookEntries | null }
): Buffer {
  const { document, hooks } = hookDocument(bytes);
  for (const event of events) {
    const entries = z.array(z.unknown()).parse(hooks[event] ?? []);
    const previous = [before.exact?.[event], before.window?.[event]].filter(value => value !== undefined);
    for (const value of previous) {
      if (entries.filter(entry => equal(entry, value)).length !== 1) {
        fail('hooks_drift');
      }
    }
    const remaining = entries.filter(entry => !previous.some(value => equal(entry, value)));
    const wanted = [after.exact?.[event], after.window?.[event]].filter(value => value !== undefined);
    if (
      wanted.length &&
      remaining.some(
        entry => wanted.some(value => equal(entry, value)) || JSON.stringify(entry).includes(recorder) || JSON.stringify(entry).includes(windowRecorder)
      )
    ) {
      fail('hooks_unowned');
    }
    remaining.push(...wanted);
    if (hooks[event] !== undefined || wanted.length) {
      hooks[event] = remaining;
    }
  }
  return Buffer.from(JSON.stringify({ ...document, hooks }, null, 2) + '\n');
}
function windowPackageSource(root: string, options: CodexConnectInstallationOptions): PackageSource {
  if (!resolveOrdinaryWindow('codex', options.productVersion, 'codex-binding-root-window-v1')) fail('product_version_unsupported');
  if (!Array.isArray(options.sourceRoots) || !options.sourceRoots.length || options.sourceRoots.length > 32) fail('source_roots_invalid');
  for (const path of options.sourceRoots) {
    if (!isAbsolute(path) || path.length > 4096 || /[\0\r\n]/.test(path) || resolve(path) !== path || resolve(path) === '/') fail('source_roots_invalid');
  }
  const files = new Map([...tree(options.packageRoot ?? packagedSkillPath('harness-connect'))].map(([path, bytes]) => [destination + '/' + path, bytes]));
  const selected = tree(options.windowPackageRoot ?? packagedSkillPath('harness-connect-window-codex'));
  if (!selected.has('SKILL.md') || !selected.has('scripts/connect.mjs')) {
    fail('package_invalid');
  }
  for (const [path, bytes] of selected) {
    const target = destination + '/' + (path === 'scripts/connect.mjs' ? 'scripts/connect-window.mjs' : path);
    if (files.has(target) && path !== 'SKILL.md') fail('package_invalid');
    files.set(target, bytes);
  }
  for (const [name, override, target] of [
    ['session-binding-codex-hook.mjs', options.hookSource, recorder],
    ['session-binding-codex-window-hook.mjs', options.windowHookSource, windowRecorder]
  ] as const) {
    const path = override ?? (implementationExtension === '.ts' ? packagePath('scripts', name) : implementationPath('assets', name));
    rootIdentity(dirname(path), true);
    const bytes = bytesAt(dirname(path), basename(path));
    if (!bytes) return fail('package_source_unavailable');
    files.set(target, bytes);
  }
  if (files.size > 257 || [...files.values()].reduce((size, bytes) => size + bytes.length, 0) > 8 * 1048576) fail('package_limit');
  const runtime = realpathSync(process.execPath),
    stat = lstatSync(runtime);
  if (!isAbsolute(runtime) || !stat.isFile() || (stat.mode & 0o022) !== 0 || !/^node(?:\.exe)?$/.test(basename(runtime))) fail('node_runtime_unavailable');
  const command = [
    runtime,
    join(resolve(root), windowRecorder),
    '--receipt-directory',
    join(resolve(root), windowReceiptDirectory),
    '--project-root',
    resolve(root)
  ]
    .map(quote)
    .join(' ');
  const hook = { hooks: [{ type: 'command' as const, command }] };
  return {
    files,
    hooks: null,
    windowHooks: { SessionStart: hook, SubagentStart: hook }
  };
}
function assertPromotedBoundary(options: CodexConnectInstallationOptions): void {
  if (options.promotedInUse === undefined) {
    fail('promoted_task_state_unverified');
  }
  if (typeof options.promotedInUse === 'function' ? options.promotedInUse() : options.promotedInUse) fail('promoted_installation_in_use');
  if (options.quiescentBoundaryConfirmed !== true) {
    fail('promoted_quiescence_unconfirmed');
  }
}
function promotedPackageSource(root: string, options: CodexConnectInstallationOptions): PackageSource {
  if (!/^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/.test(options.productVersion)) fail('product_version_unsupported');
  const files = new Map([...tree(options.packageRoot ?? packagedSkillPath('harness-connect'))].map(([path, bytes]) => [destination + '/' + path, bytes]));
  const selected = tree(options.promotedPackageRoot ?? packagedSkillPath('harness-connect-promoted-codex'));
  if (!selected.has('SKILL.md') || !selected.has('scripts/connect.mjs')) {
    fail('package_invalid');
  }
  for (const [path, bytes] of selected) {
    const target = destination + '/' + (path === 'scripts/connect.mjs' ? 'scripts/connect-promoted.mjs' : path);
    if (files.has(target) && path !== 'SKILL.md') fail('package_invalid');
    files.set(target, bytes);
  }
  for (const [name, override, target] of [
    ['session-binding-codex-hook.mjs', options.hookSource, recorder],
    ['session-binding-codex-promoted-hook.mjs', options.promotedHookSource, promotedRecorder]
  ] as const) {
    const path = override ?? (implementationExtension === '.ts' ? packagePath('scripts', name) : implementationPath('assets', name));
    const bytes = bytesAt(dirname(path), basename(path));
    if (!bytes) return fail('package_source_unavailable');
    files.set(target, bytes);
  }
  const runtime = realpathSync(process.execPath);
  if (!lstatSync(runtime).isFile() || !/^node(?:\.exe)?$/.test(basename(runtime))) fail('node_runtime_unavailable');
  const command = [
    runtime,
    join(resolve(root), promotedRecorder),
    '--receipt-directory',
    join(resolve(root), promotedReceiptDirectory),
    '--project-root',
    resolve(root),
    '--product-version',
    options.productVersion
  ]
    .map(quote)
    .join(' ');
  const hook = { hooks: [{ type: 'command' as const, command }] };
  return {
    files,
    hooks: null,
    windowHooks: { SessionStart: hook, SubagentStart: hook },
    promoted: true
  };
}
function installedManifest(rootId: string, source: ReturnType<typeof packageSource>): Manifest {
  const common = {
    package: 'harness-connect' as const,
    root_identity: rootId,
    files: [...source.files].map(([path, bytes]) => ({
      path,
      sha256: hashBytes(bytes)
    }))
  };
  if (source.promoted && source.windowHooks) {
    return {
      schema_version: 3,
      ...common,
      bundle_mode: 'promoted',
      bundle_revision: 'codex-promoted-bundle-v1',
      hooks: null,
      window_hooks: null,
      promoted_hooks: source.windowHooks
    };
  }
  if (source.windowHooks) {
    return {
      schema_version: 2,
      ...common,
      bundle_mode: 'ordinary_window',
      bundle_revision: 'codex-window-bundle-v1',
      hooks: source.hooks,
      window_hooks: source.windowHooks
    };
  }
  if (!source.hooks) return fail('package_invalid');
  return { schema_version: 1, ...common, hooks: source.hooks };
}
function packageSource(root: string, options: CodexConnectInstallationOptions): PackageSource {
  if (options.bundleMode === 'promoted') {
    return promotedPackageSource(root, options);
  }
  if (options.bundleMode === 'ordinary_window') {
    return windowPackageSource(root, options);
  }
  if (!getCodexBindingAdmission(options.productVersion)) {
    fail('product_version_unsupported');
  }
  if (!Array.isArray(options.sourceRoots) || options.sourceRoots.length === 0 || options.sourceRoots.length > 32) fail('source_roots_invalid');
  for (const sourceRoot of options.sourceRoots) {
    if (!isAbsolute(sourceRoot) || sourceRoot.length > 4096 || sourceRoot.includes('\0') || resolve(sourceRoot) === '/') fail('source_roots_invalid');
    try {
      rootIdentity(sourceRoot, true);
    } catch (error) {
      if (missing(error)) fail('source_root_missing');
      throw error;
    }
  }
  const sourceRoot = options.packageRoot ?? packagedSkillPath('harness-connect');
  const files = new Map([...tree(sourceRoot)].map(([path, bytes]) => [`${destination}/${path}`, bytes]));
  for (const path of ['SKILL.md', 'scripts/connect.mjs']) {
    if (!files.has(`${destination}/${path}`)) fail('package_invalid');
  }
  const hookSource =
    options.hookSource ??
    (implementationExtension === '.ts'
      ? packagePath('scripts', 'session-binding-codex-hook.mjs')
      : implementationPath('assets', 'session-binding-codex-hook.mjs'));
  rootIdentity(dirname(hookSource), true);
  const hookBytes = bytesAt(dirname(hookSource), basename(hookSource));
  if (!hookBytes) return fail('package_source_unavailable');
  files.set(recorder, hookBytes);
  const runtime = realpathSync(process.execPath),
    runtimeStat = lstatSync(runtime);
  if (!isAbsolute(runtime) || !runtimeStat.isFile() || (runtimeStat.mode & 0o022) !== 0 || !/^node(?:\.exe)?$/.test(basename(runtime))) {
    fail('node_runtime_unavailable');
  }
  const command = [
    runtime,
    join(resolve(root), recorder),
    '--receipt-directory',
    join(resolve(root), receiptDirectory),
    '--product-version',
    options.productVersion,
    ...options.sourceRoots.flatMap(path => ['--source-root', path])
  ]
    .map(quote)
    .join(' ');
  const hook = { hooks: [{ type: 'command' as const, command }] };
  const hooks: HookEntries = {
    SessionStart: { matcher: 'startup|resume|clear|compact', ...hook },
    SubagentStart: hook
  };
  return { files, hooks, windowHooks: null };
}
function inspectOwned(root: string) {
  const rootId = rootIdentity(root);
  const pins = new Map<string, string | null>();
  const pin = (path: string) => {
    const stat = entry(root, path);
    pins.set(path, stat ? identity(stat) : null);
  };
  for (const path of ['.agents', '.agents/skills', destination, '.harness-delta', metadata, receiptDirectory, manifestPath, recorder, '.codex', hooksPath]) {
    pin(path);
  }
  privateDirectory(root, metadata);
  privateDirectory(root, receiptDirectory);
  const bytes = bytesAt(root, manifestPath),
    hookBytes = bytesAt(root, hooksPath);
  hookDocument(hookBytes);
  const files = new Map<string, Buffer>();
  if (!bytes) {
    if (entry(root, destination) || entry(root, recorder)) {
      fail('package_unowned');
    }
    return { rootId, pins, bytes, hookBytes, files, manifest: null };
  }
  const stat = entry(root, manifestPath);
  if (!stat || (stat.mode & 0o077) !== 0) fail('manifest_unsafe');
  const parsed = installationManifestSchema.safeParse(readStrictJson(bytes));
  if (!parsed.success) return fail('manifest_invalid');
  const manifest = parsed.data;
  if (manifest.root_identity !== rootId) fail('changed_project_root');
  if (!entry(root, destination)?.isDirectory()) fail('package_drift');
  for (const [path, value] of tree(join(root, destination))) {
    files.set(`${destination}/${path}`, value);
  }
  const hook = bytesAt(root, recorder);
  if (!hook) return fail('package_drift');
  files.set(recorder, hook);
  if (manifest.schema_version !== 1) {
    const selectedRecorder = manifest.schema_version === 3 ? promotedRecorder : windowRecorder;
    const selectedReceipts = manifest.schema_version === 3 ? promotedReceiptDirectory : windowReceiptDirectory;
    pin(selectedRecorder);
    pin(selectedReceipts);
    privateDirectory(root, selectedReceipts);
    const pendingHook = bytesAt(root, selectedRecorder);
    if (!pendingHook) return fail('package_drift');
    files.set(selectedRecorder, pendingHook);
    if (manifest.schema_version === 3 && manifest.files.some(file => file.path === windowRecorder)) {
      const historical = bytesAt(root, windowRecorder);
      if (!historical) return fail('package_drift');
      files.set(windowRecorder, historical);
    }
  }
  const names = new Set(manifest.files.map(file => file.path));
  if (names.size !== files.size || names.size !== manifest.files.length) {
    fail('package_drift');
  }
  for (const file of manifest.files) {
    const value = files.get(file.path);
    if (!value || hashBytes(value) !== file.sha256) fail('package_drift');
    pin(file.path);
    let parent = dirname(file.path);
    while (parent !== '.') {
      pin(parent);
      parent = dirname(parent);
    }
  }
  if (manifest.schema_version !== 1) {
    mergeWindowHooks(
      hookBytes,
      {
        exact: manifest.hooks,
        window: manifestWindowHooks(manifest)
      },
      { exact: null, window: null }
    );
  } else mergeHooks(hookBytes, manifest.hooks, null);
  return { rootId, pins, bytes, hookBytes, files, manifest };
}
function prepareWindowPackage(root: string, owned: ReturnType<typeof inspectOwned>, source: PackageSource | undefined): void {
  const selectedReceipts = source?.promoted ? promotedReceiptDirectory : windowReceiptDirectory;
  const selectedRecorder = source?.promoted ? promotedRecorder : windowRecorder;
  privateDirectory(root, selectedReceipts);
  for (const path of [selectedReceipts, selectedRecorder]) {
    if (!owned.pins.has(path)) {
      const stat = entry(root, path);
      owned.pins.set(path, stat ? identity(stat) : null);
    }
  }
  if (!owned.manifest && entry(root, selectedRecorder)) {
    fail('package_unowned');
  }
  if (source?.windowHooks) {
    source.hooks = source.promoted ? null : (owned.manifest?.hooks ?? null);
    for (const [path, bytes] of owned.files) {
      const connector = source.promoted ? 'connect-promoted.mjs' : 'connect-window.mjs';
      if (path !== destination + '/SKILL.md' && path !== destination + '/scripts/' + connector && path !== selectedRecorder) source.files.set(path, bytes);
    }
    if (source.files.size > 257 || [...source.files.values()].reduce((size, bytes) => size + bytes.length, 0) > 8 * 1048576) fail('package_limit');
  }
}
function referencesOwnedHook(value: unknown): boolean {
  if (typeof value === 'string') {
    const command = value.replace(/\\\r?\n/g, '');
    const words: string[] = [];
    const closers: string[] = [];
    let start = 0;
    for (let offset = 0; offset < command.length; offset++) {
      const character = command.charAt(offset);
      const closer = closers.at(-1);
      if (character === '\\' && closer !== "'") {
        offset++;
        continue;
      }
      if (closer === "'" || closer === '`') {
        if (character === closer) closers.pop();
        continue;
      }
      if (character === closer) {
        closers.pop();
        continue;
      }
      if (character === '$' && command.charAt(offset + 1) === '(') {
        closers.push(')');
        offset++;
        continue;
      }
      if (((character === "'" || character === '"') && closer !== '"') || character === '`') {
        closers.push(character);
        continue;
      }
      if (character === '(' && closer === ')') {
        closers.push(')');
        continue;
      }
      if (!closers.length && /[\s;&|<>()]/.test(character)) {
        if (offset > start) words.push(command.slice(start, offset));
        start = offset + 1;
      }
    }
    if (start < command.length) words.push(command.slice(start));
    const helpers = [recorder, windowRecorder, promotedRecorder];
    return words.some(word => {
      const lexical = word.replace(/['"\\]/g, '');
      const paths = lexical.split(/[\s;&|<>()`$]+/).map(path => posix.normalize(path));
      return (
        paths.some(path => helpers.some(helper => path === helper || path.endsWith(`/${helper}`)) || /(?:^|\/)harness-connect\/scripts(?:\/|$)/.test(path)) ||
        (helpers.some(helper => lexical.includes(basename(helper))) && paths.some(path => /(?:^|\/)\.harness-delta\/codex-connect(?:\/|$)/.test(path)))
      );
    });
  }
  if (Array.isArray(value)) return value.some(referencesOwnedHook);
  return value !== null && typeof value === 'object' && Object.values(value).some(referencesOwnedHook);
}
function plannedHooks(owned: ReturnType<typeof inspectOwned>, source: PackageSource | undefined, operation: 'install' | 'remove'): Buffer | null {
  if (source?.promoted) {
    const withoutOwned = mergeWindowHooks(
      owned.hookBytes,
      {
        exact: owned.manifest?.hooks ?? null,
        window: manifestWindowHooks(owned.manifest)
      },
      { exact: null, window: null }
    );
    if (referencesOwnedHook(hookDocument(withoutOwned).hooks)) {
      fail('hooks_unowned');
    }
  }
  const after =
    source?.windowHooks || manifestWindowHooks(owned.manifest)
      ? mergeWindowHooks(
          owned.hookBytes,
          {
            exact: owned.manifest?.hooks ?? null,
            window: manifestWindowHooks(owned.manifest)
          },
          {
            exact: operation === 'install' ? (source?.hooks ?? null) : null,
            window: operation === 'install' ? (source?.windowHooks ?? null) : null
          }
        )
      : mergeHooks(owned.hookBytes, owned.manifest?.hooks ?? null, operation === 'install' ? (source?.hooks ?? null) : null);
  // An idempotent install must not rewrite formatting or reorder existing hooks.
  if (
    operation === 'install' &&
    owned.manifest &&
    source &&
    equal(owned.manifest.hooks, source.hooks) &&
    equal(manifestWindowHooks(owned.manifest), source.windowHooks)
  ) {
    return owned.hookBytes;
  }
  return after;
}
function plan(root: string, options: CodexConnectInstallationPreviewOptions) {
  const operation = options.operation ?? 'install';
  const blockers: string[] = [];
  let owned: ReturnType<typeof inspectOwned> | undefined;
  let source: ReturnType<typeof packageSource> | undefined;
  try {
    owned = inspectOwned(root);
    if (entry(root, lockPath)) fail('installation_busy');
    if (owned.manifest?.schema_version === 3 && (options.bundleMode !== 'promoted' || operation !== 'install')) fail('promoted_cutover_required');
    if (options.bundleMode === 'promoted') assertPromotedBoundary(options);
  } catch (error) {
    blockers.push(blocker(error));
  }
  try {
    source = packageSource(root, options);
  } catch (error) {
    if (operation === 'install') blockers.push(blocker(error));
  }
  const selectedReceiptDirectory =
    options.bundleMode === 'promoted' ? promotedReceiptDirectory : options.bundleMode === 'ordinary_window' ? windowReceiptDirectory : receiptDirectory;
  if (owned && (options.bundleMode === 'ordinary_window' || options.bundleMode === 'promoted')) {
    try {
      prepareWindowPackage(root, owned, source);
    } catch (error) {
      blockers.push(blocker(error));
    }
  }
  const wanted = operation === 'install' ? source?.files : new Map<string, Buffer>();
  const changes: CodexConnectInstallationChange[] = [];
  let afterHooks: Buffer | null = null;
  if (owned && wanted && blockers.length === 0) {
    try {
      if (operation === 'install' || owned.manifest) {
        afterHooks = plannedHooks(owned, source, operation);
      }
      for (const path of [...new Set([...owned.files.keys(), ...wanted.keys()])].sort()) {
        const before = owned.files.get(path),
          after = wanted.get(path);
        const beforeHash = before ? hashBytes(before) : null,
          afterHash = after ? hashBytes(after) : null;
        if (beforeHash !== afterHash) {
          changes.push({
            path,
            action: beforeHash === null ? 'create' : afterHash === null ? 'delete' : 'update',
            beforeHash,
            afterHash
          });
        }
      }
      if (afterHooks && !afterHooks.equals(owned.hookBytes ?? Buffer.alloc(0))) {
        changes.push({
          path: hooksPath,
          action: owned.hookBytes ? 'update' : 'create',
          beforeHash: owned.hookBytes ? hashBytes(owned.hookBytes) : null,
          afterHash: hashBytes(afterHooks)
        });
      }
      if (operation === 'install' && owned.pins.get(selectedReceiptDirectory) === null) {
        changes.push({
          path: selectedReceiptDirectory,
          action: 'create',
          beforeHash: null,
          afterHash: hashBytes('directory:0700')
        });
      }
    } catch (error) {
      blockers.push(blocker(error));
    }
  }
  const beforeHooksHash = owned?.hookBytes ? hashBytes(owned.hookBytes) : null;
  const preview: CodexConnectInstallationPreview = {
    state: blockers.length
      ? 'blocked'
      : !owned?.manifest
        ? 'absent'
        : source &&
            (owned.pins.get(selectedReceiptDirectory) === null ||
              bundleHash(source.files, source.hooks, source.windowHooks) !== bundleHash(owned.files, owned.manifest.hooks, manifestWindowHooks(owned.manifest)))
          ? 'update_available'
          : 'installed',
    source: source ? 'available' : 'unavailable',
    packageHash:
      source && owned
        ? hashBytes(
            JSON.stringify([
              bundleHash(source.files, source.hooks, source.windowHooks),
              owned.rootId,
              beforeHooksHash,
              owned.pins.get(selectedReceiptDirectory) !== null
            ])
          )
        : null,
    installedHash: owned?.manifest
      ? hashBytes(
          JSON.stringify([
            bundleHash(owned.files, owned.manifest.hooks, manifestWindowHooks(owned.manifest)),
            owned.rootId,
            beforeHooksHash,
            owned.pins.get(selectedReceiptDirectory) !== null
          ])
        )
      : null,
    destination,
    receiptDirectory: selectedReceiptDirectory,
    ...(options.bundleMode === 'promoted'
      ? {
          bundleMode: 'promoted' as const,
          bundleRevision: 'codex-promoted-bundle-v1' as const,
          producerContract: 'promoted_producer_contract_unverified' as const,
          requiresFreshRoots: true as const
        }
      : options.bundleMode === 'ordinary_window'
        ? {
            bundleMode: 'ordinary_window' as const,
            bundleRevision: 'codex-window-bundle-v1' as const
          }
        : {}),
    hookRegistration: 'unverified',
    blockers,
    operation,
    changes: blockers.length ? [] : changes,
    beforeHooksHash
  };
  return { preview, owned, source, wanted, afterHooks };
}
export function previewCodexConnectInstallation(root: string, options: CodexConnectInstallationPreviewOptions): CodexConnectInstallationPreview {
  return plan(root, options).preview;
}
export function statusCodexConnectInstallation(root: string, options: CodexConnectInstallationOptions): CodexConnectInstallationStatus {
  const result = plan(root, options).preview;
  return {
    state: result.state,
    source: result.source,
    packageHash: result.packageHash,
    installedHash: result.installedHash,
    destination,
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
    hookRegistration: 'unverified',
    blockers: result.blockers
  };
}
function assertInstallationUnchanged(root: string, owned: ReturnType<typeof inspectOwned>, options: CodexConnectInstallationPreviewOptions): void {
  if (options.bundleMode === 'promoted') assertPromotedBoundary(options);
  const current = inspectOwned(root);
  if (
    current.rootId !== owned.rootId ||
    bundleHash(current.files, current.manifest?.hooks ?? null, manifestWindowHooks(current.manifest)) !==
      bundleHash(owned.files, owned.manifest?.hooks ?? null, manifestWindowHooks(owned.manifest)) ||
    !equal(current.bytes ? hashBytes(current.bytes) : null, owned.bytes ? hashBytes(owned.bytes) : null) ||
    !equal(current.hookBytes ? hashBytes(current.hookBytes) : null, owned.hookBytes ? hashBytes(owned.hookBytes) : null) ||
    [...owned.pins].some(([path, pin]) => pin !== null && current.pins.get(path) !== pin)
  ) {
    fail('installation_preview_changed');
  }
}
function apply(root: string, options: CodexConnectInstallationPreviewOptions): CodexConnectInstallationStatus {
  const planned = plan(root, options);
  const { preview, owned, source, wanted, afterHooks } = planned;
  if (preview.blockers.length || !owned || !wanted) return preview;
  if (
    (options.expectedPackageHash !== undefined && options.expectedPackageHash !== preview.packageHash) ||
    (options.expectedInstalledHash !== undefined && options.expectedInstalledHash !== preview.installedHash)
  ) {
    fail('installation_preview_changed');
  }
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
      if (stat) {
        if (!stat.isDirectory()) fail('unsafe_path');
      } else {
        mkdirSync(join(root, parent), { mode: 0o700 });
        created.push(parent);
      }
      if (rootIdentity(root) !== owned.rootId) {
        fail('changed_project_root');
      }
    }
  };
  const actions: InstallationAction[] = [];
  let locked = false,
    committed = false,
    rollbackFailed = false;
  try {
    ensure(metadata);
    mkdirSync(join(root, lockPath), { mode: 0o700 });
    locked = true;
    const lockOwner = Buffer.from(JSON.stringify({ pid: process.pid, root_identity: owned.rootId }));
    durablePrivateBytes(root, `${lockPath}/owner.json`, lockOwner);
    ensure(transaction);
    if (preview.operation === 'install') ensure(preview.receiptDirectory);
    const recheck = () => assertInstallationUnchanged(root, owned, options);
    recheck();
    for (const change of preview.changes.filter(change => change.path !== preview.receiptDirectory)) {
      actions.push({
        path: change.path,
        before: change.path === hooksPath ? owned.hookBytes : (owned.files.get(change.path) ?? null),
        after: change.path === hooksPath ? afterHooks : (wanted.get(change.path) ?? null),
        moved: false,
        installed: false
      });
    }
    const manifest: Manifest | null = preview.operation === 'install' && source ? installedManifest(owned.rootId, source) : null;
    actions.push({
      path: manifestPath,
      before: owned.bytes,
      after: manifest ? Buffer.from(JSON.stringify(manifest) + '\n') : null,
      moved: false,
      installed: false
    });
    for (const [index, action] of actions.entries()) {
      if (action.after) {
        if (rootIdentity(root) !== owned.rootId) {
          fail('changed_project_root');
        }
        durablePrivateBytes(root, `${transaction}/new-${index}`, action.after);
      }
    }
    recheck();
    let hooksApplied = false;
    for (const [index, action] of actions.entries()) {
      ensure(dirname(action.path));
      const expectedHooks = hooksApplied ? afterHooks : owned.hookBytes;
      const currentHooks = bytesAt(root, hooksPath);
      if ((currentHooks === null) !== (expectedHooks === null) || (currentHooks && !currentHooks.equals(expectedHooks ?? Buffer.alloc(0)))) {
        fail('installation_preview_changed');
      }
      const before = bytesAt(root, action.path);
      if ((before === null) !== (action.before === null) || (before && !before.equals(action.before ?? Buffer.alloc(0)))) fail('installation_preview_changed');
      if (action.before) {
        renameSync(join(root, action.path), join(root, transaction, `old-${index}`));
        action.moved = true;
      }
      if (action.after) {
        renameSync(join(root, transaction, `new-${index}`), join(root, action.path));
        action.installed = true;
      }
      if (action.path === hooksPath) hooksApplied = true;
    }
    committed = true;
  } catch (error) {
    try {
      if (rootIdentity(root) !== owned.rootId) {
        fail('changed_project_root');
      }
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
    } catch {
      rollbackFailed = true;
      fail('installation_rollback_failed');
    }
    throw new CodexConnectInstallationError(blocker(error));
  } finally {
    if (!rollbackFailed && locked) {
      if (rootIdentity(root) !== owned.rootId) {
        fail('changed_project_root');
      }
      if (entry(root, transaction)) {
        for (const [index, action] of actions.entries()) {
          for (const [name, bytes] of [
            [`new-${index}`, action.after],
            [`old-${index}`, action.before]
          ] as const) {
            const path = `${transaction}/${name}`,
              value = bytesAt(root, path);
            if (value) {
              if (!bytes || !value.equals(bytes)) {
                fail('installation_cleanup_failed');
              }
              unlinkSync(join(root, path));
            }
          }
        }
        rmdirSync(join(root, transaction));
      }
      if (entry(root, `${lockPath}/owner.json`)) {
        unlinkSync(join(root, lockPath, 'owner.json'));
      }
      rmdirSync(join(root, lockPath));
      const directories = new Set(created);
      for (const action of actions) {
        let path = dirname(action.path);
        while (path.startsWith(destination)) {
          directories.add(path);
          path = dirname(path);
        }
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
  if (!privateDirectory(root, lockPath)) {
    return statusCodexConnectInstallation(root, options);
  }
  const bytes = bytesAt(root, `${lockPath}/owner.json`);
  if (!bytes) return fail('installation_recovery_required');
  const owner = lockOwnerSchema.parse(readStrictJson(bytes));
  if (owner.root_identity !== owned.rootId) {
    return fail('changed_project_root');
  }
  try {
    process.kill(owner.pid, 0);
    return fail('installation_busy');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
  }
  if (
    readdirSync(join(root, lockPath)).some(name => name !== 'owner.json') ||
    readdirSync(join(root, metadata)).some(name => name.startsWith('transaction-'))
  ) {
    return fail('installation_recovery_required');
  }
  unlinkSync(join(root, lockPath, 'owner.json'));
  rmdirSync(join(root, lockPath));
  return statusCodexConnectInstallation(root, options);
}
