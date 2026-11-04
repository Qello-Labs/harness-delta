import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IdSchema } from './contracts.js';

/** Internal per-invocation telemetry settings for one launched product process. It is not
 * exported from the package entry point, launches no process and edits no configuration.
 * Header values are credentials: they never enter argv, logs or error messages.
 */
export interface TelemetryDestination {
  /** The receiver endpoint, exactly `http://127.0.0.1:<port>`. */
  readonly endpoint: string;
  /** Exporter headers from the receiver; values must be base64url tokens. */
  readonly headers: Readonly<Record<string, string>>;
  readonly processId: string;
}
export interface ClaudeSettingsFile {
  readonly path: string;
  /** The only arguments the launcher adds; the token stays in the private file. */
  readonly argv: readonly string[];
  /** Removes the file and its private directory. Call after the product process exits. */
  dispose(): Promise<void>;
}

const signals = ['LOGS', 'METRICS', 'TRACES'] as const;
const endpointPattern = /^http:\/\/127\.0\.0\.1:([0-9]{1,5})$/;
const headerName = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const headerValue = /^[A-Za-z0-9_-]{1,512}$/;

function invalid(): never {
  throw new Error('otel_invalid_launch_settings');
}
function checkEndpoint(endpoint: string): void {
  const port = endpointPattern.exec(endpoint)?.[1];
  // A leading zero also rejects port 0.
  if (port === undefined || port.startsWith('0') || Number(port) > 65535) invalid();
}
function validate(input: TelemetryDestination): { endpoint: string; headerList: string; processId: string } {
  checkEndpoint(input.endpoint);
  const headers = Object.entries(input.headers);
  if (headers.length === 0 || !headers.every(([name, value]) => headerName.test(name) && headerValue.test(value))) invalid();
  if (!IdSchema.safeParse(input.processId).success) invalid();
  // Both alphabets exclude the header-list separators `,` and `=`, so no encoding is needed.
  return { endpoint: input.endpoint, headerList: headers.map(([name, value]) => `${name}=${value}`).join(','), processId: input.processId };
}

/** The `env` block for Claude Code `--settings`. Settings can set but not remove variables, so
 * every variable the receiver depends on is set explicitly, including the off values.
 */
export function claudeTelemetryEnv(input: TelemetryDestination): Record<string, string> {
  const { endpoint, headerList, processId } = validate(input);
  const env: Record<string, string> = {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_LOGS_EXPORTER: 'otlp',
    // Metrics are never added to event totals and carry account attributes; traces stay off.
    OTEL_METRICS_EXPORTER: 'none',
    OTEL_TRACES_EXPORTER: 'none',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
    OTEL_EXPORTER_OTLP_HEADERS: headerList,
    // The receiver answers 415 to encoded bodies.
    OTEL_EXPORTER_OTLP_COMPRESSION: 'none',
    OTEL_LOG_USER_PROMPTS: '0',
    // Falls back to OTEL_LOG_USER_PROMPTS when unset; set explicitly.
    OTEL_LOG_ASSISTANT_RESPONSES: '0',
    OTEL_LOG_TOOL_DETAILS: '0',
    OTEL_LOG_TOOL_CONTENT: '0',
    OTEL_LOG_RAW_API_BODIES: '0',
    OTEL_LOG_MANAGED_SETTINGS: '0',
    // Detailed beta tracing exports logs to BETA_TRACING_ENDPOINT instead of the logs exporter.
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '0',
    ENABLE_ENHANCED_TELEMETRY_BETA: '0',
    ENABLE_BETA_TRACING_DETAILED: '0',
    BETA_TRACING_ENDPOINT: endpoint,
    // Events omit app.version unless this is true; the receiver fails closed without it.
    OTEL_METRICS_INCLUDE_VERSION: 'true',
    OTEL_METRICS_INCLUDE_SESSION_ID: 'true',
    OTEL_METRICS_INCLUDE_RESOURCE_ATTRIBUTES: 'true',
    OTEL_METRICS_INCLUDE_ACCOUNT_UUID: 'false',
    OTEL_METRICS_INCLUDE_REPOSITORY: 'false',
    OTEL_METRICS_INCLUDE_ENTRYPOINT: 'false',
    // IdSchema characters are all valid unencoded resource attribute characters.
    OTEL_RESOURCE_ATTRIBUTES: `harness_delta.process_id=${processId}`,
    OTEL_LOGS_EXPORT_INTERVAL: '5000'
  };
  for (const signal of signals) {
    env[`OTEL_EXPORTER_OTLP_${signal}_PROTOCOL`] = 'http/json';
    // Per-signal endpoints are used as-is, so they carry the signal path.
    env[`OTEL_EXPORTER_OTLP_${signal}_ENDPOINT`] = `${endpoint}/v1/${signal.toLowerCase()}`;
    env[`OTEL_EXPORTER_OTLP_${signal}_HEADERS`] = headerList;
    env[`OTEL_EXPORTER_OTLP_${signal}_COMPRESSION`] = 'none';
  }
  return env;
}

/** Codex `-c` overrides that route logs to the receiver and turn traces, metrics and prompt
 * logging off. Codex documents only static otel headers, which `-c` would place in argv, so this
 * builder takes no credentials: Codex support stays blocked until an argv-free source is verified.
 */
export function codexOtelOverrides(input: { readonly endpoint: string }): string[] {
  if (Object.keys(input).some(key => key !== 'endpoint')) invalid();
  checkEndpoint(input.endpoint);
  return [
    // Whether this inline table replaces or merges a configured exporter table needs a live check.
    '-c',
    `otel.exporter={otlp-http={endpoint="${input.endpoint}/v1/logs",protocol="json"}}`,
    '-c',
    'otel.trace_exporter="none"',
    '-c',
    'otel.metrics_exporter="none"',
    '-c',
    'otel.log_user_prompt=false'
  ];
}

/** Writes the settings to a 0600 file in a private 0700 directory. Invalid input creates nothing. */
export async function writeClaudeSettingsFile(input: TelemetryDestination, options: { parent?: string } = {}): Promise<ClaudeSettingsFile> {
  const content = JSON.stringify({ env: claudeTelemetryEnv(input) });
  const directory = await mkdtemp(join(options.parent ?? tmpdir(), 'harness-delta-otel-'));
  const path = join(directory, 'settings.json');
  const dispose = () => rm(directory, { recursive: true, force: true });
  try {
    await writeFile(path, content, { mode: 0o600, flag: 'wx' });
  } catch {
    await dispose();
    throw new Error('otel_settings_write_failed');
  }
  return { path, argv: ['--settings', path], dispose };
}
