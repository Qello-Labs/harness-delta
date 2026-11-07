import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect } from 'vitest';

const paths = [
  'dist/skills/harness-connect/SKILL.md',
  'dist/skills/harness-connect/scripts/connect.mjs',
  'dist/skills/harness-connect/scripts/claude-session-hook.mjs',
  'dist/assets/session-binding-codex-hook.mjs',
  'skills/harness-connect/SKILL.md',
  'skills/harness-connect/scripts/connect.mjs',
  'skills/harness-connect/scripts/claude-session-hook.mjs',
  'skills/harness-connect-window-codex/SKILL.md',
  'skills/harness-connect-window-codex/scripts/connect.mjs',
  'scripts/session-binding-codex-hook.mjs',
  'scripts/session-binding-codex-hook.template.mjs',
  'scripts/session-binding-codex-window-hook.mjs'
];
let before;
beforeEach(() => {
  before = paths.map(path => readFileSync(resolve(path)));
});
afterEach(() => {
  expect(paths.map(path => readFileSync(resolve(path)))).toEqual(before);
});
