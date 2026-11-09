import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { codexBindingQualificationCodeModeHost } from '../src/qualification/codex-binding-qualification-versions.js';

const crypto = vi.hoisted(() => ({
  digest: vi.fn(() => '79f123a85dbc61e8f5d0f0c050dfc3f4b81a8305d33a32b41e008b7f6e035698')
}));
// A valid digest isolates filesystem guards without retaining release binaries in fixtures.
vi.mock('node:crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    createHash: (algorithm: string) => ({
      update: (data: string | Buffer) => (Buffer.isBuffer(data) ? { digest: crypto.digest } : actual.createHash(algorithm).update(data))
    })
  };
});

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-host-synthetic-')));
  crypto.digest.mockReset().mockReturnValue('79f123a85dbc61e8f5d0f0c050dfc3f4b81a8305d33a32b41e008b7f6e035698');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test.each(['0.163.0', '0.166.0'])('target %s preserves filesystem refusal guards', productVersion => {
  for (const mode of ['missing', 'directory', 'nonexecutable', 'group-writable', 'world-writable', 'symlink']) {
    const directory = join(root, mode);
    mkdirSync(directory);
    const helper = join(directory, 'codex-code-mode-host');
    if (mode === 'directory') mkdirSync(helper);
    else if (mode === 'symlink') {
      const target = join(root, 'target');
      writeFileSync(target, 'SYNTHETIC_HOST', { mode: 0o700 });
      symlinkSync(target, helper);
    } else if (mode !== 'missing') {
      writeFileSync(helper, 'SYNTHETIC_HOST');
      if (productVersion === '0.166.0') truncateSync(helper, 69182864);
      chmodSync(helper, mode === 'nonexecutable' ? 0o600 : mode === 'group-writable' ? 0o720 : 0o702);
    }
    expect(() => codexBindingQualificationCodeModeHost(join(directory, 'codex'), productVersion)).toThrow('binding_qualification_code_mode_host_invalid');
    expect(crypto.digest).not.toHaveBeenCalled();
  }
});

test('host preflight returns canonical executable path and accepted pin', () => {
  const helper = join(root, 'codex-code-mode-host');
  writeFileSync(helper, 'SYNTHETIC_HOST', { mode: 0o700 });
  expect(codexBindingQualificationCodeModeHost(join(root, 'codex'))).toEqual({
    path: helper,
    sha256: '79f123a85dbc61e8f5d0f0c050dfc3f4b81a8305d33a32b41e008b7f6e035698'
  });
  expect(crypto.digest).toHaveBeenCalledOnce();
});

test('host preflight refuses an executable with an unreviewed digest', () => {
  writeFileSync(join(root, 'codex-code-mode-host'), 'SYNTHETIC_HOST', { mode: 0o700 });
  crypto.digest.mockReturnValue('a'.repeat(64));
  expect(() => codexBindingQualificationCodeModeHost(join(root, 'codex'))).toThrow('binding_qualification_code_mode_host_invalid');
  expect(crypto.digest).toHaveBeenCalledOnce();
});

test.each(['0.160.0', '0.162.1'])('historical target %s does not require a host', productVersion => {
  expect(codexBindingQualificationCodeModeHost(join(root, 'codex'), productVersion)).toBeNull();
  expect(crypto.digest).not.toHaveBeenCalled();
});

test('target 0.166.0 requires its exact host pin and size', () => {
  const helper = join(root, 'codex-code-mode-host');
  writeFileSync(helper, 'SYNTHETIC_HOST', { mode: 0o700 });
  truncateSync(helper, 69182864);
  crypto.digest.mockReturnValue('fd37051bfdce0b65cf22a7077e265720a7bd6709d5e400dcbc26197f3041400a');
  expect(codexBindingQualificationCodeModeHost(join(root, 'codex'), '0.166.0')).toEqual({
    path: helper,
    sha256: 'fd37051bfdce0b65cf22a7077e265720a7bd6709d5e400dcbc26197f3041400a'
  });
});

test.each([69182863, 69182865])('target 0.166.0 refuses host size %s before hashing', size => {
  const helper = join(root, 'codex-code-mode-host');
  writeFileSync(helper, 'SYNTHETIC_HOST', { mode: 0o700 });
  truncateSync(helper, size);
  crypto.digest.mockReturnValue('fd37051bfdce0b65cf22a7077e265720a7bd6709d5e400dcbc26197f3041400a');
  expect(() => codexBindingQualificationCodeModeHost(join(root, 'codex'), '0.166.0')).toThrow('binding_qualification_code_mode_host_invalid');
  expect(crypto.digest).not.toHaveBeenCalled();
});

test.each([
  ['0.163.0', 'fd37051bfdce0b65cf22a7077e265720a7bd6709d5e400dcbc26197f3041400a'],
  ['0.166.0', '79f123a85dbc61e8f5d0f0c050dfc3f4b81a8305d33a32b41e008b7f6e035698'],
  ['0.166.0', 'a'.repeat(64)]
])('target %s refuses a different release or unreviewed host pin %s', (productVersion, digest) => {
  const helper = join(root, 'codex-code-mode-host');
  writeFileSync(helper, 'SYNTHETIC_HOST', { mode: 0o700 });
  truncateSync(helper, 69182864);
  crypto.digest.mockReturnValue(digest);
  expect(() => codexBindingQualificationCodeModeHost(join(root, 'codex'), productVersion)).toThrow('binding_qualification_code_mode_host_invalid');
  expect(crypto.digest).toHaveBeenCalledOnce();
});

test.each([128 * 1024 * 1024, 128 * 1024 * 1024 + 1])('historical host keeps its inclusive 128 MiB size bound at %s bytes', size => {
  const helper = join(root, 'codex-code-mode-host');
  writeFileSync(helper, 'SYNTHETIC_HOST', { mode: 0o700 });
  truncateSync(helper, size);
  if (size === 128 * 1024 * 1024) {
    expect(codexBindingQualificationCodeModeHost(join(root, 'codex'), '0.163.0')).toEqual({
      path: helper,
      sha256: '79f123a85dbc61e8f5d0f0c050dfc3f4b81a8305d33a32b41e008b7f6e035698'
    });
  } else {
    expect(() => codexBindingQualificationCodeModeHost(join(root, 'codex'), '0.163.0')).toThrow('binding_qualification_code_mode_host_invalid');
    expect(crypto.digest).not.toHaveBeenCalled();
  }
});
