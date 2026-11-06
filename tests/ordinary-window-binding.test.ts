import { afterEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ordinaryWindowFixture } from './helpers/ordinary-window-fixture.js';
import { readOrdinaryWindowBatch } from '../src/ordinary-window-binding.js';
import { recordOrdinaryWindowSegment, revokeOrdinaryWindowActivation } from '../src/core/ordinary-window-store.js';
import { sessionCompatibility } from '../src/source-compatibility.js';
import { Deletion } from '../src/deletion.js';
import type { OrdinaryWindowUsageBatch } from '../src/session-binding-contract.js';

const fixtures: ReturnType<typeof ordinaryWindowFixture>[] = [];
function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((reason: Error) => void) | undefined;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  if (!resolve || !reject) throw new Error('fixture_resolver_missing');
  return { promise, resolve, reject };
}
function fixture(product: 'codex' | 'claude_code' = 'codex') {
  const f = ordinaryWindowFixture(product);
  fixtures.push(f);
  f.activate();
  f.connect();
  return f;
}
afterEach(() => {
  for (const f of fixtures.splice(0)) f.store.close();
});
const read = (f: ReturnType<typeof fixture>, baseline = false) =>
  readOrdinaryWindowBatch({
    store: f.store,
    taskId: f.taskId,
    rootSessionId: f.rootId,
    baseline,
    clock: f.clock,
    provider: () => {
      f.calls.push('construct');
      return f.provider;
    }
  });

test.each(['source_changed', 'source_unavailable', 'binding_executable_changed'])('pauses %s without declaring semantic incompatibility', async gap => {
  const f = fixture();
  const before = f.snapshot();
  f.onRead(boundary => {
    boundary.baselineLedger?.add('staged-only');
    return Promise.resolve({ ...f.batch(), gaps: [gap] });
  });
  await expect(read(f)).rejects.toThrow(gap);
  expect(f.snapshot()).toEqual(before);
  expect(f.store.all('SELECT * FROM source_compatibility_blocks')).toEqual([]);
  expect(f.life.state(f.taskId)).toBe('paused');
});

test.each(['codex', 'claude_code'] as const)('commits %s usage, replay, provenance, cursor and eventless coverage atomically', async product => {
  const f = fixture(product);
  await read(f);
  expect(f.store.eventCount()).toBe(1);
  expect(f.store.all('SELECT * FROM binding_requests')).toHaveLength(1);
  expect(sessionCompatibility(f.store, f.rootId)).toMatchObject({
    state: 'compatibility_unverified',
    product_version: f.selection.declaredVersion,
    profile_id: f.selection.policy.policyId
  });
  expect(f.store.get<{ cursor: string }>('SELECT cursor FROM session_bindings')?.cursor).toBe('next');
  await read(f);
  expect(f.store.eventCount()).toBe(1);
  expect(f.calls).toEqual(['construct', 'revalidate', 'read', 'construct', 'revalidate', 'read']);
  f.onRead(() => Promise.resolve(f.batch([])));
  await read(f);
  const coverage = f.store.get<{ coverage: string }>('SELECT coverage FROM ordinary_window_segments')?.coverage;
  expect(JSON.parse(coverage ?? 'null')).toMatchObject({
    scope: 'root_only',
    rootOwnership: 'unverified',
    possibleChildContribution: 'unknown',
    childrenStatus: 'unobserved',
    detectionCompleteness: 'unknown',
    detectedChildren: []
  });
});

test('keeps provider baseline additions staged until the accepted batch transaction', async () => {
  const f = fixture();
  f.onRead(boundary => {
    boundary.baselineLedger?.add('old-request');
    expect(f.store.all('SELECT * FROM binding_baseline_exclusions')).toEqual([]);
    return Promise.resolve(f.batch([f.record('baseline-request')]));
  });
  await read(f, true);
  expect(f.store.eventCount()).toBe(0);
  expect(f.store.all('SELECT * FROM binding_requests')).toEqual([]);
  expect(f.store.all('SELECT * FROM binding_baseline_exclusions')).toHaveLength(2);
  expect(f.store.get<{ cursor: string }>('SELECT cursor FROM session_bindings')?.cursor).toBe('next');
});

