import fs from 'node:fs';
import promises from 'node:fs/promises';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, isAbsolute, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const config = JSON.parse(process.env.CLAUDE_WINDOW_FIXTURE);
const code = new Set([config.script, ...(config.codeFiles ?? [])].flatMap(path => [path, fs.realpathSync(path)]));
const owned = config.directory;
const control = owned ? join(owned, 'ordinary-window-control.json') : null;
const ancestors = new Set();
if (owned) {
  for (let path = owned; ; path = dirname(path)) {
    ancestors.add(path);
    if (path === dirname(path)) break;
  }
}
const fds = new Map([[4, 'native']]);
const effects = { ownedReads: 0, unauthorizedCalls: 0, nativeCalls: 0, processCalls: 0, metadataWrites: 0, operations: [] };
export const ledger = { effects, requests: [], attempts: 0, connections: 0, deadlines: 0 };
let sourceLoading = true;
export function beginSourceLoad() {
  sourceLoading = true;
}
export function finishSourceLoad() {
  sourceLoading = false;
}
const pathValue = value => (value instanceof URL ? fileURLToPath(value) : Buffer.isBuffer(value) ? value.toString() : value);
function native(value, follow) {
  if (typeof value === 'number') return fds.get(value) === 'native';
  const path = pathValue(value);
  if (typeof path !== 'string' || !isAbsolute(path)) return false;
  let current = '';
  let observed = false;
  const parts = path.split(sep).filter(Boolean);
  for (const [index, part] of parts.entries()) {
    current = part === '..' ? dirname(current) : join(current || sep, part);
    const alias = config.aliases?.find(item => item.path === current);
    if (alias && (follow || index < parts.length - 1)) {
      current = alias.target;
    }
    observed ||= config.nativePrefixes.some(prefix => current === prefix || current.startsWith(prefix + sep));
  }
  return observed;
}
function denied(name, value) {
  effects.unauthorizedCalls += 1;
  if (native(value, !/lstat|readlink/.test(name))) effects.nativeCalls += 1;
  if (effects.operations.length < 128) effects.operations.push(name);
  throw new Error('synthetic_unauthorized_operation');
}
function filesystem(name, value, flags) {
  const path = pathValue(value);
  const descriptor = fds.get(path);
  if (native(path, !/lstat|readlink/.test(name))) return denied(name, path);
  if (sourceLoading && code.has(path) && /^(realpathSync(?:\.native)?|readFileSync|promises.readFile|openSync)$/.test(name)) {
    if (name === 'openSync' && flags !== 'r' && flags !== 0) {
      return denied(name, path);
    }
    return 'code';
  }
  if (sourceLoading && descriptor === 'code' && /^(readSync|readvSync|readFileSync|fstatSync|closeSync)$/.test(name)) return 'code';
  if (owned) {
    if (name === 'lstatSync' && ancestors.has(path)) {
      effects.ownedReads += 1;
      return 'ancestor';
    }
    if (name === 'openSync' && path === control && flags === (fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)) {
      effects.ownedReads += 1;
      return 'control';
    }
    if (name === 'opendirSync' && path === owned) return 'directory';
    if (
      name === 'openSync' &&
      typeof path === 'string' &&
      dirname(path) === owned &&
      /^[a-f0-9-]{36}\.json$/.test(path.slice(owned.length + 1)) &&
      flags === (fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW)
    )
      return 'receipt';
  }
  if (descriptor === 'control' && /^(readSync|fstatSync|closeSync)$/.test(name)) {
    effects.ownedReads += 1;
    return 'control';
  }
  if (descriptor === 'receipt' && name === 'writeFileSync') {
    effects.metadataWrites += 1;
    return 'receipt';
  }
  if (descriptor === 'receipt' && /^(writeSync|writevSync|fstatSync|closeSync)$/.test(name)) return 'receipt';
  return denied(name, path);
}
const operations = [
  'exists',
  'access',
  'stat',
  'lstat',
  'fstat',
  'statfs',
  'realpath',
  'readlink',
  'readdir',
  'opendir',
  'open',
  'read',
  'readv',
  'readFile',
  'write',
  'writev',
  'writeFile',
  'appendFile',
  'mkdir',
  'mkdtemp',
  'rename',
  'unlink',
  'rmdir',
  'rm',
  'truncate',
  'ftruncate',
  'copyFile',
  'cp',
  'link',
  'symlink',
  'chmod',
  'chown',
  'utimes',
  'close'
];
export function install() {
  let controlRead = false;
  for (const name of operations) {
    for (const operation of [name, `${name}Sync`]) {
      const original = fs[operation];
      if (typeof original !== 'function') continue;
      const replacement = (...args) => {
        const kind = filesystem(operation, args[0], args[1]);
        const result = Reflect.apply(original, fs, args);
        if (operation === 'openSync') fds.set(result, kind);
        if (operation === 'closeSync') fds.delete(args[0]);
        if (operation === 'readSync' && kind === 'control' && !controlRead) {
          controlRead = true;
          process.send({ kind: 'control_read' });
        }
        return result;
      };
      if (original.native) {
        replacement.native = (...args) => {
          filesystem(`${operation}.native`, args[0]);
          return Reflect.apply(original.native, original, args);
        };
      }
      fs[operation] = replacement;
    }
    const original = promises[name];
    if (typeof original === 'function') {
      promises[name] = async (...args) => {
        filesystem(`promises.${name}`, args[0], args[1]);
        return Reflect.apply(original, promises, args);
      };
    }
  }
  for (const name of ['createReadStream', 'createWriteStream', 'watch', 'watchFile']) fs[name] = (...args) => denied(name, args[0]);
  function processCall(name) {
    effects.processCalls += 1;
    if (effects.operations.length < 128) effects.operations.push(name);
    throw new Error('synthetic_process_tripwire');
  }
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[name] = () => processCall(name);
  childProcess.ChildProcess.prototype.spawn = () => processCall('ChildProcess.spawn');
  for (const name of ['cwd', 'chdir', 'kill', 'binding', '_linkedBinding', 'dlopen']) process[name] = () => processCall(`process.${name}`);
  syncBuiltinESMExports();
  let reported = false;
  process.on('beforeExit', () => {
    if (reported) return;
    reported = true;
    process.send({ kind: 'effects', ...ledger }, () => process.disconnect());
  });
  process.send({ kind: 'ready' });
}
