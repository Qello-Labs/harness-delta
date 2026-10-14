import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { join } from 'node:path';
import { z } from 'zod';
import { createLocalWebDomain } from '../src/local-web-domain.js';
import { createLocalWebServer } from '../src/local-web-server.js';
import { installClaudeConnectInstallation } from '../src/claude-connect-installation.js';
import { ordinaryBindingFixture } from './helpers/ordinary-session-binding-fixture.js';
import { ClaudeConnection } from '../ui/src/ClaudeConnection.js';
import { claudeConnectionStage, claudeConnectPrompt } from '../ui/src/claude-connection-state.js';
import { MeasurementControls } from '../ui/src/MeasurementControls.js';
import { PreparationNextAction } from '../ui/src/PreparationNextAction.js';
import type { Task } from '../ui/src/types.js';

function task(): Task {
  const missing = { status: 'missing' as const, value: null, statuses: [], reasons: [] };
  return {
    id: 'task-2', name: 'Synthetic task', project_id: 'project-1', setup_id: 'setup', version: 'v1',
    state: 'registered', status: 'waiting_for_session', outcome: null, attempt: 1, criteria: [], startup: null, source: null, reason: null,
    measurement: { state: 'waiting_connection', active_ms: null, requests: null, window: { started_at: null, ends_at: null } },
    preparation: { state: 'waiting_for_session', configuration_evidence: 'verified_at_preparation', native_context_evidence: 'unverified', freshness_evidence: 'unverified', tool_use_evidence: 'unavailable', assigned_variant_id: 'a' },
    price: { partial_amount: null, currency: 'USD', unpriced_events: 0, basis: null },
    actions: [{ code: 'session-connect', enabled: true, reason: null }, { code: 'pause', enabled: true, reason: null }, { code: 'resume-binding', enabled: true, reason: null }],
    support_details: { context: 'real', connection_route: 'family', product: 'claude_code', product_version: '2.1.296', launch: [], ticket: 'unsupported', family: 'candidate_pilot', complete_cost: false, inference: false },
    binding: { product: 'claude_code', state: 'waiting', roots: 0, children: 0, requests: null, gaps: [], cost_coverage: 'partial', support: 'native_unverified_pilot', sessions: [],
      summary: { requests: null, input_total: missing, output_total: missing, partial_amount: null, currency: 'USD', unpriced_events: 0, price_table_id: null, complete_cost: null } },
    connection_readiness: { skill: { state: 'installed', reason: null, install_command: null }, installed_version: null, configured_version: '2.1.296', collection_revoked: false },
  };
}
function render(value: Task, online = true) {
  return renderToStaticMarkup(createElement(ClaudeConnection, { task: value, projectName: 'Synthetic project',
    origin: 'http://127.0.0.1:4318', locale: 'en', busy: false, online, onAction: () => {}, reason: code => code }));
}

test('an authorized prepared Claude task exposes a scoped prompt without receipt input', () => {
  const value = task();
  const markup = render(value);
  expect(claudeConnectionStage(value)).toBe('ready');
  expect(markup).toContain('data-connection-action="copy"');
  expect(markup).toContain('data-connection-prompt=""');
  expect(claudeConnectPrompt(value, 'http://127.0.0.1:4318', 'en')).toMatch(/^\/harness-connect /);
  for (const token of ['project-1', 'task-2', 'http://127.0.0.1:4318']) {
    expect(claudeConnectPrompt(value, 'http://127.0.0.1:4318', 'en')).toContain(token);
    expect(claudeConnectPrompt(value, 'http://127.0.0.1:4318', 'ko')).toContain(token);
  }
  expect(markup).not.toContain('<input');
  expect(markup).not.toContain('data-connection-action="observe"');
  expect(render(value, false)).toContain('disabled=""');
});

test.each(['missing', 'conflict', 'unavailable'] as const)('skill %s does not expose connection instructions', state => {
  const value = task();
  value.connection_readiness = { skill: { state, reason: 'synthetic-diagnostic', install_command: state === 'missing' ? 'synthetic-install-command' : null },
    installed_version: null, configured_version: '2.1.296', collection_revoked: false };
  const markup = render(value);
  expect(claudeConnectionStage(value)).toBe(state === 'missing' ? 'install' : state === 'conflict' ? 'conflict' : 'unknown');
  expect(markup).not.toContain('data-connection-prompt=""');
  expect(markup.match(/<button\b/g) ?? []).toHaveLength(1);
});

