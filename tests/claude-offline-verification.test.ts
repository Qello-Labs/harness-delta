import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { sessionCompatibility } from '../src/source-compatibility.js';
import { lookupFileProfile } from '../src/adapter-profiles.js';
import { parseFlexibleSnapshot } from '../src/adapters-flexible.js';
import { assignTask } from '../src/comparison/allocation.js';
import { Collector } from '../src/collection.js';
import { EventV2Schema, PriceTableSchema, type EventV2 } from '../src/flexible-contracts.js';
import { Lifecycle } from '../src/lifecycle.js';
import { aggregateTaskCost } from '../src/metrics.js';
import { ingestOtelLogs, registerOtelProcess } from '../src/otel-journal.js';
import { decodeLogsRequest } from '../src/sources/otel-projection.js';
import { Store } from '../src/store.js';
import { makeFlexibleFixture } from './helpers/flexible-fixture.js';
import { seedFlexibleComparison } from './helpers/flexible-store.js';
import { apiRequest, launchSessionId, logsRequest, profile, sessionStart, syntheticVersion } from './helpers/otel-fixture.js';

const version = '2.1.283';
const at = (n: number) => new Date(Date.parse('2026-01-01T00:00:00Z') + n * 1000).toISOString();
const lines = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';

/** Real file I/O and a private on-disk database; every source row is invented metadata. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'claude-offline-verification-'));
  const dbPath = join(root, 'verification.sqlite');
  const store = new Store(dbPath);
  let now = 0;
  const clock = () => at(now);
  const lifecycle = new Lifecycle(store, clock);
  lifecycle.registerProject('project-1', root);
  lifecycle.createTask('project-1', 'task-1', {
    schema_version: 2,
    type: 'feature',
    expected_size: 'small',
    assignee: 'user-1',
    product: 'claude_code',
    initial_model: null,
    criterion_ids: ['criterion-1']
  });
  lifecycle.start('task-1');
  const paths = new Map<string, string>();
  const rows = new Map<string, unknown[]>();
  const common = (sessionId: string) => ({ sessionId, cwd: root, version });
  const link = (sessionId: string) => {
    const dir = join(root, sessionId);
    mkdirSync(dir);
    const path = join(dir, 'source.jsonl');
    lifecycle.linkSession('task-1', sessionId, path, 'claude_code', version);
    paths.set(sessionId, path);
    rows.set(sessionId, [{ ...common(sessionId), type: 'attachment' }]);
    writeFileSync(path, lines(rows.get(sessionId)!));
  };
  const request = (sessionId: string, n: number, model = 'model-a', messageId = `message-${n}`) => {
    const requestRows = [
      { ...common(sessionId), type: 'user', promptId: `prompt-${n}`, timestamp: at(n), message: { content: [] } },
      {
        ...common(sessionId),
        type: 'assistant',
        timestamp: at(n + 1),
        effort: 'high',
        message: {
          id: messageId,
          model,
          content: [],
          usage: {
            input_tokens: 20,
            cache_creation_input_tokens: 40,
            cache_read_input_tokens: 40,
            output_tokens: 30
          }
        }
      }
    ];
    rows.get(sessionId)!.push(...requestRows);
    writeFileSync(paths.get(sessionId)!, lines(rows.get(sessionId)!));
    return requestRows;
  };
  const collector = new Collector(store, clock, undefined, (product, candidateVersion) =>
    product === 'claude_code' && candidateVersion === version ? parseFlexibleSnapshot : null
  );
  const events = () =>
    store
      .all<Record<string, unknown>>('SELECT * FROM events ORDER BY occurred_at,id')
      .map(row => EventV2Schema.parse({ ...row, payload: JSON.parse(String(row.payload)) as unknown }));
  const candidate = (sessionId = 'session-1') =>
    parseFlexibleSnapshot(
      readFileSync(paths.get(sessionId)!, 'utf8'),
      { projectRoot: root, sessionId, product: 'claude_code', version, taskId: 'task-1', projectId: 'project-1' },
      clock()
    );
  return {
    root,
    dbPath,
    store,
    clock,
    lifecycle,
    paths,
    rows,
    common,
    link,
    request,
    collector,
    events,
    candidate,
    set: (n: number) => {
      now = n;
    },
    cleanup: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
}
const table = PriceTableSchema.parse({
  id: 'claude-virtual-prices',
  version: 'virtual-v1',
  currency: 'USD',
  source_id: 'invented-fixed-prices',
  as_of: at(0),
  unit_tokens: 1000,
  display_decimals: 2,
  rounding: 'half_even',
  entries: ['model-a', 'model-b'].flatMap((model, index) =>
    [
      ['ordinary_input', 2],
      ['cache_write', 3],
      ['cache_read', 1],
      ['output', 4]
    ].map(([component, price]) => ({ product: 'claude_code', model, component, price_per_unit: String(Number(price) * (index + 1)) }))
  )
});
function cost(events: EventV2[]) {
  const evidence = makeFlexibleFixture().coverage;
  return aggregateTaskCost(events, table, {
    ...evidence,
    facts: { ...evidence.facts, bounded_topology: 'unknown', request_universe: 'unknown', continuous_observation: 'unknown' }
  });
}

test('claude_two_parentless_sessions_replay_once_and_sum_disjoint_virtual_prices', () => {
  const f = fixture();
  try {
    f.link('session-1');
    f.link('session-2');
    expect(f.collector.tick('task-1')).toEqual([]);
    const replay = f.request('session-1', 1, 'model-a', 'shared-message-id');
    f.request('session-2', 3, 'model-b', 'shared-message-id');
    f.set(5);
    expect(f.collector.tick('task-1')).toEqual([]);
    f.rows.get('session-1')!.push(...replay);
    writeFileSync(f.paths.get('session-1')!, lines(f.rows.get('session-1')!));
    f.set(6);
    expect(f.collector.tick('task-1')).toEqual([]);
    expect(f.events()).toHaveLength(2);
    expect(f.store.all('SELECT parent_id FROM sessions')).toEqual([{ parent_id: null }, { parent_id: null }]);
    expect(f.events().map(event => event.payload.input_total.value)).toEqual([100, 100]);
    // Unqualified candidate reference only. Per 1,000 tokens: A=(20*2+40*3+40*1+30*4)/1000=.32; B=.64.
    expect(cost([...f.events(), ...f.events()])).toMatchObject({
      partial_amount: null,
      legacy_unverified_partial_amount: '0.96',
      complete_amount: null,
      usage_complete: false,
      price_complete: false,
      compatibility: { verified_events: 0, legacy_unverified_events: 2 }
    });
    expect(f.events()[0]!.payload.billing_components.map(component => component.reading.value)).toEqual([20, 40, 40, 30]);
    expect(f.store.all<{ payload: string }>('SELECT payload FROM runtime_evidence').map(row => (JSON.parse(row.payload) as { effort: null }).effort)).toEqual([
      null,
      null
    ]);
  } finally {
    f.cleanup();
  }
});

test('claude_collector_restart_excludes_unobserved_interval_then_counts_fresh_request', () => {
  const f = fixture();
  try {
    f.link('session-1');
    f.collector.tick('task-1');
    f.request('session-1', 1);
    f.set(3);
    f.collector.tick('task-1');
    f.request('session-1', 4);
    f.set(6);
    const reopened = new Store(f.dbPath);
    try {
      const restarted = new Collector(reopened, f.clock, undefined, () => parseFlexibleSnapshot);
      restarted.tick('task-1');
      expect(reopened.eventCount()).toBe(1);
      f.request('session-1', 7);
      f.set(9);
      restarted.tick('task-1');
      expect(reopened.eventCount()).toBe(2);
      expect(cost(f.events()).legacy_unverified_partial_amount).toBe('0.64');
      expect(reopened.get("SELECT reason FROM observation_gaps WHERE started_at=? AND reason='offline'", [at(6)])).toBeDefined();
    } finally {
      reopened.close();
    }
  } finally {
    f.cleanup();
  }
});

test('claude_model_switch_and_fresh_linked_root_remain_active_with_unknown_effort', () => {
  const f = fixture();
  try {
    f.link('session-1');
    f.collector.tick('task-1');
    f.request('session-1', 1);
    f.set(3);
    f.collector.tick('task-1');
    f.request('session-1', 4, 'model-b');
    f.set(6);
    f.collector.tick('task-1');
    f.link('session-2');
    f.set(7);
    f.collector.tick('task-1');
    f.request('session-2', 8, 'model-b');
    f.set(10);
    f.collector.tick('task-1');
    expect(f.lifecycle.state('task-1')).toBe('active');
    expect(f.events()).toHaveLength(3);
    expect(cost(f.events())).toMatchObject({ partial_amount: null, legacy_unverified_partial_amount: '1.6', complete_amount: null });
    const history = f.store
      .all<{ payload: string }>('SELECT payload FROM runtime_evidence ORDER BY occurred_at')
      .map(row => JSON.parse(row.payload) as { model: string; effort: null });
    expect(history.map(row => row.model)).toEqual(['model-a', 'model-b', 'model-b']);
    expect(history.every(row => row.effort === null)).toBe(true);
  } finally {
    f.cleanup();
  }
});

test('claude_message_identity_is_session_scoped_so_cross_session_copies_are_not_deduplicated', () => {
  const f = fixture();
  try {
    f.link('session-1');
    f.link('session-2');
    f.collector.tick('task-1');
    // Same model, timestamp, message ID, counters and prompt origin under two IDs.
    // This characterizes a limitation; it does not prove independent backend requests.
    f.request('session-1', 1, 'model-a', 'copied-message');
    f.request('session-2', 1, 'model-a', 'copied-message');
    f.set(3);
    f.collector.tick('task-1');
    expect(f.events()).toHaveLength(2);
    expect(new Set(f.events().map(event => event.source_key)).size).toBe(2);
    expect(cost(f.events()).legacy_unverified_partial_amount).toBe('0.64');
  } finally {
    f.cleanup();
  }
});

test('claude_parent_uuid_does_not_establish_session_parent_child_relationship', () => {
  const f = fixture();
  try {
    f.link('session-1');
    f.collector.tick('task-1');
    f.request('session-1', 1, 'model-b');
    f.rows.set(
      'session-1',
      f.rows.get('session-1')!.map(row => ({ ...(row as Record<string, unknown>), parentUuid: 'synthetic-parent-message' }))
    );
    writeFileSync(f.paths.get('session-1')!, lines(f.rows.get('session-1')!));
    f.set(3);
    f.collector.tick('task-1');
    expect(f.events()).toHaveLength(1);
    expect(f.store.get('SELECT parent_id FROM sessions')).toEqual({ parent_id: null });
    expect(JSON.stringify(f.events())).not.toContain('synthetic-parent-message');
  } finally {
    f.cleanup();
  }
});

test('claude_collected_usage_survives_disposable_source_loss_and_database_reopen', () => {
  const f = fixture();
  try {
    f.link('session-1');
    f.collector.tick('task-1');
    f.request('session-1', 1);
    f.set(3);
    f.collector.tick('task-1');
    rmSync(f.paths.get('session-1')!);
    f.set(4);
    expect(f.collector.tick('task-1')).toMatchObject([{ category: 'read_failed' }]);
    expect(cost(f.events())).toMatchObject({ partial_amount: null, legacy_unverified_partial_amount: '0.32', complete_amount: null });
    const reopened = new Store(f.dbPath);
    try {
      expect(reopened.eventCount()).toBe(1);
      expect(reopened.all('SELECT * FROM runtime_evidence')).toHaveLength(1);
    } finally {
      reopened.close();
    }
    expect(f.store.get("SELECT reason,status FROM observations WHERE reason='source_error'")).toEqual({ reason: 'source_error', status: 'error' });
  } finally {
    f.cleanup();
  }
});

test('claude_uncollected_disposable_source_loss_remains_missing_never_zero', () => {
  const f = fixture();
  try {
    f.link('session-1');
    f.collector.tick('task-1');
    f.request('session-1', 1);
    rmSync(f.paths.get('session-1')!);
    f.set(3);
    expect(f.collector.tick('task-1')).toMatchObject([{ category: 'read_failed' }]);
    expect(f.events()).toEqual([]);
    expect(cost(f.events())).toMatchObject({ partial_amount: null, complete_amount: null });
    expect(f.store.all('SELECT * FROM runtime_evidence')).toEqual([]);
  } finally {
    f.cleanup();
  }
});

test('claude_new_session_after_task_finalization_is_rejected_before_source_read', () => {
  const f = fixture();
  try {
    f.link('session-1');
    f.collector.tick('task-1');
    f.request('session-1', 1);
    f.set(3);
    f.collector.tick('task-1');
    f.set(4);
    f.lifecycle.finalize('task-1', 'success', ['criterion-1']);
    expect(() => f.lifecycle.linkSession('task-1', 'later-session', join(f.root, 'never-created.jsonl'), 'claude_code', version)).toThrow('invalid_transition');
    rmSync(f.paths.get('session-1')!);
    f.set(5);
    expect(f.collector.tick('task-1')).toEqual([]);
    expect(f.events()).toHaveLength(1);
    expect(f.store.all('SELECT * FROM sessions')).toHaveLength(1);
  } finally {
    f.cleanup();
  }
});

test('claude_different_working_root_fails_scope_even_when_source_is_explicitly_linked', () => {
  const f = fixture();
  try {
    f.link('session-1');
    f.collector.tick('task-1');
    f.request('session-1', 1);
    const foreign = f.rows.get('session-1')!.map(row => ({ ...(row as Record<string, unknown>), cwd: join(f.root, 'different-root') }));
    writeFileSync(f.paths.get('session-1')!, lines(foreign));
    f.set(3);
    expect(f.collector.tick('task-1')).toMatchObject([{ category: 'scope_mismatch' }]);
    expect(f.events()).toEqual([]);
  } finally {
    f.cleanup();
  }
});

test('claude_sidechain_different_model_is_blocked_and_does_not_claim_child_attribution', () => {
  const f = fixture();
  try {
    f.link('session-1');
    f.collector.tick('task-1');
    const request = f.request('session-1', 1, 'model-b');
    f.rows.set('session-1', [f.rows.get('session-1')![0], request[0], { ...(request[1] as Record<string, unknown>), isSidechain: true }]);
    writeFileSync(f.paths.get('session-1')!, lines(f.rows.get('session-1')!));
    f.set(3);
    expect(f.candidate()).toMatchObject({ blocked: true, records: [], runtime: [], gaps: [{ reason: 'unknown_parent' }] });
    f.collector.tick('task-1');
    expect(f.events()).toEqual([]);
  } finally {
    f.cleanup();
  }
});

test('claude_explicit_child_session_is_excluded_while_root_records_unknown_parent_gap', () => {
  const f = fixture();
  try {
    f.link('session-1');
    f.link('child-1');
    f.store.execute("UPDATE sessions SET parent_id='session-1' WHERE id='child-1'", []);
    f.collector.tick('task-1');
    f.request('session-1', 1);
    f.request('child-1', 3, 'model-b');
    f.set(5);
    f.collector.tick('task-1');
    expect(f.events()).toHaveLength(1);
    expect(f.events()[0]!.session_id).toBe('session-1');
    expect(f.store.get("SELECT reason FROM observation_gaps WHERE reason='unknown_parent'")).toBeDefined();
    expect(cost(f.events())).toMatchObject({ partial_amount: null, legacy_unverified_partial_amount: '0.32', complete_amount: null });
  } finally {
    f.cleanup();
  }
});

test('claude_conditional_file_enrollment_does_not_admit_production_flexible_collection', () => {
  const f = fixture();
  try {
    expect(lookupFileProfile('claude_code', '2.1.292')).toBe('unsupported');
    expect(() => f.lifecycle.linkSession('task-1', 'new-version', join(f.root, 'never-created.jsonl'), 'claude_code', '2.1.292')).not.toThrow();
    expect(sessionCompatibility(f.store, 'new-version')).toMatchObject({
      state: 'compatibility_unverified',
      source: 'file',
      product_version: '2.1.292',
      parser_version: '2.1.283'
    });
    f.link('session-1');
    rmSync(f.paths.get('session-1')!);
    const read = vi.fn(() => {
      throw new Error('unexpected_source_read');
    });
    const production = new Collector(f.store, f.clock, read);
    expect(production.tick('task-1')).toMatchObject([
      { session_id: 'new-version', category: 'unsupported_source' },
      { session_id: 'session-1', category: 'unsupported_source' }
    ]);
    expect(read).not.toHaveBeenCalled();
    expect(f.store.eventCount()).toBe(0);
  } finally {
    f.cleanup();
  }
});

test('claude_assignment_cannot_be_joined_to_candidate_collection_with_closed_real_gate', () => {
  const store = new Store(':memory:');
  try {
    const f = seedFlexibleComparison(store);
    expect(() => assignTask(store, { ...f.input, metadata: { ...f.metadata, product: 'claude_code' } }, { clock: () => at(0) })).toThrow('synthetic_only');
    expect(store.all('SELECT * FROM comparison_assignments')).toEqual([]);
  } finally {
    store.close();
  }
});

test('claude_otel_injected_profile_retains_model_usage_but_no_effort_or_child_linkage', () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-otel-offline-verification-'));
  const store = new Store(':memory:');
  try {
    const life = new Lifecycle(store, () => at(0));
    life.registerProject('project-1', root);
    life.createTask('project-1', 'task-1', {
      type: 'feature',
      expected_size: 'small',
      assignee: 'user-1',
      product: 'claude_code',
      model: 'model-a',
      criterion_ids: ['criterion-1']
    });
    life.start('task-1');
    const options = { processId: 'process-1' };
    registerOtelProcess(
      store,
      { runId: 'run-1', processId: options.processId, taskId: 'task-1', sessionId: launchSessionId, productVersion: syntheticVersion },
      profile,
      at(0)
    );
    const decoded = decodeLogsRequest(
      logsRequest([
        sessionStart(0, options),
        apiRequest(1, options, { model: 'model-a' }),
        apiRequest(2, options, { model: 'model-b', query_source: 'synthetic-child', effort: 'high' })
      ])
    );
    if (!decoded) throw new Error('synthetic_decode_failed');
    expect(ingestOtelLogs(store, options.processId, decoded, profile, () => at(3))).toBe('committed');
    expect(ingestOtelLogs(store, options.processId, decoded, profile, () => at(4))).toBe('committed');
    expect(store.eventCount()).toBe(2);
    const records = store
      .all<{ payload: string }>("SELECT payload FROM otel_records WHERE event_type='api_request' ORDER BY sequence")
      .map(row => JSON.parse(row.payload) as { model: string; query_source_category: string });
    expect(records.map(row => row.model)).toEqual(['model-a', 'model-b']);
    expect(records.map(row => row.query_source_category)).toEqual(['main', 'other']);
    expect(JSON.stringify(records)).not.toContain('effort');
    expect(store.all('SELECT parent_id FROM sessions')).toEqual([{ parent_id: null }]);
    expect(store.all('SELECT * FROM runtime_evidence')).toEqual([]);
    // The journal currently rejects v2 metadata before registration.
    life.createTask('project-1', 'task-v2', {
      schema_version: 2,
      type: 'feature',
      expected_size: 'small',
      assignee: 'user-1',
      product: 'claude_code',
      initial_model: null,
      criterion_ids: ['criterion-1']
    });
    life.start('task-v2');
    expect(() =>
      registerOtelProcess(
        store,
        { runId: 'run-2', processId: 'process-2', taskId: 'task-v2', sessionId: 'session-v2', productVersion: syntheticVersion },
        profile,
        at(0)
      )
    ).toThrow('otel_scope_revoked');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('synthetic_task_assignment_is_durable_across_two_roots_retry_and_finalization', () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-assignment-verification-'));
  const path = join(root, 'allocation.sqlite');
  const store = new Store(path);
  try {
    const f = seedFlexibleComparison(store);
    const receipt = assignTask(store, { ...f.input, alias_ids: ['synthetic-issue-1'] }, { clock: () => at(0) });
    expect(store.get<{ state: string }>("SELECT state FROM tasks WHERE id='task-1'")?.state).toBe('registered');
    store.execute("UPDATE tasks SET state='active',started_at=? WHERE id='task-1'", [at(0)]);
    for (const session of ['root-1', 'root-2'])
      store.execute("INSERT INTO sessions(id,project_id,task_id,product,product_version) VALUES (?,'project-1','task-1','synthetic','1.0.0')", [session]);
    new Lifecycle(store, () => at(3)).finalize('task-1', 'success', ['criterion-1']);
    const reopened = new Store(path);
    try {
      const replay = assignTask(reopened, { ...f.input, task_id: 'retry-task', logical_task_id: 'synthetic-issue-1' }, { clock: () => at(4) });
      expect(replay).toMatchObject({ assignment_id: receipt.assignment_id, assigned_variant_id: receipt.assigned_variant_id, reused: true });
      expect(
        reopened.get<{ next_index: number }>('SELECT next_index FROM comparison_allocation_state WHERE stratum_id=?', ['stratum-user-1'])?.next_index
      ).toBe(1);
      expect(reopened.all('SELECT * FROM comparison_assignments')).toHaveLength(1);
    } finally {
      reopened.close();
    }
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
