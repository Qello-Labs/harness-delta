import { ChildProcess, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repository = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
export const failureCodes = Object.freeze(['approval_invalid', 'approval_expired', 'approval_mismatch',
  'unattended_isolation_unverified', 'binary_mismatch', 'runtime_mismatch', 'admission_missing',
  'pin_drift', 'private_input_invalid', 'system_ps_unverified', 'fixture_failed', 'scope_inactive',
  'receipt_invalid', 'source_invalid', 'counter_invalid', 'request_conflict', 'ownership_invalid',
  'oracle_mismatch', 'collector_mismatch', 'stub_contract', 'stream_invalid', 'deadline',
  'native_failed', 'observer_lost', 'cleanup_unverified', 'runner_failed']);
export class ConformanceError extends Error {
  constructor(code) { super(failureCodes.includes(code) ? code : 'runner_failed'); this.name = 'ConformanceError'; }
}
export const requireCondition = (condition, code) => { if (!condition) throw new ConformanceError(code); };
export const safeCode = error => error instanceof ConformanceError ? error.message : 'runner_failed';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function hashFile(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    requireCondition(before.isFile() && before.size <= 300 * 1048576, 'pin_drift');
    const digest = sha256(readFileSync(fd)), after = fstatSync(fd);
    requireCondition(['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(k => before[k] === after[k]), 'pin_drift');
    return digest;
  } finally { closeSync(fd); }
}
export function treeDigest(directory) {
  const rows = [];
  function visit(path) {
    for (const name of readdirSync(path).sort()) {
      const child = join(path, name), stat = lstatSync(child);
      requireCondition(!stat.isSymbolicLink(), 'pin_drift');
      if (stat.isDirectory()) visit(child);
      else { requireCondition(stat.isFile(), 'pin_drift'); rows.push([relative(directory, child), hashFile(child)]); }
    }
  }
  visit(directory);
  return sha256(JSON.stringify(rows));
}
export function snapshotPins(binary) {
  return {
    binary: hashFile(binary), runtime: hashFile(realpathSync(process.execPath)),
    source: treeDigest(join(repository, 'src')), build: treeDigest(join(repository, 'dist')),
    instrument: sha256(JSON.stringify([treeDigest(join(repository, 'scripts/tool-update')),
      treeDigest(join(repository, 'scripts/generated'))])),
    skill: treeDigest(join(repository, 'skills/harness-connect')),
    lockfile: hashFile(join(repository, 'package-lock.json')),
    package: hashFile(join(repository, 'package.json')),
    supervisor: hashFile(join(repository, 'scripts/owned-cli-pty.py')),
    python: hashFile('/usr/bin/python3'), ps: hashFile('/bin/ps'),
    pgrep: hashFile('/usr/bin/pgrep'), git: hashFile('/usr/bin/git'),
  };
}
export function assertPins(before, binary) {
  requireCondition(JSON.stringify(before) === JSON.stringify(snapshotPins(binary)), 'pin_drift');
}
const windowInputs = Object.freeze({
  codex: Object.freeze({
    skill: 'skills/harness-connect-window-codex',
    producer: 'scripts/session-binding-codex-window-hook.mjs',
    builtSkill: 'dist/skills/harness-connect-window-codex',
    builtProducer: 'dist/assets/session-binding-codex-window-hook.mjs'
  }),
  claude_code: Object.freeze({
    skill: 'skills/harness-connect-window-claude',
    producer: 'skills/harness-connect-window-claude/scripts/claude-session-hook.mjs',
    builtSkill: 'dist/skills/harness-connect-window-claude',
    builtProducer: 'dist/skills/harness-connect-window-claude/scripts/claude-session-hook.mjs'
  })
});
function windowPath(path) {
  let current = repository;
  for (const name of path.split('/')) {
    current = join(current, name);
    requireCondition(!lstatSync(current).isSymbolicLink(), 'pin_drift');
  }
  return current;
}
export function snapshotWindowPins(selection) {
  requireCondition(['codex', 'claude_code'].includes(selection?.product) && ['source', 'built'].includes(selection.executionMode), 'approval_invalid');
  const inputs = windowInputs[selection.product];
  const digest = (domain, rows) => sha256(JSON.stringify(['ordinary-window-execution-v1', selection.product, selection.executionMode, domain, rows]));
  try {
    for (const name of ['SKILL.md', 'scripts/connect.mjs']) {
      requireCondition(
        hashFile(windowPath(`${inputs.skill}/${name}`)) === hashFile(windowPath(`${inputs.builtSkill}/${name}`)),
        'pin_drift'
      );
    }
    const skill = treeDigest(windowPath(inputs.skill));
    const builtSkill = treeDigest(windowPath(inputs.builtSkill));
    const producer = hashFile(windowPath(inputs.producer));
    const builtProducer = hashFile(windowPath(inputs.builtProducer));
    requireCondition(skill === builtSkill && producer === builtProducer, 'pin_drift');
    const instrument = [
      ['scripts/tool-update', treeDigest(windowPath('scripts/tool-update'))],
      ['scripts/generated', treeDigest(windowPath('scripts/generated'))],
      [inputs.skill, skill],
      [inputs.producer, producer]
    ];
    return {
      runtime: digest('runtime', hashFile(realpathSync(process.execPath))),
      source: digest('source', treeDigest(windowPath('src'))),
      build: digest('build', treeDigest(windowPath('dist'))),
      instrument: digest('instrument', instrument),
      skill: digest('skill', [inputs.skill, skill]),
      producer: digest('producer', [inputs.producer, producer]),
      built_skill: digest('built_skill', [inputs.builtSkill, builtSkill]),
      built_producer: digest('built_producer', [inputs.builtProducer, builtProducer]),
      lockfile: digest('lockfile', hashFile(windowPath('package-lock.json'))),
      package: digest('package', hashFile(windowPath('package.json')))
    };
  } catch (error) {
    if (error instanceof ConformanceError) throw error;
    if (error instanceof Error && ['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES'].includes(error.code)) {
      throw new ConformanceError('pin_drift');
    }
    throw error;
  }
}
export function assertWindowPins(before, selection) {
  const current = snapshotWindowPins(selection);
  const keys = Object.keys(current);
  requireCondition(
    before !== null && typeof before === 'object' && Object.keys(before).length === keys.length && keys.every(key => before[key] === current[key]),
    'pin_drift'
  );
}
export function privateDirectory(path) {
  const stat = lstatSync(path);
  requireCondition(isAbsolute(path) && realpathSync(path) === path && stat.isDirectory() &&
    stat.uid === process.getuid() && (stat.mode & 0o077) === 0, 'private_input_invalid');
  return path;
}
export function privateRead(path, root, active = () => true, limit = 8 * 1048576) {
  requireCondition(active(), 'scope_inactive');
  const rel = relative(realpathSync(root), realpathSync(path));
  requireCondition(rel !== '' && !rel.startsWith('..') && !isAbsolute(rel), 'source_invalid');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    requireCondition(stat.isFile() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0 &&
      stat.size <= limit, 'source_invalid');
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}
export const writePrivateJson = (path, value) =>
  writeFileSync(path, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' });

/** Subscribe before ChildProcess.spawn can produce output, errors or close. */
export function observedProcess(command, args, options = {}, attach = () => {}) {
  const child = new ChildProcess();
  const closed = once(child, 'close');
  // The rejection is consumed by the caller, even if spawn itself throws.
  void closed.catch(() => {});
  attach(child);
  child.spawn({ file: command, args: [command, ...args], cwd: options.cwd,
    envPairs: Object.entries(options.env ?? process.env).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`),
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'], detached: false,
    windowsHide: true });
  return { child, closed };
}
export function verifySystemPs() {
  const text = execFileSync('/bin/ps', ['-o', 'pid=,ppid=,pgid=,uid=,lstart=', '-p', String(process.pid)],
    { encoding: 'utf8', timeout: 2000, maxBuffer: 4096, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC' },
      stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const fields = /^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(text);
  requireCondition(fields && Number(fields[1]) === process.pid && Number(fields[2]) === process.ppid &&
    Number(fields[3]) > 0 && Number(fields[4]) === process.getuid() &&
    Number.isFinite(Date.parse(fields[5])), 'system_ps_unverified');
}
export function fixtureEnvironment(root, endpoint) {
  return { PATH: `${join(root, 'bin')}:${dirname(realpathSync(process.execPath))}:/usr/bin:/bin`,
    HOME: join(root, 'home'), CLAUDE_CONFIG_DIR: join(root, 'config'), TMPDIR: join(root, 'tmp'),
    CLAUDE_CODE_TMPDIR: join(root, 'tmp'), XDG_CONFIG_HOME: join(root, 'home/.config'),
    XDG_STATE_HOME: join(root, 'home/.local/state'), ANTHROPIC_BASE_URL: endpoint,
    ANTHROPIC_API_KEY: 'synthetic-offline-key', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_ENABLE_TELEMETRY: '0', OTEL_SDK_DISABLED: 'true',
    OTEL_TRACES_EXPORTER: 'none', OTEL_METRICS_EXPORTER: 'none', OTEL_LOGS_EXPORTER: 'none',
    OTEL_LOG_USER_PROMPTS: 'false', OTEL_LOG_TOOL_DETAILS: 'false', LC_ALL: 'C', TZ: 'UTC',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
}
export async function prepareFixture(root) {
  privateDirectory(root);
  for (const name of ['project', 'config', 'home', 'tmp', 'bin']) mkdirSync(join(root, name), { mode: 0o700 });
  // The helper's "node" command must resolve to the selected, hashed runtime.
  const { symlinkSync } = await import('node:fs');
  symlinkSync(realpathSync(process.execPath), join(root, 'bin/node'));
  const env = fixtureEnvironment(root, 'http://127.0.0.1:1');
  const launched = observedProcess('/usr/bin/git', ['-c', 'init.defaultBranch=test/conformance', 'init', '--quiet', '--template='],
    { cwd: join(root, 'project'), env, stdio: 'ignore' });
  requireCondition((await launched.closed)[0] === 0, 'fixture_failed');
  writePrivateJson(join(root, 'config/mcp.json'), { mcpServers: {} });
  return { root, project: join(root, 'project'), env };
}

export function bounded(promise, milliseconds, code = 'deadline') {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ConformanceError(code)), milliseconds);
  })]).finally(() => clearTimeout(timer));
}
export async function awaitSupervisor(launched, milliseconds, terminationMs) {
  try { return await bounded(launched.closed, milliseconds, 'observer_lost'); }
  catch {
    launched.child.stdio[3]?.end();
    const settled = await bounded(launched.closed, terminationMs).then(() => true, () => false);
    if (!settled && launched.child.exitCode === null && launched.child.signalCode === null) {
      launched.child.kill('SIGKILL');
      await bounded(launched.closed, terminationMs).then(() => true, () => false);
    }
    throw new ConformanceError('cleanup_unverified');
  }
}

export async function closeListener(server, sockets) {
  const closed = once(server, 'close');
  const disconnected = [...sockets].map(socket => {
    const ended = once(socket, 'close'); socket.destroy(); return ended;
  });
  server.close();
  await Promise.all([closed, ...disconnected]);
  requireCondition(!server.listening && sockets.size === 0, 'cleanup_unverified');
}

export function assertSupervisedWorker() {
  let control;
  try { const stat = fstatSync(3); control = stat.isFIFO() || stat.isSocket(); } catch { control = false; }
  requireCondition(process.stdin.isTTY === true && process.stdout.isTTY === true && control, 'ownership_invalid');
}
