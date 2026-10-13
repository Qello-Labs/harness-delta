import { spawn } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { Store } from './store.js';
import { instrumentedMetadataHash } from './instrumented-codex-accounting.js';
import { hashInstrumentedBinary } from './instrumented-codex-build-identity.js';
import { InstrumentedBuildIdentitySchema, InstrumentedProducerProfileSchema } from './instrumented-codex-contracts.js';
import { runInstrumentedCodexConformance } from './instrumented-codex-conformance.js';
import { IdSchema } from './contracts.js';

const upstreamCommit = '092d3acd6bec3e3a14bdc7e7a2810ab628ab759d';
const target = 'aarch64-apple-darwin';
const acceptedCompiler = {
  distributionManifest: '821ff14e4c4a1cbe1e8915f35aff0a3fbbdf8d293ad48ab8f31e3b0440c581f9',
  installedTree: '04052d94aa9c3f55c1f162486258f1a4e475ddd6d5908f80426032d586ca1590',
} as const;
const recipe = {
  version: 1, upstreamCommit, target, rust: '1.95.0',
  command: ['build', '--locked', '--offline', '--target', target, '-p', 'codex-cli', '--bin', 'codex'],
  profile: 'dev', incremental: false, debug: 0,
  transport: IdSchema.parse('http1-responses-no-redirect-no-implicit-retry-no-pool-v1'),
  counter: IdSchema.parse('presence-preserving-disjoint-tokens-v1'),
  configuration: IdSchema.parse('fresh-root-direct-v2-two-children-gpt-61-sol-high-telemetry-off-v1'),
  acceptedCompiler,
} as const;

const LocationsSchema = z.strictObject({
  checkoutPath: z.string().min(1), toolchainPath: z.string().min(1),
  cargoHomePath: z.string().min(1), buildRootPath: z.string().min(1),
});
export type InstrumentedQualificationLocations = z.infer<typeof LocationsSchema>;

export class InstrumentedQualificationError extends Error {
  readonly name = 'InstrumentedQualificationError';
  constructor(readonly code:
    'source_mismatch' | 'lock_mismatch' | 'toolchain_mismatch' | 'platform_mismatch' |
    'command_failed' | 'input_changed' | 'identity_conflict') { super(code); }
}

