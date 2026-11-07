import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { repository } from '../scripts/tool-update/fixtures.mjs';
import { fixture } from './tool-update-conformance-fixture.js';

const resultSchema = z.strictObject({
  preflight: z.string(),
  revalidation: z.string(),
  rawUnchanged: z.boolean(),
  buildUnchanged: z.boolean(),
  sourceUnchanged: z.boolean(),
  exactUnchanged: z.boolean(),
  installedUnchanged: z.boolean(),
  restored: z.boolean(),
  otherBundleAbsent: z.boolean(),
  launches: z.number().int(),
  nativeReads: z.number().int()
});
export function windowPinControl(mode: 'source' | 'built', action: string, path = '') {
  const root = fixture();
  const put = (relative: string, bytes: string) => {
    const target = join(root, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  };
  const copy = (relative: string) => {
    const target = join(root, relative);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(repository, relative), target, { recursive: true });
  };
  for (const relative of [
    'scripts/tool-update/fixtures.mjs',
    'scripts/tool-update/window-execution-pins.mjs',
    'scripts/generated',
    'scripts/session-binding-codex-window-hook.mjs',
    'scripts/session-binding-codex-hook.mjs',
    'scripts/session-binding-codex-hook.template.mjs',
    'skills/harness-connect'
  ]) {
    copy(relative);
  }
  put('package.json', '{"type":"module"}');
  put('package-lock.json', '{"lockfileVersion":3}');
  put('src/synthetic.ts', 'export const synthetic = 1;\n');
  put('dist/synthetic.js', 'export const synthetic = 1;\n');
  put('skills/harness-connect-window-codex/SKILL.md', 'Synthetic window pin fixture.\n');
  put('skills/harness-connect-window-codex/scripts/connect.mjs', 'export const synthetic = 1;\n');
  put('skills/harness-connect-window-codex/config.json', '{"synthetic":1}');
  mkdirSync(join(root, 'dist/assets'), { recursive: true });
  mkdirSync(join(root, 'dist/skills'), { recursive: true });
  cpSync(join(root, 'skills/harness-connect-window-codex'), join(root, 'dist/skills/harness-connect-window-codex'), { recursive: true });
  cpSync(join(root, 'scripts/session-binding-codex-window-hook.mjs'), join(root, 'dist/assets/session-binding-codex-window-hook.mjs'));
  cpSync(join(root, 'skills/harness-connect'), join(root, 'installed-exact'), { recursive: true });
  symlinkSync(join(repository, 'node_modules'), join(root, 'node_modules'));
  const output = execFileSync(process.execPath, [join(repository, 'tests/helpers/window-pin-control.mjs'), root, mode, action, path], {
    encoding: 'utf8',
    timeout: 15000
  });
  return resultSchema.parse(JSON.parse(output) as unknown);
}
