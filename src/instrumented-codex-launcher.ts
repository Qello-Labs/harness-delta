import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { Duplex } from 'node:stream';
import { z } from 'zod';
import { IdSchema, TokenSchema } from './contracts.js';
import { requireConfigurationConfirmation } from './config-confirmation.js';
import { Lifecycle, utcNow } from './lifecycle.js';
import {
  InstrumentedAccounting, InstrumentedAccountingError, instrumentedMetadataHash,
} from './instrumented-codex-accounting.js';
import {
  InstrumentedBuildIdentityError, resolveInstrumentedBuildIdentity,
} from './instrumented-codex-build-identity.js';
import {
  InstrumentedBuildIdentitySchema, InstrumentedWindowSealSchema,
  type InstrumentedWindowSeal,
} from './instrumented-codex-contracts.js';
import { connectInstrumentedDescriptor } from './instrumented-codex-descriptor.js';
import { captureInstrumentedCostSnapshot, createInstrumentedValuation } from './instrumented-codex-cost.js';
import { readPriceTable } from './pricing.js';
import { readPriceBasis } from './price-catalog-store.js';
import type { Store } from './store.js';

export const InstrumentedLaunchInputSchema = z.strictObject({
  schema_version: z.literal(1),
  run_id: IdSchema, project_id: IdSchema, task_id: IdSchema, task_generation: TokenSchema,
  build_identity_id: IdSchema, binary_path: z.string().min(1).refine(isAbsolute),
  price_table_id: IdSchema,
  duration_ms: z.number().int().min(1).max(2147483647),
  termination_grace_ms: z.number().int().min(1).max(2147483647),
});

export class InstrumentedLauncherError extends Error {
  readonly name = 'InstrumentedLauncherError';
  constructor(readonly code: 'inactive_scope' | 'invalid_project_root' | 'invalid_identity' |
    'run_conflict' | 'instrumented_launch_failed') { super(code); }
}

export interface InstrumentedLaunchRuntime {
  readonly prompt?: string;
  readonly stdio?: 'inherit' | 'ignore';
  readonly signal?: AbortSignal;
}

