import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { qualifyWindowContainment } from '../scripts/tool-update/codex-window-qualification.mjs';

const backend = vi.hoisted(() => {
  const binaries: string[] = [];
  return { fault: '', binaries };
});
vi.mock('../scripts/tool-update/codex-window-image-owner.mjs', () => ({
  createWindowImageGuardian: () => {
    throw new Error('images_forbidden');
  }
}));
vi.mock('../scripts/tool-update/codex-window-containment.mjs', async importOriginal => {
  const original = await importOriginal<typeof import('../scripts/tool-update/codex-window-containment.mjs')>();
  return {
    ...original,
    runWindowTool: (command: string, args: string[]) => {
      if (command === '/usr/bin/clang') {
        const output = args[args.indexOf('-o') + 1];
        if (!output) {
          throw new Error('fake_compiler_output_missing');
        }
        writeFileSync(output, 'synthetic-native-object', {
          flag: 'wx',
          mode: 0o700
        });
        backend.binaries.push(output);
        return Promise.resolve({
          code: backend.fault === 'compiler' ? 1 : 0,
          stdout: ''
        });
      }
      const sandboxed = command === '/usr/bin/sandbox-exec';
      const argv = sandboxed ? args.slice(3) : args;
      const operationIndex = argv.findIndex(arg => arg === 'exec' || arg === 'map');
      const operation = argv[operationIndex];
      const target = argv[operationIndex + 1] ?? '';
      const selected = /\/bin\/codex(?:-code-mode-host)?$/.test(target);
      let result = 'allowed';
      if (sandboxed && !selected && !target.endsWith('/control.dylib')) {
        result = operation === 'map' ? 'mapping_rejected' : 'EPERM';
      }
      if (sandboxed && target.endsWith('/arbitrary.mjs')) throw new Error('interpreter_launched_as_probe');
      if (backend.fault === 'escape' && sandboxed && target.includes('node')) result = 'allowed';
      if (backend.fault === 'baseline' && !sandboxed && operation === 'map') result = 'mapping_rejected';
      if (backend.fault === 'malformed' && sandboxed) {
        return Promise.resolve({ code: 77, stdout: '{}' });
      }
      return Promise.resolve({
        code: result === 'allowed' ? 0 : 77,
        stdout: `{"result":"${result}"}\n`
      });
    }
  };
});

const roots: string[] = [];
beforeEach(() => {
  vi.stubGlobal('process', {
    ...process,
    platform: 'darwin',
    arch: 'arm64',
    versions: { ...process.versions, node: '24.0.0' }
  });
});
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  backend.fault = '';
  backend.binaries = [];
  vi.unstubAllGlobals();
});

function output() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'window-native-test-'));
  roots.push(root);
  return join(root, 'qualification');
}

test('native qualifier requires both selected controls and cleans its owned binaries without images', async () => {
  const out = output();
  const packet = await qualifyWindowContainment(out);
  expect(packet).toMatchObject({
    containment_verified: false,
    native_exec_mapping_verified: true,
    historical_controls_verified: false,
    cleanup_verified: true,
    actual_target_qualified: false,
    failure: null
  });
  expect(packet.controls).toHaveLength(26);
  for (const name of [
    'native_cli',
    'native_host',
    'native_mapping_control',
    'node_writable_script',
    'node_spawn_script',
    'node_spawn_eval',
    'python3',
    'rg_exec',
    'rg_mapping',
    'voice_exec',
    'voice_mapping',
    'writable_mapping',
    'node_eval'
  ]) {
    for (const descendant of [false, true]) {
      expect(packet.controls).toContainEqual(expect.objectContaining({ name, descendant, passed: true }));
    }
  }
  expect(backend.binaries.every(path => !existsSync(path))).toBe(true);
  expect(JSON.parse(readFileSync(join(out, 'qualification.json'), 'utf8'))).toMatchObject({ native_exec_mapping_verified: true });
});

test.each(['compiler', 'escape', 'baseline', 'malformed'])('native qualifier refuses %s evidence and still cleans compiled files', async fault => {
  backend.fault = fault;
  const packet = await qualifyWindowContainment(output());
  expect(packet).toMatchObject({
    native_exec_mapping_verified: false,
    cleanup_verified: true
  });
  expect(packet.failure).not.toBeNull();
  expect(backend.binaries.every(path => !existsSync(path))).toBe(true);
});
