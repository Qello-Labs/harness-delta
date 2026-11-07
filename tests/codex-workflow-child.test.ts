import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import * as collection from '../src/sources/collection.js';
import {
  createCodexWorkflowAdapter,
  createSyntheticCodexWorkflowAdapter,
  pinnedCodexWorkflowBinarySha,
  runCodexQualificationPhase
} from '../src/codex-workflow-adapter.js';
import { stopCodexWorkflow } from '../src/workflow/codex-workflow-journal.js';
import { runAssignedWorkflow } from '../src/workflow/task-workflow.js';
import { Deletion } from '../src/deletion.js';
import { Store } from '../src/store.js';
import { registerPriceTable } from '../src/pricing/pricing.js';
import { readObservedCostReport } from '../src/pricing/observed-cost-report.js';
import { codexWorkflowFixture } from './helpers/codex-workflow-fixture.js';

const runtime = { model: null, effort: null };
function familyRates(store: Store) {
  registerPriceTable(store, {
    id: 'family-reference',
    version: 'v1',
    currency: 'USD',
    source_id: 'synthetic-reference',
    as_of: '2026-01-01T00:00:00Z',
    unit_tokens: 100,
    display_decimals: 6,
    rounding: 'half_even',
    entries: ['root-choice', 'child-choice'].flatMap(model => [
      { product: 'synthetic' as const, model, component: 'ordinary_input' as const, price_per_unit: '1' },
      { product: 'synthetic' as const, model, component: 'cache_read' as const, price_per_unit: '2' },
      { product: 'synthetic' as const, model, component: 'cache_write' as const, price_per_unit: '3' },
      { product: 'synthetic' as const, model, component: 'output' as const, price_per_unit: '4' }
    ])
  });
}
function family() {
  const f = codexWorkflowFixture();
  const root = f.newRoot();
  const child = { id: randomUUID(), path: join(f.home, 'sessions', 'child.jsonl') };
  writeFileSync(
    child.path,
    JSON.stringify({
      type: 'session_meta',
      payload: {
        id: child.id,
        session_id: root.id,
        parent_thread_id: root.id,
        cli_version: '0.160.0',
        cwd: f.project,
        source: { subagent: { thread_spawn: { parent_thread_id: root.id, depth: 1 } } }
      }
    }) + '\n'
  );
  const execution = (id: string, operation: 'link' | 'collect') => ({
    ...f.execution(id, operation, root.id, root.path),
    direct_child: { session_id: child.id, source_path: child.path }
  });
  const append = (badChild = false) => {
    const turn = randomUUID();
    const childTurn = randomUUID();
    const at = new Date().toISOString();
    const row = (type: string, payload: unknown) => JSON.stringify({ timestamp: at, type, payload }) + '\n';
    const response = (id: string, ownTurn: string, responseId: string) =>
      row('token_usage_record', {
        thread_id: id,
        session_id: root.id,
        turn_id: ownTurn,
        root_turn_id: turn,
        response_id: responseId,
        usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3, reasoning_output_tokens: 1, total_tokens: 13 }
      });
    const rootRequest = randomUUID();
    appendFileSync(
      root.path,
      row('turn_context', { cwd: f.project, turn_id: turn, model: 'root-choice', effort: 'low', multi_agent_version: 'v2' }) +
        response(root.id, turn, rootRequest)
    );
    appendFileSync(
      child.path,
      row('turn_context', { cwd: f.project, turn_id: childTurn, root_turn_id: turn, model: 'child-choice', effort: 'high', multi_agent_version: 'v2' }) +
        response(child.id, childTurn, badChild ? rootRequest : randomUUID())
    );
  };
  const run = (id: string, operation: 'link' | 'collect') =>
    runAssignedWorkflow(
      f.store,
      { ...f.input, confirmation_id: `confirmation-${id}` },
      createSyntheticCodexWorkflowAdapter(f.store, execution(id, operation), f.script),
      runtime
    );
  return { ...f, rootSession: root, childSession: child, execution, append, run };
}
test('explicit root and direct child keep one sticky assignment, observe future own usage and replay zero', async () => {
  const f = family();
  try {
    const linked = await f.run('family-link', 'link');
    expect(linked.adapter_result).toMatchObject({ state: 'completed', observed_requests: 0 });
    const observing = f.run('family-collect', 'collect');
    await vi.waitFor(() => expect(f.store.get('SELECT scope_verified FROM codex_workflow_runs WHERE id=?', ['family-collect'])).toEqual({ scope_verified: 1 }));
    f.append();
    await vi.waitFor(() => expect(f.store.eventCount()).toBe(2));
    stopCodexWorkflow(f.store, 'family-collect');
    const result = await observing;
    expect(result.adapter_result).toMatchObject({ state: 'stopped', observed_requests: 2 });
    expect(f.store.all('SELECT parent_id FROM sessions ORDER BY parent_id')).toEqual([{ parent_id: null }, { parent_id: f.rootSession.id }]);
    expect(f.store.all('SELECT task_id FROM comparison_assignments')).toHaveLength(1);
    expect(f.store.all('SELECT payload FROM runtime_evidence').map(r => JSON.parse((r as { payload: string }).payload) as unknown)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ model: 'root-choice', effort: 'low' }),
        expect.objectContaining({ model: 'child-choice', effort: 'high' })
      ])
    );
    familyRates(f.store);
    const cost = readObservedCostReport(f.store, 'task-1', 'family-reference', new Date(Date.now() + 1000).toISOString(), 'output-only-v1');
    expect(cost).toMatchObject({
      event_count: 2,
      session_count: 2,
      partial_amount: '0.48',
      complete_amount: null,
      coverage: { observed_components_priced: true, evidence: { facts: { price_coverage: 'unknown', request_universe: 'unknown' } } }
    });
    const reopened = new Store(f.database);
    try {
      expect(
        (
          await runAssignedWorkflow(
            reopened,
            { ...f.input, confirmation_id: 'confirmation-family-replay' },
            createSyntheticCodexWorkflowAdapter(reopened, f.execution('family-replay', 'link'), f.script),
            runtime
          )
        ).adapter_result
      ).toMatchObject({ state: 'completed', observed_requests: 0 });
    } finally {
      reopened.close();
    }
    expect(f.store.eventCount()).toBe(2);
  } finally {
    f.cleanup();
  }
});
test('a child request collision rolls back root and child tick while preserving prior partial usage', async () => {
  const f = family();
  try {
    await f.run('collision-link', 'link');
    const observing = f.run('collision-collect', 'collect');
    await vi.waitFor(() =>
      expect(f.store.get('SELECT scope_verified FROM codex_workflow_runs WHERE id=?', ['collision-collect'])).toEqual({ scope_verified: 1 })
    );
    f.append();
    await vi.waitFor(() => expect(f.store.eventCount()).toBe(2));
    f.append(true);
    expect((await observing).adapter_result?.state).toBe('failed');
    expect(f.store.eventCount()).toBe(2);
    expect(f.store.all('SELECT id FROM runtime_evidence')).toHaveLength(2);
    familyRates(f.store);
    expect(readObservedCostReport(f.store, 'task-1', 'family-reference', new Date(Date.now() + 1000).toISOString(), 'output-only-v1')).toMatchObject({
      event_count: 2,
      excluded_event_count: 0,
      partial_amount: '0.48',
      complete_amount: null
    });
  } finally {
    f.cleanup();
  }
});
test('a mutable input cannot add child access after selecting the qualified root profile', async () => {
  const f = family();
  try {
    const input: { direct_child?: { session_id: string; source_path: string } } & Omit<ReturnType<typeof f.execution>, 'direct_child'> = {
      ...f.execution('mutation', 'link'),
      binary: { ...f.execution('mutation', 'link').binary, sha256: pinnedCodexWorkflowBinarySha }
    };
    delete input.direct_child;
    const adapter = createCodexWorkflowAdapter(f.store, input);
    input.direct_child = { session_id: f.childSession.id, source_path: f.childSession.path };
    const assertActive = vi.fn(() => {
      throw new Error('review_execute_reached');
    });
    await expect(
      adapter.run({
        taskId: 'unused',
        projectId: 'unused',
        projectRoot: f.project,
        generation: 0,
        assignedVariantId: 'unused',
        confirmationId: 'unused',
        instructionManifestHash: 'unused',
        runtime,
        instructions: [],
        assertActive
      })
    ).rejects.toThrow('codex_workflow_child_operation_unsupported');
    expect(assertActive).not.toHaveBeenCalled();
    expect(f.store.all('SELECT id FROM codex_workflow_runs')).toHaveLength(0);
  } finally {
    f.cleanup();
  }
});
test('the reserved root qualification lease rejects an added direct child before its execution guard', async () => {
  const f = family();
  const store = new Store(':memory:');
  try {
    store.execute(
      'CREATE TABLE codex_workflow_qualification(singleton INTEGER PRIMARY KEY,intent_sha256 TEXT,reserved INTEGER,deadline INTEGER,project_id TEXT,task_id TEXT,cwd TEXT,codex_home TEXT,binary_path TEXT,binary_sha TEXT,hook_recorder TEXT,manifest_hash TEXT,validation_kind TEXT,fixture_script TEXT,phase TEXT,session_id TEXT)',
      []
    );
    const e = { ...f.execution('qualification-replay', 'collect'), sandbox: 'read-only' as const };
    const deadline = Date.now() + 10000;
    const manifest = createHash('sha256').update('[]').digest('hex');
    const intent = 'a'.repeat(64);
    store.execute('INSERT INTO codex_workflow_qualification VALUES (1,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?)', [
      intent,
      deadline,
      'p',
      't',
      f.project,
      f.home,
      e.binary.path,
      e.binary.sha256,
      e.hook_recorder,
      manifest,
      'synthetic',
      f.script,
      'replay',
      f.rootSession.id
    ]);
    const assertActive = vi.fn(() => {
      throw new Error('review_lease_accepted');
    });
    await expect(
      runCodexQualificationPhase(
        store,
        e,
        {
          taskId: 't',
          projectId: 'p',
          projectRoot: f.project,
          generation: 0,
          assignedVariantId: 'unused',
          confirmationId: 'unused',
          instructionManifestHash: manifest,
          runtime,
          instructions: [],
          assertActive
        },
        { intent_sha256: intent, deadline, expectedMarker: null, fixtureScript: f.script }
      )
    ).rejects.toThrow('codex_qualification_child_unqualified');
    expect(assertActive).not.toHaveBeenCalled();
    expect(store.all('SELECT id FROM codex_workflow_runs')).toHaveLength(0);
  } finally {
    store.close();
    f.cleanup();
  }
});
test('an earlier disabled root turn does not prevent its later explicitly mapped direct child', async () => {
  const f = family();
  try {
    f.appendUsage(f.rootSession, 'earlier-model');
    expect((await f.run('historical-disabled', 'link')).adapter_result).toMatchObject({ state: 'completed', observed_requests: 0 });
    const observing = f.run('historical-family-collect', 'collect');
    await vi.waitFor(() =>
      expect(f.store.get('SELECT scope_verified FROM codex_workflow_runs WHERE id=?', ['historical-family-collect'])).toEqual({ scope_verified: 1 })
    );
    f.append();
    await vi.waitFor(() => expect(f.store.eventCount()).toBe(2));
    stopCodexWorkflow(f.store, 'historical-family-collect');
    expect((await observing).adapter_result).toMatchObject({ state: 'stopped', observed_requests: 2 });
  } finally {
    f.cleanup();
  }
});
test.each(['fork', 'compaction', 'deeper'])('explicit family rejects unsupported %s without usage', async mode => {
  const f = family();
  try {
    if (mode === 'fork') appendFileSync(f.childSession.path, JSON.stringify({ type: 'session_meta', payload: { forked_from_id: f.rootSession.id } }) + '\n');
    else
      appendFileSync(
        f.childSession.path,
        JSON.stringify({
          type: mode === 'compaction' ? 'compacted' : 'event_msg',
          payload: { type: 'sub_agent_activity', kind: 'started', agent_thread_id: randomUUID() }
        }) + '\n'
      );
    expect((await f.run(`reject-${mode}`, 'link')).adapter_result?.state).toBe('failed');
    expect(f.store.eventCount()).toBe(0);
  } finally {
    f.cleanup();
  }
});
test('production external child link remains unsupported before source access', async () => {
  const f = family();
  const read = vi.spyOn(collection, 'readSource');
  try {
    const execution = f.execution('unqualified', 'link');
    const adapter = createCodexWorkflowAdapter(f.store, { ...execution, binary: { ...execution.binary, sha256: pinnedCodexWorkflowBinarySha } });
    await expect(
      adapter.run({
        taskId: 'unused',
        projectId: 'unused',
        projectRoot: f.project,
        generation: 0,
        assignedVariantId: 'unused',
        confirmationId: 'unused',
        instructionManifestHash: 'unused',
        runtime,
        instructions: [],
        assertActive: () => {}
      })
    ).rejects.toThrow('codex_workflow_child_operation_unsupported');
    expect(read).not.toHaveBeenCalled();
    expect(f.store.all('SELECT id FROM codex_workflow_runs')).toHaveLength(0);
  } finally {
    read.mockRestore();
    f.cleanup();
  }
});
test('a tombstoned child blocks the entire family before the root source is read', async () => {
  const f = family();
  const read = vi.spyOn(collection, 'readSource');
  try {
    f.store.execute("INSERT INTO tombstones(kind,id,deleted_at) VALUES ('session',?,?)", [f.childSession.id, new Date().toISOString()]);
    expect((await f.run('deleted-child', 'link')).adapter_result?.state).toBe('failed');
    expect(read).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
    f.cleanup();
  }
});
test('a rewritten child prefix across invocations fails rather than rebasing its history', async () => {
  const f = family();
  try {
    await f.run('prefix-link', 'link');
    appendFileSync(f.childSession.path, JSON.stringify({ type: 'response_item', payload: { synthetic: 'first' } }) + '\n');
    await f.run('prefix-checkpoint', 'link');
    const { readFileSync } = await import('node:fs');
    writeFileSync(f.childSession.path, readFileSync(f.childSession.path, 'utf8').replace('first', 'changed-and-longer'));
    expect((await f.run('prefix-reject', 'link')).adapter_result).toMatchObject({ state: 'failed', reason: 'source_changed' });
    expect(f.store.eventCount()).toBe(0);
  } finally {
    f.cleanup();
  }
});
test('task deletion removes family journals and prevents its mappings returning', async () => {
  const f = family();
  try {
    await f.run('delete-link', 'link');
    expect(f.store.all('SELECT session_id FROM codex_workflow_children')).toHaveLength(1);
    new Deletion(f.store).deleteTask('task-1');
    expect(f.store.all('SELECT id FROM codex_workflow_runs')).toHaveLength(0);
    expect(f.store.all('SELECT session_id FROM codex_workflow_children')).toHaveLength(0);
    await expect(f.run('deleted-task-link', 'link')).rejects.toThrow();
    expect(f.store.all('SELECT id FROM sessions')).toHaveLength(0);
  } finally {
    f.cleanup();
  }
});
