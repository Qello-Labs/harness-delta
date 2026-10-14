import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { defaultReceiptDir, locateReceipt } from './claude-session-hook.mjs';

// This client uses the shared local UI transport. It grants no new
// source admission and never opens a database, transcript, or native process.
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const id = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/;
const validId = value => typeof value === 'string' && id.test(value);
const codes = new Set(['selection_required', 'invalid_origin', 'invalid_input', 'current_identity_unavailable',
  'local_ui_unavailable', 'local_ui_request_failed', 'unsupported_ui_contract', 'unsupported_product', 'unsupported_child',
  'startup_ticket_required', 'task_closed', 'connection_unverified', 'session_task_conflict', 'selected_session_mismatch',
  'selection_cancelled', 'connection_not_available', 'ui_state_changed', 'ui_action_uncertain', 'ui_action_conflict',
  'external_ticket_used', 'external_context_unverified', 'external_context_mismatch', 'external_freshness_unverified',
  'external_connection_unverified', 'external_window_closed', 'external_preparation_required', 'workflow_run_active', 'native_source_unqualified', 'binary_mismatch',
  'application_cleanup_pending', 'application_managed_retired', 'application_attempt_stale', 'application_product_mismatch',
  'application_checkpoint_invalid', 'application_report_conflict', 'application_checks_incomplete', 'application_identity_unavailable',
  'application_setup_session_excluded', 'application_fresh_session_required', 'application_epoch_changed', 'application_launch_unavailable',
  'application_restart_interrupted', 'application_abandoned', 'application_execution_approval_required', 'application_execution_changed',
  'application_preparation_failed', 'application_permission_stale', 'application_permission_decision_invalid', 'application_permission_outside_ceiling',
  'application_permission_accept_unqualified', 'application_permission_transport_failed', 'application_termination_unverified',
  'application_integrity_unverified', 'application_recovery_required', 'application_surface_unowned', 'application_publication_unqualified',
  'application_required', 'application_confinement_unverified', 'application_source_unqualified', 'application_native_loading_unqualified',
  'application_output_changed', 'application_input_changed', 'application_review_changed', 'application_preimage_changed',
  'application_planning_failed', 'application_workspace_changed', 'application_workspace_mismatch', 'application_path_forbidden',
  'application_preview_changed', 'application_scope_invalid', 'application_job_active', 'application_review_required',
  'binding_pilot_scope_invalid', 'binding_pilot_family_scope', 'binding_pilot_control_only', 'binding_family_limit',
  'binding_admission_family_scope', 'binding_runtime_unsupported', 'compatibility_invalidated',
  'ordinary_project_setup_required', 'ordinary_preparation_required', 'ordinary_configuration_changed',
  'binding_observer_owned', 'binding_native_root_owned', 'binding_handover_receipt_stale',
  'binding_receipt_stale', 'binding_member_ineligible', 'claude_binary_unqualified',
  'binding_provider_unavailable', 'binding_source_unqualified', 'binding_scope_revoked', 'binding_identity_mismatch',
  'binding_identity_unavailable', 'binding_session_conflict', 'binding_relation_invalid', 'binding_request_conflict',
  'binding_usage_invalid', 'binding_configuration_invalid', 'binding_source_changed', 'binding_cursor_invalid', 'binding_reconnect_required',
  'binding_identity_ambiguous', 'binding_scope_mismatch', 'binding_ancestry_unverified', 'binding_source_unavailable',
  'binding_metadata_unavailable', 'binding_clock_regressed', 'binding_turn_limit', 'binding_source_unapproved',
  'binding_metadata_untrusted', 'binding_receipt_limit', 'binding_source_limit', 'binding_usage_incomplete',
  'binding_child_requires_root', 'deleted_identifier', 'hook_receipt_missing', 'hook_receipt_ambiguous',
  'claude_baseline_limit', 'claude_baseline_incomplete', 'claude_binding_config_invalid', 'claude_child_source_unavailable', 'claude_cursor_invalid', 'claude_identity_invalid',
  'claude_project_mismatch', 'claude_receipt_expired', 'claude_receipt_invalid', 'claude_receipt_missing', 'claude_receipt_untrusted',
  'claude_scope_mismatch', 'claude_source_missing', 'claude_source_stale', 'claude_source_untrusted',
  'claude_source_version_unobserved', 'claude_source_version_unsupported']);
