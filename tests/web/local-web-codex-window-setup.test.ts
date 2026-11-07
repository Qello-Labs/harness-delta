import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, test } from 'vitest';
import { ordinaryWindowSelection } from '../../src/core/ordinary-window-store.js';
import { createCodexProjectSetupManager } from '../../src/web/local-web-codex.js';
import { localWebCodexWindowFixture } from '../helpers/local-web-codex-window-fixture.js';

const fixtures: Awaited<ReturnType<typeof localWebCodexWindowFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
async function fixture() {
  const f = await localWebCodexWindowFixture();
  fixtures.push(f);
  return f;
}

test('keeps tagged window preferences out of legacy assigned configuration and freezes preparation without source reads', async () => {
  const f = await fixture();
  const db = new Database(join(f.directory, 'metadata.sqlite'));
  try {
    const projects = createCodexProjectSetupManager(f.store, db);
    expect(projects.configuration('project')).toBeUndefined();
    expect(projects.windowConfiguration('project')).toMatchObject({
      schema_version: 2,
      mode: 'ordinary_window',
      product: 'codex',
      product_version: '0.167.0',
      receipt_directory: join(f.projectRoot, '.harness-delta/window-receipts'),
      source_roots: [f.sourceRoot]
    });
    const frozen = db.prepare('SELECT setup FROM web_tasks WHERE id=?').get(f.taskId);
    projects.action('project', {
      operation: 'configure',
      source_roots: [join(f.directory, 'does-not-exist')]
    });
    expect(projects.windowConfiguration('project')?.source_roots).toEqual([join(f.directory, 'does-not-exist')]);
    expect(db.prepare('SELECT setup FROM web_tasks WHERE id=?').get(f.taskId)).toEqual(frozen);
    expect(f.control.task(f.taskId)).toMatchObject({
      connection_enabled: false
    });
    expect(existsSync(f.receiptDirectory)).toBe(false);
    expect(f.store.all('SELECT * FROM ordinary_window_activations')).toEqual([]);
    expect(f.store.all('SELECT * FROM sessions')).toEqual([]);
  } finally {
    db.close();
  }
});

test.each(['0.163.0', '0.170.0', '0.167.0-beta.1', 'v0.167.0', '0.167', '00.167.0'])(
  'rejects window declaration %s without replacing saved preferences',
  async productVersion => {
    const f = await fixture();
    const db = new Database(join(f.directory, 'metadata.sqlite'));
    try {
      const projects = createCodexProjectSetupManager(f.store, db);
      const before = projects.windowConfiguration('project');
      expect(() =>
        projects.action('project', {
          operation: 'configure',
          product_version: productVersion
        })
      ).toThrow();
      expect(projects.windowConfiguration('project')).toEqual(before);
    } finally {
      db.close();
    }
  }
);

test.each(['/', '/synthetic/../native', '/synthetic//native'])(
  'rejects unbounded or noncanonical window root %s without replacing preferences',
  async sourceRoot => {
    const f = await fixture();
    const db = new Database(join(f.directory, 'metadata.sqlite'));
    try {
      const projects = createCodexProjectSetupManager(f.store, db);
      const before = projects.windowConfiguration('project');
      expect(() => projects.action('project', { operation: 'configure', source_roots: [sourceRoot] })).toThrow();
      expect(projects.windowConfiguration('project')).toEqual(before);
    } finally {
      db.close();
    }
  }
);

test('explicit exact selection writes original untagged settings and is never auto migrated', async () => {
  const f = await fixture();
  const db = new Database(join(f.directory, 'metadata.sqlite'));
  try {
    const projects = createCodexProjectSetupManager(f.store, db);
    const result = projects.action('project', {
      operation: 'configure',
      mode: 'exact',
      product_version: '0.163.0'
    });
    expect(result).not.toHaveProperty('mode');
    expect(result).not.toHaveProperty('schema_version');
    expect(db.prepare('SELECT settings FROM web_codex_connections WHERE project_id=?').get('project')).toEqual({
      settings: JSON.stringify({
        product_version: '0.163.0',
        source_roots: [f.sourceRoot]
      })
    });
    projects.action('project', { operation: 'configure' });
    expect(projects.windowConfiguration('project')).toBeUndefined();
    expect(projects.configuration('project')).toMatchObject({
      product_version: '0.163.0',
      receipt_directory: join(f.projectRoot, '.harness-delta/codex-connect/receipts')
    });
    expect(ordinaryWindowSelection(f.store, f.taskId)?.declaredVersion).toBe('0.167.0');
  } finally {
    db.close();
  }
});
