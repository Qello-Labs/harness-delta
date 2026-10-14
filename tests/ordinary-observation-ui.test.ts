import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, test, vi } from 'vitest';
import { OrdinaryConnectionGuide, OrdinaryCriteria, TaskAssignment } from '../ui/src/OrdinaryObservationSetup.js';
import { ordinaryConnectCommand, ordinaryTaskInput } from '../ui/src/ordinary-task-input.js';
import type { Task } from '../ui/src/types.js';

const guidedButtons = vi.hoisted(() => new Map<string, { disabled?: boolean; onClick?: () => void }>());
vi.mock('../ui/src/components/ui/button.js', async () => {
 const actual = await vi.importActual<typeof import('../ui/src/components/ui/button.js')>('../ui/src/components/ui/button.js');
 return { ...actual, Button: (props: { children?: ReactNode; disabled?: boolean; onClick?: () => void; 'data-task-action'?: string }) => {
  if (props['data-task-action']) guidedButtons.set(props['data-task-action'], props);
  return createElement(actual.Button, props);
 } };
});
beforeEach(() => guidedButtons.clear());

function task(): Task {
 const missing = { status: 'missing' as const, value: null, statuses: [], reasons: [] };
 return {
  mode: 'ordinary', id: 'task-synthetic', project_id: 'project-synthetic', setup_id: 'ordinary-claude',
  name: 'Synthetic observation', version: 'v1', state: 'active', status: 'observing',
  measurement: { state: 'active', active_ms: 0, requests: 0, window: { started_at: null, ends_at: null } },
  outcome: null, attempt: 1, criteria: ['user_confirmed_completion'], startup: null, source: null, reason: null,
  preparation: { state: 'registered', configuration_evidence: 'unavailable', native_context_evidence: 'unavailable', freshness_evidence: 'unavailable', tool_use_evidence: 'unavailable' },
  price: { partial_amount: null, currency: 'USD', unpriced_events: 0, basis: null },
  actions: [{ code: 'stop-observation', enabled: true, reason: null }, { code: 'pause', enabled: true, reason: null }],
  connection_readiness: { skill: { state: 'installed', reason: null, install_command: null }, configured_version: '2.1.296', installed_version: null, collection_revoked: false },
  binding: { product: 'claude_code', state: 'observing', roots: 1, children: 0, selected_root_id: 'synthetic-root', requests: 0, gaps: [], cost_coverage: 'partial', support: 'ordinary_qualification_pending', sessions: [],
   summary: { requests: null, input_total: missing, output_total: missing, partial_amount: null, currency: 'USD', unpriced_events: 0, price_table_id: null, complete_cost: null } },
 };
}
type ElementProps = {
 children?: ReactNode; name?: string; value?: string; checked?: boolean; disabled?: boolean;
 'data-task-action'?: string; onClick?: () => void; onChange?: (event: { target: { checked: boolean } }) => void;
};
function find(node: ReactNode, predicate: (element: ReactElement<ElementProps>) => boolean): ReactElement<ElementProps> | undefined {
 if (!isValidElement<ElementProps>(node)) return undefined;
 if (predicate(node)) return node;
 return Children.toArray(node.props.children).map(child => find(child, predicate)).find(Boolean);
}

