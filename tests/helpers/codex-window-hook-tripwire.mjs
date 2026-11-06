import fs from 'node:fs';
import promises from 'node:fs/promises';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isAbsolute, sep } from 'node:path';

const prefixes = JSON.parse(process.env.CODEX_WINDOW_NATIVE_PREFIXES);
const effects = { nativeCalls: 0, processCalls: 0, operations: [] };
const nativeFds = new Set();
const aliases = JSON.parse(process.env.CODEX_WINDOW_NATIVE_ALIASES ?? '[]');
const nativeEntries = new Set(JSON.parse(process.env.CODEX_WINDOW_NATIVE_ENTRY_NAMES ?? '[]'));
const nativePath = path => prefixes.some(prefix => path === prefix || path.startsWith(prefix + sep));
function native(value, followLeaf) {
  if (typeof value === 'number') return nativeFds.has(value);
  const path = value instanceof URL ? fileURLToPath(value) : Buffer.isBuffer(value) ? value.toString() : value;
  if (typeof path !== 'string') return false;
  const parts = (isAbsolute(path) ? path : process.cwd() + sep + path).split(sep);
  let stack = [];
  let visitedNative = false;
  // Resolve fixture aliases before processing '..', as the filesystem does.
  for (const [index, part] of parts.entries()) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      stack.pop();
      continue;
    }
    stack.push(part);
    let current = sep + stack.join(sep);
    const alias = aliases.find(value => value.path === current);
    if (alias && (followLeaf || index !== parts.length - 1)) {
      current = alias.target;
      stack = current.split(sep).filter(Boolean);
    }
    visitedNative ||= nativePath(current);
  }
  return visitedNative;
}
function record(operation) {
  effects.nativeCalls += 1;
  if (effects.operations.length < 128) effects.operations.push(operation);
}
function count(operation, value) {
  if (!native(value, !/lstat|readlink/.test(operation))) return false;
  record(operation);
  return true;
}
function observeDirectory(directory, observed) {
  const original = directory.readSync;
  directory.readSync = (...args) => {
    const entry = Reflect.apply(original, directory, args);
    // The returned entry independently witnesses the object actually opened.
    if (observed || (entry !== null && nativeEntries.has(entry.name))) record('Dir.readSync');
    return entry;
  };
  return directory;
}
function wrapSync(name) {
  const original = fs[name];
  if (typeof original !== 'function') return;
  const replacement = function (...args) {
    const observed = count(name, args[0]);
    const result = Reflect.apply(original, fs, args);
    if (name === 'opendirSync') observeDirectory(result, observed);
    if (name === 'openSync' && observed) nativeFds.add(result);
    if (name === 'closeSync') nativeFds.delete(args[0]);
    return result;
  };
  if (original.native) {
    replacement.native = (...args) => {
      count(`${name}.native`, args[0]);
      return Reflect.apply(original.native, original, args);
    };
  }
  fs[name] = replacement;
}
function wrapCallback(name) {
  const original = fs[name];
  if (typeof original !== 'function') return;
  const replacement = function (...args) {
    const observed = count(name, args[0]);
    if (name === 'opendir') {
      const callback = args.pop();
      args.push((error, directory) => callback(error, error ? directory : observeDirectory(directory, observed)));
    }
    if (name === 'open' && observed) {
      const callback = args.pop();
      args.push((error, fd) => {
        if (!error) nativeFds.add(fd);
        callback(error, fd);
      });
    }
    return Reflect.apply(original, fs, args);
  };
  if (original.native) {
    replacement.native = (...args) => {
      count(`${name}.native`, args[0]);
      return Reflect.apply(original.native, original, args);
    };
  }
  fs[name] = replacement;
}
for (const name of [
  'stat',
  'lstat',
  'fstat',
  'realpath',
  'open',
  'read',
  'readv',
  'readFile',
  'readdir',
  'readlink',
  'opendir',
  'access',
  'write',
  'writeFile',
  'appendFile',
  'close'
]) {
  wrapSync(`${name}Sync`);
  wrapCallback(name);
}
for (const name of ['createReadStream', 'createWriteStream', 'watch', 'watchFile']) wrapSync(name);
for (const name of ['stat', 'lstat', 'realpath', 'open', 'readFile', 'readdir', 'readlink', 'opendir', 'access', 'writeFile', 'appendFile']) {
  const original = promises[name];
  promises[name] = async (...args) => {
    const observed = count(`promises.${name}`, args[0]);
    const result = await Reflect.apply(original, promises, args);
    if (name === 'opendir') observeDirectory(result, observed);
    if (name === 'open' && observed) {
      nativeFds.add(result.fd);
      for (const method of ['stat', 'read', 'readv', 'readFile', 'readLines', 'createReadStream', 'write', 'writeFile']) {
        const originalMethod = result[method];
        result[method] = (...values) => {
          count(`FileHandle.${method}`, result.fd);
          return Reflect.apply(originalMethod, result, values);
        };
      }
    }
    return result;
  };
}
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  childProcess[name] = () => {
    effects.processCalls += 1;
    if (effects.operations.length < 128) {
      effects.operations.push(`child_process.${name}`);
    }
    throw new Error('synthetic_process_tripwire');
  };
}
process.kill = () => {
  effects.processCalls += 1;
  if (effects.operations.length < 128) {
    effects.operations.push('process.kill');
  }
  throw new Error('synthetic_process_tripwire');
};
syncBuiltinESMExports();
let reported = false;
process.on('beforeExit', () => {
  if (reported) return;
  reported = true;
  process.send({ kind: 'effects', effects }, () => process.disconnect());
});
process.send({ kind: 'ready' });
await import(pathToFileURL(process.env.CODEX_WINDOW_SCRIPT).href);
