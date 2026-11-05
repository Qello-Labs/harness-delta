import { afterEach, expect, test } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Store } from '../../src/store.js';
import { Lifecycle } from '../../src/lifecycle.js';
import { OtelReceiver } from '../../src/sources/otel-receiver.js';
import { claudeTelemetryEnv, codexOtelOverrides, writeClaudeSettingsFile, type TelemetryDestination } from '../../src/sources/otel-launch-settings.js';
import { launchSessionId, profile, syntheticVersion } from '../helpers/otel-fixture.js';

const resources: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const clean of resources.splice(0).reverse()) await clean();
});
const token = 'synthetic-token_AZaz09';
const destination: TelemetryDestination = { endpoint: 'http://127.0.0.1:45678', headers: { 'x-harness-delta-token': token }, processId: 'process-1' };
const signals = ['LOGS', 'METRICS', 'TRACES'] as const;

/** OTel header-list parsing (`key=value,key=value`) as exporters apply it. */
function parseHeaderList(value: string): Record<string, string> {
  return Object.fromEntries(
    value.split(',').map(pair => {
      const index = pair.indexOf('=');
      return [pair.slice(0, index), decodeURIComponent(pair.slice(index + 1))];
    })
  );
}

test('enables only the logs exporter and turns metrics and traces off', () => {
  const env = claudeTelemetryEnv(destination);
  expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1');
  expect(env.OTEL_LOGS_EXPORTER).toBe('otlp');
  expect(env.OTEL_METRICS_EXPORTER).toBe('none');
  expect(env.OTEL_TRACES_EXPORTER).toBe('none');
});

test('points the generic and every per-signal exporter at the receiver over http/json', () => {
  const env = claudeTelemetryEnv(destination);
  expect(env.OTEL_EXPORTER_OTLP_PROTOCOL).toBe('http/json');
  expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://127.0.0.1:45678');
  for (const signal of signals) {
    expect(env[`OTEL_EXPORTER_OTLP_${signal}_PROTOCOL`]).toBe('http/json');
    // Per-signal endpoints are used as-is, so they carry the signal path.
    expect(env[`OTEL_EXPORTER_OTLP_${signal}_ENDPOINT`]).toBe(`http://127.0.0.1:45678/v1/${signal.toLowerCase()}`);
    expect(env[`OTEL_EXPORTER_OTLP_${signal}_COMPRESSION`]).toBe('none');
  }
  expect(env.OTEL_EXPORTER_OTLP_COMPRESSION).toBe('none');
  // Detailed beta tracing would reroute logs; keep it off and local.
  expect(env.BETA_TRACING_ENDPOINT).toBe('http://127.0.0.1:45678');
  for (const flag of ['CLAUDE_CODE_ENHANCED_TELEMETRY_BETA', 'ENABLE_ENHANCED_TELEMETRY_BETA', 'ENABLE_BETA_TRACING_DETAILED']) expect(env[flag]).toBe('0');
});

test('sends the token header generically and per signal, and nowhere else', () => {
  const env = claudeTelemetryEnv(destination);
  const headerKeys = ['OTEL_EXPORTER_OTLP_HEADERS', ...signals.map(signal => `OTEL_EXPORTER_OTLP_${signal}_HEADERS`)];
  for (const key of headerKeys) expect(parseHeaderList(env[key]!)).toEqual(destination.headers);
  const carriers = Object.entries(env)
    .filter(([, value]) => value.includes(token))
    .map(([key]) => key);
  expect(carriers.sort()).toEqual(headerKeys.sort());
});

test('turns every documented content option off', () => {
  const env = claudeTelemetryEnv(destination);
  const content = [
    'OTEL_LOG_USER_PROMPTS',
    'OTEL_LOG_ASSISTANT_RESPONSES',
    'OTEL_LOG_TOOL_DETAILS',
    'OTEL_LOG_TOOL_CONTENT',
    'OTEL_LOG_RAW_API_BODIES',
    'OTEL_LOG_MANAGED_SETTINGS'
  ];
  for (const key of content) expect(env[key]).toBe('0');
  expect(
    Object.keys(env)
      .filter(key => key.startsWith('OTEL_LOG_'))
      .sort()
  ).toEqual(content.sort());
});

