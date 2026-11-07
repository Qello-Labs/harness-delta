import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Deletion } from '../src/deletion.js';
import { Lifecycle } from '../src/core/lifecycle.js';
import { Store } from '../src/store.js';
import { createOrdinaryWindowTask } from '../src/ordinary-observation.js';
import { recordOrdinaryWindowSegment } from '../src/core/ordinary-window-store.js';
import { readOrdinaryWindowBatch } from '../src/ordinary-window-binding.js';
import { ordinaryWindowFixture } from './helpers/ordinary-window-fixture.js';

const at = '2026-10-13T09:00:00.000Z';
const products = ['codex', 'claude_code'] as const;
type Product = (typeof products)[number];
type SegmentState = 'acquiring' | 'observing' | 'paused' | 'stopping' | 'closed';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

function seedTask(db: Database.Database, id: string, product: Product, state: SegmentState, native = `native-${id}`) {
  const settings = `{"schema_version":1, "product":"${product}", "product_version":"${product === 'codex' ? '0.163.0' : '2.1.306'}"}`;
  const metadata = JSON.stringify({
    schema_version: 2,
    type: 'feature',
    expected_size: 'medium',
    assignee: 'local-user',
    product,
    initial_model: null,
    criterion_ids: ['accepted']
  });
  db.prepare("INSERT INTO tasks(id,project_id,metadata,state,generation,last_transition_at) VALUES (?,'project',?,'active',7,?)").run(id, metadata, at);
  db.prepare("INSERT INTO ordinary_tasks(task_id,settings,settings_hash,price_table_id,prepared_at) VALUES (?,?,?,'price',?)").run(
    id,
    settings,
    digest(settings),
    at
  );
  db.prepare("INSERT INTO sessions(id,project_id,task_id,product,product_version) VALUES (?,'project',?,?,?)").run(
    `root-${id}`,
    id,
    product,
    product === 'codex' ? '0.163.0' : '2.1.306'
  );
  db.prepare(
    `INSERT INTO binding_root_segments(
    root_session_id,task_id,product,native_root_id,project_root,state,revision,observer_identity,opened_at,baseline_at,closed_at
  ) VALUES (?,?,?,?,?,?,9,?,?,?,?)`
  ).run(`root-${id}`, id, product, native, '/synthetic/project', state, `observer-${id}`, at, at, state === 'closed' ? at : null);
  if (state !== 'closed') {
    db.prepare('UPDATE ordinary_tasks SET selected_root_id=? WHERE task_id=?').run(`root-${id}`, id);
  }
  db.prepare('INSERT INTO active_intervals(id,task_id,started_at) VALUES (?,?,?)').run(`interval-${id}`, id, at);
  const identity = JSON.stringify({
    product,
    sessionId: native,
    cwd: '/synthetic/project',
    nativeMapping: { nativeSessionId: native }
  });
  db.prepare(
    `INSERT INTO session_bindings(session_id,task_id,root_id,identity,cursor,observed_since,generation,state,connect_receipt)
    VALUES (?,?,?,?,?,?,7,'observing',?)`
  ).run(`root-${id}`, id, `root-${id}`, identity, '{"offset":42}', at, `receipt-${id}`);
}

function historicalRows(db: Database.Database) {
  const tables = db.prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  return tables.map(({ name }) => ({
    name,
    bytes: JSON.stringify(db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all())
  }));
}

function schema(db: Database.Database) {
  return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
}

