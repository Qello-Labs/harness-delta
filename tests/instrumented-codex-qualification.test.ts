import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile as readAsyncFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Store } from '../src/store.js';
import { runInstrumentedCodexConformance } from '../src/instrumented-codex-conformance.js';
import {
  inspectInstrumentedCodexSource, inspectInstrumentedCodexToolchain,
  qualifyInstrumentedCodexBuild, verifyInstrumentedWorkspaceLock,
  assertInstrumentedReceiverUnchanged, rejectInheritedCargoConfiguration,
  command as runQualificationCommand,
} from '../src/instrumented-codex-qualification.js';
import { hashInstrumentedBinary } from '../src/instrumented-codex-build-identity.js';
import { instrumentedFixtureProfile } from './helpers/instrumented-codex-fixture.js';
import { main } from '../src/cli.js';

const directories: string[] = [];
const gitEnvironment = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
} as const;
vi.mock('node:child_process', { spy: true });
vi.mock('node:fs/promises', { spy: true });
vi.mock('node:http', { spy: true });
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function lock(version: string, count = 161): string {
  return 'version = 4\n' + Array.from({ length: count }, (_, index) =>
    `\n[[package]]\nname = "synthetic-workspace-${index}"\nversion = "${version}"\n`).join('') +
    '\n[[package]]\nname = "synthetic-external"\nversion = "0.0.0"\nsource = "registry+https://example.invalid"\nchecksum = "synthetic-checksum"\n';
}

test('lock repair changes exactly the workspace packages and preserves external dependency bytes', () => {
  expect(() => verifyInstrumentedWorkspaceLock(lock('0.0.0'), lock('0.162.1'))).not.toThrow();
});

test.each([
  lock('0.162.1', 160),
  lock('0.162.1').replace('checksum = "synthetic-checksum"', 'checksum = "replaced-checksum"'),
  lock('0.162.1').replace('source = "registry+https://example.invalid"', 'source = "git+https://example.invalid"'),
  lock('0.162.1') + '\n[[package]]\nname = "new-dependency"\nversion = "1.0.0"\n',
  lock('0.162.1').replace('name = "synthetic-external"\nversion = "0.0.0"', 'name = "synthetic-external"\nversion = "0.162.1"'),
])('rejects a lockfile with unreviewed dependency or package changes (%#)', patched => {
  expect(() => verifyInstrumentedWorkspaceLock(lock('0.0.0'), patched)).toThrow('lock_mismatch');
});

test('does not generalize the release repair to another workspace package set', () => {
  expect(() => verifyInstrumentedWorkspaceLock(lock('0.0.0', 160), lock('0.162.1', 160)))
    .toThrow('lock_mismatch');
});

test('a checkout claiming a different HEAD cannot reach source qualification', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hd-source-rejection-'));
  directories.push(root);
  execFileSync('/usr/bin/git', ['init', '--quiet', root], { env: gitEnvironment });
  writeFileSync(join(root, '.git/HEAD'), `${'a'.repeat(40)}\n`);
  const before = readFileSync(join(root, '.git/HEAD'));
  await expect(inspectInstrumentedCodexSource(root)).rejects.toThrow('source_mismatch');
  expect(readFileSync(join(root, '.git/HEAD'))).toEqual(before);
});

