import { randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { main } from '../src/cli.js';
import { Lifecycle } from '../src/lifecycle.js';
import { Store } from '../src/store.js';
import { registerPriceTable } from '../src/pricing.js';
import { preparePriceBasis } from '../src/price-catalog-store.js';
import { hashInstrumentedBinary } from '../src/instrumented-codex-build-identity.js';
import { InstrumentedBuildIdentitySchema } from '../src/instrumented-codex-contracts.js';
import { launchInstrumentedCodex } from '../src/instrumented-codex-launcher.js';
import { captureInstrumentedCostSnapshot, createInstrumentedValuation } from '../src/instrumented-codex-cost.js';
import { instrumentedFixtureProfile } from './helpers/instrumented-codex-fixture.js';

function fixture(mode = 'clean', qualified = true, freshTask = false) {
  const root = mkdtempSync(join(tmpdir(), 'harness-instrumented-launcher-'));
  const binary = join(root, `synthetic-${mode}`);
  copyFileSync(fileURLToPath(new URL('./helpers/instrumented-codex-launcher-producer.mjs', import.meta.url)), binary);
  chmodSync(binary, 0o700);
  const database = join(root, 'measurement.sqlite');
  const store = new Store(database);
  const lifecycle = new Lifecycle(store);
  lifecycle.registerProject('project', root);
  lifecycle.createTask('project', 'task', {
    type: 'feature', expected_size: 'small', assignee: 'fixture-user',
    product: 'codex', model: 'gpt-6.1-sol', criterion_ids: ['fixture-criterion'],
  });
  if (!freshTask) lifecycle.start('task');
  registerPriceTable(store, {
    id: 'original-prices', version: 'synthetic-v1', currency: 'USD', source_id: 'synthetic-rates',
    as_of: new Date().toISOString(), unit_tokens: 1000, display_decimals: 6, rounding: 'half_even',
    entries: [
      { product: 'codex', model: 'gpt-6.1-sol', component: 'ordinary_input', price_per_unit: '2' },
      { product: 'codex', model: 'gpt-6.1-sol', component: 'cache_read', price_per_unit: '1' },
      { product: 'codex', model: 'gpt-6.1-sol', component: 'output', price_per_unit: '4' },
    ],
  });
  const identity = InstrumentedBuildIdentitySchema.parse({
    schema_version: 1, id: 'synthetic-identity',
    profile: { ...instrumentedFixtureProfile, binary_sha256: hashInstrumentedBinary(binary) },
    qualification_kind: 'instrumented_localhost', qualification_hash: '1'.repeat(64),
    qualified_at: new Date().toISOString(),
  });
  // This row is synthetic launcher evidence, not native qualification or registration.
  if (qualified) store.execute(
    'INSERT INTO instrumented_codex_build_identities(id,profile_id,binary_sha256,manifest_hash,qualification_kind,qualification_hash,qualified_at,payload) VALUES (?,?,?,?,?,?,?,?)',
    [identity.id, identity.profile.profile_id, identity.profile.binary_sha256,
      identity.profile.build_manifest_digest, identity.qualification_kind,
      identity.qualification_hash, identity.qualified_at, JSON.stringify(identity)]);
  const input = {
    schema_version: 1, run_id: randomUUID(), project_id: 'project', task_id: 'task',
    task_generation: lifecycle.task('task').generation, build_identity_id: identity.id,
    binary_path: binary, price_table_id: 'original-prices', duration_ms: 10000, termination_grace_ms: 100,
  };
  return { root, binary, database, store, lifecycle, input,
    close: () => { store.close(); rmSync(root, { recursive: true }); } };
}

test('synthetic real fd3 process waits for durable launch and retires only after sealing', async () => {
  const f = fixture();
  try {
    const result = await launchInstrumentedCodex(f.store, f.input, { stdio: 'ignore' });
    expect(result).toMatchObject({
      state: 'completed', coverage: 'work_window', exit_code: 0, signal: null,
      unresolved_attempts: 0, reason_codes: [],
      seal: { counts: { terminal: 1, unresolved: 0 } },
      retirement: { exit_code: 0 },
      valuation: { coverage_scope: 'work_window', partial_amount: '0.22', complete_amount: null },
    });
    expect(f.store.get<{ product: string; source_path: string | null }>(
      'SELECT product,source_path FROM sessions WHERE id=?', [result.root_session_id]))
      .toEqual({ product: 'codex', source_path: null });
    expect(f.store.get<{ payload: string }>(
      'SELECT payload FROM instrumented_codex_launch_receipts WHERE run_id=?', [f.input.run_id])?.payload)
      .toContain('"start_kind":"work_window"');
    await expect(launchInstrumentedCodex(f.store, f.input, { stdio: 'ignore' })).rejects.toThrow('run_conflict');
    expect(f.store.get<{ count: number }>('SELECT COUNT(*) AS count FROM instrumented_codex_launch_receipts')?.count).toBe(1);
  } finally { f.close(); }
});

test('owned fresh task start permits whole-task cost only after human finalization', async () => {
  const f = fixture('clean', true, true);
  try {
    expect(f.lifecycle.task('task').generation).toBe(0);
    const result = await launchInstrumentedCodex(f.store, f.input, { stdio: 'ignore' });
    expect(result).toMatchObject({
      task_started: true, state: 'completed', retirement: { exit_code: 0 },
      valuation: { coverage_scope: 'work_window', complete_window_amount: '0.22', complete_amount: null },
    });
    expect(f.lifecycle.task('task')).toMatchObject({ state: 'active', generation: 1 });
    expect(f.store.get<{ start_kind: string }>(
      'SELECT start_kind FROM instrumented_codex_launch_receipts WHERE run_id=?',
      [f.input.run_id])?.start_kind).toBe('task_start');
    f.lifecycle.finalize('task', 'success', ['fixture-criterion']);
    const cutoff = new Date().toISOString();
    const snapshot = captureInstrumentedCostSnapshot(f.store, {
      inputId: 'finalized-fresh-snapshot', runId: f.input.run_id, cutoff,
    }, cutoff);
    const cost = createInstrumentedValuation(f.store, {
      id: 'finalized-fresh-cost', inputId: snapshot.input_id, targetTableId: f.input.price_table_id,
    }, cutoff);
    expect(cost).toMatchObject({
      coverage_scope: 'whole_task', complete_amount: '0.22', complete_window_amount: '0.22',
    });
  } finally { f.close(); }
});

test('a registered task with an existing session cannot be claimed as an owned fresh start', async () => {
  const f = fixture('clean', true, true);
  try {
    f.store.execute('INSERT INTO sessions(id,project_id,task_id,product,product_version) VALUES (?,?,?,?,?)',
      ['preexisting-session', 'project', 'task', 'codex', '0.162.1']);
    await expect(launchInstrumentedCodex(f.store, f.input, { stdio: 'ignore' })).rejects.toThrow('inactive_scope');
    expect(f.lifecycle.task('task')).toMatchObject({ state: 'registered', generation: 0 });
    expect(f.store.get<{ count: number }>('SELECT count(*) AS count FROM instrumented_codex_launch_receipts')?.count).toBe(0);
  } finally { f.close(); }
});

test('caller start-kind claims cannot promote an already active work window', async () => {
  const f = fixture();
  try {
    await expect(launchInstrumentedCodex(f.store, { ...f.input, start_kind: 'task_start' },
      { stdio: 'ignore' })).rejects.toThrow();
    const result = await launchInstrumentedCodex(f.store, f.input, { stdio: 'ignore' });
    expect(result.task_started).toBe(false);
    expect(f.store.get<{ start_kind: string }>(
      'SELECT start_kind FROM instrumented_codex_launch_receipts WHERE run_id=?',
      [f.input.run_id])?.start_kind).toBe('work_window');
  } finally { f.close(); }
});

test.each(['missing', 'changed', 'invalid', 'inactive', 'generation', 'profile', 'price'])(
  'launcher gate %s refuses before creating a session or launch', async gate => {
    const f = fixture('clean', gate !== 'missing');
    try {
      let input: unknown = f.input;
      if (gate === 'changed') writeFileSync(f.binary, 'changed synthetic executable');
      if (gate === 'invalid') input = { ...f.input, binary_path: 'relative' };
      if (gate === 'inactive') f.lifecycle.pause('task');
      if (gate === 'generation') input = { ...f.input, task_generation: f.input.task_generation + 1 };
      if (gate === 'profile') input = { ...f.input, profile: instrumentedFixtureProfile };
      if (gate === 'price') input = { ...f.input, price_table_id: 'unregistered-prices' };
      await expect(launchInstrumentedCodex(f.store, input, { stdio: 'ignore' })).rejects.toThrow();
      expect(f.store.get<{ count: number }>('SELECT COUNT(*) AS count FROM sessions')?.count).toBe(0);
      expect(f.store.get<{ count: number }>('SELECT COUNT(*) AS count FROM instrumented_codex_launch_receipts')?.count).toBe(0);
    } finally { f.close(); }
  },
);

test.each(['unresolved', 'unsupported', 'nonzero', 'gap', 'corrupt'])(
  'synthetic %s evidence remains partial and committed dispatch is retained', async mode => {
    const f = fixture(mode);
    try {
      const result = await launchInstrumentedCodex(f.store, f.input, { stdio: 'ignore' });
      expect(f.store.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM instrumented_codex_attempts WHERE run_id=? AND dispatch_receipt_id IS NOT NULL",
        [f.input.run_id])?.count).toBe(1);
      expect(result.valuation?.complete_amount ?? null).toBeNull();
      if (mode === 'unresolved') {
        expect(result.unresolved_attempts).toBe(1);
        expect(result.seal?.reason_codes).toContain('unresolved_attempt');
      } else if (mode === 'unsupported') {
        expect(result.reason_codes).toContain('unsupported_operation');
      } else {
        expect(result.state).toBe('failed');
        expect(result.retirement).toBeNull();
        expect(result.reason_codes).toContain(mode === 'gap' ? 'missing_member_close' : 'producer_lost');
      }
      if (mode === 'gap' || mode === 'corrupt') {
        expect(result.seal).toBeNull();
        expect(result.unresolved_attempts).toBe(1);
        expect(f.store.get<{ state: string }>('SELECT state FROM instrumented_codex_runs WHERE id=?',
          [f.input.run_id])?.state).toBe('revoked');
      }
    } finally { f.close(); }
  },
);

