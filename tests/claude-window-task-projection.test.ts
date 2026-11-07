import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Lifecycle } from '../src/lifecycle.js';
import { ordinaryProjectSettings, ordinaryTask } from '../src/ordinary-observation.js';
import { claudeWindowSetupHttpFixture } from './helpers/claude-window-setup-http-fixture.js';
let f: Awaited<ReturnType<typeof claudeWindowSetupHttpFixture>>;
beforeEach(async () => {
  f = await claudeWindowSetupHttpFixture();
});
afterEach(async () => {
  await f.close();
});

test('projects missing usage as a closed window, keeps its version stable over time, and denies both connect surfaces', async () => {
  const task = await f.prepare();
  const get = () =>
    f.app.inject({
      url: `/api/tasks/${task.id}`,
      headers: { host: '127.0.0.1:4327' }
    });
  const first = await get();
  expect(first.statusCode, first.body).toBe(200);
  expect(first.json()).toMatchObject({
    mode: 'ordinary',
    actions: [],
    measurement: { state: 'waiting_connection' },
    ordinary_window: {
      product: 'claude_code',
      evidence_mode: 'publisher_verified_local_pin',
      collection_enabled: false,
      automatic_children: false
    }
  });
  expect(first.body).not.toContain('native-denied');
  vi.setSystemTime('2026-11-07T08:46:00.000Z');
  expect((await get()).json<{ version: string }>().version).toBe(first.json<{ version: string }>().version);
  const generic = await f.post(
    `/api/tasks/${task.id}/session-connect`,
    {
      product: 'claude_code',
      receipt: randomUUID()
    },
    task.version
  );
  expect(generic.statusCode).toBe(400);
  const scopedState = (
    await f.app.inject({
      url: `/api/tasks/${task.id}/claude-window-v1`,
      headers: { host: '127.0.0.1:4327' }
    })
  ).json<{
    task: { version: string; connection_enabled: boolean };
  }>();
  expect(scopedState.task.connection_enabled).toBe(false);
  const scoped = await f.post(
    `/api/tasks/${task.id}/claude-window-connect-v1`,
    {
      project_id: 'project',
      product: 'claude_code',
      receipt: randomUUID()
    },
    scopedState.task.version
  );
  expect(scoped.statusCode).toBe(400);
});

test('keeps old task mode pinned after an explicit project mode change and never publishes active control', async () => {
  const task = await f.prepare();
  const frozen = ordinaryTask(f.store, task.id);
  expect(
    (
      await f.configure({
        bundle_mode: 'exact',
        product_version: '2.1.306'
      })
    ).statusCode
  ).toBe(200);
  const response = await f.app.inject({
    url: `/api/tasks/${task.id}`,
    headers: { host: '127.0.0.1:4327' }
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toHaveProperty('ordinary_window.product', 'claude_code');
  expect(ordinaryTask(f.store, task.id)).toEqual(frozen);
  expect(existsSync(join(f.project, '.harness-delta/claude-window-receipts/ordinary-window-control.json'))).toBe(false);
});

test('blocks mode migration when a Claude task is using the installation', async () => {
  const task = await f.prepare();
  new Lifecycle(f.store).start(task.id);
  const before = ordinaryProjectSettings(f.store, 'project');
  expect(
    (
      await f.configure({
        bundle_mode: 'exact',
        product_version: '2.1.306'
      })
    ).statusCode
  ).toBe(400);
  expect(ordinaryProjectSettings(f.store, 'project')).toEqual(before);
  expect((await f.configure({ product_version: '2.1.319' })).statusCode).toBe(200);
  expect(ordinaryTask(f.store, task.id)?.settings).toContain('2.1.318');
});
