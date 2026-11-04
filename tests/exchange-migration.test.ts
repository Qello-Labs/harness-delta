import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';
function seed(path: string, version: number) {
  const db = new Database(path);
  const directory = new URL('../src/migrations/', import.meta.url);
  for (const file of readdirSync(directory)
    .filter(file => file.endsWith('.sql'))
    .sort()
    .slice(0, version))
    db.exec(readFileSync(new URL(file, directory), 'utf8'));
  db.pragma(`user_version = ${version}`);
  db.prepare('INSERT INTO projects(id) VALUES (?)').run('preserved');
  return db;
}
describe('exchange additive migrations', () => {
  for (const version of [7, 8, 9])
    it(`preserves source rows from version ${version}`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'exchange-migration-'));
      const path = join(dir, 'store.db');
      try {
        seed(path, version).close();
        const store = new Store(path);
        expect(store.get('SELECT id FROM projects')).toEqual({ id: 'preserved' });
        expect(store.all('SELECT * FROM exchange_tasks')).toEqual([]);
        expect(store.all('SELECT * FROM exchange_team_snapshots')).toEqual([]);
        store.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  it('rolls back the entire migration on a schema conflict', () => {
    const dir = mkdtempSync(join(tmpdir(), 'exchange-migration-'));
    const path = join(dir, 'store.db');
    try {
      const old = seed(path, 8);
      old.exec('CREATE TABLE exchange_writers(id TEXT)');
      old.close();
      expect(() => new Store(path)).toThrow();
      const db = new Database(path);
      expect(db.pragma('user_version', { simple: true })).toBe(8);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='exchange_mappings'").get()).toBeUndefined();
      expect(db.prepare('SELECT id FROM projects').get()).toEqual({ id: 'preserved' });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

it('rolls back migration ten without touching imported version-nine rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'team-migration-'));
  const path = join(dir, 'store.db');
  try {
    const old = seed(path, 9);
    old.exec('CREATE TABLE exchange_team_dependencies(id TEXT)');
    old.close();
    expect(() => new Store(path)).toThrow();
    const db = new Database(path);
    expect(db.pragma('user_version', { simple: true })).toBe(9);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='exchange_team_snapshots'").get()).toBeUndefined();
    expect(db.prepare('SELECT id FROM projects').get()).toEqual({ id: 'preserved' });
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
