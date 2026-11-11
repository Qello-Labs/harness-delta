import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { buildWindowSandboxProfile, createOwnedWindowImage } from '../scripts/tool-update/codex-window-containment.mjs';

const roots: string[] = [];

test.each(['/runtime/node', '/usr/bin/python3', '/bin/sh', '/unreviewed/tool', 'launcher'])(
  'rejects interpreter or nonnative vendor execution at %s',
  executable => {
    const root = directory();
    const prefix = join(root, 'prefix');
    expect(() =>
      buildWindowSandboxProfile({
        caseRoots: [join(root, 'case')],
        vendorPrefix: prefix,
        runtimePaths: ['/runtime/lib/libnode.dylib'],
        executables: [executable === 'launcher' ? join(prefix, 'node_modules/@openai/codex/bin/codex.js') : executable],
        port: 43123,
        home: '/Users/synthetic'
      })
    ).toThrow('containment_exec_unapproved');
  }
);

test('runtime alias links are readable without granting a directory subtree', () => {
  const root = directory();
  const profile = buildWindowSandboxProfile({
    caseRoots: [join(root, 'case')],
    vendorPrefix: join(root, 'prefix'),
    runtimePaths: ['/runtime/lib/libnode.dylib'],
    runtimeLinks: ['/runtime/alias'],
    executables: [nativePath(join(root, 'prefix'))],
    port: 43123,
    home: '/Users/synthetic'
  });
  expect(profile.bytes).toContain('(literal "/runtime/alias")');
  expect(profile.bytes).not.toContain('(subpath "/runtime/alias")');
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});
function directory() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'window-containment-'));
  roots.push(root);
  return root;
}

function nativePath(prefix: string, name = 'codex') {
  return join(prefix, 'node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin', name);
}

test('the pinned SBPL is deny-default with one exact outbound endpoint and explicit file and exec paths', () => {
  const root = directory();
  const profile = buildWindowSandboxProfile({
    caseRoots: [join(root, 'mount/cases/normal')],
    vendorPrefix: join(root, 'mount/prefix'),
    runtimePaths: ['/runtime/node'],
    executables: [nativePath(join(root, 'mount/prefix')), nativePath(join(root, 'mount/prefix'), 'codex-code-mode-host')],
    port: 43123,
    home: '/Users/synthetic-user'
  });
  expect(profile.sha256).toBe(createHash('sha256').update(profile.bytes).digest('hex'));
  expect(profile.bytes).toContain('(deny default)');
  expect(profile.bytes).not.toContain('(allow default)');
  expect(profile.bytes).toContain('(remote tcp4 "localhost:43123")');
  expect(profile.bytes).not.toContain('(allow network-inbound');
  expect(profile.bytes).not.toContain('(allow mach-lookup');
  expect(profile.bytes).toContain('(literal "/runtime/node")');
  expect(profile.bytes).toContain('(subpath "/Users/synthetic-user/.codex")');
  expect(profile.bytes).not.toContain('(subpath "/Users/synthetic-user")');
});

test.each([0, 65536, -1, 1.5])('refuses an unfrozen or invalid oracle port %s', port => {
  const root = directory();
  expect(() =>
    buildWindowSandboxProfile({
      caseRoots: [join(root, 'case')],
      vendorPrefix: join(root, 'prefix'),
      runtimePaths: ['/runtime/node'],
      executables: [nativePath(join(root, 'prefix'))],
      port,
      home: '/Users/synthetic'
    })
  ).toThrow('containment_input_invalid');
});

test.each([
  'vendor/aarch64-apple-darwin/codex-path/rg',
  'vendor/aarch64-apple-darwin/codex-resources/voice/bin/codex-voice-host',
  'vendor/aarch64-apple-darwin/codex-resources/voice/lib/libffi.8.dylib'
])('refuses unselected vendor execution at %s', relativePath => {
  const root = directory();
  const prefix = join(root, 'prefix');
  expect(() =>
    buildWindowSandboxProfile({
      caseRoots: [join(root, 'case')],
      vendorPrefix: prefix,
      runtimePaths: ['/runtime/node'],
      executables: [join(prefix, 'node_modules/@openai/codex-darwin-arm64', relativePath)],
      port: 43123,
      home: '/Users/synthetic'
    })
  ).toThrow('containment_exec_unapproved');
});

