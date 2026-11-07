import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, executionMode, action, inputPath] = process.argv.slice(2);
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
const selection = { product: 'codex', executionMode };
const pins = snapshotWindowPins(selection);
const packet = {
  kind: 'ordinary_window_execution_pins',
  schema_version: 1,
  pin_scheme_revision: 'ordinary-window-execution-v1',
  product: 'codex',
  policy_id: 'codex-binding-root-window-v1',
  policy_revision: 'codex-ordinary-root-window-v1',
  evidence_mode: 'source_only',
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
    treeDigest(join(root, 'skills/harness-connect-window-codex')),
    hashFile(join(root, 'scripts/session-binding-codex-window-hook.mjs'))
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
  const after = action === 'bytes' || action === 'accept' ? measurements() : null;
  result = {
    preflight: code(() => validateWindowExecutionPins(packet)),
    revalidation: code(() => assertWindowPins(pins, selection)),
    rawUnchanged: after?.raw === before.raw,
    buildUnchanged: after?.build === before.build,
    sourceUnchanged: after?.source === before.source,
    exactUnchanged: exactBytes(action === 'missing' && inputPath === 'skills' ? 'held-input' : 'skills') === before.exact,
    installedUnchanged: treeDigest(join(root, 'installed-exact')) === before.installed,
    otherBundleAbsent: !fs.existsSync(join(root, 'skills/harness-connect-window-claude')),
    launches,
    nativeReads
  };
} finally {
  if (action === 'bytes') fs.writeFileSync(path, original);
  else if (action === 'missing' || action === 'symlink') {
    if (action === 'symlink') fs.unlinkSync(path);
    fs.renameSync(join(root, 'held-input'), path);
  }
}
assert.deepEqual(measurements(), before, 'mutation_must_restore_all_input_bytes');
process.stdout.write(JSON.stringify({ ...result, restored: true }));
