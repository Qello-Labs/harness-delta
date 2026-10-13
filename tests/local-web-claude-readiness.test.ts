import { cpSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { createLocalWebDomain, LocalWebProfileSchema } from '../src/local-web-domain.js';
import { localWebFixture } from './helpers/local-web-fixture.js';

test('Claude project installation inspection remains read-only and cannot authorize ordinary collection', async () => {
  const f = localWebFixture('claude-ordinary-human-pilot', { product: 'claude_code', productVersion: '2.1.296' });
  const receipts = join(f.root, 'receipts');
  const sources = join(f.root, 'claude-projects');
  mkdirSync(receipts, { mode: 0o700 });
  mkdirSync(sources, { mode: 0o700 });
  const profile = LocalWebProfileSchema.parse({ ...f.profile, session_binding: {
    product: 'claude_code', receipt_directory: receipts, claude_projects_directory: sources,
  } });
  const domain = createLocalWebDomain({ store: f.store, metadataFile: f.metadataFile, profiles: [profile] });
  try {
    const { id } = z.object({ id: z.string() }).parse(await domain.createTask({ name: 'Synthetic readiness task', project_id: 'project-1', setup_id: profile.id }));
    expect(domain.task(id)).not.toHaveProperty('connection_readiness');
    await domain.taskAction(id, 'apply', {});
    const before = f.store.eventCount();
    const actions = z.object({ actions: z.array(z.object({ code: z.string(), enabled: z.boolean(), reason: z.string().nullable() })) });
    expect(domain.task(id)).toMatchObject({ connection_readiness: {
      skill: { state: 'missing' }, configured_version: '2.1.296', installed_version: null, collection_revoked: false,
    } });
    expect(actions.parse(domain.task(id)).actions).toContainEqual({ code: 'session-connect', enabled: false, reason: 'binding_source_unqualified' });
    expect(f.store.eventCount()).toBe(before);
    expect(f.store.all('SELECT * FROM active_intervals')).toHaveLength(0);
    mkdirSync(join(f.project, '.claude', 'skills'), { recursive: true });
    cpSync(resolve('skills/harness-connect'), join(f.project, '.claude', 'skills', 'harness-connect'), { recursive: true });
    expect(domain.task(id)).toMatchObject({ connection_readiness: { skill: { state: 'installed', install_command: null } } });
    expect(actions.parse(domain.task(id)).actions).toContainEqual({ code: 'session-connect', enabled: false, reason: 'binding_source_unqualified' });
    expect(f.store.eventCount()).toBe(before);
    expect(f.store.all('SELECT * FROM active_intervals')).toHaveLength(0);
    await expect(domain.taskAction(id, 'session-connect', { product: 'claude_code', receipt: '00000000-0000-4000-8000-000000000001' })).rejects.toThrow();
    expect(domain.task(id).reason).toBe('binding_source_unqualified');
    expect(f.store.eventCount()).toBe(before);
  } finally { await domain.close?.(); f.cleanup(); }
});

test('synthetic validation does not inspect or expose a native installation command', async () => {
  const f = localWebFixture();
  const domain = f.create();
  try {
    const { id } = z.object({ id: z.string() }).parse(await domain.createTask({ name: 'Synthetic fixture', project_id: 'project-1', setup_id: f.profile.id }));
    await domain.taskAction(id, 'apply', {});
    expect(domain.task(id)).not.toHaveProperty('connection_readiness');
    expect(f.store.all('SELECT * FROM active_intervals')).toHaveLength(0);
  } finally { await domain.close?.(); f.cleanup(); }
});
