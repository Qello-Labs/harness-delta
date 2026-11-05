import { expect, test } from 'vitest';
import { ReadingSchema, EventSchema, ComparisonModeSchema } from '../src/contracts.js';

test('zero is observed and unavailable readings cannot contain invented values', () => {
  expect(ReadingSchema.parse({ value: 0, status: 'observed', reason: null }).value).toBe(0);
  for (const status of ['missing', 'error', 'excluded', 'unmeasurable']) {
    expect(ReadingSchema.safeParse({ value: 0, status, reason: 'not_available' }).success).toBe(false);
    expect(ReadingSchema.safeParse({ value: null, status, reason: 'not_available' }).success).toBe(true);
  }
  for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, null]) {
    expect(ReadingSchema.safeParse({ value, status: 'observed', reason: null }).success).toBe(false);
  }
});

test('events reject content, unknown fields, non-UTC dates, and invalid identities', () => {
  const event = {
    id: 'e1',
    project_id: 'p1',
    task_id: 't1',
    session_id: 's1',
    source_key: 'source:1',
    occurred_at: '2026-01-01T00:00:00Z',
    payload: { kind: 'session_linked' }
  };
  expect(EventSchema.safeParse(event).success).toBe(true);
  expect(EventSchema.safeParse({ ...event, payload: { kind: 'session_linked', prompt: 'synthetic' } }).success).toBe(false);
  expect(EventSchema.safeParse({ ...event, local_path: '/synthetic' }).success).toBe(false);
  expect(EventSchema.safeParse({ ...event, occurred_at: '2026-01-01T09:00:00+09:00' }).success).toBe(false);
  expect(EventSchema.safeParse({ ...event, id: '' }).success).toBe(false);
  expect(ComparisonModeSchema.safeParse('randomized_task').success).toBe(true);
  expect(ComparisonModeSchema.safeParse('observational_period').success).toBe(true);
  expect(ComparisonModeSchema.safeParse('mixed').success).toBe(false);
});

test('token aggregation rejects overflow and invalid individual readings', async () => {
  const { addTokens } = await import('../src/contracts.js');
  expect(addTokens([100, 40, 0])).toBe(140);
  expect(() => addTokens([Number.MAX_SAFE_INTEGER, 1])).toThrow('token_overflow');
  expect(() => addTokens([-1])).toThrow();
});

test('shared monetary values are decimal strings, not floats or content', async () => {
  const { MonetaryAmountSchema } = await import('../src/contracts.js');
  expect(MonetaryAmountSchema.safeParse('0.000001').success).toBe(true);
  for (const input of [0.1, '-1', 'Infinity', '1e4', 'private content', '01.2']) {
    expect(MonetaryAmountSchema.safeParse(input).success).toBe(false);
  }
});

test('usage accepts observed product versions but rejects nested private fields', () => {
  const reading = { status: 'observed', value: 0, reason: null };
  const event = {
    id: 'e1',
    project_id: 'p1',
    task_id: 't1',
    session_id: 's1',
    source_key: 'source:1',
    occurred_at: '2026-01-01T00:00:00Z',
    payload: {
      kind: 'usage',
      input_total: reading,
      cached_input: reading,
      output_total: reading,
      reasoning_output: reading,
      product: 'codex',
      product_version: '0.156.1',
      model: 'gpt-6-astra',
      epoch: 'epoch1'
    }
  };
  expect(EventSchema.safeParse(event).success).toBe(true);
  expect(
    EventSchema.safeParse({ ...event, payload: { ...event.payload, product: 'claude_code', product_version: '2.1.283', model: 'claude-sonnet-4.5' } }).success
  ).toBe(true);
  expect(EventSchema.safeParse({ ...event, payload: { ...event.payload, input_total: { ...reading, content: 'SYNTHETIC_PRIVATE' } } }).success).toBe(false);
});

test('shared task and outcome allowlists exclude local data and criterion prose', async () => {
  const { SharedTaskSchema, SharedOutcomeSchema } = await import('../src/contracts.js');
  const task = {
    id: 't1',
    project_id: 'p1',
    type: 'feature',
    expected_size: 'small',
    assignee: 'u1',
    product: 'codex',
    model: 'gpt-6-astra',
    criterion_ids: ['c1']
  };
  expect(SharedTaskSchema.safeParse(task).success).toBe(true);
  for (const key of ['local_root', 'criteria_text', 'prompt', 'api_key']) {
    expect(SharedTaskSchema.safeParse({ ...task, [key]: 'SYNTHETIC_PRIVATE' }).success).toBe(false);
  }
  const outcome = { task_id: 't1', status: 'success', criteria_met: ['c1'], first_success: null, assessed_at: '2026-01-01T00:00:00Z' };
  expect(SharedOutcomeSchema.safeParse(outcome).success).toBe(true);
  expect(SharedOutcomeSchema.safeParse({ ...outcome, criteria_met: [{ id: 'c1', text: 'SYNTHETIC_PRIVATE' }] }).success).toBe(false);
});
