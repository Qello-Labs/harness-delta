import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import Database from 'better-sqlite3';
import { codexBindingAdmission } from '../src/codex-binding-admission.js';
import { Deletion } from '../src/deletion.js';
import { Lifecycle } from '../src/lifecycle.js';
import { Store } from '../src/store.js';
import { createLocalWebDomain } from '../src/local-web-domain.js';
import { createLocalWebServer } from '../src/local-web-server.js';
import { localWebFixture } from './helpers/local-web-fixture.js';

type Setup = {
  configured: boolean;
  source_roots: string[];
  installation: { packageHash: string | null; installedHash: string | null };
};

describe('project Codex connection setup HTTP', () => {
  const origin = 'http://127.0.0.1:4327';
  const route = '/api/projects/project/codex-setup';
  let root: string;
  let project: string;
  let sources: string;
  let store: Store;
  let app: ReturnType<typeof createLocalWebServer>;
  let csrf: string;
  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-setup-http-')));
    project = join(root, 'project');
    sources = join(root, 'synthetic-sources');
    mkdirSync(project);
    mkdirSync(sources, { mode: 0o700 });
    store = new Store(':memory:');
    new Lifecycle(store).registerProject('project', project);
    const domain = createLocalWebDomain({ store, metadataFile: join(root, 'metadata.sqlite') });
    app = createLocalWebServer({ origin, domain, metadataFile: join(root, 'transport.sqlite') });
    csrf = (await app.inject({ url: '/api/bootstrap', headers: { host: '127.0.0.1:4327' } })).json<{ csrf: string }>().csrf;
  });
  afterEach(async () => {
    await app.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const post = (payload: unknown) => app.inject({
    method: 'POST', url: route, payload: JSON.stringify(payload),
    headers: { host: '127.0.0.1:4327', origin, 'content-type': 'application/json', 'x-harness-csrf': csrf, 'idempotency-key': randomUUID() },
  });
  const inspect = () => app.inject({ url: route, headers: { host: '127.0.0.1:4327' } });
  const configure = () => post({ operation: 'configure', product_version: '0.162.1', source_roots: [sources] });
  async function install() {
    const preview = await post({ operation: 'preview-install' });
    expect(preview.statusCode, preview.body).toBe(200);
    const snapshot = preview.json<Setup>();
    return post({
      operation: 'install', expected_package_hash: snapshot.installation.packageHash,
      expected_installed_hash: snapshot.installation.installedHash,
    });
  }

  it('inspects and previews without creating project files or measurement records', async () => {
    const before = readdirSync(project);
    const inspected = await inspect();
    const preview = await post({ operation: 'preview-install' });
    expect(inspected.statusCode).toBe(200);
    expect(preview.statusCode, preview.body).toBe(200);
    expect(inspected.json()).toMatchObject({
      configured: false, product: 'codex', product_version: '0.162.1',
      admission: {
        profile_id: codexBindingAdmission.profileId, qualified: true,
        max_family_members: codexBindingAdmission.maxFamilyMembers,
      },
      readiness: { provider: 'blocked', reason: 'codex_connect_not_configured' },
      connection: { roots: 0, observing: 0 },
    });
    expect(readdirSync(project)).toEqual(before);
    expect(store.all('SELECT * FROM sessions')).toEqual([]);
    expect(store.eventCount()).toBe(0);
  });

  it('saves project settings independently from files, trust and session connection', async () => {
    const saved = await configure();
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({
      configured: true, product_version: '0.162.1', source_roots: [sources],
      installation: { state: 'absent', hookRegistration: 'unverified' },
      readiness: { receipt_directory: 'missing', provider: 'blocked', reason: 'receipt_directory_missing' },
      connection: { roots: 0, observing: 0 },
    });
    expect(existsSync(join(project, '.codex'))).toBe(false);
    expect(store.all('SELECT * FROM tasks')).toEqual([]);
  });

  it('keeps the historical version when configuring without an explicit version', async () => {
    const saved = await post({ operation: 'configure', source_roots: [sources] });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({
      configured: true, product_version: '0.162.1', source_roots: [sources],
      admission: { profile_id: codexBindingAdmission.profileId, qualified: true },
    });
    expect((await inspect()).json()).toMatchObject({
      configured: true, product_version: '0.162.1', source_roots: [sources],
    });
  });

  it.each(['0.162.1', '0.163.0'])('preserves saved version %s when later configuration omits it', async productVersion => {
    const initial = await post({ operation: 'configure', product_version: productVersion, source_roots: [sources] });
    expect(initial.statusCode, initial.body).toBe(200);
    const saved = await post({ operation: 'configure', source_roots: [project] });
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await inspect()).json()).toMatchObject({
      configured: true, product_version: productVersion, source_roots: [project],
    });
    expect(existsSync(join(project, '.codex'))).toBe(false);
  });

  it.each(['0.162.0', '0.162.2', '0.163.1', '0.163.0-beta.1', ''])(
    'refuses unknown setup version %s without changing saved settings', async productVersion => {
      await configure();
      const before = (await inspect()).json<Setup>();
      expect((await post({ operation: 'configure', product_version: productVersion, source_roots: [project] })).statusCode).toBe(400);
      expect((await inspect()).json<Setup>()).toEqual(before);
      expect(existsSync(join(project, '.codex'))).toBe(false);
    },
  );

  it('requires protected explicit installation with reviewed hashes', async () => {
    expect((await app.inject({ method: 'POST', url: route, payload: { operation: 'configure' } })).statusCode).toBe(403);
    await configure();
    const missingReview = await post({ operation: 'install' });
    expect(missingReview.json()).toEqual({ error: 'installation_preview_changed' });
    expect(existsSync(join(project, '.codex'))).toBe(false);
    expect((await post({ operation: 'configure', allowCandidateProfiles: true })).statusCode).toBe(400);
  });

  it.each([
    { productVersion: '0.162.1', profileId: 'codex-binding-01621-direct-family-v1', qualified: true },
    { productVersion: '0.163.0', profileId: 'codex-binding-01630-direct-family-v1', qualified: true },
  ])('installs $productVersion prepared files without granting native trust or creating receipts and sessions', async ({ productVersion, profileId, qualified }) => {
    const configured = await post({ operation: 'configure', product_version: productVersion, source_roots: [sources] });
    expect(configured.statusCode, configured.body).toBe(200);
    expect(configured.json()).toMatchObject({
      product_version: productVersion,
      admission: { profile_id: profileId, qualified, max_family_members: 3 },
    });
    const installed = await install();
    expect(installed.statusCode, installed.body).toBe(200);
    expect(installed.json()).toMatchObject({
      configured: true, installation: { state: 'installed', hookRegistration: 'unverified' },
      product_version: productVersion,
      admission: { profile_id: profileId, qualified, max_family_members: 3 },
      readiness: { receipt_directory: 'ready', provider: 'ready', reason: null, hook_trust: 'manual_confirmation_required', requires_new_session: true },
      connection: { roots: 0, observing: 0 },
    });
    expect(readdirSync(join(project, '.harness-delta/codex-connect/receipts'))).toEqual([]);
    const { hooks } = z.object({ hooks: z.object({
      SessionStart: z.array(z.unknown()), SubagentStart: z.array(z.unknown()),
    }) }).parse(JSON.parse(readFileSync(join(project, '.codex/hooks.json'), 'utf8')) as unknown);
    expect(hooks.SessionStart).toHaveLength(1);
    expect(hooks.SubagentStart).toHaveLength(1);
    const entries = z.array(z.object({ hooks: z.array(z.object({ command: z.string() })) }))
      .parse([...hooks.SessionStart, ...hooks.SubagentStart]);
    for (const entry of entries) expect(entry.hooks[0]?.command).toContain(`'--product-version' '${productVersion}'`);
    expect(existsSync(join(project, '.codex/config.toml'))).toBe(false);
    expect(store.all('SELECT * FROM sessions')).toEqual([]);
    expect(store.all('SELECT * FROM active_intervals')).toEqual([]);
    expect(store.eventCount()).toBe(0);
  });

  it.each([
    ['0.162.1', '0.163.0'],
    ['0.163.0', '0.162.1'],
  ])('refuses a %s installation preview after selecting %s', async (beforeVersion, afterVersion) => {
    expect((await post({ operation: 'configure', product_version: beforeVersion, source_roots: [sources] })).statusCode).toBe(200);
    const preview = await post({ operation: 'preview-install' });
    expect(preview.statusCode, preview.body).toBe(200);
    const snapshot = preview.json<Setup>();
    expect((await post({ operation: 'configure', product_version: afterVersion })).statusCode).toBe(200);
    const result = await post({
      operation: 'install', expected_package_hash: snapshot.installation.packageHash,
      expected_installed_hash: snapshot.installation.installedHash,
    });
    expect(result.statusCode).toBe(400);
    expect(result.json()).toEqual({ error: 'installation_preview_changed' });
    expect(existsSync(join(project, '.codex'))).toBe(false);
    expect((await inspect()).json()).toMatchObject({ product_version: afterVersion });
  });

  it('reports unsafe receipt permissions instead of treating configured files as ready', async () => {
    await configure();
    expect((await install()).statusCode).toBe(200);
    chmodSync(join(project, '.harness-delta/codex-connect/receipts'), 0o755);
    const inspected = await inspect();
    expect(inspected.json()).toMatchObject({
      configured: true, readiness: { receipt_directory: 'unsafe', provider: 'blocked', reason: 'receipt_directory_unsafe' },
    });
  });

  it('repairs a removed receipt directory through the same preview and install flow', async () => {
    await configure();
    expect((await install()).statusCode).toBe(200);
    rmSync(join(project, '.harness-delta/codex-connect/receipts'), { recursive: true });
    expect((await inspect()).json()).toMatchObject({
      readiness: { provider: 'blocked', reason: 'receipt_directory_missing' },
    });
    const repaired = await install();
    expect(repaired.statusCode, repaired.body).toBe(200);
    expect(repaired.json()).toMatchObject({
      installation: { state: 'installed' }, readiness: { provider: 'ready', receipt_directory: 'ready' },
      connection: { roots: 0, observing: 0 },
    });
    expect(store.eventCount()).toBe(0);
  });

  it('does not accept a receipt directory reached through a symlinked ancestor', async () => {
    await configure();
    const external = join(root, 'external');
    mkdirSync(join(external, 'codex-connect/receipts'), { recursive: true, mode: 0o700 });
    symlinkSync(external, join(project, '.harness-delta'));
    expect((await inspect()).json()).toMatchObject({
      readiness: { receipt_directory: 'unsafe', provider: 'blocked' },
    });
  });

  it('removes reviewed installation without changing project settings or native receipt data', async () => {
    await configure();
    expect((await install()).statusCode).toBe(200);
    const preview = (await post({ operation: 'preview-remove' })).json<Setup>();
    const removed = await post({
      operation: 'remove', expected_package_hash: preview.installation.packageHash,
      expected_installed_hash: preview.installation.installedHash,
    });
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json()).toMatchObject({ configured: true, installation: { state: 'absent' }, connection: { roots: 0, observing: 0 } });
    expect(existsSync(join(project, '.harness-delta/codex-connect/receipts'))).toBe(true);
    expect(existsSync(join(project, '.agents/skills/harness-connect'))).toBe(false);
    expect(store.eventCount()).toBe(0);
  });

  it('clears private connection settings after project deletion without reinstalling anything', async () => {
    await configure();
    new Deletion(store).deleteProject('project');
    const refreshed = await app.inject({ url: '/api/bootstrap', headers: { host: '127.0.0.1:4327' } });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json()).toMatchObject({ data: { projects: [] } });
    const metadata = new Database(join(root, 'metadata.sqlite'), { readonly: true });
    try {
      expect(metadata.prepare('SELECT project_id FROM web_codex_connections').all()).toEqual([]);
    } finally { metadata.close(); }
    expect(existsSync(join(project, '.codex'))).toBe(false);
  });
});

