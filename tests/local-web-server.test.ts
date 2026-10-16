import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { createLocalWebServer, type LocalWebDomain } from '../src/local-web-server.js';
import { Store } from '../src/store.js';
import { Deletion } from '../src/deletion.js';
import { EventEmitter, once } from 'node:events';

const origin = 'http://127.0.0.1:4318';
function domain() {
  const store = new Store(':memory:');
  store.execute("INSERT INTO projects(id) VALUES ('project-1')", []);
  store.execute("INSERT INTO tasks(id,project_id) VALUES ('task-1','project-1')", []);
  let version = 'initial'; let count = 0;
  const task = () => ({ id: 'task-1', name: 'Synthetic private label', version, state: 'registered' });
  const api: LocalWebDomain = {
    metadataStore: store,
    bootstrap: () => ({ projects: [], setups: [], tasks: [task()], catalog: null }),
    task, registerProject: directory => Promise.resolve({ id: 'project-1', directory }),
    createTask: () => Promise.resolve(task()),
    taskAction: () => { count++; version = 'changed'; return Promise.resolve(task()); },
    refreshPrices: () => Promise.resolve({ status: 'failed', reason: 'catalog_source_not_configured' }),
    chooseDirectory: () => Promise.resolve(null), chooseSession: () => Promise.resolve(null),
    close: () => { store.close(); return Promise.resolve(); },
  };
  return { api, calls: () => count };
}
async function fixture(metadataFile = ':memory:') {
  const d = domain(); const app = createLocalWebServer({ origin, domain: d.api, metadataFile });
  const response = await app.inject({ url: '/api/bootstrap', headers: { host: '127.0.0.1:4318' } });
  const csrf = response.json<{ csrf: string }>().csrf;
  const headers = { host: '127.0.0.1:4318', origin, 'x-harness-csrf': csrf, 'idempotency-key': randomUUID(), 'if-match': 'initial' };
  return { ...d, app, headers };
}

test('rejects non-loopback authority and cross-origin bootstrap without domain exposure', async () => {
  const f = await fixture(); try {
    expect((await f.app.inject({ url: '/api/bootstrap', headers: { host: 'evil.example:4318' } })).statusCode).toBe(403);
    expect((await f.app.inject({ url: '/api/bootstrap', headers: { host: '127.0.0.1:4318', origin: 'https://evil.example' } })).statusCode).toBe(403);
  } finally { await f.app.close(); }
});

test('writes require origin, CSRF, typed body and unique action key', async () => {
  const f = await fixture(); try {
    const route = '/api/tasks/task-1/pause';
    expect((await f.app.inject({ method: 'POST', url: route, headers: { host: f.headers.host }, payload: {} })).statusCode).toBe(403);
    expect((await f.app.inject({ method: 'POST', url: route, headers: { ...f.headers, 'x-harness-csrf': 'wrong' }, payload: {} })).statusCode).toBe(403);
    expect((await f.app.inject({ method: 'POST', url: route, headers: f.headers, payload: { command: 'arbitrary shell' } })).statusCode).toBe(400);
    expect(f.calls()).toBe(0);
  } finally { await f.app.close(); }
});

test('duplicate click returns original result once, stale CLI state blocks new mutation', async () => {
  const f = await fixture(); try {
    const request = { method: 'POST' as const, url: '/api/tasks/task-1/pause', headers: f.headers, payload: {} };
    const first = await f.app.inject(request); expect(first.statusCode).toBe(200);
    const replay = await f.app.inject(request); expect(replay.json()).toEqual(first.json()); expect(f.calls()).toBe(1);
    expect((await f.app.inject({ ...request, headers: { ...f.headers, 'idempotency-key': randomUUID() } })).statusCode).toBe(409);
    expect(f.calls()).toBe(1);
  } finally { await f.app.close(); }
});