function sha(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const ownModules = [
  'instrumented-codex-qualification', 'instrumented-codex-conformance',
  'instrumented-codex-accounting', 'instrumented-codex-contracts',
  'instrumented-codex-descriptor', 'instrumented-codex-build-identity',
  'instrumented-codex-cost', 'instrumented-codex-usage',
];
const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
// Cached modules must never be fingerprinted as a package update that occurs during Cargo.
const loadedReceiverDigests = ownModules.map(name => ({
  name, digest: sha(readFileSync(new URL(`./${name}.${extension}`, import.meta.url))),
}));

export async function assertInstrumentedReceiverUnchanged(): Promise<void> {
  for (const { name, digest } of loadedReceiverDigests) {
    if (digest !== sha(await readFile(new URL(`./${name}.${extension}`, import.meta.url)))) {
      throw new InstrumentedQualificationError('input_changed');
    }
  }
}

export async function rejectInheritedCargoConfiguration(directory: string): Promise<void> {
  let current = await realpath(directory);
  for (;;) {
    for (const name of ['config', 'config.toml']) {
      try {
        await lstat(join(current, '.cargo', name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      throw new InstrumentedQualificationError('source_mismatch');
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

const gitEnvironment = {
  PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C',
};
const qualificationCancellation = new AsyncLocalStorage<AbortSignal | undefined>();

export async function command(
  program: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = gitEnvironment,
  input?: Buffer, allowedCodes: readonly number[] = [0],
  signal = qualificationCancellation.getStore(),
): Promise<Buffer> {
  signal?.throwIfAborted();
  const child = spawn(program, [...args], { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const terminate = () => {
    if (child.pid === undefined) return;
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  };
  const chunks: Buffer[] = [];
  let length = 0;
  let overflow = false;
  child.stdout.on('data', (chunk: Buffer) => {
    length += chunk.length;
    if (length <= 64 * 1024 * 1024) chunks.push(chunk);
    else { overflow = true; terminate(); }
  });
  child.stderr.resume();
  const completion = new Promise<number | null>((resolveCode, reject) => {
    child.once('error', reject);
    child.once('close', resolveCode);
  });
  let inputFailure = false;
  child.stdin.on('error', () => { inputFailure = true; });
  signal?.addEventListener('abort', terminate, { once: true });
  const timer = setTimeout(terminate, 1_800_000);
  child.stdin.end(input);
  try {
    const code = await completion;
    signal?.throwIfAborted();
    if (inputFailure || overflow || code === null || !allowedCodes.includes(code)) {
      throw new InstrumentedQualificationError('command_failed');
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', terminate);
  }
}

function git(checkout: string, args: readonly string[], input?: Buffer, allowedCodes?: readonly number[]) {
  return command('/usr/bin/git', [
    '-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', '-c', 'core.fsmonitor=false',
    '-c', 'diff.external=', ...args,
  ], checkout, gitEnvironment, input, allowedCodes);
}

/** Only the release's internal workspace version repair is allowed in Cargo.lock. */
export function verifyInstrumentedWorkspaceLock(base: string, patched: string): void {
  let changed = 0;
  const expected = base.split('[[package]]').map(block => {
    if (/^source = /m.test(block) || !/^version = "0\.0\.0"$/m.test(block)) return block;
    changed++;
    return block.replace(/^version = "0\.0\.0"$/m, 'version = "0.162.1"');
  }).join('[[package]]');
  if (changed !== 161 || expected !== patched) throw new InstrumentedQualificationError('lock_mismatch');
}

async function patchBytes(): Promise<Buffer> {
  return readFile(new URL('../native/instrumented-codex-01621.patch', import.meta.url));
}

async function currentPatch(checkout: string): Promise<Buffer> {
  const head = (await git(checkout, ['rev-parse', 'HEAD'])).toString('utf8').trim();
  if (head !== upstreamCommit) throw new InstrumentedQualificationError('source_mismatch');
  const tracked = await git(checkout, [
    '-c', 'diff.suppressBlankEmpty=true', 'diff', '--no-ext-diff', '--no-textconv', '--binary', '--full-index', '--no-renames',
    '--ignore-submodules=none', 'HEAD', '--',
  ]);
  const additions = (await git(checkout, ['ls-files', '--others', '--exclude-standard', '-z']))
    .toString('utf8').split('\0').filter(Boolean).sort();
  const chunks = [tracked];
  for (const path of additions) {
    if (!/^codex-rs\/[a-zA-Z0-9_./-]+$/.test(path)) {
      throw new InstrumentedQualificationError('source_mismatch');
    }
    chunks.push(await git(checkout, [
      '-c', 'diff.suppressBlankEmpty=true', 'diff', '--no-ext-diff', '--no-textconv', '--binary', '--full-index', '--no-index', '--', '/dev/null', path,
    ], undefined, [1]));
  }
  return Buffer.concat(chunks);
}

/** A local checkout is only a source location; neither its profile nor its hashes are accepted. */
export async function inspectInstrumentedCodexSource(checkoutPath: string) {
  const checkout = await realpath(checkoutPath);
  const actual = await currentPatch(checkout);
  const patch = await patchBytes();
  if (!actual.equals(patch)) {
    throw new InstrumentedQualificationError('source_mismatch');
  }
  const baseLock = await git(checkout, ['show', `${upstreamCommit}:codex-rs/Cargo.lock`]);
  const lock = await readFile(join(checkout, 'codex-rs/Cargo.lock'));
  verifyInstrumentedWorkspaceLock(baseLock.toString('utf8'), lock.toString('utf8'));
  return { patchDigest: sha(patch), dependencyLockDigest: sha(lock) };
}

async function treeDigest(root: string, paths?: readonly string[], internalLinksOnly = false): Promise<string> {
  const entries: { path: string; mode: number; digest: string }[] = [];
  async function inspect(path: string): Promise<void> {
    const file = join(root, path);
    const stat = await lstat(file);
    if (stat.isSymbolicLink()) {
      if (internalLinksOnly && !(await realpath(file)).startsWith(`${root}/`)) {
        throw new InstrumentedQualificationError('toolchain_mismatch');
      }
      entries.push({ path, mode: 0o120000, digest: sha(await readlink(file)) });
    } else if (stat.isFile()) {
      entries.push({ path, mode: stat.mode & 0o111 ? 0o100755 : 0o100644, digest: sha(await readFile(file)) });
    } else if (stat.isDirectory()) {
      for (const name of (await readdir(file)).sort()) await inspect(path ? `${path}/${name}` : name);
    } else throw new InstrumentedQualificationError('source_mismatch');
  }
  if (paths) for (const path of [...paths].sort()) await inspect(path);
  else await inspect('');
  return instrumentedMetadataHash(entries);
}

export async function inspectInstrumentedCodexToolchain(toolchainPath: string) {
  const toolchain = await realpath(toolchainPath);
  const digest = await treeDigest(toolchain, undefined, true);
  if (digest !== acceptedCompiler.installedTree) {
    throw new InstrumentedQualificationError('toolchain_mismatch');
  }
  const rustc = join(toolchain, 'bin/rustc');
  const cargo = join(toolchain, 'bin/cargo');
  for (const path of [rustc, cargo]) {
    const stat = await lstat(path);
    const header = (await readFile(path)).subarray(0, 4).toString('hex');
    if (!stat.isFile() || !['cffaedfe', 'feedfacf', 'cafebabe', 'bebafeca'].includes(header)) {
      throw new InstrumentedQualificationError('toolchain_mismatch');
    }
  }
  const rustVersion = (await command(rustc, ['--version', '--verbose'], toolchain)).toString('utf8');
  const cargoVersion = (await command(cargo, ['--version'], toolchain)).toString('utf8');
  if (!/^release: 1\.95\.0$/m.test(rustVersion) || !/^host: aarch64-apple-darwin$/m.test(rustVersion) ||
      !/^cargo 1\.95\.0 /.test(cargoVersion)) {
    throw new InstrumentedQualificationError('toolchain_mismatch');
  }
  return { digest, rustVersion, cargoVersion };
}

/**
 * The sole issuance path owns fresh source materialization, frozen Cargo execution and
 * actual fd3 conformance. Execution locations cannot provide a profile or a verdict.
 */
export async function qualifyInstrumentedCodexBuild(store: Store, input: unknown, signal?: AbortSignal) {
  return qualificationCancellation.run(signal, () => qualifyOwnedBuild(store, input));
}

async function qualifyOwnedBuild(store: Store, input: unknown) {
  const signal = qualificationCancellation.getStore();
  signal?.throwIfAborted();
  const locations = LocationsSchema.parse(input);
  await assertInstrumentedReceiverUnchanged();
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new InstrumentedQualificationError('platform_mismatch');
  }
  const checkout = await realpath(locations.checkoutPath);
  const source = await inspectInstrumentedCodexSource(checkout);
  const toolchain = await realpath(locations.toolchainPath);
  const compiler = await inspectInstrumentedCodexToolchain(toolchain);
  const nativeTools: Record<string, string> = {};
  const nativeToolDigests: Record<string, string> = {};
  for (const name of ['clang', 'clang++', 'ar', 'ranlib', 'ld']) {
    const path = (await command('/usr/bin/xcrun', ['--find', name], toolchain)).toString('utf8').trim();
    nativeTools[name] = await realpath(path);
    nativeToolDigests[name] = sha(await readFile(path));
  }
  const sdk = await realpath((await command('/usr/bin/xcrun', ['--show-sdk-path'], toolchain))
    .toString('utf8').trim());
  const sdkDigest = await treeDigest(sdk);
  const cache = await realpath(locations.cargoHomePath);
  const buildRoot = await realpath(locations.buildRootPath);
  await rejectInheritedCargoConfiguration(buildRoot);
  const root = await mkdtemp(join(buildRoot, 'instrumented-codex-'));
  const snapshot = join(root, 'source');
  const cargoHome = join(root, 'cargo-home');
  const home = join(root, 'home');
  const buildTarget = join(root, 'target');
  const patch = await patchBytes();
  let issued = false;
  try {
    await mkdir(home);
    await git(root, ['clone', '--no-hardlinks', '--no-checkout', '--local', checkout, snapshot]);
    await git(snapshot, ['checkout', '--detach', upstreamCommit]);
    await git(snapshot, ['apply', '--index', '--binary', '-'], patch);
    const paths = (await git(snapshot, ['ls-files', '-z'])).toString('utf8').split('\0').filter(Boolean);
    const sourceDigest = await treeDigest(snapshot, paths);
    if (sourceDigest !== await treeDigest(checkout, paths)) {
      throw new InstrumentedQualificationError('source_mismatch');
    }
    // Reuse downloaded archives and Git objects, never caller Cargo config, extracted
    // registry sources, Git worktrees, build scripts' output or incremental artifacts.
    for (const path of ['registry/cache', 'registry/index', 'git/db']) {
      await cp(join(cache, path), join(cargoHome, path), { recursive: true, dereference: true });
    }
    await rejectInheritedCargoConfiguration(root);
    await assertInstrumentedReceiverUnchanged();
    await command(join(toolchain, 'bin/cargo'), recipe.command, join(snapshot, 'codex-rs'), {
      ...gitEnvironment, HOME: home, PATH: `${join(toolchain, 'bin')}:/usr/bin:/bin`,
      CARGO_HOME: cargoHome, CARGO_TARGET_DIR: buildTarget,
      RUSTC: join(toolchain, 'bin/rustc'), RUSTDOC: join(toolchain, 'bin/rustdoc'),
      CARGO_INCREMENTAL: '0', CARGO_PROFILE_DEV_DEBUG: '0',
      CC: nativeTools.clang, CXX: nativeTools['clang++'], AR: nativeTools.ar, RANLIB: nativeTools.ranlib,
      CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER: nativeTools.clang, SDKROOT: sdk,
      SOURCE_DATE_EPOCH: (await git(snapshot, ['show', '-s', '--format=%ct', upstreamCommit])).toString('utf8').trim(),
      RUSTFLAGS: `--remap-path-prefix=${root}=/instrumented-build --remap-path-prefix=${toolchain}=/rust-toolchain`,
    });
    const binaryPath = join(buildTarget, target, 'debug/codex');
    const binaryHash = hashInstrumentedBinary(binaryPath);
    const version = (await command(binaryPath, ['--version'], home, {
      PATH: '/usr/bin:/bin', HOME: home, CODEX_HOME: home,
    })).toString('utf8').trim();
    if (version !== 'codex-cli 0.162.1') throw new InstrumentedQualificationError('input_changed');
    const codeDigests = loadedReceiverDigests;
    const manifest = {
      recipe, recipeDigest: instrumentedMetadataHash({ recipe, codeDigests }),
      patchDigest: source.patchDigest, sourceDigest,
      dependencyLockDigest: source.dependencyLockDigest, compiler,
      nativeToolDigests, sdkDigest,
      receiverRuntime: { version: process.version, binaryDigest: hashInstrumentedBinary(process.execPath) },
    };
    const manifestHash = instrumentedMetadataHash(manifest);
    const profile = InstrumentedProducerProfileSchema.parse({
      schema_version: 1, profile_id: 'codex-instrumented-01621-http-direct-v2-v1',
      upstream_commit: upstreamCommit, upstream_version: '0.162.1', product_version: '0.162.1',
      patched_source_digest: sourceDigest, dependency_lock_digest: source.dependencyLockDigest,
      build_manifest_digest: manifestHash, binary_sha256: binaryHash, target,
      producer_protocol: 'harness-codex-accounting-v1', qualification_id: `native-localhost:${manifestHash}`,
      transport_contract_id: recipe.transport, operation_inventory_digest: source.patchDigest,
      counter_contract_id: recipe.counter, configuration_policy_id: recipe.configuration,
      model: 'gpt-6.1-sol', effort: 'high', max_roots: 1, max_direct_children: 2, max_depth: 1,
    });
    const conformance = await runInstrumentedCodexConformance(binaryPath, profile, signal);
    if (hashInstrumentedBinary(binaryPath) !== binaryHash ||
        sourceDigest !== await treeDigest(snapshot, paths) ||
        sourceDigest !== await treeDigest(checkout, paths) ||
        source.patchDigest !== (await inspectInstrumentedCodexSource(checkout)).patchDigest ||
        compiler.digest !== (await inspectInstrumentedCodexToolchain(toolchain)).digest ||
        !patch.equals(await patchBytes())) {
      throw new InstrumentedQualificationError('input_changed');
    }
    for (const [name, path] of Object.entries(nativeTools)) {
      if (nativeToolDigests[name] !== sha(await readFile(path))) {
        throw new InstrumentedQualificationError('input_changed');
      }
    }
    if (sdkDigest !== await treeDigest(sdk)) throw new InstrumentedQualificationError('input_changed');
    await assertInstrumentedReceiverUnchanged();
    await rejectInheritedCargoConfiguration(root);
    signal?.throwIfAborted();
    const identity = InstrumentedBuildIdentitySchema.parse({
      schema_version: 1, id: randomUUID(), profile, qualification_kind: 'instrumented_localhost',
      qualification_hash: instrumentedMetadataHash({ manifest, binaryHash, conformance }),
      qualified_at: new Date().toISOString(),
    });
    store.immediateTransaction(() => {
      if (store.get('SELECT id FROM instrumented_codex_build_identities WHERE binary_sha256=? AND manifest_hash=?',
        [binaryHash, manifestHash])) throw new InstrumentedQualificationError('identity_conflict');
      store.execute(
        'INSERT INTO instrumented_codex_build_identities(id,profile_id,binary_sha256,manifest_hash,qualification_kind,qualification_hash,qualified_at,payload) VALUES (?,?,?,?,?,?,?,?)',
        [identity.id, profile.profile_id, binaryHash, manifestHash, identity.qualification_kind,
          identity.qualification_hash, identity.qualified_at, JSON.stringify(identity)]);
    });
    issued = true;
    return { identity, binaryPath, manifest, conformance };
  } finally {
    if (!issued) await rm(root, { recursive: true, force: true });
  }
}
