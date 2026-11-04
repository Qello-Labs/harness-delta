import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { Store } from '../src/store.js';
import { Lifecycle } from '../src/lifecycle.js';
import { assignTask } from '../src/allocation.js';
import { bindConfigurationToSession, configurationHistory } from '../src/configuration-evidence.js';
import { confirmConfiguration } from '../src/config-confirmation-write.js';
import { Collector, readSource } from '../src/collection.js';
import { parseFlexibleSnapshot } from '../src/adapters-flexible.js';
import { lookupFileProfile, flexibleProductionProfiles } from '../src/adapter-profiles.js';
import { EventV2Schema, RuntimeEvidenceSchema, PriceTableSchema, CostFactsSchema } from '../src/flexible-contracts.js';
import type { EventV2 } from '../src/flexible-contracts.js';
import { putUsageWithEvidence, readRuntimeHistory } from '../src/runtime-history.js';
import { aggregateTaskCost } from '../src/metrics.js';
import { priceUsage, sumAmounts } from '../src/pricing.js';
import { captureFlexibleInput, projectFlexibleComparison } from '../src/reports/flexible-comparison.js';
import { seedFlexibleComparison } from './helpers/flexible-store.js';
import { jsonLines } from './helpers/collection-fixture.js';

const at = (seconds: number) => new Date(Date.parse('2026-01-01T00:00:00Z') + seconds * 1000).toISOString();
function usages(store: Store): EventV2[] {
  return store
    .all<{ id: string; source_key: string; project_id: string; task_id: string; session_id: string; occurred_at: string; payload: string }>(
      'SELECT id,source_key,project_id,task_id,session_id,occurred_at,payload FROM events ORDER BY occurred_at,id'
    )
    .map(row => EventV2Schema.parse({ ...row, payload: JSON.parse(row.payload) as unknown }));
}

