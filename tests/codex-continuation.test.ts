import { appendFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { Collector, readSource } from '../src/collection.js';
import { Lifecycle } from '../src/lifecycle.js';
import { Store } from '../src/store.js';
import type { CandidateScope } from '../src/nested-candidate.js';
import { candidateCostCoverage } from '../src/nested-candidate.js';
import { jsonLines } from './helpers/collection-fixture.js';
import { lookupFileProfile, flexibleProductionProfiles } from '../src/adapter-profiles.js';

const at = (second: number) => new Date(Date.parse('2026-01-01T00:00:00Z') + second * 1000).toISOString();
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-continuation-')));
  const database = join(root, 'measurement.sqlite');
  let store = new Store(database);
  let second = 0;
  const clock = () => at(second);
  let life = new Lifecycle(store, clock);
  life.registerProject('p', root);
  life.createTask('p', 't', { type: 'feature', expected_size: 'small', assignee: 'u', product: 'codex', model: 'initial', criterion_ids: ['c'] });
  life.start('t');
  const family = (id: string, child = false) => {
    const ids = [id, ...(child ? [`${id}-child`] : [])];
    const scope: CandidateScope = {
      taskId: 't',
      projectId: 'p',
      allowedRootTurnIds: ['same-turn', 'fresh-turn'],
      sessions: ids.map((sessionId, index) => ({
        sessionId,
        nativeSessionId: sessionId,
        rootSessionId: id,
        parentSessionId: index ? id : null,
        sourceId: sessionId,
        product: 'codex',
        processId: null,
        agentId: null
      }))
    };
    const sources = { projectRoot: root, paths: Object.fromEntries(ids.map(sessionId => [sessionId, join(root, `${sessionId}.jsonl`)])) };
    return { scope, sources };
  };
  const link = (id: string, parent: string | null = null) => {
    life.linkCodexCandidateSession('t', 'p', id, join(root, `${id}.jsonl`), '0.160.0', parent);
    writeFileSync(
      join(root, `${id}.jsonl`),
      jsonLines([
        {
          type: 'session_meta',
          timestamp: at(0),
          payload: {
            id,
            session_id: parent ?? id,
            parent_thread_id: parent,
            cwd: root,
            cli_version: '0.160.0',
            source: parent ? { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1 } } } : 'exec'
          }
        }
      ])
    );
  };
  const turn = (id: string, responseId: string, start: number, input = 100, parent: string | null = null, turnId = 'same-turn') => [
    {
      type: 'turn_context',
      timestamp: at(start),
      payload: { turn_id: parent ? 'child-turn' : turnId, root_turn_id: parent ? turnId : null, cwd: root, model: id, effort: parent ? 'high' : 'low' }
    },
    {
      type: 'token_usage_record',
      timestamp: at(start + 1),
      payload: {
        thread_id: id,
        session_id: parent ?? id,
        turn_id: parent ? 'child-turn' : turnId,
        root_turn_id: turnId,
        response_id: responseId,
        usage: { input_tokens: input, cached_input_tokens: 10, output_tokens: 15, reasoning_output_tokens: 5, total_tokens: input + 15 }
      }
    }
  ];
  const append = (id: string, rows: unknown[]) => appendFileSync(join(root, `${id}.jsonl`), jsonLines(rows));
  const reader = vi.fn(readSource);
  let collector = new Collector(store, clock, reader);
  return {
    root,
    family,
    link,
    turn,
    append,
    reader,
    get store() {
      return store;
    },
    get life() {
      return life;
    },
    get collector() {
      return collector;
    },
    set: (value: number) => {
      second = value;
    },
    reopen: () => {
      store.close();
      store = new Store(database);
      life = new Lifecycle(store, clock);
      collector = new Collector(store, clock, reader);
    },
    cleanup: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
}

test('explicit candidate binder preserves first-family ledger when a second independent root is registered', () => {
  const f = fixture();
  try {
    f.link('root-1');
    f.link('root-1-child', 'root-1');
    expect(() => f.link('root-2')).not.toThrow();
    expect(() => f.link('root-2-child', 'root-2')).not.toThrow();
    expect(f.store.all('SELECT id,parent_id FROM sessions ORDER BY id')).toEqual([
      { id: 'root-1', parent_id: null },
      { id: 'root-1-child', parent_id: 'root-1' },
      { id: 'root-2', parent_id: null },
      { id: 'root-2-child', parent_id: 'root-2' }
    ]);
    expect(() => f.link('root-3')).toThrow('candidate_scope_mismatch');
    expect(() => f.link('grandchild', 'root-1-child')).toThrow('candidate_scope_mismatch');
    expect(() => f.link('extra-child', 'root-1')).toThrow('candidate_scope_mismatch');
  } finally {
    f.cleanup();
  }
});

