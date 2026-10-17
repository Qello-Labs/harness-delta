import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { codexBindingQualificationCodeModeHost } from '../src/codex-binding-qualification-versions.js';

const crypto = vi.hoisted(() => ({
  digest: vi.fn(() => '79f123a85dbc61e8f5d0f0c050dfc3f4b81a8305d33a32b41e008b7f6e035698'),
}));
// A valid digest isolates filesystem guards without retaining release binaries in fixtures.
vi.mock('node:crypto', async importOriginal => ({
  ...await importOriginal<typeof import('node:crypto')>(),
  createHash: () => ({ update: () => ({ digest: crypto.digest }) }),
}));

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-host-synthetic-')));
  crypto.digest.mockReset().mockReturnValue('79f123a85dbc61e8f5d0f0c050dfc3f4b81a8305d33a32b41e008b7f6e035698');
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

test.each(['missing', 'directory', 'nonexecutable', 'group-writable', 'world-writable', 'symlink'])(
  'host preflight refuses %s even with an accepted digest', mode => {
    const helper = join(root, 'codex-code-mode-host');
    if (mode === 'directory') mkdirSync(helper);
    else if (mode === 'symlink') {
      const target = join(root, 'target');
      writeFileSync(target, 'SYNTHETIC_HOST', { mode: 0o700 });
      symlinkSync(target, helper);
    } else if (mode !== 'missing') {
      writeFileSync(helper, 'SYNTHETIC_HOST');
      chmodSync(helper, mode === 'nonexecutable' ? 0o600 : mode === 'group-writable' ? 0o720 : 0o702);
    }
    expect(() => codexBindingQualificationCodeModeHost(join(root, 'codex')))
      .toThrow('binding_qualification_code_mode_host_invalid');
    expect(crypto.digest).not.toHaveBeenCalled();
  },
);

test('host preflight returns canonical executable path and accepted pin', () => {
  const helper = join(root, 'codex-code-mode-host');
  writeFileSync(helper, 'SYNTHETIC_HOST', { mode: 0o700 });
  expect(codexBindingQualificationCodeModeHost(join(root, 'codex'))).toEqual({
    path: helper, sha256: '79f123a85dbc61e8f5d0f0c050dfc3f4b81a8305d33a32b41e008b7f6e035698',
  });
  expect(crypto.digest).toHaveBeenCalledOnce();
});

test('host preflight refuses an executable with an unreviewed digest', () => {
  writeFileSync(join(root, 'codex-code-mode-host'), 'SYNTHETIC_HOST', { mode: 0o700 });
  crypto.digest.mockReturnValue('a'.repeat(64));
  expect(() => codexBindingQualificationCodeModeHost(join(root, 'codex')))
    .toThrow('binding_qualification_code_mode_host_invalid');
  expect(crypto.digest).toHaveBeenCalledOnce();
});
