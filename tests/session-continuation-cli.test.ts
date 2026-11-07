import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, test } from 'vitest';
import { Store } from '../src/store.js';
import type { TaskReport } from '../src/pricing/metrics.js';
import type { AssignmentReceipt } from '../src/comparison/allocation.js';
import { makeFlexibleFixture } from './helpers/flexible-fixture.js';
import { assignmentInput, beforeRecruitment, seedProject } from './helpers/comparison-fixture.js';
import { registerVariant, registerProtocol, freezeProtocol } from '../src/comparison/comparison.js';
import { registerPriceTable } from '../src/pricing/pricing.js';
import { compiledWorker } from './helpers/compiled-worker.js';
import { jsonLines } from './helpers/collection-fixture.js';

/** Only the local measurement CLI is spawned; no product executable/model call. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'session-continuation-cli-'));
  const compiled = compiledWorker(root);
  const database = join(root, 'measurement.sqlite');
  const children = new Set<ChildProcess>();
  const launch = (args: string[]) => {
    const child = spawn(process.execPath, [join(compiled, 'cli.js'), '--db', database, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (value: Buffer) => {
      stdout += value.toString();
    });
    child.stderr.on('data', (value: Buffer) => {
      stderr += value.toString();
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        children.delete(child);
        resolve({ code, signal, stdout, stderr });
      });
    });
    return { child, exited };
  };
  const run = async (args: string[], expectedCode = 0) => {
    const process = launch(args);
    const result = await process.exited;
    expect(result.code, result.stderr + result.stdout).toBe(expectedCode);
    expect(result.signal).toBeNull();
    return result.stdout;
  };
  const inspect = <T>(read: (store: Store) => T): T => {
    const store = new Store(database);
    try {
      return read(store);
    } finally {
      store.close();
    }
  };
  const waitFor = async (condition: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!condition()) {
      if (Date.now() >= deadline) throw new Error('metadata_readiness_timeout');
      await delay(10);
    }
  };
  const count = () => inspect(store => store.eventCount());
  const baseline = (id: string) => inspect(store => store.get<{ checkpoint: string }>('SELECT checkpoint FROM cursors WHERE session_id=?', [id]));
  const collect = () => launch(['collect', '--task', 't1', '--interval', '100']);
  const stop = async (process: ReturnType<typeof launch>, missingSource?: string) => {
    process.child.kill('SIGTERM');
    const result = await process.exited;
    expect(result).toMatchObject({ code: 0, signal: null, stderr: '' });
    if (missingSource) {
      const lines = result.stdout.trim().split('\n');
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines)
        expect(JSON.parse(line) as unknown).toEqual({
          collection_diagnostics: [
            {
              session_id: missingSource,
              at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/) as unknown,
              category: 'read_failed'
            }
          ]
        });
      expect(result.stdout).not.toContain(root);
    } else expect(result.stdout).toBe('');
  };
  const append = (id: string, rows: unknown[]) => appendFileSync(join(root, `${id}.jsonl`), jsonLines(rows));
  const header = (id: string, extra = {}) => ({
    type: 'session_meta',
    payload: {
      id,
      session_id: id,
      cwd: root,
      source: 'exec',
      cli_version: '0.158.0',
      ...extra
    }
  });
  const link = async (id: string, extra = {}) => {
    writeFileSync(join(root, `${id}.jsonl`), jsonLines([header(id, extra)]));
    await run(['session', 'link', id, '--task', 't1', '--source', join(root, `${id}.jsonl`), '--product', 'codex', '--version', '0.158.0']);
  };
  const turn = (id: string, input: number, output: number, at = new Date().toISOString()) => [
    { timestamp: at, type: 'event_msg', payload: { type: 'task_started', turn_id: id } },
    {
      timestamp: at,
      type: 'turn_context',
      payload: { turn_id: id, root_turn_id: id, model: 'synthetic', cwd: root, collaboration_mode: { mode: 'default' }, multi_agent_version: 'v1' }
    },
    {
      timestamp: at,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: input,
            output_tokens: output,
            cached_input_tokens: 0,
            cache_write_input_tokens: 0,
            reasoning_output_tokens: 0
          }
        }
      }
    },
    { timestamp: at, type: 'event_msg', payload: { type: 'task_complete', turn_id: id } }
  ];
  const afterBaseline = async (id: string) => {
    await waitFor(() => baseline(id) !== undefined);
    const checkpoint = JSON.parse(baseline(id)!.checkpoint) as { since: string };
    await waitFor(() => Date.now() > Date.parse(checkpoint.since));
  };
  const register = async () => {
    await run(['project', 'add', 'p1', '--root', root]);
    await run([
      'task',
      'register',
      't1',
      '--project',
      'p1',
      '--type',
      'feature',
      '--size',
      'small',
      '--assignee',
      'u1',
      '--product',
      'codex',
      '--model',
      'synthetic',
      '--criteria',
      'c1'
    ]);
    await run(['task', 'start', 't1']);
  };
  const report = async () => JSON.parse(await run(['report', 'task', 't1', '--cutoff', new Date().toISOString()])) as TaskReport;
  const cleanup = async () => {
    for (const child of children) child.kill('SIGKILL');
    if (children.size)
      await Promise.all(
        [...children].map(
          child =>
            new Promise<void>(resolve => {
              child.once('exit', () => resolve());
            })
        )
      );
    rmSync(root, { recursive: true, force: true });
  };
  return { root, database, run, inspect, waitFor, count, baseline, collect, stop, append, link, turn, afterBaseline, register, report, cleanup };
}

// This is the admitted partial file path, not native flexible A/B admission.
test.each(['collected', 'uncollected'] as const)(
  'CLI processes retain %s original-source usage across explicit new roots, restart and rework',
  async loss => {
    const f = fixture();
    try {
      await f.register();
      await f.link('root-1');
      const first = f.collect();
      await f.afterBaseline('root-1');
      if (loss === 'collected') {
        f.append('root-1', f.turn('same-turn', 100, 10));
        await f.waitFor(() => f.count() === 1);
      }
      await f.stop(first);
      if (loss === 'uncollected') f.append('root-1', f.turn('same-turn', 100, 10));
      // This disposable file alone is removed; the durable task/ledger is retained.
      rmSync(join(f.root, 'root-1.jsonl'));
      await f.link('root-2');
      f.append('root-2', f.turn('offline-turn', 200, 20));
      const second = f.collect();
      await f.afterBaseline('root-2');
      expect((await f.report()).usage).toMatchObject({
        status: loss === 'collected' ? 'partial' : 'missing',
        partial_tokens: loss === 'collected' ? 110 : null,
        complete_tokens: null
      });
      f.append('root-2', f.turn('same-turn', 300, 30));
      const initialCount = loss === 'collected' ? 2 : 1;
      await f.waitFor(() => f.count() === initialCount);
      const eligible = f.inspect(store => store.all('SELECT source_key,session_id,payload FROM events ORDER BY session_id'));
      expect(new Set(eligible.map(row => (row as { source_key: string }).source_key)).size).toBe(initialCount);
      // Replay the exact same native-shaped snapshot; no second usage delta.
      const snapshot = readFileSync(join(f.root, 'root-2.jsonl'), 'utf8');
      const observationCount = f.inspect(store => store.all('SELECT id FROM observations').length);
      expect(readFileSync(join(f.root, 'root-2.jsonl'), 'utf8')).toBe(snapshot);
      await f.waitFor(() => f.inspect(store => store.all('SELECT id FROM observations').length) > observationCount);
      expect(f.count()).toBe(initialCount);
      expect((await f.report()).usage.reasons).toContain('source_error');
      await f.stop(second, 'root-1');
      f.append('root-2', f.turn('offline-restart', 400, 40));
      const oldCheckpoint = f.baseline('root-2')!.checkpoint;
      const third = f.collect();
      await f.waitFor(() => f.baseline('root-2')?.checkpoint !== oldCheckpoint);
      await f.afterBaseline('root-2');
      f.append('root-2', f.turn('new-after-restart', 450, 45));
      await f.waitFor(() => f.count() === initialCount + 1);
      await f.run(['task', 'pause', 't1']);
      f.append('root-2', f.turn('paused-turn', 550, 55));
      const beforeResume = f.baseline('root-2')!.checkpoint;
      await f.run(['task', 'resume', 't1']);
      await f.waitFor(() => f.baseline('root-2')?.checkpoint !== beforeResume);
      await f.afterBaseline('root-2');
      f.append('root-2', f.turn('new-after-resume', 575, 60));
      await f.waitFor(() => f.count() === initialCount + 2);
      await f.run(['task', 'first-complete', 't1']);
      await f.run(['task', 'assess-first', 't1', '--result', 'failed']);
      await f.run(['task', 'rework', 't1']);
      f.append('root-2', f.turn('rework-turn', 625, 65));
      await f.waitFor(() => f.count() === initialCount + 3);
      await f.stop(third, 'root-1');
      await f.run(['task', 'finalize', 't1', '--outcome', 'success', '--met', 'c1']);
      const report = await f.report();
      expect(report).toMatchObject({
        task_id: 't1',
        outcome: 'success',
        first_success: false,
        rework_count: 1,
        cost: null,
        usage: { status: 'partial', partial_tokens: loss === 'collected' ? 360 : 250, complete_tokens: null }
      });
      expect(report.usage.input_total.observed_events).toBe(initialCount + 3);
      expect(report.usage.reasons).toEqual(expect.arrayContaining(['offline', 'source_error', 'incomplete']));
      expect(f.inspect(store => store.all('SELECT id FROM tasks'))).toEqual([{ id: 't1' }]);
      expect(f.inspect(store => store.all('SELECT id FROM sessions ORDER BY id'))).toEqual([{ id: 'root-1' }, { id: 'root-2' }]);
      expect(JSON.stringify(report)).not.toContain(f.root);
    } finally {
      await f.cleanup();
    }
  },
  20000
);

test.each(['fork', 'child-activity'] as const)(
  'CLI excludes %s in a new explicit root while retaining earlier partial observations',
  async topology => {
    const f = fixture();
    try {
      await f.register();
      await f.link('root-1');
      const collector = f.collect();
      await f.afterBaseline('root-1');
      f.append('root-1', f.turn('turn-1', 100, 10));
      await f.waitFor(() => f.count() === 1);
      await f.link('root-2', topology === 'fork' ? { forked_from_id: 'root-1' } : {});
      await f.afterBaseline('root-2');
      const before = f.inspect(store => store.all('SELECT id FROM observations').length);
      if (topology === 'child-activity') f.append('root-2', [{ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'SubAgentActivity' } } }]);
      f.append('root-2', f.turn('child-turn', 999999, 999999));
      await f.waitFor(
        () =>
          f
            .inspect(store => store.all<{ reason: string }>('SELECT reason FROM observations'))
            .some(row => row.reason === (topology === 'fork' ? 'unsupported' : 'child_activity')) &&
          f.inspect(store => store.all('SELECT id FROM observations').length) > before
      );
      await f.stop(collector);
      expect((await f.report()).usage).toMatchObject({ partial_tokens: 110, complete_tokens: null, input_total: { observed_events: 1 } });
      expect(f.inspect(store => store.all('SELECT session_id FROM events'))).toEqual([{ session_id: 'root-1' }]);
      expect(
        await f.run(
          ['session', 'link', 'unadmitted', '--task', 't1', '--source', join(f.root, 'never-created.jsonl'), '--product', 'codex', '--version', '0.164.0'],
          2
        )
      ).toBe('');
      expect(f.inspect(store => store.get('SELECT id FROM sessions WHERE id=?', ['unadmitted']))).toBeUndefined();
    } finally {
      await f.cleanup();
    }
  },
  15000
);

test('CLI assignment restarts reuse the canonical issue task and allocation without admitting native sources', async () => {
  const f = fixture();
  try {
    // Freeze explicit synthetic protocol at the fixture's historical time.
    // Its declared enrollment window includes the actual CLI wall clock.
    const store = new Store(f.database);
    const data = makeFlexibleFixture();
    seedProject(store);
    registerPriceTable(store, data.priceTable);
    data.variants.forEach(variant => registerVariant(store, variant));
    registerProtocol(store, { ...data.protocol, recruitment_end: '2099-01-02T00:00:00Z' });
    freezeProtocol(store, data.protocol.id, beforeRecruitment);
    store.close();
    const config = join(f.root, 'assignment.json');
    const input = {
      ...assignmentInput,
      schema_version: 2,
      metadata: data.metadata,
      logical_task_id: 'github:example:repository:issue:42',
      alias_ids: ['issue-42']
    };
    writeFileSync(config, JSON.stringify(input));
    const first = JSON.parse(await f.run(['comparison', 'assign', '--config', config])) as AssignmentReceipt;
    writeFileSync(config, JSON.stringify({ ...input, task_id: 'new-session-request', logical_task_id: 'issue-42', alias_ids: ['continuation'] }));
    const second = JSON.parse(await f.run(['comparison', 'assign', '--config', config])) as AssignmentReceipt;
    expect(second).toEqual({ ...first, reused: true });
    expect(f.inspect(store => store.all('SELECT id FROM tasks'))).toEqual([{ id: first.task_id }]);
    expect(f.inspect(store => store.all('SELECT next_index FROM comparison_allocation_state WHERE stratum_id=?', ['stratum-user-1']))).toEqual([
      { next_index: 1 }
    ]);
    expect(JSON.parse(await f.run(['comparison', 'readiness', data.protocol.id]))).toMatchObject({
      real_allocation: false,
      complete_cost: false,
      inference: false
    });
    await f.run(
      ['session', 'link', 'native', '--task', first.task_id, '--source', join(f.root, 'never-created.jsonl'), '--product', 'codex', '--version', '0.160.0'],
      2
    );
    expect(f.inspect(store => store.all('SELECT id FROM sessions'))).toEqual([]);
  } finally {
    await f.cleanup();
  }
}, 15000);