test('runtime reads are literal and vendor executable mappings exclude readable resources', () => {
  const root = directory();
  const prefix = join(root, 'prefix');
  const cli = join(prefix, 'node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex');
  const profile = buildWindowSandboxProfile({
    caseRoots: [join(root, 'case')],
    vendorPrefix: prefix,
    runtimePaths: ['/runtime/node', '/runtime/libnode.dylib'],
    executables: [cli],
    port: 43123,
    home: '/Users/synthetic'
  });
  expect(profile.bytes).toContain('(literal "/runtime/libnode.dylib")');
  expect(profile.bytes).not.toContain('(subpath "/runtime/libnode.dylib")');
  expect(profile.bytes).toContain(`(deny file-map-executable (subpath ${JSON.stringify(join(root, 'case'))}))`);
  expect(profile.bytes).toContain(
    `(deny file-map-executable (require-all (subpath ${JSON.stringify(prefix)}) (require-not (require-any (literal ${JSON.stringify(cli)})))))`
  );
});

function imageFixture(failure: 'none' | 'attach' | 'detach' | 'foreign' | 'oversized' = 'none') {
  const root = directory();
  const events = new EventEmitter();
  let mounted = false;
  let created = false;
  const run = (command: string, args: readonly string[]) => {
    if (command !== '/usr/bin/hdiutil') throw new Error('unexpected_tool');
    if (args[0] === 'create') {
      writeFileSync(join(root, 'volume.sparseimage'), '', {
        mode: 0o600
      });
      created = true;
    } else if (args[0] === 'attach') {
      mounted = true;
      if (failure === 'attach') {
        return Promise.resolve({ code: 1, stdout: '' });
      }
    } else if (args[0] === 'detach') {
      if (failure === 'detach') {
        return Promise.resolve({ code: 1, stdout: '' });
      }
      mounted = false;
      events.emit('detached');
    } else throw new Error('unexpected_action');
    return Promise.resolve({ code: 0, stdout: '' });
  };
  const inspect = () =>
    Promise.resolve({
      mounted,
      owned: failure !== 'foreign',
      capacityBytes: failure === 'oversized' ? 4294967297 : 4294967296
    });
  return {
    root,
    run,
    inspect,
    events,
    mounted: () => mounted,
    created: () => created
  };
}

test('an owned image is detached and positively verified instead of trusting a successful detach command alone', async () => {
  const f = imageFixture();
  const image = await createOwnedWindowImage(f.root, f);
  expect(f.created()).toBe(true);
  expect(f.mounted()).toBe(true);
  await image.close();
  expect(f.mounted()).toBe(false);
  expect(image.summary()).toMatchObject({
    detached: true,
    quota_bytes: 4294967296
  });
});

test('a partially successful attach is reclaimed when the attach command fails', async () => {
  const f = imageFixture('attach');
  await expect(createOwnedWindowImage(f.root, f)).rejects.toThrow('image_attach_failed');
  expect(f.mounted()).toBe(false);
});

test('failed detachment cannot report cleanup success', async () => {
  const f = imageFixture('detach');
  const image = await createOwnedWindowImage(f.root, f);
  await expect(image.close()).rejects.toThrow('image_cleanup_unverified');
  expect(image.summary().detached).toBe(false);
});

test('a foreign mount is never detached to obtain a passing result', async () => {
  const f = imageFixture('foreign');
  await expect(createOwnedWindowImage(f.root, f)).rejects.toThrow('image_ownership_unverified');
  expect(f.mounted()).toBe(true);
});

test('a volume larger than the approved data cap fails and is detached', async () => {
  const f = imageFixture('oversized');
  await expect(createOwnedWindowImage(f.root, f)).rejects.toThrow('image_quota_unverified');
  expect(f.mounted()).toBe(false);
});

test.each(['observer', 'owner', 'guardian'])('a prearmed %s loss path closes the owned image', async loss => {
  const f = imageFixture();
  const controller = new AbortController();
  const image = await createOwnedWindowImage(f.root, {
    ...f,
    signal: controller.signal
  });
  const detached = new Promise<void>(resolve => f.events.once('detached', resolve));
  controller.abort(loss);
  await detached;
  await image.close();
  expect(image.summary()).toMatchObject({
    detached: true,
    loss_observed: true
  });
});

test('pre-existing image storage is refused without changing its bytes', async () => {
  const f = imageFixture();
  mkdirSync(join(f.root, 'mount'), { mode: 0o700 });
  await expect(createOwnedWindowImage(f.root, f)).rejects.toThrow();
  expect(f.created()).toBe(false);
});
