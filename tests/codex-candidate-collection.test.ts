import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { Collector, readSource } from '../src/sources/collection.js';
import { Store } from '../src/store.js';
import { Lifecycle } from '../src/core/lifecycle.js';
import { candidateCostCoverage, type CandidateScope } from '../src/nested-candidate.js';
import { sessionCompatibility } from '../src/source-compatibility.js';
import { lookupFileProfile } from '../src/adapter-profiles.js';

const at = (seconds: number) => `2026-01-01T00:00:${String(seconds).padStart(2, '0')}Z`;
const jsonl = (values: unknown[]) => values.map(v => JSON.stringify(v)).join('\n') + '\n';
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'codex-collection-synthetic-'));
  const db = join(dir, 'test.sqlite');
  let store = new Store(db);
  let now = at(1);
  let reads = 0;
  const scope: CandidateScope = {
    projectId: 'p',
    taskId: 't',
    allowedRootTurnIds: ['root-turn'],
    sessions: [
      {
        sessionId: 'root',
        rootSessionId: 'root',
        parentSessionId: null,
        sourceId: 'root-source',
        product: 'codex',
        nativeSessionId: 'native-root',
        processId: null,
        agentId: null
      },
      {
        sessionId: 'child',
        rootSessionId: 'root',
        parentSessionId: 'root',
        sourceId: 'child-source',
        product: 'codex',
        nativeSessionId: 'native-child',
        processId: null,
        agentId: null
      }
    ]
  };
  const sources = { projectRoot: dir, paths: { 'root-source': join(dir, 'root.jsonl'), 'child-source': join(dir, 'child.jsonl') } };
  // Disposable prelinked candidate fixture ONLY. Conditional file enrollment does not admit this parent link or candidate topology.
  store.execute('INSERT INTO projects(id,local_root) VALUES (?,?)', ['p', dir]);
  store.execute("INSERT INTO tasks(id,project_id,state,metadata) VALUES ('t','p','active',?)", [JSON.stringify({ product: 'codex' })]);
  for (const s of scope.sessions)
    store.execute('INSERT INTO sessions(id,task_id,project_id,parent_id,product,product_version,source_path) VALUES (?,?,?,?,?,?,?)', [
      s.sessionId,
      't',
      'p',
      s.parentSessionId,
      'codex',
      '0.160.0',
      sources.paths[s.sourceId as keyof typeof sources.paths]
    ]);
  const meta = (child = false, extra = {}) => ({
    timestamp: at(0),
    type: 'session_meta',
    payload: {
      id: child ? 'native-child' : 'native-root',
      session_id: 'native-root',
      parent_thread_id: child ? 'native-root' : null,
      cli_version: '0.160.0',
      cwd: dir,
      source: child ? { subagent: { thread_spawn: { parent_thread_id: 'native-root', depth: 1 } } } : 'exec',
      ...extra
    }
  });
  const context = (child = false, seconds = 2, model = child ? 'child-model' : 'root-model') => ({
    timestamp: at(seconds),
    type: 'turn_context',
    payload: {
      turn_id: child ? 'child-turn' : 'root-turn',
      root_turn_id: child ? 'root-turn' : null,
      cwd: dir,
      model,
      effort: child ? 'high' : 'low',
      instructions: 'PRIVATE_SENTINEL'
    }
  });
  const response = (child = false, seconds = 3, id = child ? 'child-response' : 'root-response', input = child ? 40 : 100) => ({
    timestamp: at(seconds),
    type: 'token_usage_record',
    payload: {
      thread_id: child ? 'native-child' : 'native-root',
      session_id: 'native-root',
      turn_id: child ? 'child-turn' : 'root-turn',
      root_turn_id: 'root-turn',
      response_id: id,
      usage: { input_tokens: input, cached_input_tokens: 10, output_tokens: 15, reasoning_output_tokens: 5, total_tokens: input + 15 },
      turn_token_usage: { input_tokens: 999 },
      thread_token_usage: { input_tokens: 999 }
    }
  });
  const path = (child = false) => (child ? sources.paths['child-source'] : sources.paths['root-source']);
  const replace = (values: unknown[], child = false) => writeFileSync(path(child), jsonl(values));
  const append = (values: unknown[], child = false) => appendFileSync(path(child), jsonl(values));
  replace([meta()]);
  replace([meta(true)], true);
  const makeCollector = () =>
    new Collector(
      store,
      () => now,
      p => {
        reads++;
        return readSource(p);
      }
    );
  let collector = makeCollector();
  const tick = () => collector.tickCodexCandidate(scope, sources);
  return {
    dir,
    scope,
    sources,
    meta,
    context,
    response,
    replace,
    append,
    path,
    tick,
    get store() {
      return store;
    },
    get collector() {
      return collector;
    },
    set: (seconds: number) => {
      now = at(seconds);
    },
    reads: () => reads,
    reopen: () => {
      store.close();
      store = new Store(db);
      collector = makeCollector();
    },
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('Collector candidate reads bounded native JSONL only after prelinked authorization and counts own root/child requests once', () => {
  const f = fixture();
  try {
    expect(f.tick()).toEqual([]);
    expect(f.store.eventCount()).toBe(0);
    f.append([f.context(), f.response(), { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 999999 } } } }]);
    f.append([f.context(true), f.response(true)], true);
    f.set(4);
    expect(f.tick()).toEqual([]);
    expect(f.store.eventCount()).toBe(2);
    expect(f.store.get<{ total: number }>("SELECT sum(json_extract(payload,'$.input_total.value')) AS total FROM events")?.total).toBe(140);
    expect(f.store.all<{ payload: string }>('SELECT payload FROM runtime_evidence').map(r => JSON.parse(r.payload) as unknown)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ model: 'root-model', effort: 'low' }),
        expect.objectContaining({ model: 'child-model', effort: 'high' })
      ])
    );
    f.tick();
    expect(f.store.eventCount()).toBe(2);
    expect(JSON.stringify(f.store.all('SELECT payload FROM events')) + JSON.stringify(f.store.all('SELECT payload FROM runtime_evidence'))).not.toContain(
      'PRIVATE_SENTINEL'
    );
    expect(Object.values(candidateCostCoverage(f.scope, at(1), at(4), true).facts).every(v => v === 'unknown')).toBe(true);
  } finally {
    f.cleanup();
  }
});

