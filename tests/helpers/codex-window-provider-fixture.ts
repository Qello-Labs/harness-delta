import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lifecycle } from '../../src/lifecycle.js';
import { Store } from '../../src/store.js';
import { createOrdinaryWindowTask } from '../../src/ordinary-observation.js';
import { collectOrdinaryCodexWindow, connectOrdinaryCodexWindow } from '../../src/ordinary-session-binding.js';
import { ordinaryWindowRuntimeRevision, ordinaryWindowSelection } from '../../src/core/ordinary-window-store.js';
import { CodexWindowPendingReceiptSchema } from '../../src/session-binding-codex.js';
import { codexWindowControl, runCodexWindowHook } from './codex-window-hook-fixture.js';

export const codexWindowJsonl = (rows: readonly unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';

function prepareFixture(input: { readonly version?: string; readonly activate?: boolean }) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'codex-window-provider-')));
  const projectRoot = join(directory, 'project');
  const sourceRoot = join(directory, 'native-rollouts');
  const assetRoot = join(directory, 'native-assets');
  const receiptDirectory = join(projectRoot, '.harness-delta', 'window-receipts');
  for (const path of [projectRoot, sourceRoot, assetRoot, receiptDirectory]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  writeFileSync(join(receiptDirectory, 'ordinary-window-control.json'), JSON.stringify(codexWindowControl(projectRoot)), { mode: 0o600 });
  let milliseconds = Date.parse('2026-11-06T01:00:00.000Z');
  const clock = () => new Date(milliseconds).toISOString();
  const advance = (amount = 1000) => {
    milliseconds += amount;
    return clock();
  };
  const receive = (recordedAt: string) => {
    milliseconds = Math.max(milliseconds, Date.parse(recordedAt));
  };
  const store = new Store(':memory:', clock);
  const lifecycle = new Lifecycle(store, clock);
  const version = input.version ?? '0.167.0';
  let taskId: string;
  try {
    lifecycle.registerProject('project', projectRoot);
    taskId = createOrdinaryWindowTask(
      store,
      {
        schema_version: 2,
        mode: 'ordinary_window',
        project_id: 'project',
        product: 'codex',
        declared_version: version,
        policy_id: 'codex-binding-root-window-v1',
        criterion_ids: ['accepted']
      },
      clock
    );
  } catch (error) {
    store.close();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  const selection = ordinaryWindowSelection(store, taskId);
  if (!selection) throw new Error('fixture_selection_missing');
  const activate = () =>
    store.execute(
      `INSERT INTO ordinary_window_activations(project_id,product,source,policy_id,policy_revision,policy_digest,evidence_mode,
      accepted_risks,implementation_revision,evidence_ref,review_ref,decided_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        selection.projectId,
        'codex',
        selection.policy.source,
        selection.policy.policyId,
        selection.policy.ruleRevision,
        selection.policyDigest,
        selection.policy.evidenceMode,
        JSON.stringify(['source_identity_limits', 'root_ownership_unverified']),
        ordinaryWindowRuntimeRevision,
        'synthetic-evidence',
        'synthetic-review',
        clock()
      ]
    );
  if (input.activate !== false) activate();
  return {
    directory,
    projectRoot,
    sourceRoot,
    assetRoot,
    receiptDirectory,
    clock,
    advance,
    receive,
    store,
    lifecycle,
    version,
    taskId,
    selection,
    activate
  };
}

export async function createCodexWindowProviderFixture(input: { readonly version?: string; readonly activate?: boolean } = {}) {
  const prepared = prepareFixture(input);
  const { directory, projectRoot, sourceRoot, assetRoot, receiptDirectory, clock, advance, receive, store, lifecycle, version, taskId, selection, activate } =
    prepared;
  const nativeSessionId = 'native-root';
  const sourcePath = join(sourceRoot, 'root.jsonl');
  const header = (overrides: Readonly<Record<string, unknown>> = {}, id = nativeSessionId) => ({
    type: 'session_meta',
    payload: {
      id,
      session_id: id,
      cli_version: version,
      cwd: projectRoot,
      source: 'cli',
      ...overrides
    }
  });
  writeFileSync(sourcePath, codexWindowJsonl([header()]));
  const seen = new Set<string>();
  const emit = async (overrides: Readonly<Record<string, unknown>> = {}) => {
    const result = await runCodexWindowHook({
      receiptDirectory,
      projectRoot,
      nativePrefixes: [sourceRoot, assetRoot],
      input: {
        hook_event_name: 'SessionStart',
        session_id: nativeSessionId,
        cwd: projectRoot,
        transcript_path: sourcePath,
        source: 'startup',
        ...overrides
      }
    });
    if (result.code !== 0 || result.effects.nativeCalls !== 0 || result.effects.processCalls !== 0) {
      throw new Error(`fixture_hook_failed:${result.code}:${result.stderr}`);
    }
    const records = result.receipts.map(value => CodexWindowPendingReceiptSchema.parse(value));
    const record = records.find(value => !seen.has(value.receipt));
    if (!record) throw new Error('fixture_receipt_missing');
    for (const value of records) seen.add(value.receipt);
    receive(record.recordedAt);
    return record;
  };
  const receipt = await emit();
  const options = {
    store,
    taskId,
    receiptDirectory,
    sourceRoots: [sourceRoot],
    clock
  };
  let rootSessionId: string | undefined;
  const connect = async (value = receipt.receipt) => {
    const result = await connectOrdinaryCodexWindow(options, {
      receipt: value
    });
    rootSessionId = result.rootSessionId;
    return result;
  };
  const collect = (baseline = false) => {
    if (!rootSessionId) throw new Error('fixture_not_connected');
    return collectOrdinaryCodexWindow(options, rootSessionId, baseline);
  };
  const context = (turnId: string, at = clock()) => ({
    type: 'turn_context',
    timestamp: at,
    payload: {
      cwd: projectRoot,
      turn_id: turnId,
      root_turn_id: turnId,
      model: 'gpt-6.1-sol',
      effort: 'high'
    }
  });
  const usage = (requestId: string, turnId: string, counters: Readonly<Record<string, unknown>> = {}, at = clock()) => ({
    type: 'token_usage_record',
    timestamp: at,
    payload: {
      thread_id: nativeSessionId,
      session_id: nativeSessionId,
      turn_id: turnId,
      root_turn_id: turnId,
      response_id: requestId,
      usage: {
        input_tokens: 100,
        cached_input_tokens: 10,
        output_tokens: 20,
        reasoning_output_tokens: 5,
        total_tokens: 120,
        ...counters
      }
    }
  });
  const append = (rows: readonly unknown[]) => appendFileSync(sourcePath, codexWindowJsonl(rows));
  const appendResponse = (requestId: string = randomUUID(), counters: Readonly<Record<string, unknown>> = {}) => {
    const turnId = `turn-${requestId}`;
    append([context(turnId), usage(requestId, turnId, counters)]);
    return requestId;
  };
  return {
    directory,
    projectRoot,
    sourceRoot,
    sourceRoots: [sourceRoot],
    assetRoot,
    receiptDirectory,
    sourcePath,
    nativeSessionId,
    store,
    lifecycle,
    life: lifecycle,
    taskId,
    options,
    receipt,
    selection,
    clock,
    advance,
    activate,
    connect,
    collect,
    emit,
    header,
    context,
    usage,
    append,
    appendResponse,
    emitChild: (id = 'native-child', path: string | null = join(sourceRoot, 'missing-child.jsonl')) =>
      emit({
        hook_event_name: 'SubagentStart',
        agent_id: id,
        turn_id: 'child-turn',
        transcript_path: path
      }),
    emitLifecycle: (source: string | null, path: string | null = sourcePath) => emit({ source, transcript_path: path }),
    emitRoot: (id: string, path: string) => emit({ session_id: id, transcript_path: path }),
    snapshot: () => ({
      events: store.all('SELECT * FROM events'),
      requests: store.all('SELECT * FROM binding_requests'),
      exclusions: store.all('SELECT * FROM binding_baseline_exclusions'),
      bindings: store.all('SELECT * FROM session_bindings'),
      segments: store.all('SELECT * FROM binding_root_segments'),
      windows: store.all('SELECT * FROM ordinary_window_segments'),
      pins: store.all('SELECT * FROM session_source_compatibility')
    }),
    cleanup: () => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}
