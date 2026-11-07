import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, executionMode, action, inputPath, product] = process.argv.slice(2);
let launches = 0,
  nativeReads = 0;
for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  childProcess[key] = () => {
    launches += 1;
    throw new Error('unexpected_synthetic_launch');
  };
}
for (const key of ['openSync', 'readFileSync', 'statSync', 'lstatSync', 'realpathSync', 'readdirSync', 'readlinkSync']) {
  const original = fs[key];
  fs[key] = (path, ...args) => {
    if (String(path).startsWith(join(root, 'native-denied'))) {
      nativeReads += 1;
      throw new Error('unexpected_synthetic_native_read');
    }
    return original(path, ...args);
  };
}
childProcess.ChildProcess.prototype.spawn = () => {
  launches += 1;
  throw new Error('unexpected_synthetic_launch');
};
syncBuiltinESMExports();
const { snapshotWindowPins, assertWindowPins, treeDigest, hashFile, safeCode } = await import(pathToFileURL(join(root, 'scripts/tool-update/fixtures.mjs')));
const { validateWindowExecutionPins } = await import(pathToFileURL(join(root, 'scripts/tool-update/window-execution-pins.mjs')));
const selection = { product, executionMode };
const selected =
  product === 'codex'
    ? {
        skill: 'skills/harness-connect-window-codex',
        producer: 'scripts/session-binding-codex-window-hook.mjs',
        otherSkill: 'skills/harness-connect-window-claude'
      }
    : {
        skill: 'skills/harness-connect-window-claude',
        producer: 'skills/harness-connect-window-claude/scripts/claude-session-hook.mjs',
        otherSkill: 'skills/harness-connect-window-codex'
      };
const pins = snapshotWindowPins(selection);
const packet = {
  kind: 'ordinary_window_execution_pins',
  schema_version: 1,
  pin_scheme_revision: 'ordinary-window-execution-v1',
  product,
  policy_id: product === 'codex' ? 'codex-binding-root-window-v1' : 'claude-binding-root-window-v1',
  policy_revision: product === 'codex' ? 'codex-ordinary-root-window-v1' : 'claude-ordinary-root-window-v1',
  evidence_mode: product === 'codex' ? 'source_only' : 'publisher_verified_local_pin',
  execution_mode: executionMode,
  pins
};
const exactBytes = (skills = 'skills') =>
  JSON.stringify([
    treeDigest(join(root, skills, 'harness-connect')),
    hashFile(join(root, 'scripts/session-binding-codex-hook.mjs')),
    hashFile(join(root, 'scripts/session-binding-codex-hook.template.mjs'))
  ]);
const measurements = () => ({
  source: treeDigest(join(root, 'src')),
  build: treeDigest(join(root, 'dist')),
  raw: JSON.stringify([
    treeDigest(join(root, 'scripts/tool-update')),
    treeDigest(join(root, 'scripts/generated')),
    treeDigest(join(root, selected.skill)),
    hashFile(join(root, selected.producer))
  ]),
  exact: exactBytes(),
  installed: treeDigest(join(root, 'installed-exact'))
});
const before = measurements();
const path = inputPath ? join(root, inputPath) : null;
let original;
if (action === 'bytes') {
  original = fs.readFileSync(path);
  fs.appendFileSync(path, '\nsynthetic-mutated-input\n');
} else if (action === 'missing' || action === 'symlink') {
  fs.renameSync(path, join(root, 'held-input'));
  if (action === 'symlink') fs.symlinkSync(join(root, 'held-input'), path);
} else if (action === 'missing-both') {
  fs.renameSync(path, join(root, 'held-input'));
  fs.renameSync(join(root, 'dist', inputPath), join(root, 'held-built-input'));
} else assert.equal(action, 'accept');
const code = operation => {
  try {
    operation();
    return 'accepted';
  } catch (error) {
    return safeCode(error);
  }
};
let result;
try {
  if (action === 'missing-both') {
    assert.equal(
      code(() => snapshotWindowPins(selection)),
      'pin_drift',
      'matching_incomplete_trees_must_not_prepare'
    );
  }
  const after = action === 'bytes' || action === 'accept' ? measurements() : null;
  result = {
    preflight: code(() => validateWindowExecutionPins(packet)),
    revalidation: code(() => assertWindowPins(pins, selection)),
    rawUnchanged: after?.raw === before.raw,
    buildUnchanged: after?.build === before.build,
    sourceUnchanged: after?.source === before.source,
    exactUnchanged: exactBytes(action === 'missing' && inputPath === 'skills' ? 'held-input' : 'skills') === before.exact,
    installedUnchanged: treeDigest(join(root, 'installed-exact')) === before.installed,
    otherBundleAbsent:
      !fs.existsSync(join(root, selected.otherSkill)) && (product === 'codex' || !fs.existsSync(join(root, 'scripts/session-binding-codex-window-hook.mjs'))),
    launches,
    nativeReads
  };
} finally {
  if (action === 'bytes') fs.writeFileSync(path, original);
  else if (action === 'missing' || action === 'symlink') {
    if (action === 'symlink') fs.unlinkSync(path);
    fs.renameSync(join(root, 'held-input'), path);
  } else if (action === 'missing-both') {
    fs.renameSync(join(root, 'held-input'), path);
    fs.renameSync(join(root, 'held-built-input'), join(root, 'dist', inputPath));
  }
}
assert.deepEqual(measurements(), before, 'mutation_must_restore_all_input_bytes');
process.stdout.write(JSON.stringify({ ...result, restored: true }));
