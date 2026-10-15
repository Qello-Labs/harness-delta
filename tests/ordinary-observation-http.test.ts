import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Lifecycle } from '../src/lifecycle.js';
import { Store } from '../src/store.js';
import { createLocalWebDomain } from '../src/local-web-domain.js';
import { createLocalWebServer } from '../src/local-web-server.js';
import { ordinaryProjectSettings, ordinaryTask } from '../src/ordinary-observation.js';
import { Deletion } from '../src/deletion.js';
import { claudeBindingAdmission } from '../src/claude-binding-admission.js';

describe('ordinary observation HTTP preparation', () => {
  const origin = 'http://127.0.0.1:4327';
  let root: string;
  let store: Store;
  let app: ReturnType<typeof createLocalWebServer>;
  let csrf: string;
  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ordinary-http-')));
    const project = join(root, 'project');
    mkdirSync(project);
    store = new Store(':memory:');
    new Lifecycle(store).registerProject('project', project);
    const domain = createLocalWebDomain({ store, metadataFile: join(root, 'metadata.sqlite') });
    app = createLocalWebServer({ origin, domain, metadataFile: join(root, 'transport.sqlite') });
    const reply = await app.inject({ url: '/api/bootstrap', headers: { host: '127.0.0.1:4327' } });
    csrf = reply.json<{ csrf: string }>().csrf;
  });
  afterEach(async () => { await app.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const headers = () => ({
    host: '127.0.0.1:4327', origin, 'x-harness-csrf': csrf, 'idempotency-key': randomUUID(),
  });
  const setup = '/api/projects/project/ordinary-setup';

  it('reads setup and installation previews without preparing or installing anything', async () => {
    const before = await app.inject({ url: setup, headers: { host: '127.0.0.1:4327' } });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toMatchObject({ configured: false, installation: { state: 'absent', hookRegistration: 'unverified' } });
    const preview = await app.inject({ method: 'POST', url: setup, headers: headers(), payload: { operation: 'preview-install' } });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ configured: false, installation: { state: 'absent' } });
    expect(ordinaryProjectSettings(store, 'project')).toBeUndefined();
    expect(store.all('SELECT * FROM tasks')).toEqual([]);
    expect(store.all('SELECT * FROM sessions')).toEqual([]);
    expect(store.eventCount()).toBe(0);
  });

  it('requires normal mutation protection and rejects arbitrary setup flags', async () => {
    expect((await app.inject({ method: 'POST', url: setup, headers: { host: '127.0.0.1:4327' },
      payload: { operation: 'configure' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: setup, headers: headers(),
      payload: { operation: 'configure', allowCandidateProfiles: true } })).statusCode).toBe(400);
    expect(ordinaryProjectSettings(store, 'project')).toBeUndefined();
  });

  it('configures and creates an ordinary task without setup, assignment or protocol fields', async () => {
    const configured = await app.inject({ method: 'POST', url: setup, headers: headers(), payload: { operation: 'configure' } });
    expect(configured.statusCode).toBe(200);
    expect(configured.json()).toMatchObject({ configured: true, installation: { state: 'absent' } });
    const request = { method: 'POST' as const, url: '/api/tasks', headers: headers(), payload: {
      mode: 'ordinary', name: 'Synthetic observation', project_id: 'project', criterion_ids: ['accepted'],
    } };
    const created = await app.inject(request);
    expect(created.statusCode).toBe(200);
    const task = created.json<{ id: string; mode: string; preparation: Record<string, unknown>; version: string }>();
    expect(task.mode).toBe('ordinary');
    expect(task.preparation).not.toHaveProperty('assigned_variant_id');
    expect(ordinaryTask(store, task.id)?.price_table_id).toBeTruthy();
    expect(store.all('SELECT * FROM comparison_protocols')).toEqual([]);
    expect(store.all('SELECT * FROM comparison_assignments')).toEqual([]);
    expect(store.all('SELECT * FROM comparison_confirmations')).toEqual([]);
    const replay = await app.inject(request);
    expect(replay.json()).toEqual(task);
    expect(store.all('SELECT * FROM tasks')).toHaveLength(1);
    const dto = await app.inject({ url: `/api/tasks/${task.id}`, headers: { host: '127.0.0.1:4327' } });
    expect(dto.statusCode).toBe(200);
    expect(dto.body).not.toContain('claude_projects_directory');
    expect(dto.body).not.toContain('receipt_directory');
  });

  it('installs only after a configured explicit action and keeps registration unverified', async () => {
    await app.inject({ method: 'POST', url: setup, headers: headers(), payload: { operation: 'configure' } });
    const preview = await app.inject({ method: 'POST', url: setup, headers: headers(), payload: { operation: 'preview-install' } });
    expect(preview.json()).toMatchObject({ installation: { state: 'absent' } });
    const snapshot = preview.json<{ installation: { packageHash: string | null; installedHash: string | null } }>();
    const installed = await app.inject({ method: 'POST', url: setup, headers: headers(), payload: {
      operation: 'install', expected_package_hash: snapshot.installation.packageHash,
      expected_installed_hash: snapshot.installation.installedHash,
    } });
    expect(installed.statusCode).toBe(200);
    expect(installed.json()).toMatchObject({ installation: { state: 'installed', hookRegistration: 'unverified' } });
    expect(store.all('SELECT * FROM sessions')).toEqual([]);
    expect(store.eventCount()).toBe(0);
  });

  it('composes owned installation readiness with ordinary admission and revocation', async () => {
    await app.inject({ method: 'POST', url: setup, headers: headers(), payload: { operation: 'configure' } });
    const created = await app.inject({ method: 'POST', url: '/api/tasks', headers: headers(), payload: {
      mode: 'ordinary', name: 'Synthetic readiness', project_id: 'project', criterion_ids: ['accepted'],
    } });
    expect(created.statusCode).toBe(200);
    const task = created.json<{ id: string }>();
    const taskUrl = `/api/tasks/${task.id}`;
    const readTask = () => app.inject({ url: taskUrl, headers: { host: '127.0.0.1:4327' } });
    expect(created.json()).toMatchObject({ mode: 'ordinary', connection_readiness: {
      skill: { state: 'missing', reason: 'project_skill_missing', install_command: null },
      configured_version: '2.1.296', installed_version: null, collection_revoked: false,
    } });
    const generation = store.get<{ generation: number }>('SELECT generation FROM tasks WHERE id=?', [task.id]);
    const preview = await app.inject({ method: 'POST', url: setup, headers: headers(), payload: { operation: 'preview-install' } });
    const snapshot = preview.json<{ installation: { packageHash: string; installedHash: null } }>();
    const installed = await app.inject({ method: 'POST', url: setup, headers: headers(), payload: {
      operation: 'install', expected_package_hash: snapshot.installation.packageHash,
      expected_installed_hash: snapshot.installation.installedHash,
    } });
    expect(installed.statusCode).toBe(200);
    expect(installed.json()).toMatchObject({ installation: { state: 'installed' }, admission: {
      admitted: true, qualified: false, model_family: 'claude',
    } });
    const ready = await readTask();
    expect(ready.json()).toMatchObject({ connection_readiness: {
      skill: { state: 'installed', reason: null, install_command: null },
      configured_version: '2.1.296', installed_version: null, collection_revoked: false,
    }, measurement: { state: 'waiting_connection', active_ms: null } });
    expect(ready.json<{ actions: unknown[] }>().actions).toContainEqual({
      code: 'session-connect', enabled: true, reason: null,
    });
    expect(ready.json()).toMatchObject({ binding: { support: 'claude_family', supported_model_family: 'claude' } });
    const rejected = await app.inject({ method: 'POST', url: `${taskUrl}/session-connect`,
      headers: { ...headers(), 'if-match': ready.json<{ version: string }>().version },
      payload: { product: 'claude_code', receipt: '00000000-0000-4000-8000-000000000001' } });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toMatchObject({ error: 'claude_receipt_missing' });
    expect(claudeBindingAdmission.qualified).toBe(false);
    expect(store.get('SELECT generation FROM tasks WHERE id=?', [task.id])).toEqual(generation);
    expect(store.all('SELECT * FROM sessions')).toEqual([]);
    expect(store.all('SELECT * FROM active_intervals')).toEqual([]);
    expect(store.eventCount()).toBe(0);
    expect(existsSync(join(root, 'project/.harness-delta/claude-connect/receipts'))).toBe(false);

    const revoked = await app.inject({ method: 'POST', url: `${taskUrl}/revoke-collection`,
      headers: { ...headers(), 'if-match': (await readTask()).json<{ version: string }>().version }, payload: {} });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({ connection_readiness: {
      skill: { state: 'installed', install_command: null }, collection_revoked: true,
    } });
    expect(store.all('SELECT * FROM active_intervals')).toEqual([]);
  });

  it.each(['changed', 'missing'] as const)('exposes %s owned package files as conflict without a copy command', async kind => {
    await app.inject({ method: 'POST', url: setup, headers: headers(), payload: { operation: 'configure' } });
    const preview = await app.inject({ method: 'POST', url: setup, headers: headers(), payload: { operation: 'preview-install' } });
    const snapshot = preview.json<{ installation: { packageHash: string; installedHash: null } }>();
    const installed = await app.inject({ method: 'POST', url: setup, headers: headers(), payload: {
      operation: 'install', expected_package_hash: snapshot.installation.packageHash,
      expected_installed_hash: snapshot.installation.installedHash,
    } });
    expect(installed.json()).toMatchObject({ installation: { state: 'installed' } });
    const created = await app.inject({ method: 'POST', url: '/api/tasks', headers: headers(), payload: {
      mode: 'ordinary', name: 'Synthetic drift', project_id: 'project', criterion_ids: ['accepted'],
    } });
    const task = created.json<{ id: string }>();
    const path = join(root, 'project/.claude/skills/harness-connect/scripts/connect.mjs');
    if (kind === 'changed') writeFileSync(path, 'synthetic drift');
    else unlinkSync(path);
    const result = await app.inject({ url: `/api/tasks/${task.id}`, headers: { host: '127.0.0.1:4327' } });
    expect(result.json()).toMatchObject({ connection_readiness: {
      skill: { state: 'conflict', reason: 'package_drift', install_command: null },
    } });
    expect(result.body).not.toContain(root);
    expect(store.all('SELECT * FROM active_intervals')).toEqual([]);
    expect(store.eventCount()).toBe(0);
  });

  it('does not replay a deleted project setup result', async () => {
    const request = { method: 'POST' as const, url: setup, headers: headers(), payload: { operation: 'configure' } };
    expect((await app.inject(request)).statusCode).toBe(200);
    new Deletion(store).deleteProject('project');
    const replay = await app.inject(request);
    expect(replay.statusCode).toBe(400);
    expect(store.all('SELECT * FROM ordinary_project_settings')).toEqual([]);
  });
});
