import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

const product = 'codex';
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const codes = new Set([
  'promoted_provider_unavailable',
  'promoted_producer_contract_unverified',
  'promotion_authority_denied',
  'promotion_authority_missing',
  'promotion_generation_changed',
  'binding_source_unqualified',
  'binding_scope_revoked',
  'deleted_identifier',
  'compatibility_invalidated',
  'connection_unverified',
  'task_closed',
  'unsupported_ui_contract',
  'ui_state_changed',
  'ui_action_uncertain',
  'ui_action_conflict',
  'binding_identity_unavailable'
]);
class ConnectError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
function validateInput(operation, options) {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some(key => !['origin', 'project', 'task', 'receipt', 'product'].includes(key)) ||
    !['inspect', 'connect'].includes(operation) ||
    !id(options.project) ||
    !id(options.task) ||
    (options.product !== undefined && options.product !== product)
  ) {
    throw new ConnectError('invalid_input');
  }
  if ((options.receipt !== undefined && !uuid(options.receipt)) || (operation === 'connect' && !uuid(options.receipt))) {
    throw new ConnectError('invalid_input');
  }
}
function localOrigin(value) {
  if (typeof value !== 'string') throw new ConnectError('invalid_origin');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ConnectError('invalid_origin');
  }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new ConnectError('invalid_origin');
  }
  return url;
}
function verifyConnection(connection, view, options) {
  if (
    !connection ||
    !['connected', 'already_connected', 'reconnected'].includes(connection.status) ||
    connection.project_id !== options.project ||
    connection.task_id !== options.task ||
    !id(connection.session_id) ||
    connection.identity_basis !== 'native_metadata_receipt' ||
    connection.evidence !== 'server_verified_identity_source_and_relations' ||
    connection.collection_active !== true ||
    (connection.assigned_variant_id !== undefined && connection.assigned_variant_id !== view.preparation?.assigned_variant_id)
  ) {
    throw new ConnectError('connection_unverified');
  }
}
function verifyObservation(observed, connection, options) {
  if (
    observed?.id !== options.task ||
    observed.project_id !== options.project ||
    observed.state !== 'active' ||
    observed.binding?.state !== 'observing' ||
    !Array.isArray(observed.binding.sessions) ||
    !observed.binding.sessions.some(row => row?.session_id === connection.session_id && row.identity_basis === 'native_metadata_receipt')
  ) {
    throw new ConnectError('connection_unverified');
  }
}
export async function run(operation, options, transport = fetch) {
  validateInput(operation, options);
  const url = localOrigin(options.origin);
  const request = async (path, init = {}) => {
    let response;
    try {
      response = await transport(url.origin + path, {
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
        ...init
      });
    } catch {
      throw new ConnectError('promoted_provider_unavailable');
    }
    let value;
    try {
      value = await response.json();
    } catch {
      throw new ConnectError('unsupported_ui_contract');
    }
    if (!response.ok) {
      throw new ConnectError(codes.has(value?.error) ? value.error : 'connection_unverified');
    }
    return value;
  };
  const base = {
    producer_contract: 'promoted-payload-v1',
    product,
    project_id: options.project,
    task_id: options.task
  };
  const bootstrap = await request('/api/bootstrap');
  if (
    typeof bootstrap?.csrf !== 'string' ||
    !/^[a-f0-9]{64}$/.test(bootstrap.csrf) ||
    !Array.isArray(bootstrap.data?.projects) ||
    !Array.isArray(bootstrap.data?.tasks) ||
    !bootstrap.data.projects.some(row => row?.id === options.project) ||
    !bootstrap.data.tasks.some(row => row?.id === options.task && row?.project_id === options.project)
  ) {
    throw new ConnectError('unsupported_ui_contract');
  }
  const path = '/api/tasks/' + encodeURIComponent(options.task);
  const view = await request(path);
  if (
    view?.id !== options.task ||
    view.project_id !== options.project ||
    typeof view.version !== 'string' ||
    !/^"[a-f0-9]{64}"$/.test(view.version) ||
    !Array.isArray(view.actions)
  ) {
    throw new ConnectError('unsupported_ui_contract');
  }
  const connect = view.actions.find(action => action?.code === 'session-connect');
  if (operation === 'inspect') {
    return {
      status: 'ready',
      ...base,
      verified: false,
      collection_active: false,
      connection_enabled: connect?.enabled === true
    };
  }
  if (!connect?.enabled) {
    throw new ConnectError(codes.has(connect?.reason) ? connect.reason : 'connection_unverified');
  }
  const result = await request(path + '/session-connect', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Harness-CSRF': bootstrap.csrf,
      Origin: url.origin,
      'Idempotency-Key': randomUUID(),
      'If-Match': view.version
    },
    body: JSON.stringify({ product, receipt: options.receipt })
  });
  const connection = result?.connection;
  verifyConnection(connection, view, options);
  const observed = await request(path);
  verifyObservation(observed, connection, options);
  return {
    status: connection.status,
    ...base,
    session_id: connection.session_id,
    verified: true,
    collection_active: true,
    automatic_children: connection.automatic_children === true,
    cost_coverage: connection.cost_coverage
  };
}
async function main() {
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      strict: true,
      options: {
        origin: { type: 'string' },
        project: { type: 'string' },
        task: { type: 'string' },
        receipt: { type: 'string' },
        product: { type: 'string' }
      }
    });
    if (positionals.length !== 1) throw new ConnectError('invalid_input');
    const result = await run(positionals[0], values);
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exitCode = result.status === 'blocked' ? 1 : 0;
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        status: 'blocked',
        producer_contract: 'promoted-payload-v1',
        product,
        reason_code: error instanceof ConnectError ? error.code : 'invalid_input',
        verified: false,
        collection_active: false
      }) + '\n'
    );
    process.exitCode = 1;
  }
}
if (import.meta.main) await main();