test.each(['wrong_version', 'wrong_owner', 'invalid_counter', 'finality_failure', 'replay_conflict'])(
  'rolls back usage, replay, exclusions, pin and cursor while persisting a %s rejection',
  async kind => {
    const f = fixture();
    const before = f.snapshot();
    f.onRead(boundary => {
      boundary.baselineLedger?.add('staged-only');
      const valid = f.record('valid');
      const invalid = f.record('invalid');
      let batch: OrdinaryWindowUsageBatch;
      if (kind === 'wrong_version') {
        batch = f.batch([
          valid,
          {
            ...invalid,
            payload: {
              ...invalid.payload,
              product_version: '0.168.0'
            }
          }
        ]);
      } else if (kind === 'wrong_owner') {
        batch = f.batch([valid, { ...invalid, sessionId: 'child' }]);
      } else if (kind === 'invalid_counter') {
        batch = f.batch([
          valid,
          {
            ...invalid,
            payload: {
              ...invalid.payload,
              cached_input: {
                status: 'observed',
                value: 11,
                reason: null
              }
            }
          }
        ]);
      } else if (kind === 'finality_failure') {
        batch = {
          ...f.batch([valid]),
          gaps: ['binding_finality_unsupported']
        };
      } else {
        batch = f.batch([
          valid,
          {
            ...valid,
            payload: {
              ...valid.payload,
              output_total: {
                status: 'observed',
                value: 6,
                reason: null
              }
            }
          }
        ]);
      }
      return Promise.resolve(batch);
    });
    await expect(read(f)).rejects.toThrow();
    expect(f.snapshot()).toEqual(before);
    expect(f.store.all('SELECT product,product_version,source,reason FROM source_compatibility_blocks')).toEqual([
      {
        product: 'codex',
        product_version: '0.167.0',
        source: 'codex_binding',
        reason: 'contract_failed'
      }
    ]);
    expect(f.life.state(f.taskId)).toBe('paused');
    const coverage = f.store.get<{ coverage: string }>('SELECT coverage FROM ordinary_window_segments')?.coverage;
    expect(JSON.parse(coverage ?? 'null')).toMatchObject({
      status: 'invalidated',
      reason: 'compatibility_invalidated'
    });
  }
);

test.each(['revoke', 'pause', 'delete', 'source_change'])(
  'discards an in-flight read after %s and starts no later native read',
  async kind => {
    const f = fixture();
    const entered = deferred<void>();
    const pending = deferred<OrdinaryWindowUsageBatch>();
    let laterRead = 0;
    f.onRead(async boundary => {
      boundary.baselineLedger?.add('uncommitted');
      entered.resolve();
      const result = await pending.promise;
      boundary.authorizeSource(f.identity);
      laterRead++;
      return result;
    });
    const running = read(f);
    const rejected = expect(running).rejects.toThrow();
    await entered.promise;
    if (kind === 'revoke') {
      revokeOrdinaryWindowActivation(f.store, f.taskId, f.clock());
    } else if (kind === 'pause') f.life.pause(f.taskId);
    else if (kind === 'delete') {
      new Deletion(f.store, f.clock).deleteTask(f.taskId);
    } else {
      f.store.execute("UPDATE session_bindings SET cursor='changed' WHERE session_id=?", [f.rootId]);
    }
    pending.resolve(f.batch());
    await rejected;
    expect(laterRead).toBe(0);
    expect(f.store.eventCount()).toBe(0);
    expect(f.store.all('SELECT * FROM binding_requests')).toEqual([]);
    expect(f.store.all('SELECT * FROM binding_baseline_exclusions')).toEqual([]);
    expect(f.store.all('SELECT * FROM source_compatibility_blocks')).toEqual([]);
    expect(f.store.all('SELECT * FROM session_source_compatibility')).toEqual([]);
  },
  5000
);

test('allows a pending request without quiescence finalization or observed zero', async () => {
  const f = fixture('claude_code');
  f.onRead(() => Promise.resolve({ ...f.batch([]), gaps: ['incomplete_request'] }));
  await read(f);
  expect(f.store.eventCount()).toBe(0);
  expect(f.life.state(f.taskId)).toBe('active');
  expect(f.store.all('SELECT * FROM source_compatibility_blocks')).toEqual([]);
  expect(f.store.get<{ cursor: string }>('SELECT cursor FROM session_bindings')?.cursor).toBe('next');
});

test('denies a direct window read before provider construction when activation is absent', async () => {
  const f = fixture();
  f.store.execute('DELETE FROM ordinary_window_activations', []);
  const before = f.snapshot();
  let failure: unknown;
  try {
    await read(f);
  } catch (error) {
    failure = error;
  }
  expect(f.calls).toEqual([]);
  expect(f.snapshot()).toEqual(before);
  expect(failure).toMatchObject({
    message: 'binding_window_activation_required'
  });
});

test.each(['revoke', 'pause'] as const)(
  'does not persist a stale semantic rejection after %s',
  async kind => {
    const f = fixture();
    const entered = deferred<void>();
    const pending = deferred<OrdinaryWindowUsageBatch>();
    f.onRead(() => {
      entered.resolve();
      return pending.promise;
    });
    const running = read(f);
    const rejected = expect(running).rejects.toThrow('binding_contract_failed');
    await entered.promise;
    if (kind === 'revoke') {
      revokeOrdinaryWindowActivation(f.store, f.taskId, f.clock());
    } else f.life.pause(f.taskId);
    pending.reject(new Error('binding_contract_failed'));
    await rejected;
    expect(f.store.all('SELECT * FROM source_compatibility_blocks')).toEqual([]);
    expect(f.store.eventCount()).toBe(0);
    expect(f.store.all('SELECT * FROM binding_baseline_exclusions')).toEqual([]);
  },
  5000
);