let root: string;
let file: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ordinary-window-migration-'));
  file = join(root, 'local.db');
  const db = new Database(file);
  try {
    db.pragma('foreign_keys = ON');
    const migrations = new URL('../src/migrations/', import.meta.url);
    db.transaction(() => {
      for (const name of readdirSync(migrations)
        .filter(name => name.endsWith('.sql'))
        .sort()
        .slice(0, 35)) {
        db.exec(readFileSync(new URL(name, migrations), 'utf8'));
      }
      db.pragma('user_version = 35');
    })();
    db.prepare('INSERT INTO projects(id,local_root) VALUES (?,?)').run('project', '/synthetic/project');
    db.prepare('INSERT INTO price_tables(id,payload) VALUES (?,?)').run('price', '{"schema_version":1, "rates":[]}');
    db.prepare('INSERT INTO ordinary_project_settings VALUES (?,?,?,?)').run('project', '{"schema_version":1}', digest('project-settings'), at);
    for (const state of ['acquiring', 'observing', 'paused', 'stopping', 'closed'] as const) seedTask(db, state, 'claude_code', state);
    seedTask(db, 'historical', 'claude_code', 'closed', 'native-observing');
    db.prepare('INSERT INTO sessions(id,project_id,task_id,parent_id,product) VALUES (?,?,?,?,?)').run(
      'child',
      'project',
      'observing',
      'root-observing',
      'claude_code'
    );
    db.prepare(
      `INSERT INTO session_bindings(session_id,task_id,root_id,identity,observed_since,generation,state)
        VALUES ('child','observing','root-observing',?,?,7,'observing')`
    ).run('{"product":"claude_code","sessionId":"child","cwd":"/synthetic/project","nativeMapping":{"nativeSessionId":"native-observing"}}', at);
    db.prepare('INSERT INTO events(id,project_id,task_id,session_id,source_key,occurred_at,payload) VALUES (?,?,?,?,?,?,?)').run(
      'event',
      'project',
      'observing',
      'root-observing',
      'source-key',
      at,
      '{"kind":"usage", "synthetic":true}'
    );
    db.prepare('INSERT INTO event_receipts VALUES (?,?)').run('event', at);
    db.prepare('INSERT INTO binding_requests VALUES (?,?,?)').run('request', 'event', digest('request-fingerprint'));
    db.prepare('INSERT INTO binding_baseline_exclusions VALUES (?,?,?)').run('root-observing', 'source-identity', 'excluded-request');
    db.prepare('INSERT INTO session_source_compatibility VALUES (?,?)').run(
      'root-observing',
      '{"product":"claude_code", "product_version":"2.1.306", "state":"verified"}'
    );
    db.prepare('INSERT INTO source_compatibility_blocks VALUES (?,?,?,?)').run('codex', '0.165.0', 'codex_binding', 'contract_failed');
    db.prepare('INSERT INTO session_binding_forgets VALUES (?,?,?,?,?)').run('codex', 'forgotten', 'old-task', '/synthetic/project', 'deleted');
    db.prepare('INSERT INTO tombstones VALUES (?,?,?)').run('session', 'deleted-native', at);
    db.prepare("INSERT INTO comparison_protocols(id,project_id,settings) VALUES ('protocol','project',?)").run('{"frozen":true}');
    db.prepare(
      `INSERT INTO comparison_report_snapshots VALUES (
        'report','protocol',?,?,0,1,1,'v1','initial',NULL,?,?,?
      )`
    ).run(at, at, '{"pin":"old-input"}', '{"result":null}', digest('frozen-report'));
  } finally {
    db.close();
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

it('preserves every historical row and serialized pin without deletion or pause side effects', () => {
  const previous = new Database(file);
  const before = historicalRows(previous);
  const foreignKeys = previous.pragma('foreign_key_list(binding_root_segments)');
  const columns = previous.pragma('table_info(binding_root_segments)');
  previous.close();
  const store = new Store(file);
  try {
    expect(store.get<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(37);
    const migrated = new Database(file);
    try {
      const after = historicalRows(migrated);
      expect(after.filter(table => before.some(old => old.name === table.name))).toEqual(before);
      expect(migrated.pragma('foreign_key_list(binding_root_segments)')).toEqual(foreignKeys);
      expect(migrated.pragma('table_info(binding_root_segments)')).toEqual(columns);
      expect(migrated.pragma('foreign_key_check')).toEqual([]);
      expect(migrated.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      migrated.close();
    }
    expect(store.all('SELECT * FROM tombstones')).toEqual([
      {
        kind: 'session',
        id: 'deleted-native',
        deleted_at: at
      }
    ]);
    expect(store.all('SELECT * FROM session_binding_forgets')).toHaveLength(1);
  } finally {
    store.close();
  }
  const reopened = new Store(file);
  try {
    const db = new Database(file);
    try {
      expect(historicalRows(db).filter(table => before.some(old => old.name === table.name))).toEqual(before);
    } finally {
      db.close();
    }
  } finally {
    reopened.close();
  }
});

it('rolls back the complete rebuild and user_version when migration execution fails', () => {
  const previous = new Database(file);
  const before = historicalRows(previous);
  const beforeSchema = schema(previous);
  previous.close();
  vi.spyOn(Database.prototype, 'exec').mockImplementationOnce(function (this: Database.Database, sql: string) {
    this.exec(sql);
    throw new Error('injected_migration_failure');
  });
  expect(() => new Store(file)).toThrow('injected_migration_failure');
  vi.restoreAllMocks();
  const reopened = new Database(file);
  try {
    expect(reopened.pragma('user_version', { simple: true })).toBe(35);
    expect(schema(reopened)).toEqual(beforeSchema);
    expect(historicalRows(reopened)).toEqual(before);
    expect(reopened.pragma('foreign_key_check')).toEqual([]);
  } finally {
    reopened.close();
  }
  const recovered = new Store(file);
  recovered.close();
});

it.each(products)('denies drained v35 native deletions under a new %s window root after migration and reopen', async product => {
  const previous = new Database(file);
  try {
    previous.pragma('foreign_keys = ON');
    seedTask(previous, 'drained', 'claude_code', 'closed', 'native-root');
    previous.prepare("DELETE FROM tasks WHERE id='drained'").run();
    previous.prepare("DELETE FROM session_binding_forgets WHERE native_session_id='native-root'").run();
    expect(previous.prepare("SELECT id FROM tombstones WHERE kind='session' AND id='native-root'").get()).toEqual({ id: 'native-root' });
    expect(previous.prepare("SELECT * FROM session_binding_forgets WHERE native_session_id='native-root'").all()).toEqual([]);
  } finally {
    previous.close();
  }
  const migrated = new Store(file);
  migrated.close();
  const store = new Store(file);
  const f = ordinaryWindowFixture(product);
  try {
    f.activate();
    const life = new Lifecycle(store, f.clock);
    store.execute('INSERT INTO projects(id,local_root) VALUES (?,?)', ['replacement-project', f.identity.cwd]);
    const taskId = createOrdinaryWindowTask(
      store,
      {
        schema_version: 2,
        mode: 'ordinary_window',
        project_id: 'replacement-project',
        product,
        declared_version: f.selection.declaredVersion,
        policy_id: f.selection.policy.policyId,
        criterion_ids: ['accepted']
      },
      f.clock
    );
    const decision = f.store.get<Record<string, string>>('SELECT * FROM ordinary_window_activations');
    if (!decision) throw new Error('fixture_activation_missing');
    decision.project_id = 'replacement-project';
    const columns = Object.keys(decision);
    store.execute(`INSERT INTO ordinary_window_activations(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, Object.values(decision));
    life.start(taskId);
    store.execute('INSERT INTO sessions(id,project_id,task_id,product,product_version) VALUES (?,?,?,?,?)', [
      f.rootId,
      'replacement-project',
      taskId,
      product,
      f.selection.declaredVersion
    ]);
    store.execute(
      `INSERT INTO binding_root_segments(root_session_id,task_id,product,native_root_id,project_root,state,opened_at)
      VALUES (?,?,?,?,?,'acquiring',?)`,
      [f.rootId, taskId, product, f.identity.sessionId, f.identity.cwd, f.clock()]
    );
    store.execute('UPDATE ordinary_tasks SET selected_root_id=? WHERE task_id=?', [f.rootId, taskId]);
    const before = store.all('SELECT * FROM events');
    const factory = vi.fn(() => f.provider);
    const attempt = async () => {
      recordOrdinaryWindowSegment(
        store,
        {
          taskId,
          rootSessionId: f.rootId
        },
        f.proof
      );
      store.execute(
        `INSERT INTO session_bindings(session_id,task_id,root_id,identity,connect_receipt,observed_since,generation,state,cursor)
        VALUES (?,?,?,?,?,?,?,'observing','initial')`,
        [f.rootId, taskId, f.rootId, JSON.stringify(f.identity), f.proof.receipt, f.clock(), life.task(taskId).generation]
      );
      await readOrdinaryWindowBatch({
        store,
        taskId,
        rootSessionId: f.rootId,
        baseline: false,
        clock: f.clock,
        provider: factory
      });
    };
    const outcome = await attempt().then(
      () => 'accepted',
      (error: unknown) => {
        if (!(error instanceof Error)) throw error;
        return error.message;
      }
    );
    expect({
      outcome,
      factories: factory.mock.calls.length,
      native: f.calls
    }).toEqual({
      outcome: 'deleted_identifier',
      factories: 0,
      native: []
    });
    expect(store.all('SELECT * FROM ordinary_window_segments WHERE root_session_id=?', [f.rootId])).toEqual([]);
    expect(store.all('SELECT * FROM session_source_compatibility WHERE session_id=?', [f.rootId])).toEqual([]);
    expect(store.all('SELECT * FROM session_bindings WHERE session_id=?', [f.rootId])).toEqual([]);
    expect(store.all('SELECT * FROM events')).toEqual(before);
  } finally {
    f.store.close();
    store.close();
  }
});

it.each(products)('retains task and product-aware native reservations for %s', product => {
  const store = new Store(file);
  const db = new Database(file);
  try {
    db.pragma('foreign_keys = ON');
    seedTask(db, 'new', product, 'observing', 'shared-native');
    db.prepare("INSERT INTO sessions(id,project_id,task_id) VALUES ('extra','project','new')").run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO binding_root_segments(root_session_id,task_id,product,native_root_id,project_root,state,opened_at)
      VALUES ('extra','new','unknown_product','unknown-native','/synthetic/project','closed',?)`
        )
        .run(at)
    ).toThrow('CHECK constraint failed');
    const insert = db.prepare(
      `INSERT INTO binding_root_segments(root_session_id,task_id,product,native_root_id,project_root,state,opened_at)
        VALUES (?,?,?,?,?,'observing',?)`
    );
    expect(() => insert.run('extra', 'new', product, 'other-native', '/synthetic/project', at)).toThrow('UNIQUE constraint failed');
    seedTask(db, 'contender', product, 'closed', 'shared-native');
    expect(() => db.prepare("UPDATE binding_root_segments SET state='observing' WHERE task_id='contender'").run()).toThrow('UNIQUE constraint failed');
    seedTask(db, 'other-product', product === 'codex' ? 'claude_code' : 'codex', 'observing', 'shared-native');
    db.prepare("UPDATE binding_root_segments SET state='closed' WHERE task_id='new'").run();
    db.prepare("UPDATE binding_root_segments SET state='observing' WHERE task_id='contender'").run();
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally {
    db.close();
    store.close();
  }
});

it.each(['root_session_id', 'task_id', 'product', 'native_root_id', 'project_root', 'opened_at'])('retains immutable segment owner %s', column => {
  const store = new Store(file);
  try {
    expect(() => store.execute(`UPDATE binding_root_segments SET ${column}=${column} WHERE task_id='observing'`, [])).toThrow('binding_identity_mismatch');
  } finally {
    store.close();
  }
});

it('retains root selection, scope, member uniqueness and immutable session and binding ownership', () => {
  const store = new Store(file);
  try {
    for (const selected of ['missing', 'root-paused', 'root-historical']) {
      expect(() => store.execute("UPDATE ordinary_tasks SET selected_root_id=? WHERE task_id='observing'", [selected])).toThrow('binding_scope_mismatch');
    }
    expect(() => store.execute("UPDATE ordinary_tasks SET selected_root_id='root-historical' WHERE task_id='historical'", [])).toThrow(
      'binding_scope_mismatch'
    );
    expect(() =>
      store.execute(
        `INSERT INTO binding_root_segments(root_session_id,task_id,product,native_root_id,project_root,state,opened_at)
        VALUES ('child','observing','codex','new-native','/synthetic/project','closed',?)`,
        [at]
      )
    ).toThrow('binding_scope_mismatch');
    expect(() => store.execute("UPDATE sessions SET task_id=task_id WHERE id='child'", [])).toThrow('binding_identity_mismatch');
    expect(() => store.execute("UPDATE session_bindings SET identity=identity WHERE session_id='child'", [])).toThrow('binding_identity_mismatch');
    store.execute("INSERT INTO sessions(id,project_id,task_id,parent_id) VALUES ('duplicate-child','project','observing','root-observing')", []);
    expect(() =>
      store.execute(
        `INSERT INTO session_bindings(session_id,task_id,root_id,identity,observed_since,generation,state)
        SELECT 'duplicate-child',task_id,root_id,identity,observed_since,generation,state FROM session_bindings WHERE session_id='child'`,
        []
      )
    ).toThrow('UNIQUE constraint failed');
    expect(() => store.execute("DELETE FROM ordinary_tasks WHERE task_id='observing'", [])).not.toThrow();
    expect(store.all("SELECT * FROM binding_root_segments WHERE task_id='observing'")).toEqual([]);
  } finally {
    store.close();
  }
});

it('forgets deleted historical roots and pauses only matching product reservations', () => {
  const store = new Store(file);
  const db = new Database(file);
  try {
    db.pragma('foreign_keys = ON');
    seedTask(db, 'codex', 'codex', 'observing', 'native-observing');
    store.execute("DELETE FROM binding_root_segments WHERE task_id='historical'", []);
    expect(store.get("SELECT state,observer_identity FROM binding_root_segments WHERE task_id='observing'")).toEqual({
      state: 'paused',
      observer_identity: null
    });
    expect(store.get("SELECT state,generation FROM tasks WHERE id='observing'")).toEqual({ state: 'paused', generation: 8 });
    expect(store.get<{ ended_at: string | null }>("SELECT ended_at FROM active_intervals WHERE task_id='observing'")?.ended_at).not.toBeNull();
    expect(store.all("SELECT state,cursor FROM session_bindings WHERE task_id='observing'")).toEqual([
      { state: 'stopped', cursor: null },
      {
        state: 'stopped',
        cursor: null
      }
    ]);
    expect(store.get("SELECT state,revision FROM binding_root_segments WHERE task_id='codex'")).toEqual({ state: 'observing', revision: 9 });
    expect(store.get("SELECT state,generation FROM tasks WHERE id='codex'")).toEqual({ state: 'active', generation: 7 });
    expect(store.get("SELECT product,native_session_id FROM session_binding_forgets WHERE native_session_id='native-observing'")).toEqual({
      product: 'claude_code',
      native_session_id: 'native-observing'
    });
  } finally {
    db.close();
    store.close();
  }
});

it.each(products.flatMap(product => ['task', 'project'].map(kind => ({ product, kind }))))(
  'retains deletion fences after $kind deletion and reopen for $product',
  ({ product, kind }) => {
    const store = new Store(file);
    const db = new Database(file);
    try {
      db.pragma('foreign_keys = ON');
      seedTask(db, 'deleted', product, 'observing');
      const deletion = new Deletion(store, () => at);
      if (kind === 'task') deletion.deleteTask('deleted');
      else deletion.deleteProject('project');
    } finally {
      db.close();
      store.close();
    }
    const reopened = new Store(file);
    try {
      expect(reopened.all("SELECT * FROM binding_root_segments WHERE task_id='deleted'")).toEqual([]);
      expect(reopened.all("SELECT * FROM session_bindings WHERE task_id='deleted'")).toEqual([]);
      expect(
        reopened.get('SELECT product,native_session_id,task_id,project_root FROM session_binding_forgets WHERE product=? AND native_session_id=?', [
          product,
          'native-deleted'
        ])
      ).toEqual({
        product,
        native_session_id: 'native-deleted',
        task_id: 'deleted',
        project_root: '/synthetic/project'
      });
      expect(new Deletion(reopened).isDeleted('session', 'native-deleted')).toBe(true);
      const life = new Lifecycle(reopened, () => at);
      if (kind === 'project') {
        expect(() => life.registerProject('project', root)).toThrow('deleted_identifier');
      } else {
        expect(() =>
          life.createTask('project', 'deleted', {
            schema_version: 2,
            type: 'feature',
            expected_size: 'medium',
            assignee: 'local-user',
            product,
            initial_model: null,
            criterion_ids: ['accepted']
          })
        ).toThrow('deleted_identifier');
      }
      expect(() =>
        reopened.execute(
          `INSERT INTO binding_root_segments(root_session_id,task_id,product,native_root_id,project_root,state,opened_at)
          VALUES ('root-deleted','deleted',?,'native-deleted','/synthetic/project','observing',?)`,
          [product, at]
        )
      ).toThrow('binding_scope_mismatch');
      life.registerProject('replacement-project', root);
      life.createTask('replacement-project', 'replacement-task', {
        schema_version: 2,
        type: 'feature',
        expected_size: 'medium',
        assignee: 'local-user',
        product,
        initial_model: null,
        criterion_ids: ['accepted']
      });
      expect(() =>
        life.linkSession('replacement-task', 'native-deleted', '/synthetic/unread.jsonl', product, product === 'codex' ? '0.158.0' : '2.1.283')
      ).toThrow('deleted_identifier');
      expect(reopened.all('PRAGMA foreign_key_check')).toEqual([]);
    } finally {
      reopened.close();
    }
  }
);
