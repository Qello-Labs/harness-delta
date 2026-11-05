import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Store } from '../store.js';
import { LocalWebProfileSchema, type LocalWebProfile } from './local-web-profile.js';
import { registerWebMetadata, withLiveWebMetadataScope } from './local-web-metadata.js';

export interface PrivateTask {
  readonly id: string;
  readonly name: string;
  readonly profile_id: string;
  readonly setup: string;
  readonly startup: string | null;
  readonly source: string | null;
  readonly reason: string | null;
}
export interface Source {
  readonly handle: string;
  readonly label: string;
  readonly path: string;
  readonly session_id: string;
}
interface TaskRegistration {
  readonly id: string;
  readonly name: string;
  readonly profileId: string;
  readonly setup: unknown;
  readonly projectId: string;
  readonly reason?: string;
}

export function createLocalWebMetadata(
  store: Store,
  filename: string
): {
  readonly database: Database.Database;
  initialize(): void;
  saveProfiles(this: void, inputs: LocalWebProfile[]): { addedCount: number; existingCount: number };
  profiles(this: void): LocalWebProfile[];
  task(this: void, id: string): PrivateTask | undefined;
  tasks(): PrivateTask[];
  taskIds(): { id: string }[];
  insertTask(record: TaskRegistration): void;
  setReason(this: void, id: string, reason: string | null): void;
  setStartup(id: string, startup: { ticket_id: string; start_command: string }): void;
  connectSource(id: string, source: Source): void;
  saveSource(taskId: string, source: Source): void;
  source(handle: unknown, taskId: string): { payload: string } | undefined;
  close(): void;
} {
  mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const db: Database.Database = new Database(filename);
  db.pragma('busy_timeout = 5000');
  return {
    database: db,
    initialize() {
      db.exec(`CREATE TABLE IF NOT EXISTS web_profiles(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS web_tasks(id TEXT PRIMARY KEY,name TEXT NOT NULL,profile_id TEXT NOT NULL,setup TEXT NOT NULL,startup TEXT,source TEXT,reason TEXT);
    CREATE TABLE IF NOT EXISTS web_sources(handle TEXT PRIMARY KEY,task_id TEXT NOT NULL,payload TEXT NOT NULL)`);
      registerWebMetadata(store, db);
    },
    saveProfiles(this: void, inputs: LocalWebProfile[]) {
      return store.immediateTransaction(() =>
        db.transaction(() => {
          let addedCount = 0;
          let existingCount = 0;
          for (const input of inputs) {
            const profile = LocalWebProfileSchema.parse(input);
            withLiveWebMetadataScope(store, { projectId: profile.setup.workflow.assignment.project_id }, () => {
              // Replacing an existing definition would silently change a user's setup.
              const old = db.prepare('SELECT payload FROM web_profiles WHERE id=?').get(profile.id) as { payload: string } | undefined;
              if (old && old.payload !== JSON.stringify(profile)) throw new Error('ui_setup_conflict');
              const saved = db.prepare('INSERT OR IGNORE INTO web_profiles(id,payload) VALUES (?,?)').run(profile.id, JSON.stringify(profile));
              addedCount += saved.changes;
              if (saved.changes === 0) existingCount++;
            });
          }
          return { addedCount, existingCount };
        })()
      );
    },
    profiles(this: void) {
      return (db.prepare('SELECT payload FROM web_profiles ORDER BY rowid').all() as { payload: string }[]).map(p =>
        LocalWebProfileSchema.parse(JSON.parse(p.payload) as unknown)
      );
    },
    task(this: void, id: string) {
      return db.prepare('SELECT * FROM web_tasks WHERE id=?').get(id) as PrivateTask | undefined;
    },
    tasks() {
      return db.prepare('SELECT * FROM web_tasks').all() as PrivateTask[];
    },
    taskIds() {
      return db.prepare('SELECT id FROM web_tasks ORDER BY rowid DESC').all() as { id: string }[];
    },
    insertTask(record: TaskRegistration) {
      if (record.reason !== undefined) {
        db.prepare('INSERT INTO web_tasks(id,name,profile_id,setup,reason,project_id) VALUES (?,?,?,?,?,?)').run(
          record.id,
          record.name,
          record.profileId,
          JSON.stringify(record.setup),
          record.reason,
          record.projectId
        );
      } else {
        db.prepare('INSERT INTO web_tasks(id,name,profile_id,setup,project_id) VALUES (?,?,?,?,?)').run(
          record.id,
          record.name,
          record.profileId,
          JSON.stringify(record.setup),
          record.projectId
        );
      }
    },
    setReason(this: void, id: string, reason: string | null) {
      if (reason === null) db.prepare('UPDATE web_tasks SET reason=NULL WHERE id=?').run(id);
      else db.prepare('UPDATE web_tasks SET reason=? WHERE id=?').run(reason, id);
    },
    setStartup(id: string, startup: { ticket_id: string; start_command: string }) {
      db.prepare('UPDATE web_tasks SET startup=?,reason=NULL WHERE id=?').run(JSON.stringify(startup), id);
    },
    connectSource(id: string, source: Source) {
      db.prepare('UPDATE web_tasks SET source=?,startup=NULL,reason=NULL WHERE id=?').run(JSON.stringify(source), id);
    },
    saveSource(taskId: string, source: Source) {
      db.prepare('INSERT INTO web_sources(handle,task_id,payload) VALUES (?,?,?)').run(source.handle, taskId, JSON.stringify(source));
    },
    source(handle: unknown, taskId: string) {
      return db.prepare('SELECT payload FROM web_sources WHERE handle=? AND task_id=?').get(handle, taskId) as { payload: string } | undefined;
    },
    close() {
      db.close();
    }
  };
}
