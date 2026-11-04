import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, mkdirSync, cpSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { Worker } from 'node:worker_threads';
import { expect, test } from 'vitest';
import { Store } from '../src/store.js';
import { Lifecycle } from '../src/lifecycle.js';
import { assignTask } from '../src/allocation.js';
import { freezeProtocol, registerProtocol, registerVariant, showProtocol } from '../src/comparison.js';
import { assignmentInput, assignmentTime, beforeRecruitment, metadata, protocol, seedProject, variantA, variantB } from './helpers/comparison-fixture.js';

function setup(store: Store): void {
  seedProject(store);
  registerVariant(store, variantA);
  registerVariant(store, variantB);
  registerProtocol(store, protocol);
  freezeProtocol(store, protocol.id, beforeRecruitment);
}
const dependencies = { clock: () => assignmentTime, shuffle: () => ['variant-b', 'variant-a', 'variant-a', 'variant-b'] };
const positions = (store: Store) => store.get<{ next_index: number }>('SELECT next_index FROM comparison_allocation_state')?.next_index;

test('allocation commits identity, metadata, deadline and slot once before a retry can reveal it', () => {
  const root = mkdtempSync(join(tmpdir(), 'allocation-reopen-'));
  const file = join(root, 'local.db');
  let store = new Store(file);
  try {
    setup(store);
    const receipt = assignTask(store, assignmentInput, dependencies);
    expect(receipt).toMatchObject({
      task_id: 'task-1',
      assigned_variant_id: 'variant-b',
      allocation_index: 0,
      assigned_at: '2026-01-01T00:00:00.000Z',
      followup_ends_at: '2026-01-01T01:00:00.000Z',
      reused: false
    });
    expect(positions(store)).toBe(1);
    expect(store.all('SELECT * FROM sessions')).toEqual([]);
    expect(store.all('SELECT * FROM observations')).toEqual([]);
    // Simulate loss of the receipt after commit: reopen and retry outside recruitment.
    store.close();
    store = new Store(file);
    const retry = assignTask(store, assignmentInput, { ...dependencies, clock: () => '2026-02-01T00:00:00Z' });
    expect(retry).toEqual({ ...receipt, reused: true });
    expect(positions(store)).toBe(1);
    expect(JSON.stringify(receipt)).not.toMatch(/pending_variants|seed|future/);
    expect(JSON.stringify(showProtocol(store, protocol.id))).not.toMatch(/pending_variants|next_index|seed/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('aliases and cross-protocol attempts resolve original assignment and immutable preregistration', () => {
  const store = new Store(':memory:');
  try {
    setup(store);
    const original = assignTask(store, { ...assignmentInput, alias_ids: ['alias-1'] }, dependencies);
    const alias = assignTask(store, { ...assignmentInput, logical_task_id: 'alias-1', task_id: 'another-id' }, dependencies);
    expect(alias).toEqual({ ...original, reused: true });
    registerProtocol(store, { ...protocol, id: 'comparison-2' });
    freezeProtocol(store, 'comparison-2', beforeRecruitment);
    expect(assignTask(store, { ...assignmentInput, protocol_id: 'comparison-2' }, dependencies)).toEqual({ ...original, reused: true });
    expect(store.all('SELECT id FROM comparison_assignments')).toHaveLength(1);
    expect(store.all("SELECT id FROM comparison_deviations WHERE reason_code = 'reassignment_attempt'")).toHaveLength(2);
    expect(() => assignTask(store, { ...assignmentInput, metadata: { ...metadata, expected_size: 'large' } }, dependencies)).toThrow(
      'preregistration_conflict'
    );
    expect(() => assignTask(store, { ...assignmentInput, environment_id: 'environment-2' }, dependencies)).toThrow('preregistration_conflict');
    expect(() => assignTask(store, { ...assignmentInput, allocator_id: 'other-writer' }, dependencies)).toThrow('allocator_conflict');
    expect(positions(store)).toBe(1);
  } finally {
    store.close();
  }
});

test('pre-execution, recruitment, authority and synthetic-only gates reject without consuming positions', () => {
  const store = new Store(':memory:');
  try {
    setup(store);
    const life = new Lifecycle(store, () => assignmentTime);
    life.createTask('project-1', 'started', metadata);
    life.start('started');
    life.createTask('project-1', 'paused', metadata);
    life.start('paused');
    life.pause('paused');
    life.createTask('project-1', 'finalized', metadata);
    life.start('finalized');
    life.finalize('finalized', 'aborted', []);
    for (const taskId of ['started', 'paused', 'finalized']) {
      expect(() => assignTask(store, { ...assignmentInput, task_id: taskId, logical_task_id: taskId }, dependencies)).toThrow('task_already_started');
    }
    for (const timestamp of ['2025-12-31T23:59:59Z', '2026-01-02T00:00:00Z']) {
      expect(() => assignTask(store, assignmentInput, { ...dependencies, clock: () => timestamp })).toThrow('outside_recruitment');
    }
    expect(() => assignTask(store, { ...assignmentInput, allocator_id: 'other-writer' }, dependencies)).toThrow('allocator_conflict');
    expect(() => assignTask(store, { ...assignmentInput, environment_id: 'ineligible' }, dependencies)).toThrow('ineligible_task');
    expect(() => assignTask(store, { ...assignmentInput, metadata: { ...metadata, assignee: 'ineligible' } }, dependencies)).toThrow('ineligible_task');
    registerProtocol(store, { ...protocol, id: 'real', purpose: 'real_experiment' });
    freezeProtocol(store, 'real', beforeRecruitment);
    expect(() => assignTask(store, { ...assignmentInput, protocol_id: 'real' }, dependencies)).toThrow('real_experiment_disabled');
    expect(positions(store)).toBe(0);
    expect(store.all('SELECT id FROM comparison_assignments')).toEqual([]);
    expect(store.get('SELECT id FROM tasks WHERE id = ?', ['task-1'])).toBeUndefined();
    life.createTask('project-1', 'real-task', { ...metadata, product: 'codex' });
    expect(() => assignTask(store, assignmentInput, dependencies)).toThrow('synthetic_store_required');
  } finally {
    store.close();
  }
});

test('balanced shuffled blocks retain incomplete blocks and allow both variants per user', () => {
  const store = new Store(':memory:');
  try {
    setup(store);
    const arms = Array.from({ length: 6 }, (_, index) =>
      assignTask(
        store,
        {
          ...assignmentInput,
          task_id: `task-${index}`,
          logical_task_id: `logical-${index}`,
          metadata: { ...metadata, assignee: index % 2 ? 'user-2' : 'user-1' }
        },
        dependencies
      )
    );
    expect(arms.map(row => row.assigned_variant_id)).toEqual(['variant-b', 'variant-a', 'variant-a', 'variant-b', 'variant-b', 'variant-a']);
    expect(new Set(arms.slice(0, 4).map(row => row.block_id)).size).toBe(1);
    expect(arms[4]!.block_id).not.toBe(arms[0]!.block_id);
    expect(positions(store)).toBe(6);
    for (const user of ['user-1', 'user-2']) {
      const assigned = store.all<{ variant_id: string }>(
        "SELECT a.variant_id FROM comparison_assignments a JOIN tasks t ON t.id = a.task_id WHERE json_extract(t.metadata,'$.assignee') = ?",
        [user]
      );
      expect(new Set(assigned.map(row => row.variant_id)).size).toBe(2);
    }
  } finally {
    store.close();
  }
});

test('rollback restores identity and slot; invalid shuffles cannot break block balance', () => {
  const store = new Store(':memory:');
  try {
    setup(store);
    store.execute("CREATE TRIGGER fail_assignment BEFORE INSERT ON comparison_assignments BEGIN SELECT RAISE(ABORT,'fixture_failure'); END", []);
    expect(() => assignTask(store, assignmentInput, dependencies)).toThrow('fixture_failure');
    expect(positions(store)).toBe(0);
    expect(store.all('SELECT * FROM comparison_identity_keys')).toEqual([]);
    expect(store.all('SELECT id FROM tasks')).toEqual([]);
    store.execute('DROP TRIGGER fail_assignment', []);
    expect(() => assignTask(store, assignmentInput, { ...dependencies, shuffle: () => ['variant-a', 'variant-a', 'variant-a', 'variant-b'] })).toThrow(
      'invalid_shuffle'
    );
    expect(positions(store)).toBe(0);
    expect(assignTask(store, assignmentInput, dependencies).allocation_index).toBe(0);
    expect(() => new Lifecycle(store).createTask('project-1', 'real-after', { ...metadata, product: 'codex' })).toThrow('synthetic_store_required');
    expect(() =>
      store.execute('INSERT INTO sessions(id,task_id,project_id,product,source_path) VALUES (?,?,?,?,?)', [
        'real-source',
        'task-1',
        'project-1',
        'codex',
        '/synthetic/not-read'
      ])
    ).toThrow('synthetic_store_required');
  } finally {
    store.close();
  }
});

test('a late declared identity conflict blocks affected protocols without merging or rerolling', () => {
  const store = new Store(':memory:');
  try {
    setup(store);
    assignTask(store, assignmentInput, dependencies);
    assignTask(store, { ...assignmentInput, logical_task_id: 'logical-2', task_id: 'task-2' }, dependencies);
    expect(() => assignTask(store, { ...assignmentInput, alias_ids: ['logical-2'] }, dependencies)).toThrow('identity_conflict');
    expect(showProtocol(store, protocol.id)).toMatchObject({ status: 'identity_conflict', invalidated_reason: 'identity_conflict' });
    expect(store.all('SELECT * FROM comparison_assignments')).toHaveLength(2);
    expect(store.all('SELECT * FROM comparison_allocation_state')).toEqual([]);
    expect(() => assignTask(store, { ...assignmentInput, logical_task_id: 'logical-3', task_id: 'task-3' }, dependencies)).toThrow('protocol_not_active');
  } finally {
    store.close();
  }
});

test('two real SQLite writers racing an identity commit one assignment and one position', async () => {
  const root = mkdtempSync(join(tmpdir(), 'allocation-race-'));
  const file = join(root, 'local.db');
  try {
    const store = new Store(file);
    setup(store);
    store.close();
    const compiled = join(root, 'compiled');
    mkdirSync(compiled);
    writeFileSync(join(compiled, 'package.json'), '{"type":"module"}');
    symlinkSync(join(process.cwd(), 'node_modules'), join(compiled, 'node_modules'), 'dir');
    for (const name of readdirSync(new URL('../src/', import.meta.url), { recursive: true, encoding: 'utf8' })) {
      if (!name.endsWith('.ts')) continue;
      const output = transpileModule(readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8'), {
        compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2023 }
      }).outputText;
      mkdirSync(dirname(join(compiled, name)), { recursive: true });
      writeFileSync(join(compiled, name.replace(/\.ts$/, '.js')), output);
    }
    cpSync(new URL('../src/codex-admissions.json', import.meta.url), join(compiled, 'codex-admissions.json'));
    cpSync(new URL('../src/migrations/', import.meta.url), join(compiled, 'migrations'), { recursive: true });
    const barrier = new SharedArrayBuffer(8);
    const counter = new Int32Array(barrier);
    const workerCode = `const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const { Store } = await import(workerData.storeUrl);
        const { assignTask } = await import(workerData.allocationUrl);
        const store = new Store(workerData.file);
        Atomics.add(new Int32Array(workerData.barrier), 0, 1);
        parentPort.postMessage({ ready: true });
        while (Atomics.load(new Int32Array(workerData.barrier), 1) === 0) Atomics.wait(new Int32Array(workerData.barrier), 1, 0);
        try { parentPort.postMessage({ receipt: assignTask(store, workerData.input, { clock: () => workerData.now }) }); }
        catch { parentPort.postMessage({ failed: true }); }
        finally { store.close(); }
      })().catch(error => { throw error; });`;
    const workers = [0, 1].map(
      () =>
        new Worker(workerCode, {
          eval: true,
          workerData: {
            storeUrl: new URL(`file://${join(compiled, 'store.js')}`).href,
            allocationUrl: new URL(`file://${join(compiled, 'allocation.js')}`).href,
            file,
            barrier,
            input: assignmentInput,
            now: assignmentTime
          }
        })
    );
    // Compile current source for independent Node workers, not a stale dist build.
    const results = await Promise.all(
      workers.map(
        worker =>
          new Promise<unknown>((resolve, reject) => {
            worker.on('message', (message: { ready?: boolean; receipt?: unknown; failed?: boolean }) => {
              if (message.ready && Atomics.load(counter, 0) === 2) {
                Atomics.store(counter, 1, 1);
                Atomics.notify(counter, 1, 2);
              }
              if (message.receipt) resolve(message.receipt);
              if (message.failed) reject(new Error('worker_allocation_failed'));
            });
            worker.on('error', reject);
          })
      )
    );
    expect(results[0]).toMatchObject({ task_id: 'task-1', allocation_index: 0 });
    expect(results[1]).toMatchObject({ task_id: 'task-1', allocation_index: 0 });
    const check = new Store(file);
    try {
      expect(check.all('SELECT * FROM comparison_assignments')).toHaveLength(1);
      expect(positions(check)).toBe(1);
    } finally {
      check.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unrelated project task ID cannot invalidate another project through alias resolution', () => {
  const store = new Store(':memory:');
  try {
    setup(store);
    assignTask(store, assignmentInput, dependencies);
    store.execute('INSERT INTO projects(id) VALUES (?)', ['other-project']);
    const otherProtocol = { ...protocol, id: 'other-comparison', project_id: 'other-project' };
    registerProtocol(store, otherProtocol);
    freezeProtocol(store, otherProtocol.id, beforeRecruitment);
    assignTask(
      store,
      { ...assignmentInput, protocol_id: otherProtocol.id, project_id: 'other-project', logical_task_id: 'other-logical', task_id: 'other-task' },
      dependencies
    );
    expect(() => assignTask(store, { ...assignmentInput, task_id: 'other-task' }, dependencies)).toThrow('project_mismatch');
    expect(showProtocol(store, protocol.id)).toMatchObject({ status: 'frozen', data_revision: 0 });
    expect(showProtocol(store, otherProtocol.id)).toMatchObject({ status: 'frozen', data_revision: 0 });
  } finally {
    store.close();
  }
});