test('carries the attributes the receiver checks and minimizes identity attributes', () => {
  const env = claudeTelemetryEnv(destination);
  expect(env.OTEL_METRICS_INCLUDE_VERSION).toBe('true');
  expect(env.OTEL_METRICS_INCLUDE_SESSION_ID).toBe('true');
  expect(env.OTEL_METRICS_INCLUDE_RESOURCE_ATTRIBUTES).toBe('true');
  expect(env.OTEL_RESOURCE_ATTRIBUTES).toBe('harness_delta.process_id=process-1');
  for (const key of ['OTEL_METRICS_INCLUDE_ACCOUNT_UUID', 'OTEL_METRICS_INCLUDE_REPOSITORY', 'OTEL_METRICS_INCLUDE_ENTRYPOINT']) expect(env[key]).toBe('false');
  expect(env.OTEL_LOGS_EXPORT_INTERVAL).toBe('5000');
});

test('sets exactly the reviewed variable set', () => {
  expect(Object.keys(claudeTelemetryEnv(destination)).sort()).toEqual(
    [
      'BETA_TRACING_ENDPOINT',
      'CLAUDE_CODE_ENABLE_TELEMETRY',
      'CLAUDE_CODE_ENHANCED_TELEMETRY_BETA',
      'ENABLE_BETA_TRACING_DETAILED',
      'ENABLE_ENHANCED_TELEMETRY_BETA',
      'OTEL_EXPORTER_OTLP_COMPRESSION',
      'OTEL_EXPORTER_OTLP_ENDPOINT',
      'OTEL_EXPORTER_OTLP_HEADERS',
      'OTEL_EXPORTER_OTLP_LOGS_COMPRESSION',
      'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
      'OTEL_EXPORTER_OTLP_LOGS_HEADERS',
      'OTEL_EXPORTER_OTLP_LOGS_PROTOCOL',
      'OTEL_EXPORTER_OTLP_METRICS_COMPRESSION',
      'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
      'OTEL_EXPORTER_OTLP_METRICS_HEADERS',
      'OTEL_EXPORTER_OTLP_METRICS_PROTOCOL',
      'OTEL_EXPORTER_OTLP_PROTOCOL',
      'OTEL_EXPORTER_OTLP_TRACES_COMPRESSION',
      'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
      'OTEL_EXPORTER_OTLP_TRACES_HEADERS',
      'OTEL_EXPORTER_OTLP_TRACES_PROTOCOL',
      'OTEL_LOGS_EXPORTER',
      'OTEL_LOGS_EXPORT_INTERVAL',
      'OTEL_LOG_ASSISTANT_RESPONSES',
      'OTEL_LOG_MANAGED_SETTINGS',
      'OTEL_LOG_RAW_API_BODIES',
      'OTEL_LOG_TOOL_CONTENT',
      'OTEL_LOG_TOOL_DETAILS',
      'OTEL_LOG_USER_PROMPTS',
      'OTEL_METRICS_EXPORTER',
      'OTEL_METRICS_INCLUDE_ACCOUNT_UUID',
      'OTEL_METRICS_INCLUDE_ENTRYPOINT',
      'OTEL_METRICS_INCLUDE_REPOSITORY',
      'OTEL_METRICS_INCLUDE_RESOURCE_ATTRIBUTES',
      'OTEL_METRICS_INCLUDE_SESSION_ID',
      'OTEL_METRICS_INCLUDE_VERSION',
      'OTEL_RESOURCE_ATTRIBUTES',
      'OTEL_TRACES_EXPORTER'
    ].sort()
  );
});

test.each([
  ['a non-loopback host', { endpoint: 'http://192.168.1.2:45678' }],
  ['a host name', { endpoint: 'http://localhost:45678' }],
  ['https', { endpoint: 'https://127.0.0.1:45678' }],
  ['a path', { endpoint: 'http://127.0.0.1:45678/v1/logs' }],
  ['a missing port', { endpoint: 'http://127.0.0.1' }],
  ['port zero', { endpoint: 'http://127.0.0.1:0' }],
  ['a port above the range', { endpoint: 'http://127.0.0.1:65536' }],
  ['a port with a leading zero', { endpoint: 'http://127.0.0.1:04567' }],
  ['credentials in the URL', { endpoint: 'http://user:pass@127.0.0.1:45678' }],
  ['a header value that breaks the header list', { headers: { 'x-harness-delta-token': `${token},other=x` } }],
  ['a header value with whitespace', { headers: { 'x-harness-delta-token': `${token} x` } }],
  ['an invalid header name', { headers: { 'x harness': token } }],
  ['no headers', { headers: {} }],
  ['a process id outside the id alphabet', { processId: 'process 1,other=x' }]
])('rejects %s without echoing the input', (_, change) => {
  const input = { ...destination, ...change };
  let message = '';
  try {
    claudeTelemetryEnv(input);
  } catch (error) {
    message = String(error);
  }
  expect(message).toBe('Error: otel_invalid_launch_settings');
  expect(message).not.toContain(token);
});

