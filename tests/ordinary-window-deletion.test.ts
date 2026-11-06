import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { ordinaryWindowFixture } from './helpers/ordinary-window-fixture.js';
import { Deletion } from '../src/deletion.js';
import { Store } from '../src/store.js';
import { createOrdinarySessionBindingService } from '../src/ordinary-session-binding.js';
import { createSessionBindingService } from '../src/session-binding-service.js';
import { readOrdinaryWindowBatch } from '../src/ordinary-window-binding.js';

const acquiringCases = (['codex', 'claude_code'] as const).flatMap(product =>
  (['absent', 'revoked'] as const).flatMap(authority =>
    (['task', 'project', 'session', 'selection', 'selection_first', 'task_cascade', 'project_cascade', 'segment'] as const).flatMap(kind =>
      (['ordinary', 'assigned'] as const).map(consumer => ({
        product,
        authority,
        kind,
        consumer
      }))
    )
  )
);
const deletionCases = [
  ...acquiringCases.map(value => ({ ...value, queued: 'none' as const })),
  ...(['codex', 'claude_code'] as const).flatMap(product =>
    (['ordinary', 'assigned'] as const).flatMap(consumer =>
      (['before', 'after'] as const).map(queued => ({
        product,
        consumer,
        queued,
        authority: 'absent' as const,
        kind: 'segment' as const
      }))
    )
  )
];

test.each(deletionCases)(
  'fences $consumer cleanup after $kind deletion of a $product acquiring window with $authority authority, no proof and $queued legacy queue',
  async ({ product, authority, kind, consumer, queued }) => {
    const f = ordinaryWindowFixture(product);
    const directory = mkdtempSync(join(tmpdir(), 'ordinary-window-deletion-'));
    try {
      if (authority === 'revoked') {
        f.activate();
        f.store.execute('UPDATE ordinary_window_activations SET revoked_at=?', [f.clock()]);
      }
      f.life.start(f.taskId);
      const queueLegacy = () =>
        f.store.execute('INSERT INTO session_binding_forgets(product,native_session_id,task_id,project_root) VALUES (?,?,?,?)', [
          product,
          f.identity.sessionId,
          'previous-task',
          f.identity.cwd
        ]);
      if (queued === 'before') queueLegacy();
      f.store.execute('INSERT INTO sessions(id,project_id,task_id,product,product_version) VALUES (?,?,?,?,?)', [
        f.rootId,
        f.selection.projectId,
        f.taskId,
        product,
        f.selection.declaredVersion
      ]);
      f.store.execute(
        `INSERT INTO binding_root_segments(root_session_id,task_id,product,native_root_id,project_root,state,opened_at)
        VALUES (?,?,?,?,?,'acquiring',?)`,
        [f.rootId, f.taskId, product, f.identity.sessionId, f.identity.cwd, f.clock()]
      );
      if (queued === 'after') queueLegacy();
      f.store.execute('UPDATE ordinary_tasks SET selected_root_id=? WHERE task_id=?', [f.rootId, f.taskId]);
      expect(f.store.all('SELECT * FROM ordinary_window_segments')).toEqual([]);
      expect(f.store.all('SELECT * FROM session_bindings')).toEqual([]);
      const deletion = new Deletion(f.store, f.clock);
      switch (kind) {
        case 'task':
          deletion.deleteTask(f.taskId);
          break;
        case 'project':
          deletion.deleteProject(f.selection.projectId);
          break;
        case 'session':
          f.store.execute('DELETE FROM sessions WHERE id=?', [f.rootId]);
          break;
        case 'selection':
          f.store.execute('DELETE FROM ordinary_tasks WHERE task_id=?', [f.taskId]);
          break;
        case 'selection_first':
          f.store.execute('DELETE FROM ordinary_window_selections WHERE task_id=?', [f.taskId]);
          deletion.deleteTask(f.taskId);
          break;
        case 'task_cascade':
          f.store.execute('DELETE FROM tasks WHERE id=?', [f.taskId]);
          break;
        case 'project_cascade':
          f.store.execute('DELETE FROM projects WHERE id=?', [f.selection.projectId]);
          break;
        case 'segment':
          f.store.execute('DELETE FROM binding_root_segments WHERE root_session_id=?', [f.rootId]);
          break;
      }
      const file = join(directory, 'deleted.db');
      f.store.execute('VACUUM INTO ?', [file]);
      const reopened = new Store(file, f.clock);
      try {
        const forget = vi.fn(() => Promise.resolve());
        const factory = vi.fn(() => [{ ...f.provider, forgetSession: forget }]);
        const binding =
          consumer === 'ordinary'
            ? createOrdinarySessionBindingService({
                store: reopened,
                providersForTask: factory,
                clock: f.clock
              })
            : createSessionBindingService({
                store: reopened,
                providers: [],
                providersForTask: factory,
                setupFor: () => {
                  throw new Error('deleted_window_setup_forbidden');
                }
              });
        await binding.flushForgotten();
        expect({
          factories: factory.mock.calls.length,
          forgets: forget.mock.calls.length,
          native: f.calls
        }).toEqual({
          factories: 0,
          forgets: 0,
          native: []
        });
        expect(reopened.all('SELECT * FROM ordinary_window_forget_fences')).toEqual([
          {
            product,
            native_session_id: f.identity.sessionId,
            task_id: f.taskId
          }
        ]);
        expect(reopened.all('SELECT product,native_session_id,reason_code FROM session_binding_forgets')).toEqual([
          {
            product,
            native_session_id: f.identity.sessionId,
            reason_code: 'binding_forget_pending'
          }
        ]);
        if ('close' in binding) await binding.close();
      } finally {
        reopened.close();
      }
    } finally {
      f.store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
);

test.each(['codex', 'claude_code'] as const)('denies a legacy native tombstone before %s provider reconstruction', async product => {
  const f = ordinaryWindowFixture(product);
  try {
    f.activate();
    f.connect();
    f.store.execute('INSERT INTO tombstones(kind,id,deleted_at) VALUES (?,?,?)', ['session', f.identity.sessionId, f.clock()]);
    const before = f.snapshot();
    const factory = vi.fn(() => f.provider);
    const outcome = await readOrdinaryWindowBatch({
      store: f.store,
      taskId: f.taskId,
      rootSessionId: f.rootId,
      baseline: false,
      clock: f.clock,
      provider: factory
    }).then(
      () => 'accepted',
      (error: unknown) => {
        if (!(error instanceof Error)) throw error;
        return error.message;
      }
    );
    expect({
      outcome,
      factories: factory.mock.calls.length,
      native: f.calls,
      events: f.store.eventCount()
    }).toEqual({
      outcome: 'deleted_identifier',
      factories: 0,
      native: [],
      events: 0
    });
    expect(f.snapshot()).toEqual(before);
  } finally {
    f.store.close();
  }
});
