import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, vi } from 'vitest';
import { Lifecycle } from '../../src/lifecycle.js';
import { Store } from '../../src/store.js';
import { createLocalWebDomain } from '../../src/web/local-web-domain.js';
import { createLocalWebServer } from '../../src/web/local-web-server.js';

export async function claudeWindowSetupHttpFixture() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime('2026-11-07T08:45:00.000Z');
  const native = vi.fn(() => {
    throw new Error('native_access_forbidden');
  });
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'claude-window-setup-')));
  const project = join(directory, 'project');
  mkdirSync(project);
  const store = new Store(':memory:');
  new Lifecycle(store).registerProject('project', project);
  const domain = createLocalWebDomain({
    store,
    metadataFile: join(directory, 'metadata.sqlite'),
    claudeWindowBinaryAdapters: {
      currentUid: native,
      readProcess: native,
      readImage: native,
      realpath: native,
      stat: native,
      open: native
    }
  });
  const app = createLocalWebServer({
    origin: 'http://127.0.0.1:4327',
    domain,
    metadataFile: join(directory, 'transport.sqlite')
  });
  const response = await app.inject({
    url: '/api/bootstrap',
    headers: { host: '127.0.0.1:4327' }
  });
  expect(response.statusCode).toBe(200);
  const csrf = response.json<{ csrf: string }>().csrf;
  const post = (url: string, payload: Record<string, unknown>, version?: string) =>
    app.inject({
      method: 'POST',
      url,
      payload,
      headers: {
        host: '127.0.0.1:4327',
        origin: 'http://127.0.0.1:4327',
        'x-harness-csrf': csrf,
        'idempotency-key': randomUUID(),
        ...(version ? { 'if-match': version } : {})
      }
    });
  const configure = (payload: Record<string, unknown>) =>
    post('/api/projects/project/ordinary-setup', {
      operation: 'configure',
      ...payload
    });
  return {
    directory,
    project,
    store,
    app,
    native,
    post,
    configure,
    async prepare() {
      const configured = await configure({
        bundle_mode: 'ordinary_window',
        product_version: '2.1.318',
        claude_projects_directory: join(directory, 'native-denied')
      });
      expect(configured.statusCode, configured.body).toBe(200);
      const created = await post('/api/tasks', {
        mode: 'ordinary',
        name: 'Synthetic window',
        project_id: 'project',
        criterion_ids: ['accepted']
      });
      expect(created.statusCode, created.body).toBe(200);
      return created.json<{ id: string; version: string }>();
    },
    async close() {
      expect(native).not.toHaveBeenCalled();
      expect(store.all('SELECT * FROM session_bindings')).toEqual([]);
      expect(store.all('SELECT * FROM ordinary_window_activations')).toEqual([]);
      await app.close();
      store.close();
      vi.useRealTimers();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}
