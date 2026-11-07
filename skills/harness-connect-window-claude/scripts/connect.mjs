import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const version = value => typeof value === 'string' && /^"[a-f0-9]{64}"$/.test(value);
const record = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
const reasons = new Set([
  'binding_window_activation_required',
  'binding_window_unavailable',
  'binding_version_out_of_window',
  'binding_ordinary_assignment_conflict',
  'binding_root_only_required',
  'binding_scope_revoked',
  'binding_scope_mismatch',
  'binding_window_trial_expired',
  'binding_window_trial_budget_exhausted',
  'binding_fresh_root_required',
  'compatibility_invalidated',
  'binding_receipt_stale',
  'binding_identity_mismatch',
  'binding_identity_unavailable',
  'binding_metadata_untrusted',
  'binding_session_conflict',
  'binding_relation_invalid',
  'binding_request_conflict',
  'binding_source_changed',
  'binding_source_unavailable',
  'binding_source_unqualified',
  'binding_reconnect_required',
  'binding_provider_unavailable',
  'binding_executable_changed',
  'deleted_identifier',
  'ordinary_preparation_required',
  'ordinary_configuration_changed',
  'task_closed',
  'connection_not_available',
  'ui_state_changed',
  'ui_action_conflict',
  'ui_action_uncertain'
]);
class ConnectError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
const fail = code => {
  throw new ConnectError(code);
};
function localOrigin(value) {
  if (typeof value !== 'string') fail('invalid_origin');
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('invalid_origin');
  }
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    value !== url.origin
  )
    fail('invalid_origin');
  return url.origin;
}
function taskView(value, options) {
  if (!record(value, ['csrf', 'task']) || typeof value.csrf !== 'string' || !/^[a-f0-9]{64}$/.test(value.csrf)) {
    fail('unsupported_ui_contract');
  }
  const task = value.task;
  if (
    !record(task, ['schema_version', 'kind', 'project_id', 'task_id', 'version', 'state', 'connection_enabled', 'reason', 'selected_root_id']) ||
    task.schema_version !== 1 ||
    task.kind !== 'claude_window_task' ||
    task.project_id !== options.project ||
    task.task_id !== options.task ||
    !version(task.version) ||
    !['registered', 'active', 'paused', 'finalized'].includes(task.state) ||
    typeof task.connection_enabled !== 'boolean' ||
    !(task.reason === null || reasons.has(task.reason)) ||
    !(task.selected_root_id === null || id(task.selected_root_id)) ||
    (task.connection_enabled && task.reason !== null)
  ) {
    fail('unsupported_ui_contract');
  }
  return { csrf: value.csrf, task };
}
function requireLive(task) {
  if (task.state !== 'active') fail('task_closed');
  if (!task.connection_enabled) {
    fail(task.reason ?? 'connection_not_available');
  }
}
function connectionResult(value, options) {
  if (
    !record(value, [
      'schema_version',
      'kind',
      'status',
      'project_id',
      'task_id',
      'version',
      'session_id',
      'automatic_children',
      'collection_active',
      'evidence_mode',
      'trust',
      'root_ownership',
      'possible_child_contribution',
      'mapped_image_proof',
      'cost_coverage'
    ]) ||
    value.schema_version !== 1 ||
    value.kind !== 'claude_window_connection' ||
    value.status !== 'connected' ||
    value.project_id !== options.project ||
    value.task_id !== options.task ||
    !version(value.version) ||
    !id(value.session_id) ||
    value.automatic_children !== false ||
    value.collection_active !== true ||
    value.evidence_mode !== 'publisher_verified_local_pin' ||
    value.trust !== 'compatibility_unverified' ||
    value.root_ownership !== 'unverified' ||
    value.possible_child_contribution !== 'unknown' ||
    value.mapped_image_proof !== 'unverified' ||
    value.cost_coverage !== 'partial'
  )
    fail('connection_unverified');
  return value;
}
export async function run(operation, options, transport = fetch) {
  if (
    !record(options, ['origin', 'product', 'project', 'task', 'receipt']) ||
    options.product !== 'claude_code' ||
    !['inspect', 'connect'].includes(operation) ||
    !id(options.project) ||
    !id(options.task) ||
    (options.receipt !== undefined && !uuid(options.receipt)) ||
    (operation === 'connect' && options.receipt === undefined)
  ) {
    fail('invalid_input');
  }
  const origin = localOrigin(options.origin);
  const route = '/api/tasks/' + encodeURIComponent(options.task);
  const request = async (suffix, action) => {
    const method = action === undefined ? 'GET' : 'POST';
    let reply;
    let value;
    try {
      reply = await transport(origin + route + suffix, {
        method,
        redirect: 'error',
        credentials: 'omit',
        signal: AbortSignal.timeout(10000),
        headers: {
          Accept: 'application/json',
          ...(action === undefined
            ? {}
            : {
                'Content-Type': 'application/json',
                Origin: origin,
                'X-Harness-CSRF': action.csrf,
                'Idempotency-Key': randomUUID(),
                'If-Match': action.version
              })
        },
        ...(action === undefined ? {} : { body: JSON.stringify({ project_id: options.project, product: 'claude_code', receipt: options.receipt }) })
      });
      value = await reply.json();
    } catch {
      fail(method === 'POST' ? 'ui_action_uncertain' : 'local_ui_unavailable');
    }
    if (reply.redirected) fail('unsupported_ui_contract');
    if (!reply.ok) {
      fail(reasons.has(value?.error) ? value.error : 'local_ui_request_failed');
    }
    return value;
  };
  const before = taskView(await request('/claude-window-v1'), options);
  if (operation === 'inspect') {
    return {
      status: before.task.state === 'active' && before.task.connection_enabled ? 'ready' : 'blocked',
      project_id: options.project,
      task_id: options.task,
      automatic_children: false,
      reason_code: before.task.state !== 'active' ? 'task_closed' : (before.task.reason ?? (before.task.connection_enabled ? null : 'connection_not_available'))
    };
  }
  requireLive(before.task);
  const result = connectionResult(await request('/claude-window-connect-v1', { csrf: before.csrf, version: before.task.version }), options);
  const after = taskView(await request('/claude-window-v1'), options);
  requireLive(after.task);
  if (after.task.selected_root_id !== result.session_id || after.task.version !== result.version) fail('connection_unverified');
  return result;
}
async function main() {
  try {
    const { values } = parseArgs({
      args: process.argv.slice(3),
      options: { origin: { type: 'string' }, project: { type: 'string' }, task: { type: 'string' }, receipt: { type: 'string' }, product: { type: 'string' } },
      strict: true,
      allowPositionals: false
    });
    process.stdout.write(JSON.stringify(await run(process.argv[2], { ...values, product: values.product ?? 'claude_code' })) + '\n');
  } catch (error) {
    process.stdout.write(
      JSON.stringify({ status: 'blocked', reason_code: error instanceof ConnectError ? error.code : 'invalid_input', verified: false }) + '\n'
    );
    process.exitCode = 1;
  }
}
if (import.meta.main) await main();