test('installation never raises admission when the existing server action is blocked', () => {
  const value = task();
  value.actions = [{ code: 'session-connect', enabled: false, reason: 'binding_source_unqualified' }];
  expect(claudeConnectionStage(value)).toBe('blocked');
  expect(render(value)).toContain('data-connection-blocker="binding_source_unqualified"');
  expect(render(value)).not.toContain('data-connection-prompt=""');
  expect(render(value)).not.toContain('data-connection-action="copy"');
});

test.each(['active', 'starting', 'paused', 'measurement_ended'] as const)('measurement %s preserves its own control and does not duplicate sidebar controls', state => {
  const value = task();
  value.measurement.state = state;
  if (value.binding) value.binding.roots = 1;
  expect(claudeConnectionStage(value)).toBe({ active: 'measuring', starting: 'starting', paused: 'paused', measurement_ended: 'ended' }[state]);
  const markup = render(value);
  expect(markup).not.toContain('data-connection-prompt=""');
  if (state !== 'measurement_ended') expect(markup).toContain(`data-connection-action="${state === 'paused' ? 'resume-binding' : 'pause'}"`);
  expect(renderToStaticMarkup(createElement(MeasurementControls, { task: value, locale: 'en', busy: false, online: true, onAction: () => {}, reason: code => code }))).toBe('');
  expect(renderToStaticMarkup(createElement(PreparationNextAction, { task: value, locale: 'en', disabled: false, onAction: () => {}, onConnect: () => {} }))).toBe('');
});

test('revoked authority takes precedence over a stale active measurement', () => {
  const value = task();
  value.measurement.state = 'active';
  if (value.connection_readiness) value.connection_readiness.collection_revoked = true;
  expect(claudeConnectionStage(value)).toBe('revoked');
  expect(render(value)).not.toContain('data-connection-action="pause"');
  expect(render(value)).not.toContain('data-connection-action="resume-binding"');
  expect(render(value)).not.toContain('data-connection-action="copy"');
});

test('paused binding falls back to an authorized parent reconnect, never file observation', () => {
  const value = task();
  value.measurement.state = 'paused';
  if (value.binding) value.binding.roots = 1;
  value.actions = [{ code: 'session-connect', enabled: true, reason: null }, { code: 'resume-binding', enabled: false, reason: 'binding_reconnect_required' }];
  expect(render(value)).toContain('data-connection-action="copy"');
  expect(render(value)).not.toContain('data-connection-action="observe"');
});

test('unprepared, synthetic and other-product tasks retain their existing routes', () => {
  for (const variant of ['unprepared', 'synthetic', 'codex', 'ticket']) {
    const value = task();
    if (variant === 'unprepared') delete value.connection_readiness;
    if (variant === 'synthetic' && value.support_details) value.support_details.context = 'synthetic_validation_only';
    if (variant === 'codex' && value.binding) value.binding.product = 'codex';
    if (variant === 'ticket' && value.support_details) value.support_details.connection_route = 'ticket';
    expect(claudeConnectionStage(value)).toBeNull();
    expect(render(value)).toBe('');
  }
});

function ordinaryTask(): Task {
  const value = task();
  value.mode = 'ordinary';
  delete value.support_details;
  if (value.binding) {
    value.binding.product_version = '2.1.296';
    value.binding.max_family_members = 8;
    value.binding.support = 'ordinary_qualification_pending';
    value.binding.selected_root_id = null;
  }
  value.actions = [{ code: 'session-connect', enabled: false, reason: 'binding_source_unqualified' }];
  return value;
}

test('ordinary Claude uses guided readiness without requiring comparison support or assignment', () => {
  const value = ordinaryTask();
  delete value.preparation.assigned_variant_id;
  expect(claudeConnectionStage(value)).toBe('blocked');
  expect(render(value)).toContain('data-connection-stage="blocked"');
  expect(render(value)).toContain('data-connection-blocker="binding_source_unqualified"');
  expect(render(value)).not.toContain('data-connection-action="copy"');
});

