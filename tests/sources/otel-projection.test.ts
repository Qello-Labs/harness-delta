import { expect, test } from 'vitest';
import { decodeLogsRequest, projectRecord } from '../../src/sources/otel-projection.js';
import { apiError, apiRequest, assistantResponse, logRecord, logsRequest, profile, sessionStart, userPrompt } from '../helpers/otel-fixture.js';

const options = { processId: 'process-1' };
const forbidden = [
  'synthetic.person',
  'org-synthetic',
  'account-synthetic',
  'user_synthetic',
  'anon-synthetic',
  'synthetic-repo',
  'synthetic-host',
  'synthetic-private-agent',
  'synthetic private error text',
  '/synthetic/private',
  'prompt-synthetic',
  'repl_main_thread',
  '500000',
  '0.5',
  'REDACTED',
  'synthetic-term'
];

function only(request: unknown) {
  const decoded = decodeLogsRequest(request);
  expect(decoded).not.toBeNull();
  return decoded!.map(record => projectRecord(record, profile));
}

test('api_request projection keeps only allowlisted usage metadata', () => {
  const [projected] = only(logsRequest([apiRequest(4, options)]));
  expect(projected).toEqual({
    ok: true,
    record: {
      eventType: 'api_request',
      sequence: 4,
      occurredAt: '2026-01-01T00:00:01.000Z',
      sessionId: '00000000-0000-4000-8000-000000000001',
      productVersion: '1.0.0-synthetic',
      processAttribute: 'process-1',
      fields: {
        model: 'synthetic-model',
        request_id: 'req_synthetic_4',
        client_request_id: 'client-4',
        success: true,
        status_code: null,
        attempt: null,
        duration_ms: 1200,
        input_tokens: 10,
        output_tokens: 7,
        cache_read_tokens: 3,
        cache_creation_tokens: 2,
        query_source_category: 'main'
      },
      managedSources: null
    }
  });
  const text = JSON.stringify(projected);
  for (const value of forbidden) expect(text).not.toContain(value);
});

test('api_error keeps status and attempt but drops error text and has no token counts', () => {
  const [projected] = only(logsRequest([apiError(5, options)]));
  expect(projected).toMatchObject({
    ok: true,
    record: {
      eventType: 'api_error',
      fields: {
        success: false,
        status_code: 529,
        attempt: 3,
        duration_ms: 300,
        query_source_category: 'compact',
        input_tokens: null,
        output_tokens: null
      }
    }
  });
  const text = JSON.stringify(projected);
  for (const value of forbidden) expect(text).not.toContain(value);
});

test('unknown query sources map to other without retaining the raw value', () => {
  const [projected] = only(logsRequest([apiRequest(1, options, { query_source: 'private-subagent-name' })]));
  expect(projected).toMatchObject({ ok: true, record: { fields: { query_source_category: 'other' } } });
  expect(JSON.stringify(projected)).not.toContain('private-subagent-name');
});

test('other event types keep only sequence, time, session and version', () => {
  const [projected] = only(logsRequest([userPrompt(2, options)]));
  expect(projected).toEqual({
    ok: true,
    record: {
      eventType: 'other',
      sequence: 2,
      occurredAt: '2026-01-01T00:00:01.000Z',
      sessionId: '00000000-0000-4000-8000-000000000001',
      productVersion: '1.0.0-synthetic',
      processAttribute: 'process-1',
      fields: null,
      managedSources: null
    }
  });
});

test('session-start keeps only its trigger and whether managed sources exist', () => {
  const [clean, managed] = only(logsRequest([sessionStart(0, options), sessionStart(0, options, ['file'])]));
  expect(clean).toMatchObject({ ok: true, record: { eventType: 'managed_settings_resolved', fields: { trigger: 'startup' }, managedSources: false } });
  expect(managed).toMatchObject({ ok: true, record: { managedSources: true } });
  expect(JSON.stringify([clean, managed])).not.toContain('/synthetic/private');
});

test('raw body events are flagged as content exposure and project nothing', () => {
  const [projected] = only(logsRequest([logRecord('api_request_body', 3, { body: 'synthetic content' }, options)]));
  expect(projected).toEqual({ ok: false, reason: 'content_enabled' });
});

test('redacted prompt and response attributes project as other events', () => {
  const projected = only(logsRequest([userPrompt(1, options), assistantResponse(2, options)]));
  expect(projected).toMatchObject([
    { ok: true, record: { eventType: 'other', fields: null } },
    { ok: true, record: { eventType: 'other', fields: null } }
  ]);
  expect(JSON.stringify(projected)).not.toContain('REDACTED');
});

test('prompt or response values other than the exact redaction marker are flagged as content exposure', () => {
  const exposed = [
    userPrompt(1, options, 'synthetic prompt text'),
    assistantResponse(2, options, 'synthetic response text'),
    userPrompt(3, options, ''),
    userPrompt(4, options, '[REDACTED]'),
    assistantResponse(5, options, 7),
    apiRequest(6, options, { prompt: 'synthetic prompt text' })
  ];
  const projected = only(logsRequest(exposed));
  expect(projected).toEqual(exposed.map(() => ({ ok: false, reason: 'content_enabled' })));
  expect(JSON.stringify(projected)).not.toContain('synthetic');
});

test('records without a valid sequence, timestamp, session or complete token counts are invalid', () => {
  const missingTokens = apiRequest(1, options);
  missingTokens.attributes = missingTokens.attributes.filter(item => item.key !== 'cache_creation_tokens');
  const badSequence = apiRequest(-1, options);
  const badSession = apiRequest(1, { ...options, sessionId: 'bad session' });
  const badTime = apiRequest(1, { ...options, at: 'yesterday' });
  const overflow = apiRequest(1, options, { input_tokens: '9007199254740993' as unknown as number });
  for (const record of [missingTokens, badSequence, badSession, badTime]) {
    expect(only(logsRequest([record]))[0]).toEqual({ ok: false, reason: 'invalid_record' });
  }
  overflow.attributes = overflow.attributes.map(item => (item.key === 'input_tokens' ? { key: item.key, value: { intValue: '9007199254740993' } } : item));
  expect(only(logsRequest([overflow]))[0]).toEqual({ ok: false, reason: 'invalid_record' });
});

test('the process attribute may come from resource attributes', () => {
  const record = apiRequest(1, options);
  record.attributes = record.attributes.filter(item => item.key !== 'harness_delta.process_id');
  const [projected] = only(logsRequest([record], { 'harness_delta.process_id': 'process-9' }));
  expect(projected).toMatchObject({ ok: true, record: { processAttribute: 'process-9' } });
});

test('structurally invalid requests are undecodable', () => {
  for (const request of [null, [], { resourceLogs: 'x' }, { resourceLogs: [{ scopeLogs: [{ logRecords: [{ attributes: 'x' }] }] }] }]) {
    expect(decodeLogsRequest(request)).toBeNull();
  }
  expect(decodeLogsRequest({})).toEqual([]);
});
