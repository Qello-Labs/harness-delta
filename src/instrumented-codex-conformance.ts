import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Duplex } from 'node:stream';
import { z } from 'zod';
import { Store } from './store.js';
import { Lifecycle } from './lifecycle.js';
import { registerPriceTable } from './pricing.js';
import { InstrumentedAccounting, instrumentedMetadataHash } from './instrumented-codex-accounting.js';
import {
  InstrumentedProducerRecordSchema, InstrumentedRunControlSchema,
  type InstrumentedProducerProfile,
} from './instrumented-codex-contracts.js';
import { connectInstrumentedDescriptor } from './instrumented-codex-descriptor.js';
import { captureInstrumentedCostSnapshot, createInstrumentedValuation } from './instrumented-codex-cost.js';
import { hashInstrumentedBinary } from './instrumented-codex-build-identity.js';

const scenarios = [
  'root', 'direct_family', 'missing_tokens', 'receiver_loss',
  'native_tool', 'unknown_tool', 'code_mode', 'third_child',
] as const;
type Scenario = typeof scenarios[number];
export type InstrumentedConformanceEvidence = {
  readonly scenario: Scenario;
  readonly requests: number;
  readonly records: number;
  readonly members: number;
  readonly terminal: number;
  readonly unresolved: number;
  readonly reasons: readonly string[];
  readonly sourceUnverifiedAmount: string | null;
};

const SyntheticRequestSchema = z.object({
  input: z.array(z.object({
    role: z.string().optional(), type: z.string().optional(), call_id: z.string().optional(),
    tools: z.array(z.unknown()).optional(),
  }).passthrough()),
  tools: z.array(z.unknown()).optional(),
});

function offeredTools(value: unknown): string[] {
  const tool = z.object({ name: z.string().optional(), tools: z.array(z.unknown()).optional() }).parse(value);
  return [...(tool.name ? [tool.name] : []), ...(tool.tools ?? []).flatMap(offeredTools)];
}

/** This runner never writes a build identity; even its successful fixtures remain unqualified. */
export async function runInstrumentedCodexConformance(
  binaryPath: string, profile: InstrumentedProducerProfile, cancelSignal?: AbortSignal,
): Promise<readonly InstrumentedConformanceEvidence[]> {
  assert.equal(hashInstrumentedBinary(binaryPath), profile.binary_sha256);
  const results: InstrumentedConformanceEvidence[] = [];
  for (const scenario of scenarios) {
    cancelSignal?.throwIfAborted();
    results.push(await runScenario(binaryPath, profile, scenario, cancelSignal));
  }
  assert.equal(hashInstrumentedBinary(binaryPath), profile.binary_sha256);
  return results;
}