test('stopped ordinary history is not a live connection or a resumable selected root', () => {
  const value = ordinaryTask();
  value.measurement.state = 'paused';
  if (value.binding) value.binding.roots = 2;
  expect(claudeConnectionStage(value)).toBe('blocked');
  value.actions = [{ code: 'session-connect', enabled: true, reason: null }];
  expect(claudeConnectionStage(value)).toBe('ready');
  expect(render(value)).toContain('data-connection-action="copy"');
  expect(render(value)).not.toContain('data-connection-action="resume-binding"');
});

test('domain stop releases selected ownership while historical roots remain reportable in the guided card', async () => {
  const f = ordinaryBindingFixture();
  const domain = createLocalWebDomain({
    store: f.store, metadataFile: join(f.current().cwd, 'web.sqlite'), bindingProviders: [f.provider],
  });
  const origin = 'http://127.0.0.1:4327';
  const app = createLocalWebServer({
    origin, domain, metadataFile: join(f.current().cwd, 'transport.sqlite'),
  });
  try {
    expect(installClaudeConnectInstallation(f.current().cwd).state).toBe('installed');
    const { id } = z.object({ id: z.string() }).parse(await domain.createTask({
      mode: 'ordinary', name: 'Synthetic ownership', project_id: 'project', criterion_ids: ['accepted'],
    }));
    const registered = f.life.task(id);
    f.setTime(registered.registered_at);
    f.use(f.binding, id);
    await f.binding.connect(id, 'claude_code', f.receipt());
    const readTask = async () => {
      const reply = await app.inject({ url: `/api/tasks/${id}`, headers: { host: '127.0.0.1:4327' } });
      expect(reply.statusCode).toBe(200);
      return reply.json<Task>();
    };
    for (const state of ['active', 'paused'] as const) {
      if (state === 'paused') f.binding.pause(id);
      const selected = await readTask();
      expect(selected.measurement.state).toBe(state);
      expect(selected.binding?.selected_root_id).toBeTruthy();
      expect(selected.actions).toContainEqual({ code: 'stop-observation', enabled: true, reason: null });
      expect(render(selected)).toContain('data-connection-action="stop-observation"');
    }
    await domain.taskAction(id, 'stop-observation', {});
    const stopped = await readTask();
    expect(stopped.binding).toMatchObject({ roots: 1, selected_root_id: null, segment_state: null });
    expect(stopped.actions).toContainEqual({
      code: 'stop-observation', enabled: false, reason: 'inactive_observation',
    });
    expect(stopped.actions.find(action => action.code === 'resume-binding')?.enabled).toBe(false);
    expect(render(stopped)).not.toContain('data-connection-action="stop-observation"');
    expect(render(stopped)).not.toContain('data-connection-action="resume-binding"');
    expect(stopped.outcome).toBeNull();
  } finally {
    await app.close();
    await f.cleanup();
  }
});

test('ordinary pause and stop keep distinct server actions in the guided card', () => {
  const value = ordinaryTask();
  value.measurement.state = 'active';
  if (value.binding) value.binding.selected_root_id = 'synthetic-root';
  value.actions = [{ code: 'pause', enabled: true, reason: null }, { code: 'stop-observation', enabled: true, reason: null }];
  const markup = render(value);
  expect(markup).toContain('data-connection-action="pause"');
  expect(markup).toContain('data-connection-action="stop-observation"');
  expect(markup).not.toContain('data-connection-action="observe"');
  expect(renderToStaticMarkup(createElement(MeasurementControls, { task: value, locale: 'en', busy: false, online: true, onAction: () => {}, reason: code => code }))).toBe('');
});

test('ordinary installer content replaces the legacy shell-copy route when missing', () => {
  const value = ordinaryTask();
  if (value.connection_readiness) value.connection_readiness.skill = { state: 'missing', reason: 'project_skill_missing', install_command: null };
  const markup = renderToStaticMarkup(createElement(ClaudeConnection, {
    task: value, projectName: 'Synthetic project', origin: 'http://127.0.0.1:4318',
    locale: 'en', busy: false, online: true, onAction: () => {}, reason: code => code,
    installation: createElement('div', { 'data-reviewed-installation': true }),
  }));
  expect(claudeConnectionStage(value)).toBe('install');
  expect(markup).toContain('data-reviewed-installation="true"');
  expect(markup).not.toContain('data-connection-action="copy"');
});