test('durable action replay survives service reload and cannot be reused with a different action', async () => {
  const root = mkdtempSync(join(tmpdir(), 'local-web-test-')); const path = join(root, 'ui.sqlite');
  const f = await fixture(path); const key = f.headers['idempotency-key'];
  try {
    expect((await f.app.inject({ method: 'POST', url: '/api/tasks/task-1/pause', headers: f.headers, payload: {} })).statusCode).toBe(200);
    await f.app.close(); const next = await fixture(path);
    try {
      expect((await next.app.inject({ method: 'POST', url: '/api/tasks/task-1/pause', headers: { ...next.headers, 'idempotency-key': key }, payload: {} })).statusCode).toBe(200);
      expect(next.calls()).toBe(0);
      expect((await next.app.inject({ method: 'POST', url: '/api/tasks/task-1/prepare', headers: { ...next.headers, 'idempotency-key': key }, payload: {} })).statusCode).toBe(409);
    } finally { await next.app.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('cancelled picker has no task transition and unknown failures never expose producer text', async () => {
  const f = await fixture(); try {
    const picker = await f.app.inject({ method: 'POST', url: '/api/project-picker', headers: f.headers, payload: {} });
    expect(picker.json()).toEqual({ selection: null }); expect(f.calls()).toBe(0);
    f.api.taskAction = () => Promise.reject(new Error('SECRET_PROMPT /Users/private/path'));
    const failed = await f.app.inject({ method: 'POST', url: '/api/tasks/task-1/pause', headers: { ...f.headers, 'idempotency-key': randomUUID() }, payload: {} });
    expect(failed.statusCode).toBe(400); expect(failed.body).not.toContain('SECRET'); expect(failed.body).not.toContain('/Users');
  } finally { await f.app.close(); }
});

test('application reviews are transient and deleted tasks cannot replay publication responses',async()=>{
 const root=mkdtempSync(join(tmpdir(),'application-web-')),path=join(root,'ui.sqlite');const f=await fixture(path);
 try{f.api.applicationReview=()=>({jobId:'synthetic-job',approvalDigest:'a'.repeat(64),changes:[{path:'AGENTS.md',before:null,after:'SYNTHETIC_PRIVATE_REVIEW'}]});
 const review=await f.app.inject({url:'/api/tasks/task-1/application-review',headers:{host:f.headers.host}});expect(review.statusCode).toBe(200);expect(review.headers['cache-control']).toBe('no-store');expect(review.body).toContain('SYNTHETIC_PRIVATE_REVIEW');
 const db=new Database(path);try{expect(db.prepare('SELECT * FROM web_actions').all()).toHaveLength(0);
 const request={method:'POST' as const,url:'/api/tasks/task-1/application-publish',headers:f.headers,payload:{approvalDigest:'a'.repeat(64)}};expect((await f.app.inject(request)).statusCode).toBe(200);expect(JSON.stringify(db.prepare('SELECT * FROM web_actions').all())).not.toContain('SYNTHETIC_PRIVATE_REVIEW');
 f.api.task=()=>{throw new Error('unknown_task');};expect((await f.app.inject(request)).statusCode).not.toBe(200);expect(f.calls()).toBe(1);
 }finally{db.close();}
 }finally{await f.app.close();rmSync(root,{recursive:true,force:true});}
});

test.each(['create', 'action'] as const)('deletion fences a delayed %s response and keeps its consumed key blocked', async kind => {
  const root = mkdtempSync(join(tmpdir(), 'web-response-fence-'));
  const path = join(root, 'transport.sqlite');
  const f = await fixture(path);
  const signals = new EventEmitter();
  const entered = once(signals, 'entered', { signal: AbortSignal.timeout(3000) });
  const released = once(signals, 'released', { signal: AbortSignal.timeout(3000) });
  const delayed = async () => {
    signals.emit('entered');
    await released;
    return { id: 'task-1', name: 'synthetic-delayed-private-label', version: 'changed' };
  };
  if (kind === 'create') f.api.createTask = delayed;
  else f.api.taskAction = delayed;
  const request = { method: 'POST' as const,
    url: kind === 'create' ? '/api/tasks' : '/api/tasks/task-1/pause',
    headers: f.headers,
    payload: kind === 'create' ? { name: 'synthetic-request', project_id: 'project-1', setup_id: 'setup-1' } : {},
  };
  try {
    const pending = f.app.inject(request);
    await entered;
    new Deletion(f.api.metadataStore).deleteTask('task-1');
    signals.emit('released');
    const result = await pending;
    expect(result.statusCode).toBe(400);
    expect(result.json()).toEqual({ error: 'deleted_identifier' });
    const db = new Database(path);
    try {
      expect(db.prepare('SELECT state,response FROM web_actions WHERE id=?').get(f.headers['idempotency-key']))
        .toEqual({ state: 'deleted', response: null });
    } finally { db.close(); }
    expect((await f.app.inject(request)).json()).toEqual({ error: 'deleted_identifier' });
  } finally {
    signals.emit('released');
    await f.app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
