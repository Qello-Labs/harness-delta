import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { localWebFixture } from './helpers/local-web-fixture.js';
import { createLocalWebServer } from '../src/local-web-server.js';
import type { LocalWebProfile } from '../src/local-web-domain.js';

async function fixture() {
  const f = localWebFixture();
  const domain = f.create();
  const origin = 'http://127.0.0.1:4318';
  const app = createLocalWebServer({ origin, domain, metadataFile: f.metadataFile });
  const csrf = (await app.inject({ url: '/api/bootstrap', headers: { host: '127.0.0.1:4318' } })).json<{ csrf: string }>().csrf;
  const post = (key = randomUUID()) =>
    app.inject({
      method: 'POST',
      url: '/api/setup-picker',
      payload: {},
      headers: { host: '127.0.0.1:4318', origin, 'x-harness-csrf': csrf, 'idempotency-key': key }
    });
  const pick = (profiles: LocalWebProfile[]) => {
    const file = join(f.root, 'synthetic-settings.json');
    writeFileSync(file, JSON.stringify({ schema_version: 1, profiles }));
    f.pick(file);
  };
  const saved = () => {
    const db = new Database(f.metadataFile, { readonly: true });
    try {
      return db.prepare('SELECT id,payload FROM web_profiles ORDER BY id').all();
    } finally {
      db.close();
    }
  };
  const cleanup = async () => {
    await app.close();
    f.cleanup();
  };
  return { ...f, domain, app, post, pick, cancel: () => f.pick(null), saved, cleanup };
}

test('new selection and identical repeat report actual saves without copying profiles, cards or tasks', async () => {
  const f = await fixture();
  try {
    await f.domain.createTask({ name: 'Synthetic retained task', project_id: 'project-1', setup_id: f.profile.id });
    const tasks = f.store.all('SELECT * FROM tasks');
    const baseline = (await f.domain.bootstrap()) as { tasks: unknown[] };
    f.pick([{ ...f.profile, id: 'synthetic-b', name: 'Synthetic settings B' }]);
    const key = randomUUID();
    const first = await f.post(key);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ imported: true, added_count: 1, existing_count: 0 });
    const saved = f.saved();
    const snapshot = await f.domain.bootstrap();
    expect(snapshot).toMatchObject({ setups: [{ id: f.profile.id }, { id: 'synthetic-b' }], tasks: baseline.tasks });
    expect((await f.post(key)).json()).toEqual(first.json());
    const repeat = await f.post();
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json()).toEqual({ imported: true, added_count: 0, existing_count: 1 });
    expect(f.saved()).toEqual(saved);
    expect(await f.domain.bootstrap()).toEqual(snapshot);
    expect(f.store.all('SELECT * FROM tasks')).toEqual(tasks);
    // A restart must retain the same idempotent save result.
    await f.app.close();
    const next = f.create();
    try {
      expect(await next.importSetup!()).toEqual({ imported: true, added_count: 0, existing_count: 1 });
    } finally {
      await next.close?.();
    }
  } finally {
    await f.cleanup();
  }
});

test.each([false, true])('mixed manifest reports a new connection regardless of existing entry order (%s)', async existingFirst => {
  const f = await fixture();
  try {
    const fresh = { ...f.profile, id: 'synthetic-b', name: 'Synthetic settings B' };
    f.pick(existingFirst ? [f.profile, fresh] : [fresh, f.profile]);
    expect((await f.post()).json()).toEqual({ imported: true, added_count: 1, existing_count: 1 });
    expect(f.saved()).toHaveLength(2);
    expect((await f.post()).json()).toEqual({ imported: true, added_count: 0, existing_count: 2 });
    expect(await f.domain.bootstrap()).toMatchObject({ tasks: [], setups: [{ id: f.profile.id }, { id: 'synthetic-b' }] });
  } finally {
    await f.cleanup();
  }
});

test.each([false, true])('same-ID conflict rejects the whole manifest without overwriting or partial inserts (%s)', async conflictFirst => {
  const f = await fixture();
  try {
    const saved = f.saved();
    const snapshot = await f.domain.bootstrap();
    const fresh = { ...f.profile, id: 'synthetic-b' };
    const conflict = { ...f.profile, name: 'Conflicting synthetic settings' };
    f.pick(conflictFirst ? [conflict, fresh] : [fresh, conflict]);
    const result = await f.post();
    expect(result.statusCode).toBe(400);
    expect(result.json()).toEqual({ error: 'ui_setup_conflict' });
    expect(f.saved()).toEqual(saved);
    expect(await f.domain.bootstrap()).toEqual(snapshot);
  } finally {
    await f.cleanup();
  }
});

test('cancelled selection leaves settings and tasks unchanged', async () => {
  const f = await fixture();
  try {
    const saved = f.saved();
    const snapshot = await f.domain.bootstrap();
    f.cancel();
    // The picker itself returns null; no file is read or imported.
    const result = await f.post();
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ cancelled: true });
    expect(f.saved()).toEqual(saved);
    expect(await f.domain.bootstrap()).toEqual(snapshot);
  } finally {
    await f.cleanup();
  }
});

test('counts actual inserts for repeated IDs within one manifest and accepts an empty no-op', async () => {
  const f = await fixture();
  try {
    const fresh = { ...f.profile, id: 'synthetic-b' };
    f.pick([fresh, fresh]);
    expect((await f.post()).json()).toEqual({ imported: true, added_count: 1, existing_count: 1 });
    expect(f.saved()).toHaveLength(2);
    f.pick([]);
    expect((await f.post()).json()).toEqual({ imported: true, added_count: 0, existing_count: 0 });
    expect(f.saved()).toHaveLength(2);
  } finally {
    await f.cleanup();
  }
});