test('bounded watchdog awaits actual process and descriptor closure without a restart', async () => {
  const f = fixture('budget');
  try {
    const result = await launchInstrumentedCodex(f.store, { ...f.input, duration_ms: 1 }, { stdio: 'ignore' });
    expect(result).toMatchObject({ state: 'failed', timed_out: true, retirement: null });
    expect(result.signal).not.toBeNull();
    expect(f.store.get<{ count: number }>('SELECT COUNT(*) AS count FROM instrumented_codex_launch_receipts')?.count).toBe(1);
  } finally { f.close(); }
});

test('real spawn failure closes the descriptor and revokes the prepared run', async () => {
  const f = fixture();
  try {
    chmodSync(f.binary, 0o600);
    await expect(launchInstrumentedCodex(f.store, f.input, { stdio: 'ignore' })).rejects.toThrow();
    expect(f.store.get<{ state: string }>('SELECT state FROM instrumented_codex_runs WHERE id=?',
      [f.input.run_id])?.state).toBe('revoked');
    expect(f.store.get<{ count: number }>('SELECT COUNT(*) AS count FROM instrumented_codex_retirements')?.count).toBe(0);
  } finally { f.close(); }
});

test('abort after launch awaits owned exit and forbids retirement', async () => {
  const f = fixture('budget');
  const controller = new AbortController();
  try {
    const pending = launchInstrumentedCodex(f.store, f.input, { stdio: 'ignore', signal: controller.signal });
    controller.abort();
    const result = await pending;
    expect(result).toMatchObject({ state: 'failed', retirement: null, timed_out: false });
    expect(result.reason_codes).toContain('producer_lost');
    expect(result.signal).not.toBeNull();
  } finally { f.close(); }
});