async function runScenario(
  binaryPath: string, profile: InstrumentedProducerProfile, scenario: Scenario, cancelSignal?: AbortSignal,
): Promise<InstrumentedConformanceEvidence> {
  const root = await mkdtemp(join(tmpdir(), 'hd-native-conformance-'));
  let receiver: Store | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  let child: ChildProcess | undefined;
  let bridge: ReturnType<typeof connectInstrumentedDescriptor> | undefined;
  let closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveChildren: () => void = () => {};
  const terminate = () => {
    if (child?.pid === undefined) return;
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  };
  try {
    const home = join(root, 'home');
    await mkdir(home);
    const clock = () => new Date().toISOString();
    const store = receiver = new Store(join(root, 'receiver.sqlite'), clock);
    const lifecycle = new Lifecycle(store, clock);
    lifecycle.registerProject('synthetic-project', root);
    lifecycle.createTask('synthetic-project', 'synthetic-task', {
      type: 'feature', expected_size: 'small', assignee: 'synthetic-user',
      product: 'codex', model: 'gpt-6.1-sol', criterion_ids: ['synthetic-response'],
    });
    lifecycle.start('synthetic-task');
    const sessionId = randomUUID();
    store.execute('INSERT INTO sessions(id,project_id,task_id,product,product_version) VALUES (?,?,?,?,?)',
      [sessionId, 'synthetic-project', 'synthetic-task', 'codex', '0.162.1']);
    const table = {
      id: 'synthetic-prices', version: 'synthetic-v1', source_id: 'synthetic-reference',
      as_of: clock(), currency: 'USD' as const, unit_tokens: 1000, display_decimals: 6,
      rounding: 'half_even' as const,
      entries: [
        { product: 'codex' as const, model: 'gpt-6.1-sol', component: 'ordinary_input' as const, price_per_unit: '2' },
        { product: 'codex' as const, model: 'gpt-6.1-sol', component: 'cache_read' as const, price_per_unit: '1' },
        { product: 'codex' as const, model: 'gpt-6.1-sol', component: 'cache_write' as const, price_per_unit: '3' },
        { product: 'codex' as const, model: 'gpt-6.1-sol', component: 'output' as const, price_per_unit: '4' },
      ],
    };
    registerPriceTable(store, table);
    const runId = randomUUID();
    const producerId = randomUUID();
    const control = InstrumentedRunControlSchema.parse({
      schema_version: 1, run_id: runId, project_id: 'synthetic-project', task_id: 'synthetic-task',
      task_generation: lifecycle.task('synthetic-task').generation, collector_instance_id: randomUUID(),
      profile_id: profile.profile_id, producer_manifest_hash: profile.build_manifest_digest,
      root_session_id: sessionId, configuration_receipt_id: 'synthetic-configuration',
      authorization_receipt_id: 'localhost-only', price_table_id: table.id,
      price_table_hash: instrumentedMetadataHash(table), price_basis_hash: null,
      state: 'prepared', opened_at: null, closed_at: null, control_sequence: 0,
    });
    const accounting = InstrumentedAccounting.prepare(store, { control, profile, producerInstanceId: producerId }, clock);
    let requests = 0;
    const observedDispatches = new Set<string>();
    const oracle: { failure: Error | null } = { failure: null };
    let completedChildren = 0;
    let receiverInterrupted = false;
    const childrenCompleted = new Promise<void>(resolve => { resolveChildren = resolve; });
    const receive = accounting.receive.bind(accounting);
    accounting.receive = input => {
      const record = InstrumentedProducerRecordSchema.parse(input);
      const receipt = receive(record);
      if (record.body.kind === 'attempt_terminal' && record.member_id !== sessionId) {
        completedChildren++;
        if (completedChildren === 2) resolveChildren();
      }
      if (scenario === 'receiver_loss' && record.body.kind === 'attempt_reserve') {
        receiverInterrupted = true;
        accounting.recordTransportFailure('receiver_lost');
        descriptor.destroy();
      }
      return receipt;
    };
    const family = scenario === 'direct_family' || scenario === 'third_child';
    server = createServer((request, response) => {
      void (async () => {
        // The only content inspected is generated by this private synthetic native fixture.
        if (request.method === 'GET' &&
            new URL(request.url ?? '/', 'http://127.0.0.1').pathname === '/plugins/featured') {
          request.resume();
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end('[]');
          return;
        }
        assert.equal(request.method, 'POST');
        assert.equal(request.url, '/v1/responses');
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of request) {
          assert.ok(Buffer.isBuffer(chunk));
          length += chunk.length;
          assert.ok(length <= 4 * 1024 * 1024);
          chunks.push(chunk);
        }
        const parsed = SyntheticRequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        if (requests === 1 && scenario === 'native_tool') {
          assert.ok(parsed.input.some(item => item.call_id === 'call_synthetic' &&
            JSON.stringify(item).includes('NATIVE_SYNTHETIC_STDOUT_CONFIRMED')),
          'native command stdout was not confirmed by the controlled cell');
        }
        const tools = [
          ...(parsed.tools ?? []),
          ...parsed.input.filter(item => item.type === 'additional_tools').flatMap(item => item.tools ?? []),
        ].flatMap(offeredTools);
        if (requests === 0 && scenario === 'code_mode') assert.ok(tools.includes('exec'));
        if (requests === 0 && scenario === 'native_tool') assert.ok(tools.includes('exec'));
        if (scenario === 'unknown_tool') assert.ok(!tools.includes('synthetic_unknown_tool'));
        const lastUser = [...parsed.input].reverse().find(item => item.role === 'user');
        const childRequest = JSON.stringify(lastUser)?.includes('SYNTHETIC_CHILD_') ||
          (parsed.input.some(item => item.type === 'agent_message') &&
            !parsed.input.some(item => item.type === 'function_call_output' && item.call_id?.startsWith('call_spawn_')));
        const dispatched = store.all<{ id: string }>(
          "SELECT id FROM instrumented_codex_attempts WHERE run_id=? AND state='dispatched'", [runId])
          .find(attempt => !observedDispatches.has(attempt.id));
        if (scenario !== 'third_child') assert.ok(dispatched, 'HTTP arrived without a distinct durable dispatch');
        if (dispatched) observedDispatches.add(dispatched.id);
        requests++;
        assert.ok(requests <= 8, 'unexpected request replay');
        const number = requests;
        if (family && number > 1 && !childRequest) await childrenCompleted;
        const finalItem = {
          id: `msg_${number}`, type: 'message', role: 'assistant',
          content: [{ type: 'output_text', text: 'Synthetic controlled response.' }],
        };
        let items: readonly unknown[] = [finalItem];
        if (number === 1 && family) {
          items = Array.from({ length: scenario === 'third_child' ? 3 : 2 }, (_, index) => ({
            id: `fc_spawn_${index}`, type: 'function_call', call_id: `call_spawn_${index}`,
            namespace: 'collaboration', name: 'spawn_agent', arguments: JSON.stringify({
              message: `SYNTHETIC_CHILD_${index}: Return one synthetic response without tools.`,
              task_name: `synthetic_child_${index}`, fork_turns: 'none',
            }),
          }));
        } else if (number === 1 && scenario === 'unknown_tool') {
          items = [{
            id: 'fc_synthetic', type: 'function_call', call_id: 'call_synthetic',
            name: 'synthetic_unknown_tool',
            arguments: JSON.stringify({ cmd: 'printf synthetic', max_output_tokens: 100 }),
          }];
        } else if (number === 1 && (scenario === 'code_mode' || scenario === 'native_tool')) {
          items = [{
            id: 'cc_synthetic', type: 'custom_tool_call', call_id: 'call_synthetic',
            name: 'exec', input: scenario === 'native_tool' ?
              'const result=await tools.exec_command({cmd:"printf synthetic",login:false,max_output_tokens:100});' +
              'if(result.output!=="synthetic") throw new Error("unexpected_synthetic_native_output");' +
              'text("NATIVE_SYNTHETIC_STDOUT_CONFIRMED");' :
              'text("synthetic");',
          }];
        }
        const usage = {
          input_tokens: 100,
          input_tokens_details: scenario === 'missing_tokens' ? { cached_tokens: 20 } :
            { cached_tokens: 20, cache_write_tokens: 0 },
          output_tokens: 10, output_tokens_details: { reasoning_tokens: 5 }, total_tokens: 110,
        };
        const events = [
          { type: 'response.created', response: { id: `resp_${number}` } },
          ...items.map(item => ({ type: 'response.output_item.done', item })),
          { type: 'response.completed', response: { id: `resp_${number}`, model: 'gpt-6.1-sol', usage } },
        ];
        response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
        response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
      })().catch((error: unknown) => {
        oracle.failure ??= error instanceof Error ? error : new Error('conformance_oracle_failure');
        response.destroy();
      });
    });
    const listening = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await listening;
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const networkPolicy = `(version 1)(allow default)(deny network*)` +
      `(allow network-outbound (remote ip "localhost:${address.port}"))` +
      `(allow network-bind (local unix-socket))(allow network-outbound (remote unix-socket))`;
    child = spawn('/usr/bin/sandbox-exec', ['-p', networkPolicy, binaryPath,
      '--harness-accounting-fd3', 'exec', '--skip-git-repo-check', '-C', root,
      '-c', `model_providers.mock={name="mock",base_url="${origin}/v1",env_key="HARNESS_SYNTHETIC_KEY",wire_api="responses",supports_websockets=true}`,
      '-c', 'model_provider="mock"', '-c', 'model="gpt-6.1-sol"', '-c', 'model_reasoning_effort="high"',
      '-c', 'analytics.enabled=false', '-c', 'otel.exporter="none"',
      '-c', 'otel.trace_exporter="none"', '-c', 'otel.metrics_exporter="none"',
      ...(family ? ['-c', 'features.multi_agent=true', '-c', 'agents.enabled=true',
        '-c', 'agents.default_subagent_model="gpt-6.1-sol"', '-c', 'agents.default_subagent_reasoning_effort="high"',
        '-c', 'agents.max_depth=1'] : []),
      ...(scenario === 'code_mode' ? ['-c', 'features.code_mode=true'] : []),
      'Return one synthetic response without external resources.',
    ], {
      cwd: root, detached: true,
      env: {
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: home, CODEX_HOME: home, TMPDIR: root, HARNESS_SYNTHETIC_KEY: 'synthetic',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    });
    let spawnFailure: Error | undefined;
    closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      child!.once('error', error => { spawnFailure = error; });
      child!.once('close', (code, signal) => resolve({ code, signal }));
    });
    child.stdout?.resume();
    child.stderr?.resume();
    const stream = child.stdio[3];
    assert.ok(stream instanceof Duplex);
    const descriptor = stream;
    bridge = connectInstrumentedDescriptor(accounting, stream, producerId);
    cancelSignal?.addEventListener('abort', terminate, { once: true });
    if (cancelSignal?.aborted) terminate();
    let timedOut = false;
    timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, 60_000);
    const { code, signal } = await closed;
    if (spawnFailure) throw spawnFailure;
    await bridge.closed;
    cancelSignal?.throwIfAborted();
    assert.equal(timedOut, false, `conformance deadline: ${scenario}`);
    assert.equal(signal, null);
    if (oracle.failure !== null) throw oracle.failure;
    const records = store.all<{ payload: string }>(
      'SELECT payload FROM instrumented_codex_records WHERE run_id=? ORDER BY sequence', [runId])
      .map(row => InstrumentedProducerRecordSchema.parse(JSON.parse(row.payload)));
    const members = store.all<{ id: string; parent_id: string | null }>(
      'SELECT id,parent_id FROM instrumented_codex_members WHERE run_id=?', [runId]);
    if (scenario === 'receiver_loss') {
      assert.ok(receiverInterrupted);
      assert.notEqual(code, 0);
      assert.equal(requests, 0);
      assert.ok(records.some(record => record.body.kind === 'attempt_reserve'));
      assert.ok(!records.some(record => record.body.kind === 'dispatch_commit'));
      assert.throws(() => accounting.seal());
      return { scenario, requests, records: records.length, members: members.length,
        terminal: 0, unresolved: 1, reasons: ['receiver_lost'], sourceUnverifiedAmount: null };
    }
    assert.equal(code, 0, `native exit: ${scenario}`);
    assert.equal(bridge.failure(), null);
    const seal = accounting.seal();
    const cutoff = clock();
    const snapshot = captureInstrumentedCostSnapshot(store, { inputId: 'synthetic-snapshot', runId, cutoff }, cutoff);
    const cost = createInstrumentedValuation(store, {
      id: 'synthetic-valuation', inputId: snapshot.input_id, targetTableId: table.id,
    }, cutoff);
    assert.equal(snapshot.build_identity, null);
    assert.equal(cost.complete_amount, null);
    assert.equal(cost.complete_window_amount, null);
    assert.equal(seal.counts.unresolved, 0);
    const unsupported = records.filter(record => record.body.kind === 'unsupported_operation');
    if (scenario === 'root' || scenario === 'direct_family') {
      assert.equal(requests, family ? 4 : 1);
      assert.equal(members.length, family ? 3 : 1);
      assert.equal(members.filter(member => member.parent_id === null).length, 1);
      assert.ok(members.every(member => member.parent_id === null || member.parent_id === sessionId));
      assert.equal(seal.counts.terminal, requests);
      assert.equal(seal.counts.reserved, requests);
      assert.equal(seal.counts.dispatch_committed, requests);
      assert.equal(observedDispatches.size, requests);
      assert.deepEqual(seal.reason_codes, [], JSON.stringify({
        scenario, record_kinds: records.map(record => [record.sequence, record.body.kind]),
        unsupported: unsupported.map(record => ({
          sequence: record.sequence, body: record.body,
        })),
      }));
      assert.deepEqual(unsupported, []);
      assert.equal(cost.source_unverified_partial_amount, family ? '0.88' : '0.22');
    } else if (scenario === 'missing_tokens') {
      assert.equal(requests, 1);
      assert.ok(records.some(record => record.body.kind === 'attempt_terminal' &&
        record.body.readings.cache_write_input.status === 'missing'));
      assert.equal(cost.facts.counter_semantics, 'unknown');
      assert.equal(cost.facts.terminal_accounting, 'unknown');
      assert.equal(cost.usage_complete, false);
    } else if (scenario === 'third_child') {
      assert.equal(members.length, 3);
      assert.ok(unsupported.some(record => record.body.kind === 'unsupported_operation' &&
        record.body.reason === 'topology_mismatch'));
      assert.ok(seal.reason_codes.includes('topology_mismatch'));
    } else {
      assert.equal(requests, 2);
      assert.ok(unsupported.some(record => record.body.kind === 'unsupported_operation' &&
        record.body.reason === 'unsupported_operation'));
      assert.ok(seal.reason_codes.includes('unsupported_operation'));
      if (scenario === 'native_tool') {
        assert.ok(unsupported.filter(record => record.body.kind === 'unsupported_operation' &&
          record.body.operation_class === 'unknown' && record.body.transport_class === 'unknown').length >= 1,
        'the cell containing a native command must remain unqualified');
      }
    }
    return { scenario, requests, records: records.length, members: members.length,
      terminal: seal.counts.terminal, unresolved: seal.counts.unresolved,
      reasons: [...seal.reason_codes, ...(scenario === 'missing_tokens' ? ['counter_semantics'] : [])],
      sourceUnverifiedAmount: cost.source_unverified_partial_amount };
  } finally {
    clearTimeout(timer);
    cancelSignal?.removeEventListener('abort', terminate);
    resolveChildren();
    bridge?.close();
    if (child && child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
      terminate();
    }
    await closed;
    server?.closeAllConnections();
    if (server?.listening) {
      const listeningServer = server;
      await new Promise<void>((resolve, reject) => listeningServer.close(error => error ? reject(error) : resolve()));
    }
    receiver?.close();
    await rm(root, { recursive: true, force: true });
  }
}