test('canonical patch rendering reaches source rejection through real Git diff commands', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hd-source-rendering-'));
  directories.push(root);
  const env = gitEnvironment;
  execFileSync('/usr/bin/git', ['init', '--quiet', root], { env });
  mkdirSync(join(root, 'codex-rs'));
  const metadata = join(root, 'codex-rs/source.txt');
  writeFileSync(metadata, '1\n\n2\n');
  execFileSync('/usr/bin/git', ['-C', root, 'add', '.'], { env });
  execFileSync('/usr/bin/git', ['-C', root, '-c', 'user.name=Synthetic',
    '-c', 'user.email=synthetic@example.invalid', 'commit', '--quiet', '-m', 'Synthetic source'], { env });
  writeFileSync(metadata, '1\n\n3\n');
  writeFileSync(join(root, 'codex-rs/addition.txt'), '4\n');
  const { spawn: original } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const diffs: Buffer[] = [];
  vi.mocked(spawn).mockImplementation((program, args, options) => {
    const child = program === '/usr/bin/git' && args.includes('rev-parse')
      ? original('/usr/bin/printf', ['092d3acd6bec3e3a14bdc7e7a2810ab628ab759d\n'], options)
      : original(program, args, options);
    if (program === '/usr/bin/git' && args.includes('diff')) {
      child.stdout!.on('data', (chunk: Buffer) => diffs.push(chunk));
    }
    return child;
  });

  await expect(inspectInstrumentedCodexSource(root)).rejects.toThrow('source_mismatch');
  expect(vi.mocked(spawn).mock.calls.filter(([program, args]) =>
    program === '/usr/bin/git' && Array.isArray(args) && args.includes('diff'))).toHaveLength(2);
  expect(Buffer.concat(diffs).toString('utf8').split('\n')).not.toContain(' ');
});

test('version-reporting shell shims are not an inspected native Rust toolchain', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hd-toolchain-rejection-'));
  directories.push(root);
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin/rustc'), '#!/bin/sh\nprintf "release: 1.95.0\\nhost: aarch64-apple-darwin\\n"\n',
    { mode: 0o755 });
  writeFileSync(join(root, 'bin/cargo'), '#!/bin/sh\nprintf "cargo 1.95.0 synthetic\\n"\n', { mode: 0o755 });
  await expect(inspectInstrumentedCodexToolchain(root)).rejects.toThrow('toolchain_mismatch');
});

describe.runIf(process.platform === 'darwin' && process.arch === 'arm64')('native compiler shims', () => {
  let root: string;
  let marker: string;
  beforeEach(async ({ signal }) => {
    root = mkdtempSync(join(tmpdir(), 'hd-native-toolchain-rejection-'));
    directories.push(root);
    mkdirSync(join(root, 'bin'));
    marker = join(root, 'executed');
    const source = join(root, 'compiler.c');
    writeFileSync(source, `#include <stdio.h>
#include <string.h>
int main(int argc, char **argv) {
  FILE *marker = fopen("${marker}", "w");
  if (marker) fclose(marker);
  if (strstr(argv[0], "cargo")) puts("cargo 1.95.0 synthetic");
  else puts("release: 1.95.0\\nhost: aarch64-apple-darwin");
  return 0;
}
`);
    await runQualificationCommand('/usr/bin/clang', [source, '-o', join(root, 'bin/rustc')],
      root, process.env, undefined, [0], signal);
    writeFileSync(join(root, 'bin/cargo'), readFileSync(join(root, 'bin/rustc')), { mode: 0o755 });
  });

  test('native version-reporting compiler shims are rejected before execution', async () => {
    await expect(inspectInstrumentedCodexToolchain(root)).rejects.toThrow('toolchain_mismatch');
    expect(existsSync(marker)).toBe(false);
  });
});

test('ancestor Cargo configuration cannot execute an inherited compiler wrapper', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hd-cargo-config-rejection-'));
  directories.push(root);
  const build = join(root, 'build');
  mkdirSync(build);
  mkdirSync(join(root, '.cargo'));
  const marker = join(root, 'executed');
  const wrapper = join(root, 'wrapper');
  writeFileSync(wrapper, `#!/bin/sh\nprintf synthetic > "${marker}"\n`, { mode: 0o755 });
  writeFileSync(join(root, '.cargo/config.toml'), `[build]\nrustc-wrapper = "${wrapper}"\n`);
  await expect(rejectInheritedCargoConfiguration(build)).rejects.toThrow('source_mismatch');
  expect(existsSync(marker)).toBe(false);
});

test('receiver bytes changed after module loading cannot become the build fingerprint', async () => {
  await expect(assertInstrumentedReceiverUnchanged()).resolves.toBeUndefined();
  vi.mocked(readAsyncFile).mockResolvedValueOnce(Buffer.from('synthetic package update'));
  await expect(assertInstrumentedReceiverUnchanged()).rejects.toThrow('input_changed');
});

