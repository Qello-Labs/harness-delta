import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Lifecycle } from '../src/core/lifecycle.js';
import { ordinaryProjectSettings, ordinaryTask } from '../src/ordinary-observation.js';
import { claudeWindowSetupHttpFixture } from './helpers/claude-window-setup-http-fixture.js';
const staging = vi.hoisted((): { activate?: () => void } => ({}));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    mkdirSync: (path: string, options?: import('node:fs').MakeDirectoryOptions) => {
      const result = actual.mkdirSync(path, options);
      if (path.includes('/transaction-')) {
        const activate = staging.activate;
        delete staging.activate;
        activate?.();
      }
      return result;
    }
  };
});
let f: Awaited<ReturnType<typeof claudeWindowSetupHttpFixture>>;
beforeEach(async () => {
  f = await claudeWindowSetupHttpFixture();
});
afterEach(async () => {
  delete staging.activate;
  await f.close();
});

test('refuses HTTP window migration when a task becomes active during staging and preserves existing files', async () => {
  expect((await f.configure({ product_version: '2.1.306' })).statusCode).toBe(200);
  const preview = await f.post('/api/projects/project/ordinary-setup', {
    operation: 'preview-install'
  });
  expect(preview.statusCode, preview.body).toBe(200);
  const exact = preview.json<{
    installation: {
      packageHash: string;
      installedHash: string | null;
    };
  }>().installation;
  const installed = await f.post('/api/projects/project/ordinary-setup', {
    operation: 'install',
    expected_package_hash: exact.packageHash,
    expected_installed_hash: exact.installedHash
  });
  expect(installed.statusCode, installed.body).toBe(200);
  const task = await f.prepare();
  const windowPreview = await f.post('/api/projects/project/ordinary-setup', {
    operation: 'preview-install'
  });
  expect(windowPreview.statusCode, windowPreview.body).toBe(200);
  const window = windowPreview.json<{
    installation: {
      packageHash: string;
      installedHash: string | null;
    };
  }>().installation;
  const files = () =>
    readdirSync(f.project, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => {
        const path = join(entry.parentPath, entry.name);
        return [relative(f.project, path), readFileSync(path).toString('base64')] as const;
      })
      .sort(([a], [b]) => a.localeCompare(b));
  const before = files();
  const lifecycle = new Lifecycle(f.store);
  staging.activate = () => lifecycle.start(task.id);

  const response = await f.post('/api/projects/project/ordinary-setup', {
    operation: 'install',
    expected_package_hash: window.packageHash,
    expected_installed_hash: window.installedHash
  });

  expect(lifecycle.state(task.id)).toBe('active');
  expect(response.statusCode, response.body).toBe(400);
  expect(response.json()).toEqual({ error: 'ordinary_installation_in_use' });
  expect(files()).toEqual(before);
  expect(readdirSync(join(f.project, '.harness-delta/claude-connect'))).toEqual(['installation.json']);
});

test.each([undefined, '2.1.306', '2.2.0', '2.1.318-beta.1', '3.0.0'])(
  'requires an explicit valid stable declaration for window configuration: %s',
  async version => {
    const response = await f.configure({
      bundle_mode: 'ordinary_window',
      ...(version ? { product_version: version } : {})
    });
    expect(response.statusCode).toBe(400);
    expect(ordinaryProjectSettings(f.store, 'project')).toBeUndefined();
    expect(f.store.all('SELECT * FROM ordinary_window_selections')).toEqual([]);
  }
);

test('preserves saved mode when omitted and requires explicit version in either mode transition', async () => {
  const saved = await f.configure({
    bundle_mode: 'ordinary_window',
    product_version: '2.1.318'
  });
  expect(saved.statusCode, saved.body).toBe(200);
  expect(saved.json()).toMatchObject({
    bundle_mode: 'ordinary_window',
    product_version: '2.1.318',
    admission: { admitted: false, qualified: false },
    window: {
      evidence_mode: 'publisher_verified_local_pin',
      collection_enabled: false
    }
  });
  expect((await f.configure({ product_version: '2.1.319' })).statusCode).toBe(200);
  const before = ordinaryProjectSettings(f.store, 'project');
  expect(before).toMatchObject({
    bundle_mode: 'ordinary_window',
    bundle_revision: 'claude-window-bundle-v1',
    product_version: '2.1.319'
  });
  expect((await f.configure({ bundle_mode: 'exact' })).statusCode).toBe(400);
  expect(ordinaryProjectSettings(f.store, 'project')).toEqual(before);
  expect(
    (
      await f.configure({
        bundle_mode: 'exact',
        product_version: '2.1.306'
      })
    ).statusCode
  ).toBe(200);
  expect(ordinaryProjectSettings(f.store, 'project')).toMatchObject({
    bundle_mode: 'exact',
    product_version: '2.1.306'
  });
  expect(ordinaryProjectSettings(f.store, 'project')).not.toHaveProperty('bundle_revision');
});

test('freezes declared mode, revision, policy, root and price without starting or activating a task', async () => {
  const task = await f.prepare();
  const frozen = ordinaryTask(f.store, task.id);
  if (!frozen) throw new Error('fixture_preparation_missing');
  expect(new Lifecycle(f.store).state(task.id)).toBe('registered');
  expect(JSON.parse(frozen.settings)).toMatchObject({
    mode: 'ordinary_window',
    declaredVersion: '2.1.318',
    policy: {
      policyId: 'claude-binding-root-window-v1',
      evidenceMode: 'publisher_verified_local_pin'
    }
  });
  expect(frozen?.price_table_id).toBeTruthy();
  const db = new Database(join(f.directory, 'metadata.sqlite'), {
    readonly: true
  });
  try {
    const record = db.prepare<[string], { profile_id: string; setup: string }>('SELECT profile_id,setup FROM web_tasks WHERE id=?').get(task.id);
    if (!record) throw new Error('fixture_metadata_missing');
    expect(record.profile_id).toBe('ordinary-claude-window-v1');
    expect(JSON.parse(record.setup)).toMatchObject({
      kind: 'claude_window_setup',
      bundle_mode: 'ordinary_window',
      bundle_revision: 'claude-window-bundle-v1',
      configuration: {
        product_version: '2.1.318',
        project_root: f.project,
        receipt_directory: join(f.project, '.harness-delta/claude-window-receipts')
      }
    });
  } finally {
    db.close();
  }
  expect(
    (
      await f.configure({
        product_version: '2.1.319',
        claude_projects_directory: join(f.directory, 'other-native-denied')
      })
    ).statusCode
  ).toBe(200);
  expect(ordinaryTask(f.store, task.id)).toEqual(frozen);
  expect(f.store.all('SELECT * FROM runtime_evidence')).toEqual([]);
});