test('new Collector establishes current tail; old turn responses are excluded and replay dedup survives reopened DB', () => {
  const f = fixture();
  try {
    f.append([f.context(false, 0), f.response(false, 0, 'baseline')]);
    f.tick();
    f.append([f.response(false, 3, 'old-turn')]);
    f.set(4);
    f.tick();
    expect(f.store.eventCount()).toBe(0);
    f.append([f.context(), f.response()]);
    f.tick();
    expect(f.store.eventCount()).toBe(1);
    f.reopen();
    f.tick();
    expect(f.store.eventCount()).toBe(1);
    f.append([f.context(), f.response()]);
    f.set(7);
    f.tick();
    expect(f.store.eventCount()).toBe(1);
  } finally {
    f.cleanup();
  }
});

test.each([
  'paused',
  'deleted-task',
  'deleted-project',
  'deleted-child',
  'path',
  'root',
  'version',
  'parent',
  'foreign-project',
  'extra-session',
  'mixed-channel'
] as const)('candidate %s scope is rejected before any source read', failure => {
  const f = fixture();
  try {
    if (failure === 'paused') f.store.execute("UPDATE tasks SET state='paused' WHERE id='t'", []);
    if (failure.startsWith('deleted-'))
      f.store.execute('INSERT INTO tombstones(kind,id,deleted_at) VALUES (?,?,?)', [
        failure === 'deleted-child' ? 'session' : failure.slice(8),
        failure === 'deleted-child' ? 'child' : failure === 'deleted-task' ? 't' : 'p',
        at(1)
      ]);
    if (failure === 'path') f.sources.paths['child-source'] = join(f.dir, 'not-linked.jsonl');
    if (failure === 'root') f.sources.projectRoot = join(f.dir, 'wrong-root');
    if (failure === 'version') f.store.execute("UPDATE sessions SET product_version='0.158.0' WHERE id='child'", []);
    if (failure === 'parent') f.store.execute("UPDATE sessions SET parent_id=NULL WHERE id='child'", []);
    if (failure === 'foreign-project') f.scope.projectId = 'foreign';
    if (failure === 'extra-session')
      f.store.execute("INSERT INTO sessions(id,task_id,project_id,parent_id,product,product_version) VALUES ('extra','t','p','root','codex','0.160.0')", []);
    if (failure === 'mixed-channel')
      f.store.execute(
        "INSERT INTO observation_runs(id,project_id,task_id,session_id,generation,profile_id,state,started_at,updated_at,input_facts,output_facts) VALUES ('r','p','t','root',0,'synthetic-managed-v1','ready',?,?,'{}','{}')",
        [at(1), at(1)]
      );
    expect(() => f.tick()).toThrow(/^candidate_/);
    expect(f.reads()).toBe(0);
  } finally {
    f.cleanup();
  }
});