it('exposes a missing configured receipt directory instead of a generic provider error', async () => {
  const fixture = localWebFixture();
  fixture.profile.session_binding = {
    product: 'codex', receipt_directory: join(fixture.root, 'missing-receipts'),
    source_roots: [join(fixture.home, 'sessions')], project_root: fixture.project,
  };
  const domain = fixture.create();
  try {
    const created = await domain.createTask({ name: 'Synthetic missing receipt', project_id: 'project-1', setup_id: fixture.profile.id });
    const { id } = z.object({ id: z.string() }).parse(created);
    expect(domain.task(id).actions).toContainEqual({
      code: 'session-connect', enabled: false, reason: 'receipt_directory_missing',
    });
    expect(fixture.store.eventCount()).toBe(0);
  } finally {
    await domain.close?.();
    fixture.cleanup();
  }
});

it('uses reviewed project connection settings for existing Codex tasks without changing their frozen assignment', async () => {
  const fixture = localWebFixture(codexBindingAdmission.profileId, { product: 'codex', productVersion: '0.162.1' });
  const oldReceipts = join(fixture.root, 'old-missing-receipts');
  fixture.profile.session_binding = {
    product: 'codex', receipt_directory: oldReceipts,
    source_roots: [join(fixture.home, 'sessions')], project_root: fixture.project,
  };
  const domain = fixture.create();
  try {
    const created = z.object({ id: z.string() }).parse(await domain.createTask({
      name: 'Synthetic project preparation', project_id: 'project-1', setup_id: fixture.profile.id,
    }));
    await domain.taskAction(created.id, 'apply', {});
    const assignment = fixture.store.get('SELECT * FROM comparison_assignments WHERE task_id=?', [created.id]);
    const protocol = fixture.store.all('SELECT * FROM comparison_protocols');
    expect(domain.task(created.id).actions).toContainEqual({
      code: 'session-connect', enabled: false, reason: 'receipt_directory_missing',
    });
    if (!domain.codexProjectAction) throw new Error('missing_codex_setup');
    await domain.codexProjectAction('project-1', {
      operation: 'configure', product_version: '0.162.1', source_roots: [join(fixture.home, 'sessions')],
    });
    const preview = z.object({ installation: z.object({
      packageHash: z.string().nullable(), installedHash: z.string().nullable(),
    }) }).parse(await domain.codexProjectAction('project-1', { operation: 'preview-install' }));
    await domain.codexProjectAction('project-1', {
      operation: 'install', expected_package_hash: preview.installation.packageHash,
      expected_installed_hash: preview.installation.installedHash,
    });
    expect(domain.task(created.id)).toMatchObject({ binding: { state: 'unconnected' } });
    expect(domain.task(created.id).actions).toContainEqual({
      code: 'session-connect', enabled: true, reason: null,
    });
    expect(domain.task(created.id).actions).not.toContainEqual({
      code: 'session-connect', enabled: false, reason: 'receipt_directory_missing',
    });
    expect(existsSync(oldReceipts)).toBe(false);
    expect(fixture.store.get('SELECT * FROM comparison_assignments WHERE task_id=?', [created.id])).toEqual(assignment);
    expect(fixture.store.all('SELECT * FROM comparison_protocols')).toEqual(protocol);
    expect(fixture.store.all('SELECT * FROM sessions')).toEqual([]);
    expect(fixture.store.eventCount()).toBe(0);
  } finally {
    await domain.close?.();
    fixture.cleanup();
  }
});

