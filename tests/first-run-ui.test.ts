import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { preparationAction, PreparationNextAction } from '../ui/src/PreparationNextAction.js';
import type { Task } from '../ui/src/types.js';

function task(): Task {
  return {
    id: 'synthetic-task',
    name: 'Synthetic',
    project_id: 'project',
    setup_id: 'setup',
    version: 'v1',
    state: 'registered',
    status: 'draft',
    measurement: { state: 'waiting_connection', active_ms: null, requests: null, window: { started_at: null, ends_at: null } },
    outcome: null,
    attempt: 1,
    criteria: [],
    startup: null,
    source: null,
    reason: null,
    preparation: {
      state: 'preparation_needed',
      configuration_evidence: 'unverified',
      native_context_evidence: 'unverified',
      freshness_evidence: 'unverified',
      tool_use_evidence: 'unavailable',
      assigned_variant_id: null
    },
    price: { partial_amount: null, currency: 'USD', unpriced_events: 0, basis: null },
    actions: [
      { code: 'apply', enabled: true, reason: null },
      { code: 'ticket', enabled: false, reason: 'external_preparation_required' }
    ]
  };
}

test('next action follows configuration, ticket and connection authorization', () => {
  const value = task();
  expect(preparationAction(value)).toBe('apply');
  value.actions = [
    { code: 'apply', enabled: false, reason: 'configuration_ready' },
    { code: 'ticket', enabled: true, reason: null },
    { code: 'connect', enabled: false, reason: 'external_ticket_required' }
  ];
  value.status = 'waiting_for_session';
  expect(preparationAction(value)).toBe('ticket');
  value.startup = { ticket_id: 'synthetic-ticket', start_command: 'synthetic' };
  value.actions.push({ code: 'connect', enabled: true, reason: null });
  expect(preparationAction(value)).toBe('connect');
  value.measurement.state = 'connected';
  expect(preparationAction(value)).toBeNull();
});

test('preparation next action preserves busy and offline write guards', () => {
  const markup = renderToStaticMarkup(
    createElement(PreparationNextAction, {
      task: task(),
      locale: 'en',
      disabled: true,
      onAction: () => {},
      onConnect: () => {}
    })
  );
  expect(markup).toContain('data-preparation-action="apply"');
  expect(markup).toContain('disabled=""');
});

test('synthetic and candidate-family contexts do not suggest native tickets', () => {
  const value = task();
  value.actions = [{ code: 'ticket', enabled: true, reason: null }];
  value.support_details = {
    context: 'synthetic_validation_only',
    connection_route: 'synthetic',
    product: 'synthetic',
    product_version: '1.0.0',
    launch: [],
    ticket: 'synthetic_validation_only',
    family: 'synthetic_validation_only',
    complete_cost: false,
    inference: false
  };
  expect(preparationAction(value)).toBeNull();
  expect(
    renderToStaticMarkup(
      createElement(PreparationNextAction, {
        task: value,
        locale: 'en',
        disabled: false,
        onAction: () => {},
        onConnect: () => {}
      })
    )
  ).toContain('data-preparation-action="validation-ready"');
  value.support_details = {
    ...value.support_details,
    context: 'real',
    connection_route: 'family',
    product: 'codex',
    product_version: '0.160.0',
    family: 'candidate_pilot',
    ticket: 'exact_version_only'
  };
  expect(preparationAction(value)).toBe('session-connect');
  value.support_details = { ...value.support_details, connection_route: 'ticket', ticket: 'unsupported' };
  expect(preparationAction(value)).toBeNull();
});
