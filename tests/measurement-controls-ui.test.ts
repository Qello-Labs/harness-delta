import { Children, createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { MeasurementControls, measurementActionCode } from '../ui/src/MeasurementControls.js';
import type { Task } from '../ui/src/types.js';

const missing = { status: 'missing' as const, value: null, statuses: [], reasons: [] };
function task(product?: 'codex' | 'claude_code'): Task {
  return {
    id: 'task',
    name: 'Synthetic task',
    project_id: 'project',
    setup_id: 'setup',
    version: 'v1',
    state: 'paused',
    status: 'paused',
    measurement: { state: 'paused', active_ms: 1, requests: 0, window: { started_at: null, ends_at: null } },
    outcome: null,
    attempt: 1,
    criteria: [],
    startup: null,
    reason: null,
    preparation: {
      state: 'stopped',
      configuration_evidence: 'verified',
      native_context_evidence: 'unavailable',
      freshness_evidence: 'verified',
      tool_use_evidence: 'unavailable',
      assigned_variant_id: null
    },
    price: { partial_amount: null, currency: 'USD', unpriced_events: 0, basis: null },
    actions: [
      { code: 'resume-binding', enabled: true, reason: null },
      { code: 'observe', enabled: !product, reason: product ? 'binding_reconnect_required' : null },
      { code: 'pause', enabled: false, reason: 'inactive_observation' }
    ],
    source: product ? null : { handle: 'source', label: 'synthetic.jsonl' },
    ...(product
      ? {
          binding: {
            product,
            state: 'stopped',
            roots: 1,
            children: 2,
            requests: 0,
            gaps: [],
            cost_coverage: 'partial' as const,
            support: 'synthetic_validation_only',
            sessions: [],
            summary: {
              requests: 0,
              input_total: missing,
              output_total: missing,
              partial_amount: null,
              currency: 'USD',
              unpriced_events: 0,
              price_table_id: null,
              complete_cost: null
            }
          }
        }
      : {})
  };
}
function render(value: Task, locale: 'en' | 'ko' = 'ko', flags = { busy: false, online: true }) {
  return renderToStaticMarkup(createElement(MeasurementControls, { task: value, locale, ...flags, onAction: () => {}, reason: code => code }));
}

for (const product of ['codex', 'claude_code'] as const) {
  test(`paused ${product} family exposes only the family resume action`, () => {
    const value = task(product);
    expect(measurementActionCode(value)).toBe('resume-binding');
    const markup = render(value);
    expect(markup.match(/<button\b/g)).toHaveLength(1);
    expect(markup).toContain('측정 재개');
    expect(markup).toContain('부모 1개, 자식 2개');
    expect(markup).toContain('일시중단 중 사용량은 포함하지 않습니다.');
    expect(markup).not.toContain('binding_reconnect_required');
    expect(markup).not.toContain('disabled=""');
  });
}
test('paused file connection uses observe even with an empty family DTO', () => {
  const value = task();
  value.binding = { ...task('codex').binding!, roots: 0, children: 0 };
  expect(measurementActionCode(value)).toBe('observe');
  const markup = render(value, 'en');
  expect(markup.match(/<button\b/g)).toHaveLength(1);
  expect(markup).toContain('Resume measurement');
  expect(markup).toContain('Selected session record');
  expect(markup).not.toContain('parent');
});
test('active and starting measurements expose pause rather than disabled resume', () => {
  for (const state of ['active', 'starting']) {
    const value = task('claude_code');
    value.measurement.state = state;
    value.state = 'active';
    value.actions = [{ code: 'pause', enabled: true, reason: null }];
    expect(measurementActionCode(value)).toBe('pause');
    const markup = render(value);
    expect(markup.match(/<button\b/g)).toHaveLength(1);
    expect(markup).toContain('측정 일시중단');
    expect(markup).not.toContain('측정 재개');
  }
});
test('first file observation retains start and explicit connection blocker', () => {
  const value = task();
  value.measurement.state = 'waiting_connection';
  value.source = null;
  value.actions = [{ code: 'observe', enabled: false, reason: 'external_connection_required' }];
  expect(measurementActionCode(value)).toBe('observe');
  const markup = render(value);
  expect(markup).toContain('측정 시작');
  expect(markup).toContain('disabled=""');
  expect(markup).toContain('external_connection_required');
  expect(markup).not.toContain('직접 선택한 기록');
});
test('selected operation retains disabled reasons and busy/offline guards', () => {
  const value = task('codex');
  value.actions[0] = { code: 'resume-binding', enabled: false, reason: 'binding_source_unqualified' };
  expect(render(value)).toContain('disabled=""');
  expect(render(value)).toContain('binding_source_unqualified');
  value.actions[0] = { code: 'resume-binding', enabled: true, reason: null };
  expect(render(value, 'en', { busy: true, online: true })).toContain('disabled=""');
  expect(render(value, 'en', { busy: false, online: false })).toContain('disabled=""');
});
test('finalized task exposes no measurement controls', () => {
  const value = task('codex');
  value.state = 'finalized';
  value.measurement.state = 'measurement_ended';
  expect(render(value)).toBe('');
});

test('the rendered primary control dispatches the selected existing operation', () => {
  const handler = (node: ReactNode): (() => void) | undefined => {
    if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(node)) return undefined;
    if (node.props.onClick) return node.props.onClick;
    return Children.toArray(node.props.children).map(handler).find(Boolean);
  };
  const active = task('claude_code');
  active.measurement.state = 'active';
  active.actions = [{ code: 'pause', enabled: true, reason: null }];
  for (const [value, expected] of [
    [task('codex'), 'resume-binding'],
    [task('claude_code'), 'resume-binding'],
    [task(), 'observe'],
    [active, 'pause']
  ] as const) {
    const dispatched: string[] = [];
    const tree = MeasurementControls({
      task: value,
      locale: 'en',
      busy: false,
      online: true,
      onAction: code => {
        dispatched.push(code);
      },
      reason: code => code
    });
    const click = handler(tree);
    expect(click).toBeDefined();
    click!();
    expect(dispatched).toEqual([expected]);
  }
});