test('ordinary creation carries only the selected ordinary request fields', () => {
 const input = { name: 'Synthetic work', projectId: 'project-selected', type: 'fix', size: 'medium', assignee: 'tester', criterionIds: ['criterion-selected'] };
 const result = ordinaryTaskInput(input);
 expect(result).toEqual({ mode: 'ordinary', name: 'Synthetic work', project_id: 'project-selected', type: 'fix', size: 'medium', assignee: 'tester', criterion_ids: ['criterion-selected'] });
});
test('ordinary creation omits optional comparison and outcome fields', () => {
 const result = ordinaryTaskInput({ name: 'Synthetic work', projectId: 'project-selected', criterionIds: ['user_confirmed_completion'] });
 expect(Object.keys(result ?? {}).sort()).toEqual(['criterion_ids', 'mode', 'name', 'project_id']);
});
test('ordinary creation refuses missing user selections', () => {
 for (const input of [
  { name: 'Synthetic', projectId: 'project', criterionIds: [] },
  { name: ' ', projectId: 'project', criterionIds: ['user_confirmed_completion'] },
  { name: 'Synthetic', projectId: '', criterionIds: ['user_confirmed_completion'] },
 ]) expect(ordinaryTaskInput(input)).toBeNull();
});
test('visible criterion selection controls the actual creation request', () => {
 let selected = ['user_confirmed_completion'];
 const tree = OrdinaryCriteria({ selected, locale: 'en', onChange: value => { selected = value; } });
 const criterion = find(tree, element => element.props.name === 'criterion_ids');
 expect(criterion?.props.value).toBe('user_confirmed_completion');
 expect(criterion?.props.checked).toBe(true);
 criterion?.props.onChange?.({ target: { checked: false } });
 expect(ordinaryTaskInput({ name: 'Synthetic', projectId: 'project', criterionIds: selected })).toBeNull();
});
test('ordinary tasks omit assignment structure even if a stale assignment exists', () => {
 const value = task();
 value.preparation.assigned_variant_id = 'arm-b';
 const markup = renderToStaticMarkup(createElement(TaskAssignment, { task: value, locale: 'en' }));
 expect(markup).toBe('');
});
test('comparison tasks preserve assignment structure', () => {
 const value = task();
 value.mode = 'comparison'; value.preparation.assigned_variant_id = 'arm-b';
 const markup = renderToStaticMarkup(createElement(TaskAssignment, { task: value, locale: 'ko' }));
 expect(markup).toContain('data-task-assignment="comparison"');
 expect(markup).toContain('arm-b');
});
test('connect invocation carries the selected project task and current origin on one line', () => {
 const command = ordinaryConnectCommand('project-selected', 'task-selected', 'http://127.0.0.1:32123');
 expect(command.split(' ')[0]).toBe('/harness-connect');
 expect(command).toContain('project-selected');
 expect(command).toContain('task-selected');
 expect(command).toContain('http://127.0.0.1:32123');
 expect(command).not.toMatch(/[\r\n]/);
});
test('ordinary stop dispatches observation ownership release, not pause or native release', () => {
 const actions: string[] = [];
 renderToStaticMarkup(createElement(OrdinaryConnectionGuide, { task: task(), locale: 'en', origin: 'http://127.0.0.1:32123', busy: false, online: true, onAction: code => { actions.push(code); }, reason: code => code }));
 const stop = guidedButtons.get('stop-observation');
 expect(stop?.disabled).toBe(false);
 stop?.onClick?.();
 expect(actions).toEqual(['stop-observation']);
});
test('ordinary stop preserves busy offline and server action gates', () => {
 for (const flags of [{ busy: true, online: true, enabled: true }, { busy: false, online: false, enabled: true }, { busy: false, online: true, enabled: false }]) {
  const value = task();
  value.actions = [{ code: 'stop-observation', enabled: flags.enabled, reason: flags.enabled ? null : 'ordinary_qualification_pending' }];
  renderToStaticMarkup(createElement(OrdinaryConnectionGuide, { task: value, locale: 'ko', origin: 'http://127.0.0.1:32123', busy: flags.busy, online: flags.online, onAction: () => {}, reason: code => code }));
  expect(guidedButtons.get('stop-observation')?.disabled).toBe(true);
 }
});
test('ordinary observation output exposes the actual measurement state in both locales', () => {
 const value = task(); value.measurement.state = 'paused';
 for (const locale of ['en', 'ko'] as const) {
  const markup = renderToStaticMarkup(createElement(OrdinaryConnectionGuide, { task: value, locale, origin: 'http://127.0.0.1:32123', busy: false, online: true, onAction: () => {}, reason: code => code }));
  expect(markup).toContain('data-observation-state="paused"');
  expect(markup).toContain('data-connection-stage="paused"');
  expect(markup).toContain('data-task-action="stop-observation"');
 }
});