test('response before matching context and stale context across turns/compaction remain gaps', () => {
  const f = fixture();
  try {
    f.tick();
    f.append([
      f.response(),
      f.context(),
      { type: 'event_msg', timestamp: at(3), payload: { type: 'task_complete', turn_id: 'root-turn' } },
      f.response(false, 3, 'after-close'),
      f.context(),
      { type: 'compacted', payload: { message: 'PRIVATE_SENTINEL' } },
      f.response(false, 3, 'after-compaction')
    ]);
    f.set(4);
    f.tick();
    expect(f.store.eventCount()).toBe(0);
    expect(f.store.all('SELECT * FROM observation_gaps')).not.toHaveLength(0);
  } finally {
    f.cleanup();
  }
});

test('native context changes pair chronologically; conflicting response identities roll back the whole batch', () => {
  const f = fixture();
  try {
    f.tick();
    f.append([f.context(), f.response(), f.context(false, 3, 'changed-model'), f.response(false, 4, 'changed-response')]);
    f.set(5);
    f.tick();
    expect(f.store.all('SELECT * FROM runtime_evidence')).toHaveLength(2);
    f.append([f.response(false, 5, 'changed-response', 101)]);
    f.set(6);
    expect(() => f.tick()).toThrow('candidate_conflict');
    expect(f.store.eventCount()).toBe(2);
  } finally {
    f.cleanup();
  }
});

test('partial trailing records wait for newline and stable identity/append is enforced', () => {
  const f = fixture();
  try {
    f.tick();
    f.append([f.context()]);
    appendFileSync(f.path(), JSON.stringify(f.response()));
    f.set(4);
    f.tick();
    expect(f.store.eventCount()).toBe(0);
    appendFileSync(f.path(), '\n');
    f.tick();
    expect(f.store.eventCount()).toBe(1);
    const moved = join(f.dir, 'old.jsonl');
    renameSync(f.path(), moved);
    f.replace([f.meta(), f.context(), f.response()]);
    expect(() => f.tick()).toThrow('candidate_source_changed');
  } finally {
    f.cleanup();
  }
});

test('source growth cannot conceal a rewritten prefix and malformed headers/version/cwd are rejected', () => {
  const f = fixture();
  try {
    f.tick();
    f.replace([f.meta(), { type: 'response_item', payload: { text: 'PRIVATE_SENTINEL' } }]);
    f.set(4);
    f.tick();
    f.replace([f.meta(), { type: 'response_item', payload: { text: 'DIFFERENT_SENTINEL' } }, f.context(), f.response()]);
    expect(() => f.tick()).toThrow('candidate_source_changed');
    for (const extra of [{ cli_version: '0.158.0' }, { cwd: join(f.dir, 'wrong') }, { session_id: 'foreign' }]) {
      f.reopen();
      f.replace([f.meta(false, extra)]);
      expect(() => f.tick()).toThrow(/^candidate_/);
    }
  } finally {
    f.cleanup();
  }
});

test('explicit fork markers are rejected unless a paginated direct-child suffix is verifiably bounded', () => {
  const f = fixture();
  try {
    const childMeta = {
      ...f.meta(true, {
        forked_from_id: 'native-root',
        forked_from_ordinal_exclusive: 20,
        history_mode: 'paginated',
        history_base: { thread_id: 'native-root', end_ordinal_exclusive: 20, end_byte_offset: 123 },
        subagent_history_start_ordinal: 23
      }),
      ordinal: 20
    };
    f.replace(
      [
        childMeta,
        { ...f.context(false, 0), ordinal: 21 },
        { type: 'event_msg', ordinal: 22, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 999 } } } }
      ],
      true
    );
    f.tick();
    f.append(
      [
        { ...f.context(true), ordinal: 23 },
        { ...f.response(true), ordinal: 24 }
      ],
      true
    );
    f.set(4);
    f.tick();
    expect(f.store.eventCount()).toBe(1);
    f.reopen();
    f.replace([f.meta(true, { forked_from_id: 'native-root' }), f.context(true), f.response(true)], true);
    expect(() => f.tick()).toThrow('candidate_unsupported_history');
  } finally {
    f.cleanup();
  }
});

