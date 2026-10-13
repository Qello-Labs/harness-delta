#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
if (args[0] !== '--harness-accounting-fd3' || args[1] !== 'exec' ||
    args[2] !== '--model' || args[3] !== 'gpt-6.1-sol' ||
    !args.includes('model_reasoning_effort="high"') ||
    args.some(arg => arg.startsWith('model_providers.openai.')) ||
    !args.includes('analytics.enabled=false') || !args.includes('otel.exporter="none"') ||
    !args.includes('otel.trace_exporter="none"') || !args.includes('otel.metrics_exporter="none"') ||
    !args.includes('agents.max_depth=1') ||
    args.at(-2) !== '--') process.exit(91);
const descriptor = new Socket({ fd: 3, readable: true, writable: true });
const lines = createInterface({ input: descriptor })[Symbol.asyncIterator]();
const next = async () => {
  const line = await lines.next();
  if (line.done) throw new Error('synthetic_receiver_closed');
  return JSON.parse(line.value);
};
const bootstrap = await next();
const db = new DatabaseSync(join(process.cwd(), 'measurement.sqlite'));
const receipt = db.prepare('SELECT payload FROM instrumented_codex_launch_receipts WHERE run_id=?')
  .get(bootstrap.run_id);
if (!receipt || JSON.parse(receipt.payload).process_id !== process.pid) process.exit(92);
db.close();
const canonical = value => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};
let sequence = 0;
let previousHash = null;
const send = async body => {
  const record = {
    schema_version: 1, run_id: bootstrap.run_id, producer_instance_id: bootstrap.producer_instance_id,
    member_id: bootstrap.root_session_id, task_generation: bootstrap.task_generation,
    sequence: ++sequence, previous_record_hash: previousHash,
    occurred_at: new Date().toISOString(), body,
  };
  descriptor.write(`${JSON.stringify(record)}\n`);
  previousHash = createHash('sha256').update(canonical(record)).digest('hex');
  return next();
};
const mode = basename(process.argv[1]);
if (mode.includes('budget')) await lines.next();
await send({ kind: 'member_ready', native_session_id: randomUUID(), parent_member_id: null,
  child_reservation_id: null, configuration_receipt_id: bootstrap.configuration_receipt_id });
await send({ kind: 'operation_open', operation_id: 'fixture-operation', turn_id: null,
  operation_class: 'generation', transport_class: 'http_responses',
  requested_model: 'gpt-6.1-sol', requested_effort: 'high',
  configuration_revision: bootstrap.configuration_revision });
const reserved = await send({ kind: 'attempt_reserve', operation_id: 'fixture-operation',
  retry_parent_attempt_id: null });
await send({ kind: 'dispatch_commit', attempt_id: reserved.body.attempt_id });
if (mode.includes('gap')) {
  descriptor.end();
} else if (mode.includes('corrupt')) {
  descriptor.end('not-json\n');
} else {
  if (!mode.includes('unresolved')) {
    const observed = value => ({ status: 'observed', value, reason: null });
    await send({ kind: 'attempt_terminal', attempt_id: reserved.body.attempt_id,
      disposition: 'response_completed', response_id: 'fixture-response',
      effective_model: 'gpt-6.1-sol', readings: {
        input_total: observed(100), cached_input: observed(20), cache_write_input: observed(0),
        output_total: observed(10), reasoning_output: observed(5), total_tokens: observed(110),
      } });
  }
  if (mode.includes('unsupported')) {
    await send({ kind: 'unsupported_operation', operation_id: 'fixture-auxiliary',
      operation_class: 'guardian', transport_class: 'websocket', reason: 'unsupported_operation' });
  }
  await send({ kind: 'operation_close', operation_id: 'fixture-operation', disposition: 'completed' });
  const fence = await send({ kind: 'close_request' });
  await send({ kind: 'member_close', close_fence_id: fence.body.close_fence_id,
    final_record_sequence: sequence, final_record_hash: previousHash });
  descriptor.end();
}
if (mode.includes('nonzero')) process.exitCode = 7;