test.each(['collected', 'uncollected'] as const)('bounded candidate continuation retains %s source loss across two roots and own children', loss => {
  const f = fixture();
  try {
    f.link('root-1');
    f.link('root-1-child', 'root-1');
    const first = f.family('root-1', true);
    f.collector.tickCodexCandidate(first.scope, first.sources);
    f.append('root-1', f.turn('root-1', 'response-1', 1));
    f.append('root-1-child', f.turn('root-1-child', 'child-response-1', 1, 40, 'root-1'));
    f.set(3);
    if (loss === 'collected') f.collector.tickCodexCandidate(first.scope, first.sources);
    rmSync(join(f.root, 'root-1.jsonl'));
    rmSync(join(f.root, 'root-1-child.jsonl'));
    f.reopen();
    f.set(5);
    f.link('root-2');
    f.link('root-2-child', 'root-2');
    const families = [first, f.family('root-2', true)];
    f.append('root-2', f.turn('root-2', 'offline-response', 4));
    expect(f.collector.tickCodexContinuation(families)).toEqual([{ session_id: 'root-1', at: at(5), category: 'read_failed' }]);
    expect(f.store.eventCount()).toBe(loss === 'collected' ? 2 : 0);
    f.append('root-2', f.turn('root-2', 'response-2', 6));
    f.append('root-2-child', f.turn('root-2-child', 'child-response-2', 6, 40, 'root-2'));
    f.set(8);
    f.collector.tickCodexContinuation(families);
    f.collector.tickCodexContinuation(families);
    expect(f.store.eventCount()).toBe(loss === 'collected' ? 4 : 2);
    expect(f.store.get<{ total: number }>("SELECT sum(json_extract(payload,'$.input_total.value')) AS total FROM events")?.total).toBe(
      loss === 'collected' ? 280 : 140
    );
    expect(
      f.store
        .all<{ payload: string }>('SELECT payload FROM runtime_evidence')
        .map(row => JSON.parse(row.payload) as { model: string })
        .map(row => row.model)
        .sort()
    ).toEqual([...(loss === 'collected' ? ['root-1', 'root-1-child'] : []), 'root-2', 'root-2-child']);
    expect(f.store.all('SELECT reason FROM observation_gaps')).toContainEqual({ reason: 'source_error' });
    expect(Object.values(candidateCostCoverage(families[1]!.scope, at(0), at(9), true).facts).every(value => value === 'unknown')).toBe(true);
    expect(lookupFileProfile('codex', '0.160.0')).toBe('unsupported');
    expect(flexibleProductionProfiles).toEqual([]);
    // Missing files can reappear, but only fresh turns after recovery are eligible.
    f.set(9);
    writeFileSync(
      join(f.root, 'root-1.jsonl'),
      jsonLines([
        {
          type: 'session_meta',
          payload: {
            id: 'root-1',
            session_id: 'root-1',
            cwd: f.root,
            source: 'exec',
            cli_version: '0.160.0'
          }
        },
        ...f.turn('root-1', 'uncertain-response', 8)
      ])
    );
    writeFileSync(
      join(f.root, 'root-1-child.jsonl'),
      jsonLines([
        {
          type: 'session_meta',
          payload: {
            id: 'root-1-child',
            session_id: 'root-1',
            parent_thread_id: 'root-1',
            cwd: f.root,
            cli_version: '0.160.0',
            source: { subagent: { thread_spawn: { parent_thread_id: 'root-1', depth: 1 } } }
          }
        }
      ])
    );
    f.collector.tickCodexContinuation(families);
    expect(f.store.eventCount()).toBe(loss === 'collected' ? 4 : 2);
    f.append('root-1', f.turn('root-1', 'fresh-response', 10, 50, null, 'fresh-turn'));
    f.set(12);
    f.collector.tickCodexContinuation(families);
    expect(f.store.eventCount()).toBe(loss === 'collected' ? 5 : 3);
  } finally {
    f.cleanup();
  }
});

test.each(['paused', 'wrong-path', 'omitted-family', 'duplicate-native', 'duplicate-path', 'foreign-task', 'grandchild'] as const)(
  'continuation rejects %s manifest before any bounded source read',
  failure => {
    const f = fixture();
    try {
      f.link('root-1');
      f.link('root-2');
      const families = [f.family('root-1'), f.family('root-2')];
      if (failure === 'paused') f.life.pause('t');
      if (failure === 'wrong-path') families[1]!.sources.paths['root-2'] = join(f.root, 'not-linked.jsonl');
      if (failure === 'omitted-family') families.pop();
      if (failure === 'duplicate-native') families[1]!.scope.sessions[0]!.nativeSessionId = 'root-1';
      if (failure === 'duplicate-path') families[1]!.sources.paths['root-2'] = families[0]!.sources.paths['root-1']!;
      if (failure === 'foreign-task') families[1]!.scope.taskId = 'other-task';
      if (failure === 'grandchild') families[1]!.scope.sessions[0]!.parentSessionId = 'root-1';
      expect(() => f.collector.tickCodexContinuation(families)).toThrow(/^candidate_/);
      expect(f.reader).not.toHaveBeenCalled();
      expect(f.store.eventCount()).toBe(0);
    } finally {
      f.cleanup();
    }
  }
);

