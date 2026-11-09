import fs from 'node:fs';
import promises from 'node:fs/promises';
import childProcess from 'node:child_process';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const config = JSON.parse(process.env.PROMOTED_PRODUCER_FIXTURE);
const code = new Set(config.codeFiles.map(path => pathToFileURL(path).href));
const ancestors = new Set();
for (let path = config.directory; ; path = dirname(path)) {
  ancestors.add(path);
  if (path === dirname(path)) break;
}
const descriptors = new Map();
const effects = {
  unauthorizedCalls: 0,
  nativeCalls: 0,
  processCalls: 0,
  metadataWrites: 0,
  operations: []
};
let loading = false;
const pathValue = value => (value instanceof URL ? fileURLToPath(value) : Buffer.isBuffer(value) ? value.toString() : value);
function denied(name, value) {
  effects.unauthorizedCalls += 1;
  const path = pathValue(value);
  if (typeof path === 'number' || (typeof path === 'string' && config.nativePrefixes.some(prefix => resolve(path).startsWith(prefix)))) {
    effects.nativeCalls += 1;
  }
  effects.operations.push(name);
  throw new Error('synthetic_unauthorized_operation');
}
function filesystem(name, value, flags) {
  const path = pathValue(value);
  const descriptor = descriptors.get(path);
  if (loading && typeof path === 'string' && code.has(pathToFileURL(path).href) && /^(realpathSync|realpathSync.native|readFileSync|openSync)$/.test(name)) {
    return 'code';
  }
  if (loading && descriptor === 'code' && /^(readSync|fstatSync|closeSync)$/.test(name)) return 'code';
  if (name === 'lstatSync' && ancestors.has(path)) return 'ancestor';
  if (
    name === 'openSync' &&
    path === join(config.directory, 'promotion-control.json') &&
    flags === (fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  ) {
    return 'control';
  }
  if (name === 'opendirSync' && path === config.directory) return 'directory';
  if (
    name === 'openSync' &&
    typeof path === 'string' &&
    dirname(path) === config.directory &&
    /^[a-f0-9-]{36}\.json$/.test(path.slice(config.directory.length + 1)) &&
    flags === (fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW)
  ) {
    return 'receipt';
  }
  if (descriptor === 'control' && /^(readSync|fstatSync|closeSync)$/.test(name)) return 'control';
  if (descriptor === 'receipt' && /^(writeFileSync|writeSync|closeSync)$/.test(name)) {
    if (name === 'writeFileSync') effects.metadataWrites += 1;
    return 'receipt';
  }
  return denied(name, value);
}
function install() {
  for (const name of [
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
    'openAsBlob',
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
  ]) {
    for (const operation of [name, `${name}Sync`]) {
      const original = fs[operation];
      if (typeof original !== 'function') continue;
      const replacement = (...args) => {
        const kind = filesystem(operation, args[0], args[1]);
        const result = Reflect.apply(original, fs, args);
        if (operation === 'openSync') descriptors.set(result, kind);
        if (operation === 'closeSync') descriptors.delete(args[0]);
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
    if (typeof promises[name] === 'function') {
      promises[name] = (...args) => denied(`promises.${name}`, args[0]);
    }
  }
  for (const name of ['createReadStream', 'createWriteStream', 'watch', 'watchFile']) fs[name] = (...args) => denied(name, args[0]);
  function processCall(name) {
    effects.processCalls += 1;
    effects.operations.push(name);
    throw new Error('synthetic_process_operation');
  }
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[name] = () => processCall(name);
  childProcess.ChildProcess.prototype.spawn = () => processCall('ChildProcess.spawn');
  for (const name of ['cwd', 'chdir', 'kill', 'binding', '_linkedBinding', 'dlopen']) process[name] = () => processCall(`process.${name}`);
  syncBuiltinESMExports();
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    loading = Boolean(context.parentURL && specifier.startsWith('.') && code.has(new URL(specifier, context.parentURL).href));
    try {
      return nextResolve(specifier, context);
    } finally {
      loading = false;
    }
  },
  load(url, context, nextLoad) {
    if (url === pathToFileURL(process.argv[1]).href) install();
    loading = code.has(url);
    try {
      return nextLoad(url, context);
    } finally {
      loading = false;
    }
  }
});
process.once('exit', () => process.stderr.write(`PROMOTED_EFFECTS:${JSON.stringify(effects)}\n`));
