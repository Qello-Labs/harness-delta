import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { reduceExecStream } from '../scripts/conformance/exec-stream.js';

const threadId = '11112222-3333-4444-5555-666677778888';
const stream = (...rows: unknown[]) => rows.map(row => (typeof row === 'string' ? row : JSON.stringify(row))).join('\n');
const usage = { input_tokens: 10, cached_input_tokens: 8, cache_write_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0 };

test('exec stream reduction keeps the thread id in memory and the usage vector without text', () => {
  const reduced = reduceExecStream(
    stream(
      { type: 'thread.started', thread_id: threadId },
      { type: 'turn.started' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'SECRET_RESPONSE' } },
      { type: 'turn.completed', usage },
      'not json SECRET_LINE',
      { type: 'Weird Name!' },
      { type: threadId },
      { type: 'turn.failed' }
    )
  );
  expect(reduced.threadId).toBe(threadId);
  expect(reduced.usage).toEqual({ input: 10, cached: 8, output: 2, reasoning: 0, cacheWrite: 0, totalTokens: null });
  expect(reduced.summary).toEqual({
    types: { 'thread.started': 1, 'turn.started': 1, 'item.completed': 1, 'turn.completed': 1, 'turn.failed': 1, other: 2 },
    unparsed: 1,
    threadIdPresent: true,
    turnCompleted: 1,
    threadIdConflict: false,
    failureReasons: ['unclassified_error']
  });
  expect(JSON.stringify(reduced.summary)).not.toContain('SECRET');
  expect(JSON.stringify(reduced.summary)).not.toContain(threadId);
});

test('exec stream reduction fails closed on missing, invalid or conflicting values', () => {
  expect(reduceExecStream('').threadId).toBeNull();
  expect(reduceExecStream(stream({ type: 'thread.started', thread_id: 'not-a-uuid' })).threadId).toBeNull();
  const conflict = reduceExecStream(
    stream({ type: 'thread.started', thread_id: threadId }, { type: 'thread.started', thread_id: '99992222-3333-4444-5555-666677778888' })
  );
  expect(conflict.threadId).toBeNull();
  expect(conflict.summary.threadIdConflict).toBe(true);
  const missing = reduceExecStream(stream({ type: 'turn.completed', usage: { input_tokens: 1 } }));
  expect(missing.usage).toEqual({ input: 1, cached: null, output: null, reasoning: null, cacheWrite: null, totalTokens: null });
  const negative = reduceExecStream(stream({ type: 'turn.completed', usage: { ...usage, output_tokens: -1 } }));
  expect(negative.usage?.output).toBe(-1);
  const twice = reduceExecStream(stream({ type: 'turn.completed', usage }, { type: 'turn.completed', usage }));
  expect(twice.usage).toBeNull();
  expect(twice.summary.turnCompleted).toBe(2);
  expect(readFileSync(new URL('../scripts/conformance/exec-stream.ts', import.meta.url), 'utf8')).not.toContain('node:fs');
});

test('failed exec preserves only fixed model rejection reasons, including a ChatGPT account rejection', () => {
  const reduced = reduceExecStream(
    stream(
      { type: 'error', message: "The 'synthetic-model' model is not supported when using Codex with a ChatGPT account." },
      { type: 'turn.failed', error: { code: 'model_not_supported', message: 'SECRET_DETAIL' } },
      { type: 'error', code: 'SECRET_ERROR_CODE', message: 'SECRET_UNKNOWN' },
      { type: 'item.completed', item: { text: "The 'synthetic-model' model is not supported when using Codex with a ChatGPT account." } }
    )
  );
  expect(reduced.summary.failureReasons).toEqual(['chatgpt_account_model_not_supported', 'model_not_supported', 'unclassified_error']);
  expect(reduced.usage).toBeNull();
  expect(JSON.stringify(reduced.summary)).not.toMatch(/SECRET|synthetic-model|ChatGPT account/);
});

test('failure projection rejects misleading messages and does not infer model support from unrelated events', () => {
  const reduced = reduceExecStream(
    stream(
      { type: 'error', message: 'A model may not be supported: SECRET' },
      { type: 'turn.failed', error: null },
      { type: 'item.completed', code: 'model_not_supported' },
      { type: 'turn.completed', usage }
    )
  );
  expect(reduced.summary.failureReasons).toEqual(['unclassified_error']);
  expect(reduceExecStream('').summary.failureReasons).toEqual([]);
});

test('failure projection decodes the observed HTTP JSON message wrapper without retaining its body', () => {
  const message = JSON.stringify({
    type: 'error',
    status: 400,
    error: {
      type: 'invalid_request_error',
      message: "The 'synthetic-model' model is not supported when using Codex with a ChatGPT account."
    },
    secret: 'SECRET_HTTP_BODY'
  });
  const reduced = reduceExecStream(
    stream(
      { type: 'error', message },
      { type: 'turn.failed', error: { message } },
      { type: 'error', message: JSON.stringify({ error: { code: 'model_not_supported', message: 'SECRET' } }) }
    )
  );
  expect(reduced.summary.failureReasons).toEqual(['chatgpt_account_model_not_supported', 'model_not_supported']);
  expect(JSON.stringify(reduced.summary)).not.toMatch(/SECRET|synthetic-model|invalid_request_error/);
});