function replaceRoot(f: ReturnType<typeof fixture>): void {
  f.life.pause(f.taskId);
  f.store.execute("UPDATE binding_root_segments SET state='closed' WHERE root_session_id=?", [f.rootId]);
  f.life.resume(f.taskId);
  const rootId = 'replacement-measurement-root';
  const identity = {
    ...f.identity,
    sessionId: 'replacement-native-root',
    sourceIdentity: 'replacement-source',
    nativeMapping: {
      nativeSessionId: 'replacement-native-root',
      agentId: null,
      processId: null
    }
  };
  const proof = {
    ...f.proof,
    receipt: randomUUID(),
    nativeSessionId: identity.sessionId,
    sourceIdentity: identity.sourceIdentity
  };
  f.store.execute('INSERT INTO sessions(id,project_id,task_id,product,product_version) VALUES (?,?,?,?,?)', [
    rootId,
    f.selection.projectId,
    f.taskId,
    'codex',
    f.selection.declaredVersion
  ]);
  f.store.execute(
    `INSERT INTO binding_root_segments(root_session_id,task_id,product,native_root_id,project_root,state,opened_at)
    VALUES (?,?,?,?,?,'acquiring',?)`,
    [rootId, f.taskId, 'codex', identity.sessionId, identity.cwd, f.clock()]
  );
  f.store.execute('UPDATE ordinary_tasks SET selected_root_id=? WHERE task_id=?', [rootId, f.taskId]);
  recordOrdinaryWindowSegment(
    f.store,
    {
      taskId: f.taskId,
      rootSessionId: rootId
    },
    proof
  );
  f.store.execute(
    `INSERT INTO session_bindings(session_id,task_id,root_id,identity,connect_receipt,observed_since,generation,state,cursor)
    VALUES (?,?,?,?,?,?,?,'observing','replacement-cursor')`,
    [rootId, f.taskId, rootId, JSON.stringify(identity), proof.receipt, f.clock(), f.life.task(f.taskId).generation]
  );
  f.store.execute("UPDATE binding_root_segments SET state='observing',baseline_at=? WHERE root_session_id=?", [f.clock(), rootId]);
}

test.each(
  (['root', 'generation', 'segment', 'cursor'] as const).flatMap(change =>
    (['resolved', 'binding_contract_failed', 'source_changed'] as const).map(completion => ({ change, completion }))
  )
)(
  'keeps the current attempt unchanged after a stale $completion batch following $change replacement',
  async ({ change, completion }) => {
    const f = fixture();
    const entered = deferred<void>();
    const pending = deferred<OrdinaryWindowUsageBatch>();
    f.onRead(() => {
      entered.resolve();
      return pending.promise;
    });
    const running = read(f);
    const rejected = expect(running).rejects.toThrow(completion === 'resolved' ? 'binding_scope_revoked' : completion);
    await entered.promise;
    if (change === 'root') {
      replaceRoot(f);
    } else if (change === 'generation') {
      f.life.pause(f.taskId);
      f.life.resume(f.taskId);
      f.store.execute('UPDATE session_bindings SET generation=? WHERE session_id=?', [f.life.task(f.taskId).generation, f.rootId]);
    } else if (change === 'segment') {
      f.store.execute('UPDATE binding_root_segments SET revision=revision+1 WHERE root_session_id=?', [f.rootId]);
    } else {
      f.store.execute("UPDATE session_bindings SET cursor='replacement-cursor' WHERE session_id=?", [f.rootId]);
    }
    const state = () => ({
      ...f.snapshot(),
      tasks: f.store.all('SELECT * FROM tasks'),
      selections: f.store.all('SELECT * FROM ordinary_tasks'),
      segments: f.store.all('SELECT * FROM binding_root_segments'),
      bindings: f.store.all('SELECT * FROM session_bindings'),
      coverage: f.store.all('SELECT * FROM ordinary_window_segments'),
      intervals: f.store.all('SELECT * FROM active_intervals'),
      blocks: f.store.all('SELECT * FROM source_compatibility_blocks')
    });
    const before = state();
    expect(f.life.state(f.taskId)).toBe('active');
    expect(f.store.all('SELECT revoked_at FROM ordinary_window_activations')).toEqual([{ revoked_at: null }]);
    if (completion === 'resolved') pending.resolve(f.batch());
    else pending.reject(new Error(completion));
    await rejected;
    expect(state()).toEqual(before);
  },
  5000
);
