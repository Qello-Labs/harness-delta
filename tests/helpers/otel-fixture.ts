// Independently authored synthetic OTLP http/json payloads. Attribute names follow the
// documented Claude Code event tables; values are invented and prove no product support.
export const syntheticVersion = '1.0.0-synthetic';
export const launchSessionId = '00000000-0000-4000-8000-000000000001';
export const profile = {
  id: 'synthetic-claude-otel-v1',
  product: 'claude_code',
  version: syntheticVersion,
  sessionStartSequence: 0,
  querySources: { repl_main_thread: 'main', compact: 'compact', synthetic_helper: 'auxiliary' }
} as const;

type Value = string | number | boolean | string[];
const anyValue = (value: Value): Record<string, unknown> =>
  Array.isArray(value)
    ? { arrayValue: { values: value.map(item => ({ stringValue: item })) } }
    : typeof value === 'string'
      ? { stringValue: value }
      : typeof value === 'boolean'
        ? { boolValue: value }
        : Number.isInteger(value)
          ? { intValue: String(value) }
          : { doubleValue: value };
export const attributes = (values: Record<string, Value>) => Object.entries(values).map(([key, value]) => ({ key, value: anyValue(value) }));

export interface RecordOptions {
  processId: string;
  sessionId?: string;
  version?: string;
  at?: string;
}
// Identity, workspace and content-like attributes are included on purpose: projection must drop them.
function standard(name: string, sequence: number, options: RecordOptions): Record<string, Value> {
  return {
    'event.name': name,
    'event.timestamp': options.at ?? '2026-01-01T00:00:01.000Z',
    'event.sequence': sequence,
    'session.id': options.sessionId ?? launchSessionId,
    'app.version': options.version ?? syntheticVersion,
    'app.entrypoint': 'cli',
    'user.email': 'synthetic.person@example.invalid',
    'organization.id': 'org-synthetic',
    'user.account_uuid': 'account-synthetic',
    'user.account_id': 'user_synthetic',
    'user.id': 'anon-synthetic',
    'terminal.type': 'synthetic-term',
    'prompt.id': 'prompt-synthetic',
    'vcs.repository.name': 'synthetic-repo',
    'harness_delta.process_id': options.processId
  };
}
export function logRecord(name: string, sequence: number, extra: Record<string, Value>, options: RecordOptions) {
  return {
    timeUnixNano: '1767225601000000000',
    body: { stringValue: `claude_code.${name}` },
    attributes: attributes({ ...standard(name, sequence, options), ...extra })
  };
}
export const sessionStart = (sequence: number, options: RecordOptions, sources: string[] = []) =>
  logRecord(
    'managed_settings_resolved',
    sequence,
    {
      'managed_settings.trigger': 'startup',
      'managed_settings.sources': sources,
      'managed_settings.source_behavior': 'first-wins',
      'managed_settings.helper.state': 'none',
      'managed_settings.helper.path': '/synthetic/private/helper'
    },
    options
  );
export const apiRequest = (sequence: number, options: RecordOptions, overrides: Record<string, Value> = {}) =>
  logRecord(
    'api_request',
    sequence,
    {
      model: 'synthetic-model',
      cost_usd: 0.5,
      cost_usd_micros: 500000,
      duration_ms: 1200,
      input_tokens: 10,
      output_tokens: 7,
      cache_read_tokens: 3,
      cache_creation_tokens: 2,
      request_id: `req_synthetic_${sequence}`,
      client_request_id: `client-${sequence}`,
      speed: 'normal',
      query_source: 'repl_main_thread',
      effort: 'high',
      'agent.name': 'synthetic-private-agent',
      ...overrides
    },
    options
  );
export const apiError = (sequence: number, options: RecordOptions, overrides: Record<string, Value> = {}) =>
  logRecord(
    'api_error',
    sequence,
    {
      model: 'synthetic-model',
      error: 'synthetic private error text',
      status_code: 529,
      duration_ms: 300,
      attempt: 3,
      request_id: `req_error_${sequence}`,
      client_request_id: `client-error-${sequence}`,
      query_source: 'compact',
      ...overrides
    },
    options
  );
export const userPrompt = (sequence: number, options: RecordOptions, prompt: Value = '<REDACTED>') =>
  logRecord('user_prompt', sequence, { prompt_length: 42, prompt }, options);
export const assistantResponse = (sequence: number, options: RecordOptions, response: Value = '<REDACTED>') =>
  logRecord('assistant_response', sequence, { model: 'synthetic-model', response_length: 17, query_source: 'repl_main_thread', response }, options);

export function logsRequest(records: unknown[], resource: Record<string, Value> = {}) {
  return {
    resourceLogs: [
      {
        resource: { attributes: attributes({ 'service.name': 'claude-code', 'host.name': 'synthetic-host', ...resource }) },
        scopeLogs: [{ scope: { name: 'com.anthropic.claude_code.events' }, logRecords: records }]
      }
    ]
  };
}