const fail = code => { throw new Error(code); };
const safeCode = error => error instanceof Error && codes.has(error.message) ? error.message : 'local_ui_request_failed';
export function sessionHint(product, env = process.env) {
  const value = product === 'codex' ? env.CODEX_THREAD_ID : undefined;
  return value && uuid.test(value) ? { session_id: value.toLowerCase(), identity_basis: 'host_environment_hint' }
    : { session_id: null, identity_basis: 'unavailable' };
}
function localOrigin(value) {
  let url;
  try { url = new URL(value); } catch { fail('invalid_origin'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) fail('invalid_origin');
  return url.origin;
}
const sourceSession = source => {
  if (!source || typeof source.label !== 'string' || !validId(source.handle)) return null;
  return source.label.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.jsonl$/i)?.[1].toLowerCase() ?? null;
};
function verified(task, session, handle) {
  return !closed(task) && task.preparation?.configuration_evidence === 'verified_at_preparation'
    && ['configuration_verified', 'waiting_connection', 'connected', 'measuring', 'stopped'].includes(task.preparation?.state)
    && sourceSession(task.source) === session && (!handle || task.source.handle === handle)
    && task.preparation?.native_context_evidence === 'native_developer_context_observed'
    && task.preparation?.freshness_evidence === 'fresh_root_after_ticket'
    && validId(task.preparation?.assigned_variant_id)
    && Number.isFinite(Date.parse(task.measurement?.window?.started_at))
    && Number.isFinite(Date.parse(task.measurement?.window?.ends_at))
    && Date.parse(task.measurement.window.ends_at) > Date.parse(task.measurement.window.started_at);
}
const closed = task => task.state === 'finalized' || !['registered', 'active', 'paused'].includes(task.state)
  || task.preparation?.state === 'released' || (task.measurement?.window?.ends_at && Date.parse(task.measurement.window.ends_at) <= Date.now());
