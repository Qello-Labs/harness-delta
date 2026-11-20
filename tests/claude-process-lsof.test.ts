import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createClaudeWindowBinaryAdapters, readClaudeProcessBinary } from '../src/claude-process-binary.js';

const native = vi.hoisted(() => ({ text: '', digest: '' }));
vi.mock('node:child_process', () => ({
  execFileSync: (file: string) => {
    if (file !== '/usr/sbin/lsof') throw new Error('native_execution_forbidden');
    return native.text;
  },
  spawnSync: () => {
    throw new Error('native_execution_forbidden');
  }
}));
vi.mock('../src/claude-binding-admission.js', () => ({
  claudeBindingRuntimeSupported: () => true,
  getEffectiveClaudeExactImages: () => [{ productVersion: '2.1.306', binarySha256: native.digest }]
}));

let root = '';
let image = '';
let auxiliary: readonly string[] = [];
const records = (paths: readonly string[]) => `p3107\n${paths.map(path => `ftxt\nn${path}\n`).join('')}`;
const adapters = () => createClaudeWindowBinaryAdapters({ assertAuthorized: () => undefined, scratchDirectory: root });

beforeEach(() => {
  vi.stubGlobal(
    'process',
    new Proxy(process, {
      get(target, key): unknown {
        if (key === 'platform') return 'darwin';
        if (key === 'arch') return 'arm64';
        return Reflect.get(target, key);
      }
    })
  );
  root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-lsof-')));
  mkdirSync(join(root, 'claude/versions'), { recursive: true });
  image = join(root, 'claude/versions/2.1.329');
  const bytes = Buffer.from('synthetic executable image');
  writeFileSync(image, bytes, { mode: 0o700 });
  native.digest = createHash('sha256').update(bytes).digest('hex');
  auxiliary = [
    join(root, 'usr/lib/dyld'),
    join(root, 'usr/share/icu/icudt.dat'),
    join(root, 'Library/Caches/.plist-cache.synthetic'),
    join(root, 'Library/LaunchServices/synthetic.csstore'),
    join(root, 'System/se_SecurityMessages'),
    join(root, 'System/events.allowlist')
  ];
  native.text = records([image]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

test.each([0, 3, 6])('selects the unique Claude mapping at position %i among macOS text mappings', position => {
  const paths = [...auxiliary];
  paths.splice(position, 0, image);
  native.text = records(paths);

  expect(adapters().readImage(3107)).toEqual({ path: image, layout: 'standalone', requiredHost: null });
});

test('the exact reader selects the Claude executable rather than the first auxiliary mapping', () => {
  native.text = records([...auxiliary, image]);

  expect(readClaudeProcessBinary(3107)).toEqual({ productVersion: '2.1.306', sha256: native.digest });
});

test('the window native reader retains single executable mapping support', () => {
  expect(adapters().readImage(3107)).toEqual({ path: image, layout: 'standalone', requiredHost: null });
});

test('the exact native reader retains single executable mapping support', () => {
  expect(readClaudeProcessBinary(3107)).toEqual({ productVersion: '2.1.306', sha256: native.digest });
});

test('selects a standalone claude basename and ignores an app-bundle mapping', () => {
  const path = join(root, 'bin/claude');
  native.text = records([join(root, 'Claude.app/Contents/MacOS/claude'), path]);

  expect(adapters().readImage(3107)).toEqual({ path, layout: 'standalone', requiredHost: null });
});

test.each([
  ['no Claude mapping', () => records(auxiliary)],
  ['two Claude mappings', () => records([image, join(root, 'bin/claude')])],
  ['duplicate executable mappings', () => records([image, image])],
  ['only app-bundle mapping', () => records([join(root, 'Claude.app/Contents/MacOS/claude')])],
  ['missing process', () => `ftxt\nn${image}\n`],
  ['foreign process', () => `p3108\nftxt\nn${image}\n`],
  ['duplicate process', () => `p3107\np3107\nftxt\nn${image}\n`],
  ['second process after a file', () => `${records([image])}p3107\nftxt\nn${image}\n`],
  ['missing descriptor', () => `p3107\nn${image}\n`],
  ['name before file set', () => `p3107\nn${image}\nftxt\n`],
  ['missing name', () => `${records([image])}ftxt\n`],
  ['duplicate name in file set', () => `${records([image])}n${image}\n`],
  ['unexpected descriptor', () => `p3107\nfmem\nn${image}\n`],
  ['unselected field', () => `${records([image])}cSYNTHETIC\n`],
  ['empty file name', () => `${records([image])}ftxt\nn\n`],
  ['empty field', () => `${records([image])}\n`],
  ['relative auxiliary path', () => records([image, 'relative/dyld'])],
  ['nul in auxiliary path', () => records([image, `${root}/dyld\0bad`])],
  ['dot traversal in auxiliary path', () => records([image, `${root}/../dyld`])]
] as const)('refuses %s without selecting an executable', (_name, output) => {
  native.text = output();

  expect(adapters().readImage(3107)).toBeNull();
});

test('the exact reader also refuses ambiguous Claude executable mappings', () => {
  native.text = records([image, join(root, 'bin/claude')]);

  expect(() => readClaudeProcessBinary(3107)).toThrow('claude_binary_unqualified');
});
