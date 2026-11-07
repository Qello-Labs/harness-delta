import fs from 'node:fs';
import fsp from 'node:fs/promises';
import childProcess from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { createLocalWebDomain } from '../src/web/local-web-domain.js';
import { createLocalWebServer } from '../src/web/local-web-server.js';
import { Deletion } from '../src/deletion.js';
import { windowReportCutoff, windowReportFixture } from './helpers/ordinary-window-report-fixture.js';
import { ordinaryWindowReport } from '../ui/src/api.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0)) await close();
});

function httpFixture(product: 'codex' | 'claude_code') {
  const f = windowReportFixture(product);
  const root = fs.mkdtempSync(join(tmpdir(), 'window-report-http-'));
  const factory = vi.fn(() => {
    throw new Error('unexpected_provider_construction');
  });
  const domain = createLocalWebDomain({ store: f.store, metadataFile: join(root, 'domain.sqlite'), bindingProviderFactory: factory });
  const app = createLocalWebServer({ origin: 'http://127.0.0.1:4327', domain, metadataFile: join(root, 'transport.sqlite') });
  cleanup.push(async () => {
    await app.close();
    f.store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { ...f, app, factory };
}

test.each(['codex', 'claude_code'] as const)('HTTP %s window report reads eventless Store evidence with zero provider or native effects', async product => {
  const f = httpFixture(product);
  await f.app.ready();
  const transport = await f.app.inject({ url: '/api/fixture-transport-ready', headers: { host: '127.0.0.1:4327' } });
  expect(transport.statusCode).toBe(404);
  f.activate();
  const before = f.reportSnapshot();
  const sync = ['realpathSync', 'statSync', 'lstatSync', 'openSync', 'readSync', 'readFileSync', 'readdirSync', 'readlinkSync'] as const;
  const async = ['realpath', 'stat', 'lstat', 'open', 'readFile', 'readdir', 'readlink'] as const;
  const process = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync'] as const;
  const spies = [
    ...sync.map(name =>
      vi.spyOn(fs, name).mockImplementation(() => {
        throw new Error('unexpected_native_filesystem:' + name);
      })
    ),
    ...async.map(name =>
      vi.spyOn(fsp, name).mockImplementation(() => {
        throw new Error('unexpected_native_filesystem:' + name);
      })
    ),
    ...process.map(name =>
      vi.spyOn(childProcess, name).mockImplementation(() => {
        throw new Error('unexpected_native_process');
      })
    )
  ];
  const reply = await f.app.inject({
    url: `/api/tasks/${f.taskId}/ordinary-window-report-v1?cutoff=${encodeURIComponent(windowReportCutoff)}`,
    headers: { host: '127.0.0.1:4327' }
  });
  expect(reply.statusCode).toBe(200);
  expect(reply.json()).toMatchObject({
    report_version: 'ordinary-window-task-v1',
    collection: { state: 'disabled' },
    selection: { declared_version: f.selection.declaredVersion },
    coverage: { segments: [], detectionCompleteness: 'unknown' },
    inference: false,
    exchange: { supported: false },
    usage: { event_count: 0, verified: { partial_tokens: null } },
    cost: { complete_amount: null }
  });
  expect(f.factory).not.toHaveBeenCalled();
  expect(f.calls).toEqual([]);
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  expect(f.reportSnapshot()).toEqual(before);
});

test.each(['orphan', 'mismatch', 'deleted'] as const)('HTTP window report refuses %s evidence and cannot write authority', async state => {
  const f = httpFixture('codex');
  if (state === 'orphan') {
    f.store.execute('DELETE FROM ordinary_window_selections WHERE task_id=?', [f.taskId]);
  }
  if (state === 'mismatch') {
    f.store.execute("UPDATE ordinary_tasks SET settings_hash='mismatched' WHERE task_id=?", [f.taskId]);
  }
  if (state === 'deleted') {
    new Deletion(f.store, f.clock).deleteTask(f.taskId);
  }
  const before = f.reportSnapshot();
  const reply = await f.app.inject({
    url: `/api/tasks/${f.taskId}/ordinary-window-report-v1?cutoff=${encodeURIComponent(windowReportCutoff)}`,
    headers: { host: '127.0.0.1:4327' }
  });
  expect(reply.statusCode).toBe(400);
  expect(reply.json()).toEqual({
    error: state === 'orphan' ? 'ordinary_preparation_required' : state === 'mismatch' ? 'ordinary_configuration_changed' : 'unknown_task'
  });
  expect(f.factory).not.toHaveBeenCalled();
  expect(f.reportSnapshot()).toEqual(before);
});

test('HTTP report refuses activation flags without calling providers or changing Store authority', async () => {
  const f = httpFixture('codex');
  const before = f.reportSnapshot();
  const reply = await f.app.inject({
    url: `/api/tasks/${f.taskId}/ordinary-window-report-v1?cutoff=${encodeURIComponent(windowReportCutoff)}&activated=true`,
    headers: { host: '127.0.0.1:4327' }
  });
  expect(reply.statusCode).toBe(400);
  expect(f.factory).not.toHaveBeenCalled();
  expect(f.reportSnapshot()).toEqual(before);
});

test('the browser report reader consumes the real versioned HTTP response without authorizing collection', async () => {
  const f = httpFixture('codex');
  const before = f.reportSnapshot();
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const reply = await f.app.inject({
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).parse(init?.method ?? 'GET'),
      url: input,
      headers: { host: '127.0.0.1:4327' },
      ...(typeof init?.body === 'string' ? { payload: init.body } : {})
    });
    return new Response(reply.body, { status: reply.statusCode });
  });
  try {
    const report = await ordinaryWindowReport(f.taskId, windowReportCutoff, new AbortController().signal);
    expect(report).toMatchObject({
      task_id: f.taskId,
      report_version: 'ordinary-window-task-v1',
      collection: { state: 'disabled' },
      usage: { event_count: 0, compatibility_unverified: { partial_tokens: null } }
    });
    expect(f.reportSnapshot()).toEqual(before);
    expect(f.factory).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
  } finally {
    vi.unstubAllGlobals();
  }
});