// Assignment admits synthetic products only. These sources contain serialized
// synthetic accounting fixtures, NOT native transcripts or a native collector.
test.each(['collected', 'uncollected'] as const)('durable logical assignment survives %s original fixture loss and new root accounting', loss => {
  const root = mkdtempSync(join(tmpdir(), 'multi-root-assignment-'));
  const database = join(root, 'measurement.sqlite');
  let now = 0;
  let store = new Store(database, () => at(now));
  try {
    const f = seedFlexibleComparison(store);
    const input = { ...f.input, logical_task_id: 'github:example:repository:issue:42', alias_ids: ['issue-42'] };
    const first = assignTask(store, input, { clock: () => at(now), shuffle: values => values });
    const confirmation = (id: string) =>
      confirmConfiguration(
        store,
        {
          schema_version: 1,
          id,
          task_id: first.task_id,
          evidence_method: 'self_attested',
          actual_variant_id: first.assigned_variant_id,
          product: 'synthetic',
          product_version: '1.0.0',
          model: null,
          reasoning_setting: null,
          environment_id: 'environment-1'
        },
        at(now)
      );
    confirmation('confirmation-root-1');
    new Lifecycle(store, () => at(now)).start(first.task_id);
    const linkSynthetic = (sessionId: string, confirmationId: string) => {
      // Synthetic sessions have no native source_path. This is the existing
      // synthetic comparison fixture contract, not a bypass of native linking.
      store.execute('INSERT INTO sessions(id,task_id,project_id,product,product_version) VALUES (?,?,?,?,?)', [
        sessionId,
        first.task_id,
        'project-1',
        'synthetic',
        '1.0.0'
      ]);
      bindConfigurationToSession(store, confirmationId, sessionId);
    };
    linkSynthetic('session-1', 'confirmation-root-1');
    const firstSource = join(root, 'root-1.synthetic.json');
    writeFileSync(firstSource, JSON.stringify({ event: f.events[0], runtime: f.runtime[0] }));
    const ingestSynthetic = (path: string) => {
      const row = JSON.parse(readFileSync(path, 'utf8')) as { event: unknown; runtime: unknown };
      return putUsageWithEvidence(store, EventV2Schema.parse(row.event), RuntimeEvidenceSchema.parse(row.runtime));
    };
    now = 4;
    if (loss === 'collected') expect(ingestSynthetic(firstSource)).toBe(true);
    rmSync(firstSource); // Only this test's disposable source; ledger remains.
    store.close();
    now = 6;
    store = new Store(database, () => at(now));
    const retry = assignTask(
      store,
      { ...input, task_id: 'new-root-request', logical_task_id: 'issue-42', alias_ids: ['continuation-alias'] },
      {
        clock: () => at(now),
        shuffle: () => {
          throw new Error('must_not_rerandomize');
        }
      }
    );
    expect(retry).toMatchObject({
      assignment_id: first.assignment_id,
      task_id: first.task_id,
      assigned_variant_id: first.assigned_variant_id,
      reused: true,
      allocation_index: first.allocation_index
    });
    expect(store.get<{ next_index: number }>('SELECT next_index FROM comparison_allocation_state WHERE stratum_id=?', ['stratum-user-1'])?.next_index).toBe(1);
    expect(store.all('SELECT id FROM tasks')).toHaveLength(1);
    const report = () =>
      projectFlexibleComparison(captureFlexibleInput(store, f.protocol.id, 'continuation-report', at(now), at(now), 1, 'initial', null)).tasks[0]!;
    expect(report().cost).toMatchObject({ partial_amount: loss === 'collected' ? '0.26' : null, complete_amount: null, usage_complete: false });
    if (loss === 'uncollected') expect(report().cost.reasons).toContain('missing_value');
    confirmation('confirmation-root-2');
    linkSynthetic('session-2', 'confirmation-root-2');
    const runtime2 = RuntimeEvidenceSchema.parse({
      ...f.runtime[0],
      id: 'runtime-2',
      session_id: 'session-2',
      model: 'other-model',
      occurred_at: at(7),
      recorded_at: at(8)
    });
    const original = f.events[0]!;
    const event2 = EventV2Schema.parse({
      ...original,
      id: 'event-2',
      source_key: 'event-2',
      session_id: 'session-2',
      occurred_at: at(9),
      payload: { ...original.payload, model: runtime2.model, runtime_evidence_id: runtime2.id }
    });
    const table = PriceTableSchema.parse({
      ...f.priceTable,
      entries: [...f.priceTable.entries, ...f.priceTable.entries.map(entry => ({ ...entry, model: 'other-model' }))]
    });
    // A separately registered fictional rate table; protocol table stays immutable.
    const secondSource = join(root, 'root-2.synthetic.json');
    writeFileSync(secondSource, JSON.stringify({ event: event2, runtime: runtime2 }));
    now = 10;
    expect(ingestSynthetic(secondSource)).toBe(true);
    expect(ingestSynthetic(secondSource)).toBe(false);
    if (loss === 'collected') expect(putUsageWithEvidence(store, original, f.runtime[0]!)).toBe(false);
    expect(usages(store).map(event => [event.task_id, event.session_id, event.payload.model])).toEqual([
      ...(loss === 'collected' ? [['task-1', 'session-1', 'synthetic-model']] : []),
      ['task-1', 'session-2', 'other-model']
    ]);
    expect(readRuntimeHistory(store, first.task_id, at(20)).map(runtime => runtime.session_id)).toEqual([
      ...(loss === 'collected' ? ['session-1'] : []),
      'session-2'
    ]);
    expect(configurationHistory(store, first.task_id).confirmations.map(record => record.session_ids)).toEqual([['session-1'], ['session-2']]);
    const captured = captureFlexibleInput(store, f.protocol.id, 'continuation-report', at(now), at(now), 1, 'initial', null);
    const priced = projectFlexibleComparison({ ...captured, price_table: table }).tasks[0]!;
    expect(priced).toMatchObject({
      assignment_id: first.assignment_id,
      original_variant_id: first.assigned_variant_id,
      cost: { partial_amount: loss === 'collected' ? '0.52' : '0.26', complete_amount: null, usage_complete: false }
    });
    expect(priced.cost.partial_amount).toBe(sumAmounts(usages(store).map(event => priceUsage(event, table).partial_amount!)));
    expect(priced.cost.reasons).toContain('unsupported_profile');
    expect(captured.assignments[0]!.coverage.profile_id).toBe('unsupported-production-cost');
    expect(captured.assignments[0]!.coverage.facts.continuous_observation).toBe('unknown');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// Native-shaped candidate files exercise the real reader/collector/store APIs.
// The parser resolver is injected explicitly: production does not admit it.
test.each(['collected', 'uncollected'] as const)('Codex candidate multiple roots retain %s source-loss semantics after collector restart', loss => {
  const root = mkdtempSync(join(tmpdir(), 'multi-root-codex-'));
  const database = join(root, 'measurement.sqlite');
  let now = 0;
  let store = new Store(database, () => at(now));
  const clock = () => at(now);
  const path = (id: string) => join(root, `${id}.jsonl`);
  const header = (id: string) => ({ type: 'session_meta', payload: { id, cwd: root, source: 'exec', cli_version: '0.158.0' } });
  // Equal turn IDs and counters in independent roots are separate observations.
  const turn = (start: number, model: string) => [
    { type: 'turn_context', timestamp: at(start), payload: { turn_id: 'turn-shared', root_turn_id: 'turn-shared', cwd: root, model } },
    {
      type: 'event_msg',
      timestamp: at(start + 1),
      payload: {
        type: 'token_count',
        info: { total_token_usage: { input_tokens: 130, cached_input_tokens: 20, cache_write_input_tokens: 10, output_tokens: 10, reasoning_output_tokens: 0 } }
      }
    },
    { type: 'event_msg', timestamp: at(start + 1), payload: { type: 'task_complete', turn_id: 'turn-shared' } }
  ];
  const collector = () =>
    new Collector(store, clock, readSource, (product, version) => (product === 'codex' && version === '0.158.0' ? parseFlexibleSnapshot : null));
  const coverage = () => ({
    profile_id: 'unsupported-production-cost',
    task_id: 't1',
    window_start: at(0),
    window_end: at(20),
    facts: CostFactsSchema.parse(Object.fromEntries(Object.keys(CostFactsSchema.shape).map(key => [key, 'unknown']))),
    has_observed_value: usages(store).length > 0
  });
  const table = PriceTableSchema.parse({
    id: 'fictional-codex-rates',
    version: 'fixture-v1',
    currency: 'USD',
    source_id: 'fictional-offline-fixture',
    as_of: at(0),
    unit_tokens: 1000,
    display_decimals: 2,
    rounding: 'half_even',
    entries: ['model-a', 'model-b'].flatMap(model =>
      [
        ['ordinary_input', '2'],
        ['cache_read', '1'],
        ['cache_write', '3'],
        ['output', '4']
      ].map(([component, price_per_unit]) => ({ product: 'codex', model, component, price_per_unit }))
    )
  });
  try {
    let life = new Lifecycle(store, clock);
    life.registerProject('p1', root);
    life.createTask('p1', 't1', {
      schema_version: 2,
      type: 'feature',
      expected_size: 'small',
      assignee: 'u1',
      product: 'codex',
      initial_model: null,
      criterion_ids: ['c1']
    });
    writeFileSync(path('root-1'), jsonLines([header('root-1')]));
    life.linkSession('t1', 'root-1', path('root-1'), 'codex', '0.158.0');
    life.start('t1');
    const firstCollector = collector();
    expect(firstCollector.tick('t1')).toEqual([]);
    writeFileSync(path('root-1'), jsonLines([header('root-1'), ...turn(1, 'model-a')]));
    now = 3;
    if (loss === 'collected') expect(firstCollector.tick('t1')).toEqual([]);
    rmSync(path('root-1'));
    store.close();
    now = 6;
    store = new Store(database, clock);
    life = new Lifecycle(store, clock);
    const read = vi.fn(readSource);
    const blocked = new Collector(store, clock, read);
    expect(blocked.tick('t1')).toMatchObject([{ session_id: 'root-1', category: 'unsupported_source' }]);
    expect(read).not.toHaveBeenCalled();
    writeFileSync(path('root-2'), jsonLines([header('root-2')]));
    life.linkSession('t1', 'root-2', path('root-2'), 'codex', '0.158.0');
    const restarted = collector();
    expect(restarted.tick('t1')).toMatchObject([{ session_id: 'root-1', category: 'read_failed' }]);
    expect(aggregateTaskCost(usages(store), table, coverage())).toMatchObject({
      partial_amount: null,
      ...(loss === 'collected' ? { legacy_unverified_partial_amount: '0.29' } : {}),
      complete_amount: null
    });
    if (loss === 'uncollected') expect(aggregateTaskCost(usages(store), table, coverage()).reasons).toContain('missing_value');
    writeFileSync(path('root-2'), jsonLines([header('root-2'), ...turn(7, 'model-b')]));
    now = 9;
    expect(restarted.tick('t1')).toMatchObject([{ session_id: 'root-1', category: 'read_failed' }]);
    restarted.tick('t1'); // Replayed snapshot must not increase totals.
    const persisted = usages(store);
    expect(persisted.map(event => [event.task_id, event.session_id, event.payload.model, event.payload.input_total.value])).toEqual([
      ...(loss === 'collected' ? [['t1', 'root-1', 'model-a', 130]] : []),
      ['t1', 'root-2', 'model-b', 130]
    ]);
    expect(new Set(persisted.map(event => event.source_key)).size).toBe(persisted.length);
    expect(readRuntimeHistory(store, 't1', at(20)).map(runtime => [runtime.session_id, runtime.model])).toEqual([
      ...(loss === 'collected' ? [['root-1', 'model-a']] : []),
      ['root-2', 'model-b']
    ]);
    for (const event of persisted) {
      expect(event.payload.attribution).toBe('verified');
      // Runtime attribution does not qualify an injected candidate file parser.
      expect(event.payload.source_compatibility).toBeUndefined();
      expect(
        putUsageWithEvidence(
          store,
          event,
          readRuntimeHistory(store, 't1', at(20)).find(runtime => runtime.id === event.payload.runtime_evidence_id)!
        )
      ).toBe(false);
    }
    const cost = aggregateTaskCost(persisted, table, coverage());
    expect(cost).toMatchObject({
      partial_amount: null,
      legacy_unverified_partial_amount: loss === 'collected' ? '0.58' : '0.29',
      complete_amount: null,
      usage_complete: false,
      price_complete: false,
      compatibility: { verified_events: 0, legacy_unverified_events: loss === 'collected' ? 2 : 1 }
    });
    expect(cost.legacy_unverified_partial_amount).toBe(sumAmounts(persisted.map(event => priceUsage(event, table).partial_amount!)));
    expect(cost.reasons).toContain('unsupported_profile');
    expect(store.all("SELECT reason FROM observations WHERE status='error'")).toContainEqual({ reason: 'source_error' });
    expect(store.all("SELECT session_id,reason FROM observation_gaps WHERE reason='offline' ORDER BY session_id")).toEqual([
      { session_id: 'root-1', reason: 'offline' },
      { session_id: 'root-2', reason: 'offline' }
    ]);
    expect(store.all<{ parent_id: string | null }>('SELECT parent_id FROM sessions').every(session => session.parent_id === null)).toBe(true);
    expect(life.state('t1')).toBe('active');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('conditional version selection preserves registration, native assignment and fork gates', () => {
  const root = mkdtempSync(join(tmpdir(), 'multi-root-gates-'));
  const store = new Store(':memory:');
  try {
    const f = seedFlexibleComparison(store);
    expect(() => assignTask(store, { ...f.input, metadata: { ...f.metadata, product: 'codex' } }, { clock: () => at(0) })).toThrow('synthetic_only');
    expect(flexibleProductionProfiles).toEqual([]);
    expect(lookupFileProfile('codex', '0.160.0')).toBe('unsupported');
    expect(() => new Lifecycle(store).linkSession('unregistered-task', 'native-root', join(root, 'never-created.jsonl'), 'codex', '0.160.0')).toThrow(
      'unknown_task'
    );
    expect(() => new Lifecycle(store).linkSession('unregistered-task', 'outside-window', join(root, 'never-created.jsonl'), 'codex', '0.164.0')).toThrow(
      'unsupported'
    );
    expect(store.all('SELECT id FROM sessions')).toEqual([]);
    const scope = { taskId: 't1', projectId: 'p1', sessionId: 's1', projectRoot: root, product: 'codex' as const, version: '0.158.0' };
    expect(() =>
      parseFlexibleSnapshot(
        jsonLines([{ type: 'session_meta', payload: { id: 's1', cwd: root, source: 'exec', cli_version: '0.158.0', forked_from_id: 'parent' } }]),
        scope,
        at(0)
      )
    ).toThrow('unsupported');
    const child = parseFlexibleSnapshot(
      jsonLines([
        { type: 'session_meta', payload: { id: 's1', cwd: root, source: 'exec', cli_version: '0.158.0' } },
        { type: 'turn_context', timestamp: at(1), payload: { turn_id: 'child-turn', root_turn_id: 'parent-turn', cwd: root, model: 'model-a' } }
      ]),
      scope,
      at(2)
    );
    expect(child).toMatchObject({ blocked: true, records: [], gaps: [{ reason: 'unknown_parent' }] });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