test('compilation cancellation closes the owned parent and descendant process group', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hd-compilation-cancel-'));
  directories.push(root);
  const controller = new AbortController();
  const timeout = AbortSignal.timeout(3000);
  let resolveReady!: (value: { parent: number; descendant: number }) => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<{ parent: number; descendant: number }>((resolve, reject) => {
    resolveReady = resolve; rejectReady = reject;
  });
  timeout.addEventListener('abort', () => rejectReady(timeout.reason), { once: true });
  const actualSpawn = (await vi.importActual<typeof import('node:child_process')>('node:child_process')).spawn;
  vi.mocked(spawn).mockImplementationOnce((...args) => {
    const child = actualSpawn(...args);
    let text = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8');
      if (text.includes('\n')) resolveReady(JSON.parse(text.trim()) as { parent: number; descendant: number });
    });
    return child;
  });
  const pending = runQualificationCommand(process.execPath,
    [new URL('./helpers/instrumented-qualification-process.mjs', import.meta.url).pathname],
    root, { PATH: process.env.PATH }, undefined, [0], controller.signal);
  const outcome = pending.then(value => ({ value, error: null }), (error: unknown) => ({ value: null, error }));
  const pids = await ready.finally(() => { controller.abort(); });
  expect((await outcome).error).toMatchObject({ name: 'AbortError' });
  for (const pid of [pids.parent, pids.descendant]) {
    const result = spawn('/bin/ps', ['-o', 'stat=', '-p', String(pid)]);
    let state = '';
    result.stdout.on('data', (chunk: Buffer) => { state += chunk.toString('utf8'); });
    await new Promise<void>((resolve, reject) => {
      result.once('error', reject); result.once('close', () => resolve());
    });
    expect(state.trim() === '' || state.trim().startsWith('Z')).toBe(true);
  }
});

test.runIf(process.platform === 'darwin')('conformance cancellation closes descendants and removes receiver state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hd-conformance-cancel-'));
  directories.push(root);
  const binary = join(root, 'synthetic-codex');
  writeFileSync(binary, `#!${process.execPath}\n` +
    readFileSync(new URL('./helpers/instrumented-qualification-process.mjs', import.meta.url), 'utf8'),
  { mode: 0o755 });
  const controller = new AbortController();
  let resolveReady!: (value: number) => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<number>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const timeout = AbortSignal.timeout(3000);
  timeout.addEventListener('abort', () => rejectReady(timeout.reason), { once: true });
  let receiverRoot = '';
  const actualSpawn = (await vi.importActual<typeof import('node:child_process')>('node:child_process')).spawn;
  vi.mocked(spawn).mockImplementationOnce((...args) => {
    receiverRoot = String(args[2]?.cwd);
    const child = actualSpawn(...args);
    let text = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8');
      if (text.includes('\n')) resolveReady((JSON.parse(text.trim()) as { descendant: number }).descendant);
    });
    return child;
  });
  const profile = { ...instrumentedFixtureProfile, binary_sha256: hashInstrumentedBinary(binary) };
  const outcome = runInstrumentedCodexConformance(binary, profile, controller.signal)
    .then(value => ({ value, error: null }), (error: unknown) => ({ value: null, error }));
  const descendant = await ready.finally(() => { controller.abort(); });
  expect((await outcome).error).toMatchObject({ name: 'AbortError' });
  expect(existsSync(receiverRoot)).toBe(false);
  const child = spawn('/bin/ps', ['-o', 'stat=', '-p', String(descendant)]);
  let state = '';
  child.stdout.on('data', (chunk: Buffer) => { state += chunk.toString('utf8'); });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject); child.once('close', () => resolve());
  });
  expect(state.trim() === '' || state.trim().startsWith('Z')).toBe(true);
});

