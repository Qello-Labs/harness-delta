import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { main } from '../src/cli.js';
import { Lifecycle } from '../src/lifecycle.js';
import { Store } from '../src/store.js';

test.each([['codex', '0.161.0'], ['codex', '0.162.1'], ['codex', '0.163.0'], ['claude_code', '2.1.292'], ['claude_code', '2.1.293'], ['claude_code', '2.1.296'], ['claude_code', '2.1.301']])('CLI links recent regular %s, displays trust and persists invalidation across commands', async (product, version) => {
  const root = mkdtempSync(join(tmpdir(), 'compatibility-cli-')); const db = join(root, 'db.sqlite');
  const store = new Store(db);
  const life = new Lifecycle(store); life.registerProject('p', root);
  life.createTask('p', 't', { type: 'feature', expected_size: 'small', assignee: 'u', product, model: 'synthetic', criterion_ids: ['c'] }); store.close();
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    expect(await main(['--db', db, 'session', 'link', 's', '--task', 't', '--source', join(root, 'absent'), '--product', product, '--version', version])).toBe(0);
    expect(String(stdout.mock.calls.at(-1)?.[0])).toContain('compatibility_unverified');
    expect(await main(['--db', db, 'compatibility', 'invalidate', '--product', product, '--version', version, '--source', 'file'])).toBe(0);
    expect(String(stdout.mock.calls.at(-1)?.[0])).toContain('invalidated');
    expect(await main(['--db', db, 'compatibility', 'inspect', '--product', product, '--version', version, '--source', 'file'])).toBe(0);
    expect(String(stdout.mock.calls.at(-1)?.[0])).toContain('invalidated');
    expect(await main(['--db', db, 'session', 'link', 'new', '--task', 't', '--source', join(root, 'absent'), '--product', product, '--version', version])).toBe(2);
    expect(String(stderr.mock.calls.at(-1)?.[0])).toContain('compatibility_invalidated');
    expect(await main(['--db', db, 'compatibility', 'status'])).toBe(0);
    expect(String(stdout.mock.calls.at(-1)?.[0])).not.toContain(root);
  } finally { stdout.mockRestore(); stderr.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

test('a retired workflow version stays blockable through its stored cohort while an unobserved one stays unsupported', async () => {
  const root = mkdtempSync(join(tmpdir(), 'compatibility-cli-')); const db = join(root, 'db.sqlite');
  const store = new Store(db); const life = new Lifecycle(store); life.registerProject('p', root);
  life.createTask('p', 't', { type: 'feature', expected_size: 'small', assignee: 'u', product: 'claude_code', model: 'synthetic', criterion_ids: ['c'] });
  // A cohort observed while 2.1.293 was inside the 2.1.291 window; that window no longer exists.
  store.execute("INSERT INTO sessions(id,project_id,task_id,product,product_version) VALUES ('s','p','t','claude_code','2.1.293')", []);
  store.execute('INSERT INTO session_source_compatibility(session_id,payload) VALUES (?,?)', ['s', JSON.stringify({ state: 'compatibility_unverified', product: 'claude_code',
    product_version: '2.1.293', source: 'claude_workflow', parser_version: '2.1.291', parser_revision: 'claude-workflow-own-trace-v1', profile_id: 'claude-workflow-own-trace-v1', rule_revision: 'forward-version-v1' })]);
  store.close();
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const command = (operation: string, version: string) => main(['--db', db, 'compatibility', operation, '--product', 'claude_code', '--version', version, '--source', 'claude_workflow']);
  try {
    expect(await command('inspect', '2.1.293')).toBe(2);
    expect(String(stderr.mock.calls.at(-1)?.[0])).toContain('unsupported');
    expect(await command('invalidate', '2.1.293')).toBe(0);
    expect(String(stdout.mock.calls.at(-1)?.[0])).toContain('invalidated');
    expect(await command('invalidate', '2.1.294')).toBe(2);
    const after = new Store(db);
    try { expect(after.all('SELECT product_version,source,reason FROM source_compatibility_blocks')).toEqual([{ product_version: '2.1.293', source: 'claude_workflow', reason: 'semantic_incompatibility' }]); }
    finally { after.close(); }
  } finally { stdout.mockRestore(); stderr.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});