test('conditional file enrollment preserves exact admission and the closed default flexible Collector path', () => {
  const f = fixture();
  try {
    expect(lookupFileProfile('codex', '0.161.0')).toBe('unsupported');
    f.store.execute("UPDATE tasks SET metadata=? WHERE id='t'", [
      JSON.stringify({
        schema_version: 2,
        type: 'feature',
        expected_size: 'small',
        assignee: 'synthetic-user',
        product: 'codex',
        initial_model: null,
        criterion_ids: ['criterion']
      })
    ]);
    expect(() => new Lifecycle(f.store).linkSession('t', 'new', join(f.dir, 'never-created.jsonl'), 'codex', '0.161.0')).not.toThrow();
    expect(sessionCompatibility(f.store, 'new')).toMatchObject({
      state: 'compatibility_unverified',
      source: 'file',
      product_version: '0.161.0',
      parser_version: '0.158.0'
    });
    expect(f.collector.tick('t')).toMatchObject([
      { session_id: 'root', category: 'unsupported_source' },
      { session_id: 'new', category: 'unsupported_source' }
    ]);
    expect(f.reads()).toBe(0);
    expect(f.store.eventCount()).toBe(0);
    // Conditional file support does not authorize the separate candidate topology.
    expect(() => f.tick()).toThrow('candidate_scope_mismatch');
    expect(f.reads()).toBe(0);
  } finally {
    f.cleanup();
  }
});

test.each(['pause', 'delete-child', 'change-path'] as const)('scope revoked by root reader callback (%s) prevents the subsequent child read', failure => {
  const f = fixture();
  let reads = 0;
  try {
    const collector = new Collector(
      f.store,
      () => at(1),
      path => {
        reads++;
        const bytes = readSource(path);
        if (failure === 'pause') f.store.execute("UPDATE tasks SET state='paused' WHERE id='t'", []);
        if (failure === 'delete-child') f.store.execute("INSERT INTO tombstones(kind,id,deleted_at) VALUES ('session','child',?)", [at(1)]);
        if (failure === 'change-path') f.store.execute("UPDATE sessions SET source_path=? WHERE id='child'", [join(f.dir, 'changed-path.jsonl')]);
        return bytes;
      }
    );
    expect(() => collector.tickCodexCandidate(f.scope, f.sources)).toThrow(/^candidate_/);
    expect(reads).toBe(1);
    expect(f.store.eventCount()).toBe(0);
  } finally {
    f.cleanup();
  }
});

test('paginated header ordinal must match the physical history base and ordinal holes stay unsupported', () => {
  const f = fixture();
  try {
    const meta = {
      ...f.meta(true, {
        forked_from_id: 'native-root',
        forked_from_ordinal_exclusive: 20,
        history_mode: 'paginated',
        history_base: { thread_id: 'native-root', end_ordinal_exclusive: 20, end_byte_offset: 123 },
        subagent_history_start_ordinal: 23
      }),
      ordinal: 19
    };
    f.replace([meta], true);
    expect(() => f.tick()).toThrow('candidate_unsupported_history');
    f.replace(
      [
        { ...meta, ordinal: 20 },
        { ...f.context(true), ordinal: 23 }
      ],
      true
    );
    expect(() => f.tick()).toThrow('candidate_unsupported_history');
  } finally {
    f.cleanup();
  }
});

test('a response for a different turn invalidates stale context before later responses', () => {
  const f = fixture();
  try {
    f.tick();
    const wrong = f.response();
    wrong.payload.turn_id = 'different-turn';
    f.append([f.context(), wrong, f.response(false, 3, 'late-stale')]);
    f.set(4);
    f.tick();
    expect(f.store.eventCount()).toBe(0);
  } finally {
    f.cleanup();
  }
});

test('candidate observation time follows the bounded source read when a response arrives during that read', () => {
  const f = fixture();
  let now = at(1);
  let appendDuringRead = false;
  try {
    const collector = new Collector(
      f.store,
      () => now,
      path => {
        if (appendDuringRead && path === f.path()) {
          f.append([f.context(), f.response()]);
          now = at(4);
          appendDuringRead = false;
        }
        return readSource(path);
      }
    );
    collector.tickCodexCandidate(f.scope, f.sources);
    appendDuringRead = true;
    expect(collector.tickCodexCandidate(f.scope, f.sources)).toEqual([]);
    expect(f.store.eventCount()).toBe(1);
    expect(JSON.parse(f.store.get<{ payload: string }>('SELECT payload FROM runtime_evidence')!.payload)).toMatchObject({
      recorded_at: new Date(at(4)).toISOString()
    });
  } finally {
    f.cleanup();
  }
});