test('conformance spawn failure closes the receiver server and removes its database', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hd-conformance-spawn-failure-'));
  directories.push(root);
  const binary = join(root, 'synthetic-executable');
  writeFileSync(binary, 'synthetic executable bytes');
  let receiverRoot = '';
  let receiverServer: ReturnType<typeof createServer> | undefined;
  let serverClosed = false;
  const actualHttp = await vi.importActual<typeof import('node:http')>('node:http');
  vi.mocked(createServer).mockImplementationOnce((...args) => {
    receiverServer = actualHttp.createServer(...args);
    receiverServer.once('close', () => { serverClosed = true; });
    return receiverServer;
  });
  const actualProcesses = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  vi.mocked(spawn).mockImplementationOnce((_program, args, options) => {
    receiverRoot = String(options?.cwd);
    return actualProcesses.spawn(join(root, 'missing-program'), args, options);
  });
  await expect(runInstrumentedCodexConformance(binary,
    { ...instrumentedFixtureProfile, binary_sha256: hashInstrumentedBinary(binary) }))
    .rejects.toMatchObject({ code: 'ENOENT' });
  expect(serverClosed).toBe(true);
  expect(receiverServer?.listening).toBe(false);
  expect(existsSync(receiverRoot)).toBe(false);
});

test('conformance rejects a profile for different executable bytes before launching it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hd-conformance-rejection-'));
  directories.push(root);
  const binary = join(root, 'not-a-qualified-executable');
  writeFileSync(binary, 'synthetic executable bytes');
  await expect(runInstrumentedCodexConformance(binary, instrumentedFixtureProfile)).rejects.toThrow();
});

test('caller profile, passed verdict, and hash flags never authorize identity insertion', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hd-qualification-rejection-'));
  directories.push(root);
  const store = new Store(join(root, 'store.sqlite'));
  try {
    for (const authority of [
      { profile: { binary_sha256: 'a'.repeat(64) } }, { passed: true }, { hashVerified: true },
    ]) {
      const input = {
        checkoutPath: root, toolchainPath: root, cargoHomePath: root, buildRootPath: root,
        ...authority,
      };
      await expect(qualifyInstrumentedCodexBuild(store, input)).rejects.toThrow();
      expect(store.get<{ count: number }>('SELECT count(*) AS count FROM instrumented_codex_build_identities')?.count)
        .toBe(0);
    }
  } finally { store.close(); }
});

test('source rejection leaves the caller database without production qualification', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hd-qualification-rejection-'));
  directories.push(root);
  execFileSync('/usr/bin/git', ['init', '--quiet', root], { env: gitEnvironment });
  writeFileSync(join(root, '.git/HEAD'), `${'b'.repeat(40)}\n`);
  const store = new Store(join(root, 'store.sqlite'));
  try {
    await expect(qualifyInstrumentedCodexBuild(store, {
      checkoutPath: root, toolchainPath: root, cargoHomePath: root, buildRootPath: root,
    })).rejects.toThrow();
    expect(store.get<{ count: number }>('SELECT count(*) AS count FROM instrumented_codex_build_identities')?.count)
      .toBe(0);
  } finally { store.close(); }
});

test('CLI qualification accepts only execution locations, never a caller qualification verdict', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hd-qualification-cli-'));
  directories.push(root);
  const database = join(root, 'receiver.sqlite');
  const config = join(root, 'locations.json');
  writeFileSync(config, JSON.stringify({
    checkout_path: root, toolchain_path: root, cargo_home_path: root, build_root_path: root,
    passed: true,
  }));
  expect(await main(['--db', database, 'instrumented-codex', 'qualify', '--locations', config])).toBe(2);
  expect(await main(['--db', database, 'instrumented-codex', 'qualify', '--locations', config,
    '--profile', 'claimed-profile'])).toBe(2);
  const store = new Store(database);
  try {
    expect(store.all('SELECT id FROM instrumented_codex_build_identities')).toEqual([]);
    expect(store.all('SELECT id FROM sessions')).toEqual([]);
  } finally { store.close(); }
});