it('retains a different frozen-version profile and its noncanonical receipt path after project setup', async () => {
  const fixture = localWebFixture('codex-workflow-own-response-v1', { product: 'codex', productVersion: '0.160.0' });
  const receipts = join(fixture.root, 'legacy-receipts');
  const alias = join(fixture.root, 'legacy-alias');
  mkdirSync(receipts, { mode: 0o700 });
  symlinkSync(receipts, alias);
  fixture.profile.session_binding = {
    product: 'codex', receipt_directory: alias,
    source_roots: [join(fixture.home, 'sessions')], project_root: fixture.project,
  };
  const domain = fixture.create();
  try {
    const created = z.object({ id: z.string() }).parse(await domain.createTask({
      name: 'Synthetic legacy profile', project_id: 'project-1', setup_id: fixture.profile.id,
    }));
    const before = domain.task(created.id).actions;
    if (!domain.codexProjectAction) throw new Error('missing_codex_setup');
    await domain.codexProjectAction('project-1', {
      operation: 'configure', product_version: '0.162.1', source_roots: [join(fixture.home, 'sessions')],
    });
    expect(domain.task(created.id).actions).toEqual(before);
    expect(existsSync(join(fixture.project, '.harness-delta/codex-connect/receipts'))).toBe(false);
  } finally {
    await domain.close?.();
    fixture.cleanup();
  }
});
