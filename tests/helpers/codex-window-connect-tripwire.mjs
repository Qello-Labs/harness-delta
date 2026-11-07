import fs from 'node:fs';
import promises from 'node:fs/promises';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

const scenario = JSON.parse(process.env.CODEX_WINDOW_CONNECT_SCENARIO);
const ResponseCtor = Response;
const HeadersCtor = Headers;
const entry = process.argv[1];
const ownEntries = new Set([entry, fs.realpathSync(entry)]);
const ownCodeFds = new Set();
const ownEntry = value => ownEntries.has(value instanceof URL ? fileURLToPath(value) : Buffer.isBuffer(value) ? value.toString() : value);
const nativeRoot = process.env.CODEX_WINDOW_CONNECT_NATIVE;
const nativeFds = new Set([4]);
const effects = {
  filesystemCalls: 0,
  nativeCalls: 0,
  processCalls: 0,
  metadataWrites: 0,
  operations: []
};
const requests = [];
let entryArmed = false;
function armEntry() {
  if (entryArmed) return;
  entryArmed = true;
  process.cwd = () => processCall('process.cwd');
  process.send({ kind: 'ready' });
}
let reads = 0;
let attempts = 0;
let connections = 0;
let selectedRoot = null;
const keys = new Set();
function filesystem(name, value, flags) {
  const path = value instanceof URL ? fileURLToPath(value) : Buffer.isBuffer(value) ? value.toString() : value;
  // The loader's entry reads may descend through public open/read/fstat APIs.
  if (
    ownEntries.has(path) &&
    ['realpathSync', 'realpathSync.native', 'readFileSync', 'promises.readFile', 'openSync'].includes(name) &&
    (name !== 'openSync' || flags === 'r' || flags === 0)
  ) {
    // Node resolves its main URL before loading code; guard cwd before any entry bytes run.
    if (['readFileSync', 'promises.readFile', 'openSync'].includes(name)) armEntry();
    return;
  }
  if (ownCodeFds.has(path) && ['readSync', 'readvSync', 'readFileSync', 'fstatSync', 'closeSync'].includes(name)) return;
  effects.filesystemCalls += 1;
  if (nativeFds.has(path) || (typeof path === 'string' && path.startsWith(nativeRoot))) effects.nativeCalls += 1;
  if (/write|append|mkdir|rename|unlink|rm|truncate|copy|link/i.test(name)) {
    effects.metadataWrites += 1;
  }
  if (effects.operations.length < 128) effects.operations.push(name);
  throw new Error('synthetic_filesystem_tripwire');
}
for (const name of [
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
]) {
  for (const operation of [name, `${name}Sync`]) {
    const original = fs[operation];
    if (typeof original !== 'function') continue;
    const replacement = (...args) => {
      filesystem(operation, args[0], args[1]);
      const result = Reflect.apply(original, fs, args);
      if (operation === 'openSync' && ownEntry(args[0])) ownCodeFds.add(result);
      if (operation === 'closeSync') ownCodeFds.delete(args[0]);
      return result;
    };
    if (original.native) {
      replacement.native = (...args) => filesystem(`${operation}.native`, args[0]);
    }
    fs[operation] = replacement;
  }
  const original = promises[name];
  if (typeof original === 'function') {
    promises[name] = async (...args) => {
      filesystem(`promises.${name}`, args[0]);
      return Reflect.apply(original, promises, args);
    };
  }
}
for (const name of ['createReadStream', 'createWriteStream', 'watch', 'watchFile']) {
  fs[name] = (...args) => filesystem(name, args[0]);
}
function processCall(name) {
  effects.processCalls += 1;
  if (effects.operations.length < 128) effects.operations.push(name);
  throw new Error('synthetic_process_tripwire');
}
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  childProcess[name] = () => processCall(`child_process.${name}`);
}
childProcess.ChildProcess.prototype.spawn = () => processCall('child_process.ChildProcess.spawn');
for (const name of ['chdir', 'kill', 'binding', '_linkedBinding', 'dlopen']) {
  process[name] = () => processCall(`process.${name}`);
}
syncBuiltinESMExports();

function json(value, status = 200) {
  return new ResponseCtor(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
globalThis.fetch = async (url, options) => {
  requests.push({
    url,
    method: options.method,
    headers: options.headers,
    body: options.body ?? null
  });
  if (scenario.failAt === requests.length) {
    throw new Error('SYNTHETIC_PRIVATE_TRANSPORT_PATH');
  }
  if (scenario.invalidJsonAt === requests.length) {
    return new ResponseCtor('SYNTHETIC_PRIVATE_BODY');
  }
  if (scenario.redirectAt === requests.length) {
    const reply = json({});
    Object.defineProperty(reply, 'redirected', { value: true });
    return reply;
  }
  if (options.redirect !== 'error' || !(options.signal instanceof AbortSignal) || options.signal.aborted) {
    return json({ error: 'invalid_ui_request' }, 400);
  }
  const base = scenario.origin + '/api/tasks/' + encodeURIComponent(scenario.task);
  if (url === base + '/codex-window-v1' && options.method === 'GET') {
    const index = reads++;
    const view = scenario.views?.[index];
    if (view !== undefined) return json(view);
    return json({
      csrf: scenario.csrf,
      task: { ...scenario.view, selected_root_id: selectedRoot }
    });
  }
  if (url !== base + '/codex-window-connect-v1' || options.method !== 'POST') {
    return json({ error: 'SYNTHETIC_PRIVATE_UNEXPECTED_ROUTE' }, 404);
  }
  attempts += 1;
  if (scenario.serverError !== undefined) {
    return json({ error: scenario.serverError }, scenario.status ?? 409);
  }
  const headers = new HeadersCtor(options.headers);
  const key = headers.get('Idempotency-Key');
  const body = JSON.parse(options.body);
  if (
    headers.get('Origin') !== scenario.origin ||
    headers.get('X-Harness-CSRF') !== scenario.csrf ||
    headers.get('If-Match') !== (scenario.serverVersion ?? scenario.view.version)
  )
    return json({ error: 'ui_state_changed' }, 409);
  if (
    !key ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(key) ||
    keys.has(key) ||
    body.project_id !== scenario.project ||
    body.product !== 'codex' ||
    body.receipt !== scenario.receipt ||
    Object.keys(body).length !== 3
  )
    return json({ error: 'binding_request_conflict' }, 409);
  keys.add(key);
  connections += 1;
  selectedRoot = scenario.connection.session_id;
  return json(scenario.response === undefined ? scenario.connection : scenario.response);
};
let reported = false;
process.on('beforeExit', () => {
  if (reported) return;
  reported = true;
  process.send({ kind: 'effects', effects, requests, attempts, connections }, () => process.disconnect());
});