function result(task, session, status, identityBasis) {
  return { status, project_id: task.project_id, task_id: task.id, session_id: session, scope: 'selected_session',
    identity_basis: identityBasis, assigned_variant_id: task.preparation.assigned_variant_id,
    evidence: 'server_native_context_and_exact_selected_source',
    collection_active: task.measurement.state === 'active', cost_coverage: 'partial', automatic_children: false };
}
export async function run(operation, options, transport = fetch) {
  const origin = localOrigin(options.origin);
  if (!['inspect', 'connect'].includes(operation) || !['codex', 'claude_code'].includes(options.product)) fail('invalid_input');
  const request = async (route, method = 'GET', body, version, csrf) => {
    let reply;
    try {
      reply = await transport(origin + route, { method, redirect: 'error', signal: AbortSignal.timeout(method === 'GET' ? 10000 : 130000),
        headers: { Accept: 'application/json', ...(method === 'POST' ? { 'Content-Type': 'application/json', Origin: origin,
          'X-Harness-CSRF': csrf, 'Idempotency-Key': randomUUID(), 'If-Match': version } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch { fail(method === 'POST' ? 'ui_action_uncertain' : 'local_ui_unavailable'); }
    let value;
    try { value = await reply.json(); } catch { fail('local_ui_request_failed'); }
    if (!reply.ok) fail(codes.has(value?.error) ? value.error : 'local_ui_request_failed');
    return value;
  };
  const bootstrap = await request('/api/bootstrap');
  const data = bootstrap?.data;
  if (!data || !Array.isArray(data.projects) || !Array.isArray(data.tasks) || !Array.isArray(data.setups)) fail('unsupported_ui_contract');
  if (operation === 'inspect') return { status: 'selection_required',
    support: options.product === 'codex' || data.tasks.some(t => t.binding?.product === options.product && t.binding.support !== 'instrumentation_required') ? 'server_validation_required' : 'unsupported_product',
    automatic_children: false, binding_support: data.tasks.filter(t => validId(t.id)).map(t => ({ task_id: t.id, support: t.binding?.support ?? 'unavailable' })), projects: data.projects.filter(p => validId(p.id)).map(p => ({ project_id: p.id })),
    tasks: data.tasks.filter(t => validId(t.id) && validId(t.project_id)).map(t => ({ task_id: t.id, project_id: t.project_id,
      assigned_variant_id: validId(t.preparation?.assigned_variant_id) ? t.preparation.assigned_variant_id : null })) };
  if (!validId(options.project ?? '') || !validId(options.task ?? '')) fail('selection_required');
  if (options.product === 'claude_code' && options.receipt === undefined && options.session === undefined) {
    const located = locateReceipt(defaultReceiptDir());
    if (!located.receipt) fail(located.reason);
    options = { ...options, receipt: located.receipt };
  }
  if (options.receipt !== undefined) {
    if (!uuid.test(options.receipt) || options.session !== undefined || options.role !== undefined && !['root', 'child'].includes(options.role)) fail('invalid_input');
    const selected = data.tasks.find(t => t.id === options.task && t.project_id === options.project);
    if (!selected || !data.projects.some(p => p.id === options.project)) fail('selection_required');
    const route = '/api/tasks/' + encodeURIComponent(options.task);
    const task = await request(route);
    if (task.id !== options.task || task.project_id !== options.project || closed(task)) fail('task_closed');
    const action = task.actions?.find(a => a.code === 'session-connect');
    if (!action?.enabled) fail(codes.has(action?.reason) ? action.reason : 'binding_provider_unavailable');
    if (typeof bootstrap.csrf !== 'string' || !/^[a-f0-9]{64}$/.test(bootstrap.csrf) || typeof task.version !== 'string' || !/^"[a-f0-9]{64}"$/.test(task.version)) fail('unsupported_ui_contract');
    const value = await request(route + '/session-connect', 'POST', { product: options.product, receipt: options.receipt }, task.version, bootstrap.csrf);
    const connection = value?.connection;
    if (!['connected','reconnected','already_connected'].includes(connection?.status) || connection.project_id !== options.project || connection.task_id !== options.task
      || !validId(connection.session_id) || connection.assigned_variant_id !== task.preparation?.assigned_variant_id
      || connection.identity_basis !== 'native_metadata_receipt' || connection.evidence !== 'server_verified_identity_source_and_relations'
      || connection.collection_active !== true || connection.cost_coverage !== 'partial' || typeof connection.automatic_children !== 'boolean') fail('connection_unverified');
    const stored = await request(route);
    if (stored.id !== options.task || stored.project_id !== options.project || closed(stored) || stored.preparation?.assigned_variant_id !== connection.assigned_variant_id
      || stored.binding?.state !== 'observing' || !stored.binding.sessions?.some(s => s.session_id === connection.session_id && s.identity_basis === 'native_metadata_receipt')) fail('connection_unverified');
    return { status: connection.status, project_id: connection.project_id, task_id: connection.task_id, session_id: connection.session_id,
      assigned_variant_id: connection.assigned_variant_id, identity_basis: connection.identity_basis, evidence: connection.evidence,
      collection_active: true, automatic_children: connection.automatic_children, cost_coverage: 'partial' };
  }
  const hint = sessionHint(options.product);
  const session = (options.session ?? hint.session_id)?.toLowerCase();
  if (!session || !uuid.test(session)) fail('current_identity_unavailable');
  const identityBasis = options.session === undefined ? hint.identity_basis : 'user_selected';
  const selected = data.tasks.find(t => t.id === options.task && t.project_id === options.project);
  if (!selected || !data.projects.some(p => p.id === options.project)) fail('selection_required');
  if (options.product !== 'codex') fail('unsupported_product');
  if (!data.setups.some(s => s.id === selected.setup_id && s.project_id === options.project)) fail('unsupported_ui_contract');
  // A same-cwd task is never evidence. Even replay checks all visible bindings.
  if (data.tasks.some(t => t.id !== options.task && sourceSession(t.source) === session)) fail('session_task_conflict');
  const route = '/api/tasks/' + encodeURIComponent(options.task);
  let task = await request(route);
  if (task.id !== options.task || task.project_id !== options.project || task.setup_id !== selected.setup_id) fail('selection_required');
  if (closed(task)) fail('task_closed');
  const assignedVariant = task.preparation?.assigned_variant_id;
  if (!validId(assignedVariant)) fail('unsupported_ui_contract');
  if (sourceSession(task.source) === session) {
    if (!verified(task, session)) fail('connection_unverified');
    return result(task, session, 'already_connected', identityBasis);
  }
  if (options.role === 'child') fail('unsupported_child');
  if (options.role !== undefined && options.role !== 'root') fail('invalid_input');
  if (!task.startup?.ticket_id) fail('startup_ticket_required');
  if (!task.actions?.some(a => a.code === 'connect' && a.enabled === true)) fail('connection_not_available');
  if (typeof bootstrap.csrf !== 'string' || !/^[a-f0-9]{64}$/.test(bootstrap.csrf) || typeof task.version !== 'string' || !/^"[a-f0-9]{64}"$/.test(task.version)) fail('unsupported_ui_contract');
  const beforePicker = { version: task.version, ticket: task.startup.ticket_id };
  const picked = await request(route + '/session-picker', 'POST', {}, task.version, bootstrap.csrf);
  if (!picked?.selection) fail('selection_cancelled');
  if (sourceSession(picked.selection) !== session) fail('selected_session_mismatch');
  // Picker creates only a private source handle; no source contents are read.
  // Re-read without adopting a changed version; server If-Match fences later drift.
  task = await request(route);
  if (task.id !== options.task || task.project_id !== options.project || closed(task)) fail('task_closed');
  if (task.setup_id !== selected.setup_id || task.preparation?.assigned_variant_id !== assignedVariant) fail('ui_state_changed');
  if (sourceSession(task.source) === session) {
    if (!verified(task, session)) fail('connection_unverified');
    return result(task, session, 'already_connected', identityBasis);
  }
  if (task.version !== beforePicker.version || task.startup?.ticket_id !== beforePicker.ticket
    || task.preparation?.configuration_evidence !== 'verified_at_preparation'
    || !task.actions?.some(a => a.code === 'connect' && a.enabled === true)) fail('ui_state_changed');
  await request(route + '/connect', 'POST', { source_handle: picked.selection.handle }, task.version, bootstrap.csrf);
  const stored = await request(route);
  if (stored.id !== options.task || stored.project_id !== options.project || stored.setup_id !== selected.setup_id
    || stored.preparation?.assigned_variant_id !== assignedVariant || !verified(stored, session, picked.selection.handle)) fail('connection_unverified');
  return result(stored, session, 'connected', identityBasis);
}

async function main() {
  const operation = process.argv[2];
  const { values } = parseArgs({ args: process.argv.slice(3), options: {
    origin: { type: 'string' }, product: { type: 'string' }, project: { type: 'string' }, task: { type: 'string' },
    session: { type: 'string' }, receipt: { type: 'string' }, role: { type: 'string' }, help: { type: 'boolean' },
  }, strict: true, allowPositionals: false });
  if (operation === 'help' || values.help) {
    process.stdout.write('node scripts/connect.mjs inspect --origin http://127.0.0.1:PORT --product codex|claude_code\nnode scripts/connect.mjs identity --product codex\nnode scripts/connect.mjs connect --origin URL --product codex --project ID --task ID [--receipt NATIVE_RECEIPT | --session UUID] [--role root|child]\nReceipt connection uses server identity/source/ancestry validation and starts observation. Legacy selected-session connection opens the picker and leaves observation separate. Source support is server-owned.\n');
    return;
  }
  if (operation === 'identity') {
    if (!['codex', 'claude_code'].includes(values.product)) fail('invalid_input');
    process.stdout.write(JSON.stringify(sessionHint(values.product)) + '\n'); return;
  }
  process.stdout.write(JSON.stringify(await run(operation, values)) + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch(error => { process.stdout.write(JSON.stringify({ status: 'blocked', reason_code: safeCode(error), verified: false }) + '\n'); process.exitCode = 1; });
}