test('original catalog basis stays pinned in the sealed snapshot', async () => {
  const f = fixture();
  try {
    const basis = preparePriceBasis(f.store);
    const result = await launchInstrumentedCodex(f.store, {
      ...f.input, price_table_id: basis.table.id,
    }, { stdio: 'ignore' });
    expect(result.state).toBe('completed');
    expect(result.valuation?.price_basis_hash).toBe(basis.basis_hash);
    expect(result.valuation?.price_table_id).toBe(basis.table.id);
  } finally { f.close(); }
});

test('actual CLI dispatch launches the qualified synthetic fd3 binary', async () => {
  const f = fixture();
  const execution = join(f.root, 'execution.json');
  writeFileSync(execution, JSON.stringify(f.input));
  try {
    expect(await main(['--db', f.database, 'instrumented-codex', 'launch',
      '--execution', execution])).toBe(0);
    const stored = f.store.get<{ payload: string }>(
      'SELECT payload FROM instrumented_codex_valuations WHERE snapshot_id IN (SELECT id FROM instrumented_codex_cost_snapshots WHERE run_id=?)',
      [f.input.run_id]);
    expect(stored && JSON.parse(stored.payload)).toMatchObject({
      coverage_scope: 'work_window', price_table_id: 'original-prices', partial_amount: '0.22',
      complete_amount: null,
    });
  } finally { f.close(); }
});

test('actual CLI dispatch accepts metadata execution and rejects native bypass flags', async () => {
  const f = fixture('clean', false);
  const execution = join(f.root, 'execution.json');
  writeFileSync(execution, JSON.stringify(f.input));
  try {
    expect(await main(['--db', f.database, 'instrumented-codex', 'launch', '--execution', execution])).toBe(2);
    expect(await main(['--db', f.database, 'instrumented-codex', 'launch', '--execution', execution,
      '--dangerously-bypass-approvals-and-sandbox'])).toBe(2);
    expect(f.store.get<{ count: number }>('SELECT COUNT(*) AS count FROM sessions')?.count).toBe(0);
  } finally { f.close(); }
});