test('writes a private settings file that keeps the token out of argv, and disposes it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'otel-settings-test-'));
  resources.push(() => rmSync(root, { recursive: true, force: true }));
  const file = await writeClaudeSettingsFile(destination, { parent: root });
  resources.push(() => file.dispose());
  expect(file.argv).toEqual(['--settings', file.path]);
  expect(file.argv.join(' ')).not.toContain(token);
  expect(dirname(file.path).startsWith(root)).toBe(true);
  expect(statSync(file.path).mode & 0o777).toBe(0o600);
  expect(statSync(dirname(file.path)).mode & 0o777).toBe(0o700);
  expect(JSON.parse(readFileSync(file.path, 'utf8'))).toEqual({ env: claudeTelemetryEnv(destination) });
  await file.dispose();
  expect(existsSync(dirname(file.path))).toBe(false);
  await expect(file.dispose()).resolves.toBeUndefined();
});

test('rejects invalid input before creating any file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'otel-settings-test-'));
  resources.push(() => rmSync(root, { recursive: true, force: true }));
  await expect(writeClaudeSettingsFile({ ...destination, endpoint: 'http://10.0.0.1:1' }, { parent: root })).rejects.toThrow('otel_invalid_launch_settings');
  expect(readdirSync(root)).toEqual([]);
});

test('accepts the destination of a real receiver and round-trips its headers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'otel-test-'));
  const store = new Store(':memory:');
  resources.push(
    () => rmSync(root, { recursive: true, force: true }),
    () => store.close()
  );
  const clock = () => '2026-01-01T00:00:00.000Z';
  const life = new Lifecycle(store, clock);
  life.registerProject('p1', root);
  life.createTask('p1', 't1', {
    type: 'feature',
    expected_size: 'small',
    assignee: 'u1',
    product: 'claude_code',
    model: 'synthetic-model',
    criterion_ids: ['c1']
  });
  life.start('t1');
  const receiver = await OtelReceiver.start(
    store,
    { runId: 'run-1', processId: 'process-1', taskId: 't1', sessionId: launchSessionId, productVersion: syntheticVersion },
    profile,
    { clock }
  );
  resources.push(() => receiver.close());
  const env = claudeTelemetryEnv({ endpoint: receiver.endpoint, headers: receiver.exporterHeaders(), processId: 'process-1' });
  expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(receiver.endpoint);
  expect(parseHeaderList(env.OTEL_EXPORTER_OTLP_LOGS_HEADERS!)).toEqual(receiver.exporterHeaders());
});

test('builds token-free Codex overrides that route logs to the receiver and turn the rest off', () => {
  expect(codexOtelOverrides({ endpoint: 'http://127.0.0.1:45678' })).toEqual([
    '-c',
    'otel.exporter={otlp-http={endpoint="http://127.0.0.1:45678/v1/logs",protocol="json"}}',
    '-c',
    'otel.trace_exporter="none"',
    '-c',
    'otel.metrics_exporter="none"',
    '-c',
    'otel.log_user_prompt=false'
  ]);
});

test('rejects a non-loopback Codex endpoint and accepts no credentials', () => {
  expect(() => codexOtelOverrides({ endpoint: 'http://localhost:45678' })).toThrow('otel_invalid_launch_settings');
  // Codex has no documented argv-free header source, so the builder has no header input.
  expect(() => codexOtelOverrides({ endpoint: 'http://127.0.0.1:45678', headers: { 'x-harness-delta-token': token } } as never)).toThrow(
    'otel_invalid_launch_settings'
  );
});

test('is not exported from the package entry point', async () => {
  const api = await import('../../src/index.js');
  expect(Object.keys(api).filter(name => /telemetry|settings|otel/i.test(name))).toEqual([]);
});