test('response IDs collide across independent roots without rekeying or overwriting the original family', () => {
  const f = fixture();
  try {
    f.link('root-1');
    f.link('root-2');
    const families = [f.family('root-1'), f.family('root-2')];
    f.collector.tickCodexContinuation(families);
    f.append('root-1', f.turn('root-1', 'same-response', 1));
    f.append('root-2', f.turn('root-2', 'same-response', 1));
    f.set(3);
    expect(() => f.collector.tickCodexContinuation(families)).toThrow('candidate_conflict');
    expect(f.store.all('SELECT session_id FROM events')).toEqual([{ session_id: 'root-1' }]);
    expect(f.store.all('SELECT session_id FROM runtime_evidence')).toEqual([{ session_id: 'root-1' }]);
    expect(() => f.collector.tickCodexContinuation(families)).toThrow('candidate_conflict');
    expect(f.store.eventCount()).toBe(1);
  } finally {
    f.cleanup();
  }
});

test('child read failure rolls back its family while an independent family remains eligible', () => {
  const f = fixture();
  try {
    f.link('root-1');
    f.link('root-1-child', 'root-1');
    f.link('root-2');
    const families = [f.family('root-1', true), f.family('root-2')];
    f.collector.tickCodexContinuation(families);
    f.append('root-1', f.turn('root-1', 'root-response', 1));
    f.append('root-2', f.turn('root-2', 'other-response', 1));
    f.set(3);
    rmSync(join(f.root, 'root-1-child.jsonl'));
    expect(f.collector.tickCodexContinuation(families)).toEqual([{ session_id: 'root-1', at: at(3), category: 'read_failed' }]);
    expect(f.store.all('SELECT session_id FROM events')).toEqual([{ session_id: 'root-2' }]);
    expect(f.store.all<{ session_id: string }>("SELECT session_id FROM observation_gaps WHERE reason='source_error' ORDER BY session_id")).toEqual([
      { session_id: 'root-1' },
      { session_id: 'root-1-child' }
    ]);
  } finally {
    f.cleanup();
  }
});

test('revoking any family during a bounded read prevents later source access', () => {
  const f = fixture();
  try {
    f.link('root-1');
    f.link('root-2');
    const families = [f.family('root-1'), f.family('root-2')];
    let reads = 0;
    const collector = new Collector(
      f.store,
      () => at(0),
      path => {
        reads++;
        const bytes = readSource(path);
        f.store.execute('UPDATE sessions SET source_path=? WHERE id=?', [join(f.root, 'changed.jsonl'), 'root-2']);
        return bytes;
      }
    );
    expect(() => collector.tickCodexContinuation(families)).toThrow('candidate_scope_mismatch');
    expect(reads).toBe(1);
    expect(f.store.eventCount()).toBe(0);
  } finally {
    f.cleanup();
  }
});

test('a child cannot attribute a response from an independent root as ancestor history', () => {
  const f = fixture();
  try {
    f.link('root-1');
    f.link('root-2');
    f.link('root-2-child', 'root-2');
    const families = [f.family('root-1'), f.family('root-2', true)];
    f.collector.tickCodexContinuation(families);
    const rows = f.turn('root-2-child', 'foreign-response', 1, 100, 'root-2');
    rows[1]!.payload.thread_id = 'root-1';
    f.append('root-2-child', rows);
    f.set(3);
    expect(() => f.collector.tickCodexContinuation(families)).toThrow('candidate_scope_mismatch');
    expect(f.store.eventCount()).toBe(0);
  } finally {
    f.cleanup();
  }
});

test('pause and new Collector drop continuity while default production collection remains unavailable', () => {
  const f = fixture();
  try {
    f.link('root-1');
    f.link('root-2');
    const families = [f.family('root-1'), f.family('root-2')];
    f.collector.tickCodexContinuation(families);
    f.append('root-1', f.turn('root-1', 'first-response', 1));
    f.set(3);
    f.collector.tickCodexContinuation(families);
    f.life.pause('t');
    f.append('root-1', f.turn('root-1', 'paused-response', 4));
    f.set(6);
    f.life.resume('t');
    f.collector.tickCodexContinuation(families);
    expect(f.store.eventCount()).toBe(1);
    f.append('root-1', f.turn('root-1', 'resumed-response', 7));
    f.set(9);
    f.collector.tickCodexContinuation(families);
    expect(f.store.eventCount()).toBe(2);
    f.reopen();
    f.append('root-1', f.turn('root-1', 'offline-response', 10));
    f.set(12);
    f.collector.tickCodexContinuation(families);
    expect(f.store.eventCount()).toBe(2);
    f.append('root-1', f.turn('root-1', 'new-process-response', 13));
    f.set(15);
    f.collector.tickCodexContinuation(families);
    expect(f.store.eventCount()).toBe(3);
    f.reader.mockClear();
    expect(f.collector.tick('t')).toMatchObject([{ category: 'unsupported_source' }, { category: 'unsupported_source' }]);
    expect(f.reader).not.toHaveBeenCalled();
    expect(f.store.eventCount()).toBe(3);
  } finally {
    f.cleanup();
  }
});
