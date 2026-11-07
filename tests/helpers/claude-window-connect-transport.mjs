import { ledger } from './claude-window-tripwire.mjs';

const scenario = JSON.parse(process.env.CLAUDE_WINDOW_FIXTURE).scenario;
const ResponseCtor = Response;
const HeadersCtor = Headers;
const timeout = AbortSignal.timeout;
const aborters = new WeakMap();
AbortSignal.timeout = milliseconds => {
  if (milliseconds !== 10000) throw new Error('synthetic_invalid_deadline');
  ledger.deadlines += 1;
  const controller = new AbortController();
  const signal = AbortSignal.any([Reflect.apply(timeout, AbortSignal, [milliseconds]), controller.signal]);
  aborters.set(signal, controller);
  return signal;
};
const json = (value, status = 200) => new ResponseCtor(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const keys = new Set();
let selected = null;
let reads = 0;
globalThis.fetch = async (url, options) => {
  ledger.requests.push({ url, method: options.method, headers: options.headers, body: options.body ?? null });
  const index = ledger.requests.length;
  if (scenario.failAt === index) {
    throw new Error('SYNTHETIC_PRIVATE_TRANSPORT');
  }
  if (scenario.invalidJsonAt === index) {
    return new ResponseCtor('SYNTHETIC_PRIVATE_BODY');
  }
  if (scenario.redirectAt === index) {
    const reply = json({});
    Object.defineProperty(reply, 'redirected', { value: true });
    return reply;
  }
  if (scenario.abortAt === index) {
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      // Signal the exact transport boundary; the parent never waits by sleeping.
      process.once('message', message => {
        if (message.kind !== 'abort_request') return;
        aborters.get(options.signal).abort(new DOMException('SYNTHETIC_PRIVATE_DEADLINE', 'TimeoutError'));
      });
      process.send({ kind: 'request_pending' });
    });
  }
  if (options.redirect !== 'error' || options.credentials !== 'omit' || !(options.signal instanceof AbortSignal) || options.signal.aborted) {
    return json({ error: 'invalid_ui_request' }, 400);
  }
  const base = scenario.origin + '/api/tasks/' + encodeURIComponent(scenario.task);
  if (url === base + '/claude-window-v1' && options.method === 'GET') {
    const explicit = scenario.views?.[reads++];
    return json(explicit ?? { csrf: scenario.csrf, task: { ...scenario.view, selected_root_id: selected } });
  }
  if (url !== base + '/claude-window-connect-v1' || options.method !== 'POST') return json({ error: 'SYNTHETIC_PRIVATE_ROUTE' }, 404);
  ledger.attempts += 1;
  if (scenario.serverError !== undefined) {
    return json({ error: scenario.serverError }, 409);
  }
  const headers = new HeadersCtor(options.headers);
  if (
    headers.get('Origin') !== scenario.origin ||
    headers.get('X-Harness-CSRF') !== scenario.csrf ||
    headers.get('If-Match') !== (scenario.serverVersion ?? scenario.view.version)
  )
    return json({ error: 'ui_state_changed' }, 409);
  const key = headers.get('Idempotency-Key');
  const body = JSON.parse(options.body);
  if (
    !key ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(key) ||
    keys.has(key) ||
    scenario.replayed ||
    body.project_id !== scenario.project ||
    body.product !== 'claude_code' ||
    body.receipt !== scenario.receipt ||
    Object.keys(body).length !== 3
  )
    return json({ error: 'binding_request_conflict' }, 409);
  keys.add(key);
  ledger.connections += 1;
  selected = scenario.connection.session_id;
  return json(scenario.response ?? scenario.connection);
};