/** Only fd3 is observed; native input and output never enter the measurement store. */
export async function launchInstrumentedCodex(
  store: Store, input: unknown, runtime: InstrumentedLaunchRuntime = {},
) {
  const config = InstrumentedLaunchInputSchema.parse(input);
  if (runtime.prompt !== undefined) z.string().refine(value => !value.includes('\0')).parse(runtime.prompt);
  const row = store.get<{ payload: string }>(
    'SELECT payload FROM instrumented_codex_build_identities WHERE id=?', [config.build_identity_id]);
  if (!row) throw new InstrumentedBuildIdentityError('unqualified_build');
  const identity = InstrumentedBuildIdentitySchema.parse(JSON.parse(row.payload));
  if (identity.id !== config.build_identity_id) throw new InstrumentedLauncherError('invalid_identity');
  resolveInstrumentedBuildIdentity(store, config.binary_path, identity.profile);
  const task = new Lifecycle(store).task(config.task_id);
  const freshTask = task.state === 'registered';
  const root = store.get<{ local_root: string | null }>(
    'SELECT local_root FROM projects WHERE id=?', [config.project_id])?.local_root;
  if (!root || realpathSync(root) !== root || !statSync(root).isDirectory()) {
    throw new InstrumentedLauncherError('invalid_project_root');
  }
  let generation = config.task_generation;
  let expectedState = task.state;
  const assertScope = () => {
    const current = new Lifecycle(store).task(config.task_id);
    if (current.project_id !== config.project_id ||
        !['registered', 'active'].includes(expectedState) || current.state !== expectedState ||
        current.generation !== generation ||
        store.get<{ local_root: string }>('SELECT local_root FROM projects WHERE id=?',
          [config.project_id])?.local_root !== root ||
        store.get("SELECT 1 FROM tombstones WHERE (kind='task' AND id=?) OR (kind='project' AND id=?)",
          [config.task_id, config.project_id]) || runtime.signal?.aborted) {
      throw new InstrumentedLauncherError('inactive_scope');
    }
    requireConfigurationConfirmation(store, config.task_id, utcNow());
  };
  assertScope();
  const table = readPriceTable(store, config.price_table_id);
  const basisHash = store.get('SELECT price_table_id FROM price_catalog_bases WHERE price_table_id=?',
    [table.id]) ? readPriceBasis(store, table.id).basis_hash : null;
  const rootSessionId = randomUUID();
  const producerId = randomUUID();
  store.immediateTransaction(() => {
    assertScope();
    if (freshTask && store.get('SELECT id FROM sessions WHERE task_id=?', [task.id])) {
      throw new InstrumentedLauncherError('inactive_scope');
    }
    if (store.get('SELECT id FROM instrumented_codex_runs WHERE id=?', [config.run_id]) ||
        store.get("SELECT id FROM instrumented_codex_runs WHERE task_id=? AND state IN ('prepared','open','closing')",
          [task.id])) throw new InstrumentedLauncherError('run_conflict');
    store.execute('INSERT INTO sessions(id,project_id,task_id,product,product_version) VALUES (?,?,?,?,?)',
      [rootSessionId, config.project_id, task.id, 'codex', identity.profile.product_version]);
  });
  // Receiver preparation establishes SQLite durability before its own transaction.
  const prepare = freshTask
    ? InstrumentedAccounting.prepareFreshTask.bind(InstrumentedAccounting)
    : InstrumentedAccounting.prepare.bind(InstrumentedAccounting);
  const accounting = prepare(store, {
      profile: identity.profile, producerInstanceId: producerId,
      control: {
        schema_version: 1, run_id: config.run_id, project_id: config.project_id,
        task_id: task.id, task_generation: config.task_generation, collector_instance_id: randomUUID(),
        profile_id: identity.profile.profile_id, producer_manifest_hash: identity.profile.build_manifest_digest,
        root_session_id: rootSessionId, configuration_receipt_id: randomUUID(),
        authorization_receipt_id: randomUUID(), price_table_id: table.id,
        price_table_hash: instrumentedMetadataHash(table), price_basis_hash: basisHash,
        state: 'prepared', opened_at: null, closed_at: null, control_sequence: 0,
      },
  });
  generation = accounting.control().task_generation;
  expectedState = 'active';
  const args = ['--harness-accounting-fd3', 'exec', '--model', identity.profile.model,
    '-c', `model_reasoning_effort="${identity.profile.effort}"`,
    '-c', 'analytics.enabled=false', '-c', 'otel.exporter="none"',
    '-c', 'otel.trace_exporter="none"', '-c', 'otel.metrics_exporter="none"',
    '-c', 'agents.enabled=true', '-c', `agents.default_subagent_model="${identity.profile.model}"`,
    '-c', `agents.default_subagent_reasoning_effort="${identity.profile.effort}"`,
    '-c', `agents.max_depth=${identity.profile.max_depth}`,
    '--', runtime.prompt ?? '-'];
  const nativeStdio = runtime.stdio ?? 'inherit';
  const child = spawn(config.binary_path, args, {
    cwd: root, stdio: [nativeStdio, nativeStdio, nativeStdio, 'pipe'],
  });
  let failed = false;
  let timedOut = false;
  const childClosed = new Promise<void>(resolve => { child.once('close', () => { resolve(); }); });
  const descriptor = child.stdio[3];
  if (!(descriptor instanceof Duplex)) {
    child.once('error', () => { failed = true; });
    if (child.pid !== undefined) child.kill('SIGKILL');
    await childClosed;
    accounting.recordTransportFailure('producer_lost');
    store.execute("UPDATE instrumented_codex_runs SET state='revoked' WHERE id=?", [config.run_id]);
    throw new InstrumentedLauncherError('instrumented_launch_failed');
  }
  const descriptorClosed = new Promise<void>(resolve => {
    descriptor.once('close', () => { resolve(); });
  });
  let connection: ReturnType<typeof connectInstrumentedDescriptor> | undefined;
  let escalation: NodeJS.Timeout | undefined;
  const stop = () => {
    failed = true;
    accounting.recordTransportFailure('producer_lost');
    if (child.pid !== undefined) {
      child.kill('SIGTERM');
      escalation ??= setTimeout(() => {
        child.kill('SIGKILL');
        descriptor.destroy();
      }, config.termination_grace_ms);
    }
  };
  child.once('error', () => { stop(); descriptor.destroy(); });
  descriptor.once('error', stop);
  descriptor.once('close', () => { if (connection?.failure()) stop(); });
  runtime.signal?.addEventListener('abort', stop, { once: true });
  const watchdog = setTimeout(() => { timedOut = true; stop(); }, config.duration_ms);
  try {
    assertScope();
    accounting.recordLaunch(config.binary_path, child);
    connection = connectInstrumentedDescriptor(accounting, descriptor, producerId);
  } catch (error) {
    stop();
    descriptor.destroy();
    await Promise.all([childClosed, descriptorClosed]);
    if (error instanceof Error) throw error;
    throw new InstrumentedLauncherError('instrumented_launch_failed');
  } finally {
    // The launch error path has already awaited both closures.
    if (!connection) {
      clearTimeout(watchdog);
      clearTimeout(escalation);
      runtime.signal?.removeEventListener('abort', stop);
      store.execute("UPDATE instrumented_codex_runs SET state='revoked' WHERE id=? AND state!='sealed'",
        [config.run_id]);
    }
  }
  await Promise.all([childClosed, descriptorClosed, connection.closed]);
  clearTimeout(watchdog);
  clearTimeout(escalation);
  runtime.signal?.removeEventListener('abort', stop);
  failed ||= connection.failure() !== null || child.exitCode !== 0 || child.signalCode !== null;
  if (failed) accounting.recordTransportFailure('producer_lost');
  let seal: InstrumentedWindowSeal | null = null;
  try { seal = accounting.seal(); }
  catch (error) {
    if (!(error instanceof InstrumentedAccountingError) ||
        !['missing_member_close', 'inactive_scope'].includes(error.code)) throw error;
    accounting.recordTransportFailure(error.code === 'inactive_scope' ? 'scope_revoked' : 'missing_member_close');
    failed = true;
    store.execute("UPDATE instrumented_codex_runs SET state='revoked' WHERE id=? AND state!='sealed'",
      [config.run_id]);
  }
  const retirement = seal && !failed ? accounting.recordRetirement(child) : null;
  const cutoff = utcNow();
  const snapshot = seal ? captureInstrumentedCostSnapshot(store, {
    inputId: randomUUID(), runId: config.run_id, cutoff,
  }, cutoff) : null;
  const valuation = snapshot ? createInstrumentedValuation(store, {
    id: randomUUID(), inputId: snapshot.input_id, targetTableId: table.id,
  }, cutoff) : null;
  const reasons = InstrumentedWindowSealSchema.shape.reason_codes.parse(JSON.parse(
    store.get<{ reason_codes: string }>('SELECT reason_codes FROM instrumented_codex_runs WHERE id=?',
      [config.run_id])?.reason_codes ?? '[]'));
  const unresolved = store.get<{ count: number }>(
    "SELECT COUNT(*) AS count FROM instrumented_codex_attempts WHERE run_id=? AND state IN ('reserved','dispatched')",
    [config.run_id])?.count ?? 0;
  return {
    schema_version: 1, kind: 'instrumented_codex_work_window' as const,
    run_id: config.run_id, root_session_id: rootSessionId, build_identity_id: identity.id,
    state: failed ? 'failed' as const : 'completed' as const, coverage: 'work_window' as const,
    task_started: freshTask,
    exit_code: child.exitCode, signal: child.signalCode, timed_out: timedOut,
    unresolved_attempts: unresolved, reason_codes: reasons,
    seal, retirement, snapshot_id: snapshot?.input_id ?? null, valuation,
  };
}
