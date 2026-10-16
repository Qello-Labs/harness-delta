import { createElement, isValidElement, useEffect, useRef, useState, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test, vi } from 'vitest';
import { App, defaultSetupProjectId } from './App';
import { GuidedSetup } from './GuidedSetup';
import { SavedSetups } from './SavedSetups';
import { SetupSummary } from './SetupSummary';
import { SharedSetupPreview, type SharedSetupImport } from './SharedSetupPreview';
import { AgentConnectionSetup } from './AgentConnectionSetup';
import { HarnessApplication } from './HarnessApplication';
import { ClaudeConnection } from './ClaudeConnection';
import { OrdinaryCriteria } from './OrdinaryObservationSetup';
import type { Setup, Snapshot, SupportDetails, Task } from './types';
import { connectionRoute } from './AssignedHarness';
import * as api from './api';

vi.mock('react', async importOriginal => { const react = await importOriginal<typeof import('react')>(); return { ...react, useState: vi.fn(react.useState), useRef: vi.fn(react.useRef), useEffect: vi.fn(react.useEffect) }; });
vi.mock('./api', async importOriginal => ({ ...await importOriginal<typeof import('./api')>(), bootstrap: vi.fn(), mutate: vi.fn(), task: vi.fn() }));

test('navigation follows onboarding, tasks and setup with current-page semantics', () => {
  const markup = renderToStaticMarkup(createElement(App));
  const navigation = markup.match(/<nav\b[^>]*>([\s\S]*?)<\/nav>/)?.[1] ?? '';
  expect([...navigation.matchAll(/data-screen="([^"]+)"/g)].map(match => match[1])).toEqual(['intro', 'tasks', 'setup']);
  expect(navigation).toMatch(/data-screen="tasks"[^>]*aria-current="page"/);
  expect(navigation.match(/aria-current="page"/g)).toHaveLength(1);
});

test('initial render is loading rather than empty or disconnected', () => {
  const markup = renderToStaticMarkup(createElement(App));
  expect(markup).toContain('data-bootstrap="loading"');
  expect(markup).toContain('data-connection="loading"');
  expect(markup).not.toContain('data-bootstrap="unavailable"');
  expect(markup).not.toContain('data-tasks="empty"');
});

const projects = [
  { id: 'one', name: 'One', directory: '/synthetic/one', baseline: null, setup_ids: [] },
  { id: 'two', name: 'Two', directory: '/synthetic/two', baseline: null, setup_ids: [] },
];
const snapshot: Snapshot = { projects, setups: [], tasks: [], catalog: null };
const saved: Setup[] = [
  { id: 'saved-one', name: 'First', project_id: 'one', arm_a: 'applied', arm_b: 'candidate', types: ['fix'], sizes: ['medium'], support: 'synthetic_validation_only' },
  { id: 'saved-two', name: 'Second', project_id: 'two', arm_a: 'applied', arm_b: 'candidate', types: ['feature'], sizes: ['small'], support: 'synthetic_validation_only' },
];
const syntheticSupport: SupportDetails = {
  context: 'synthetic_validation_only', connection_route: 'synthetic', product: 'synthetic', product_version: '0.0.0',
  launch: [], ticket: 'synthetic_validation_only', family: 'synthetic_validation_only', complete_cost: false, inference: false,
};
const imported: SharedSetupImport = { shared: true, token: 'import-token', projects: projects.map(project => ({ project_id: project.id, name: project.name, pair: { id: 'pair', name: 'Pair', arm_a: { version: 'applied' }, arm_b: { version: 'candidate' }, settings_hash: 'hash' }, original_tools: [], templates: [] })) };
const savedConnection = { imported: true, already_connected: false, profile_id: 'shared-setting', local_setup_path: '.harness-delta/setup/synthetic.json' };
type AppControl = { children?: ReactNode; id?: string; name?: string; value?: string; checked?: boolean; disabled?: boolean; 'aria-expanded'?: boolean; 'data-action-blocked'?: string; 'data-task-action'?: string; onChange?: () => void; onClick?: () => void };
function appControls(node: ReactNode): { type: unknown; key: string | null; props: AppControl }[] {
  if (Array.isArray(node)) return node.flatMap(appControls);
  if (!isValidElement<AppControl>(node)) return [];
  return [node, ...appControls(node.props.children)];
}
function appHarness(data: Snapshot = snapshot, initial: [number, unknown][] = []) {
  const states: unknown[] = []; const refs: { current: unknown }[] = [];
  let stateIndex = 0; let refIndex = 0;
  const overrides = new Map<number, unknown>([[1, data], [2, false], [3, 'setup'], [6, true], ...initial]);
  vi.mocked(useState).mockImplementation((initial?: unknown) => { const index = stateIndex++; if (index === states.length) states.push(overrides.has(index) ? overrides.get(index) : initial); return [states[index], (value: unknown) => { states[index] = typeof value === 'function' ? Reflect.apply(value, undefined, [states[index]]) : value; }]; });
  vi.mocked(useRef).mockImplementation((initial: unknown) => refs[refIndex++] ??= { current: initial });
  vi.mocked(useEffect).mockImplementation(() => undefined);
  vi.mocked(api.bootstrap).mockResolvedValue(data);
  function render() { stateIndex = 0; refIndex = 0; return App(); }
  function choose(id: string) { const radio = appControls(render()).find(node => node.props.name === 'setup-project' && node.props.value === id); if (!radio?.props.onChange) throw new Error('Missing project radio'); radio.props.onChange(); }
  function guided() { const nodes: ReactNode[] = [render()]; while (nodes.length) { const node = nodes.pop(); if (Array.isArray(node)) { nodes.push(...node); continue; } if (!isValidElement<{ children?: ReactNode }>(node)) continue; if (node.type === GuidedSetup && isValidElement<Parameters<typeof GuidedSetup>[0]>(node)) return node; nodes.push(node.props.children); } throw new Error('Missing guided setup'); }
  function savedSetups() { const nodes: ReactNode[] = [render()]; while (nodes.length) { const node = nodes.pop(); if (Array.isArray(node)) { nodes.push(...node); continue; } if (!isValidElement<{ children?: ReactNode }>(node)) continue; if (node.type === SavedSetups && isValidElement<Parameters<typeof SavedSetups>[0]>(node)) return node; nodes.push(node.props.children); } throw new Error('Missing saved settings'); }
  return { render, choose, guided, savedSetups, restore: () => { vi.mocked(useState).mockReset(); vi.mocked(useRef).mockReset(); vi.mocked(useEffect).mockReset(); vi.mocked(api.bootstrap).mockReset(); vi.mocked(api.mutate).mockReset(); } };
}

test('saved settings are scoped to the explicitly selected project and empty state', () => {
  const harness = appHarness({ ...snapshot, setups: saved });
  try {
    const unselected = harness.savedSetups().props;
    expect(renderToStaticMarkup(createElement(SavedSetups, unselected))).not.toContain('data-setup-id');
    expect(appControls(SavedSetups(unselected)).find(node => node.props.onClick === unselected.onImport)?.props.disabled).toBe(true);
    harness.choose('one');
    const selected = harness.savedSetups().props;
    const first = renderToStaticMarkup(createElement(SavedSetups, selected));
    expect(first).toContain('data-setup-id="saved-one"');
    expect(first).not.toContain('data-setup-id="saved-two"');
    expect(appControls(SavedSetups(selected)).find(node => node.props.onClick === selected.onImport)?.props.disabled).toBe(false);
    harness.choose('two');
    const second = renderToStaticMarkup(createElement(SavedSetups, harness.savedSetups().props));
    expect(second).toContain('data-setup-id="saved-two"');
    expect(second).not.toContain('data-setup-id="saved-one"');
    harness.choose('one');
    const empty = renderToStaticMarkup(createElement(SavedSetups, { ...harness.savedSetups().props, setups: [] }));
    expect(empty).toContain('data-saved-setups-empty');
    expect(empty).not.toContain('data-setup-id');
  } finally { harness.restore(); }
});

test('one connected comparison hides only its own template in saved cards and task choices', () => {
  const template = saved[0];
  if (!template) throw new Error('Missing template');
  const connected = { ...template, id: 'shared-one', shared: { revision_id: 'revision-one', template_id: template.id, template_name: template.name, runtime: { model: null, effort: null } } };
  const data = { ...snapshot, setups: [template, connected, ...saved.slice(1)] };
  const harness = appHarness(data);
  vi.stubGlobal('location', { hash: 'setup' });
  try {
    harness.choose('one');
    const markup = renderToStaticMarkup(createElement(SavedSetups, harness.savedSetups().props));
    expect(markup).toContain('data-setup-id="shared-one"');
    expect(markup).not.toContain('data-setup-id="saved-one"');
    harness.savedSetups().props.onUse(connected);
    const select = appControls(harness.render()).find(node => node.type === 'select' && node.props.id === 'setup');
    expect(select?.props.value).toBe('shared-one');
    expect(appControls(select?.props.children).filter(node => node.type === 'option').map(node => node.props.value)).toEqual(['', 'shared-one']);
  } finally { vi.unstubAllGlobals(); harness.restore(); }
});

test('saved setting opens a new task with its project, setting, type and size selected', () => {
  const harness = appHarness({ ...snapshot, setups: saved });
  vi.stubGlobal('location', { hash: 'setup' });
  try {
    harness.choose('one');
    const first = saved[0];
    if (!first) throw new Error('Missing saved fixture');
    harness.savedSetups().props.onUse(first);
    const controls = appControls(harness.render());
    expect(controls.find(node => node.type === 'select' && node.props.id === 'task-mode')?.props.value).toBe('comparison');
    for (const [id, value] of [['project', 'one'], ['setup', 'saved-one'], ['type', 'fix'], ['size', 'medium']]) {
      expect(controls.find(node => node.type === 'select' && node.props.id === id)?.props.value).toBe(value);
    }
    expect(location.hash).toBe('new');
    expect(vi.mocked(api.mutate)).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); harness.restore(); }
});

test('a new task without comparison settings defaults to ordinary criteria and can switch explicitly', () => {
  const harness = appHarness(snapshot, [[3, 'new']]);
  try {
    const controls = appControls(harness.render());
    const mode = controls.find(node => node.type === 'select' && node.props.id === 'task-mode');
    expect(mode?.props.value).toBe('ordinary');
    expect(controls.some(node => node.type === OrdinaryCriteria)).toBe(true);
    expect(controls.some(node => node.props.id === 'setup')).toBe(false);
    if (!isValidElement<{ onChange: (event: { target: { value: string } }) => void }>(mode)) throw new Error('Missing mode selector');
    mode.props.onChange({ target: { value: 'comparison' } });
    const next = appControls(harness.render());
    expect(next.find(node => node.type === 'select' && node.props.id === 'task-mode')?.props.value).toBe('comparison');
    expect(next.some(node => node.props.id === 'setup')).toBe(true);
    expect(next.some(node => node.type === OrdinaryCriteria)).toBe(false);
    expect(api.mutate).not.toHaveBeenCalled();
  } finally { harness.restore(); }
});

test('new-task selection explains the server recruitment window before submitting a task', () => {
  const original = saved[0];
  if (!original) throw new Error('Missing saved fixture');
  const setup = { ...original, recruitment: { starts_at: '2099-01-01T00:00:00Z', ends_at: '2099-02-01T00:00:00Z', state: 'before_start' as const } };
  const harness = appHarness({ ...snapshot, setups: [setup] });
  vi.stubGlobal('location', { hash: 'setup' });
  try {
    harness.choose('one');
    harness.savedSetups().props.onUse(setup);
    const html = renderToStaticMarkup(harness.render());
    expect(html).toContain('data-error-kind="outside_recruitment_before_start"');
    expect([...html.matchAll(/<time datetime="([^"]+)"/gi)].map(match => match[1])).toEqual([setup.recruitment.starts_at, setup.recruitment.ends_at]);
    expect(vi.mocked(api.mutate)).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); harness.restore(); }
});

test('support status remains visible before the saved conditions disclosure', () => {
  const first = saved[0];
  if (!first) throw new Error('Missing saved fixture');
  const markup = renderToStaticMarkup(createElement(SetupSummary, { setup: { ...first, support_details: syntheticSupport }, projectName: 'One', locale: 'ko', busy: false, onUse: () => undefined }));
  expect(markup.indexOf('data-support-context="synthetic_validation_only"')).toBeGreaterThan(-1);
  expect(markup.indexOf('data-support-context="synthetic_validation_only"')).toBeLessThan(markup.indexOf('<details class="text-sm"'));
});

test('setup shows title and project registration before a form with no automatic project selection', () => {
  const harness = appHarness();
  try {
    const controls = appControls(harness.render());
    expect(controls.findIndex(node => node.type === 'h1')).toBeLessThan(controls.findIndex(node => node.props.id === 'directory'));
    expect(controls.findIndex(node => node.props.id === 'directory')).toBeLessThan(controls.findIndex(node => node.type === GuidedSetup));
    expect(controls.filter(node => node.props.name === 'setup-project').map(node => node.props.checked)).toEqual([false, false]);
    expect(harness.guided().props.project).toBeNull();
  } finally { harness.restore(); }
});

test('ordinary setup is absent until a project is selected from multiple projects', () => {
  const harness = appHarness();
  try {
    expect(appControls(harness.render()).filter(node => node.type === AgentConnectionSetup)).toHaveLength(0);
  } finally { harness.restore(); }
});

test.each(['one', 'two'])('ordinary setup renders only the selected project: %s', projectId => {
  const harness = appHarness();
  try {
    harness.choose(projectId);
    const cards = appControls(harness.render()).filter(node => node.type === AgentConnectionSetup);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.key).not.toBe(harness.guided().key);
    expect(isValidElement<Parameters<typeof AgentConnectionSetup>[0]>(cards[0]) && cards[0].props.projectId).toBe(projectId);
  } finally { harness.restore(); }
});

test('a sole registered project is selected for comparison review without another click', () => {
  const onlyProject = projects[0];
  if (!onlyProject) throw new Error('Missing project fixture');
  const harness = appHarness({ ...snapshot, projects: [onlyProject] });
  try {
    const first = harness.guided();
    expect(first.props.project).toEqual(onlyProject);
    expect(first.key).toBe(onlyProject.id);
    expect(appControls(harness.render()).find(node => node.props.name === 'setup-project')?.props.checked).toBe(true);
    harness.choose(onlyProject.id);
    expect(harness.guided().key).toBe(first.key);
  } finally { harness.restore(); }
});

test('the implicitly selected project remains selected when another project appears', () => {
  const onlyProject = projects[0];
  if (!onlyProject) throw new Error('Missing project fixture');
  const selected = defaultSetupProjectId('', [onlyProject]);
  expect(defaultSetupProjectId(selected, projects)).toBe(onlyProject.id);
  expect(defaultSetupProjectId('', projects)).toBe('');
});

test('project registration reload keeps the original comparison form selected', async () => {
  const onlyProject = projects[0];
  const nextProject = projects[1];
  if (!onlyProject || !nextProject) throw new Error('Missing project fixtures');
  const harness = appHarness({ ...snapshot, projects: [onlyProject] });
  try {
    vi.mocked(api.mutate).mockResolvedValue({ ready: false, issues: [] });
    await harness.guided().props.perform('/api/setup-review', {
      project_id: onlyProject.id, comparison_path: '/synthetic/comparison.json',
    });
    vi.mocked(api.bootstrap).mockResolvedValue({ ...snapshot, projects });
    vi.mocked(api.mutate).mockResolvedValue(nextProject);
    const before = harness.guided();
    const beforeCards = appControls(harness.render()).filter(node => node.type === AgentConnectionSetup);
    expect(beforeCards).toHaveLength(1);
    await before.props.perform('/api/projects', { directory: nextProject.directory });
    const after = harness.guided();
    const afterCards = appControls(harness.render()).filter(node => node.type === AgentConnectionSetup);
    expect(afterCards).toHaveLength(1);
    expect(afterCards[0]?.key).toBe(beforeCards[0]?.key);
    expect(isValidElement<Parameters<typeof AgentConnectionSetup>[0]>(afterCards[0]) && afterCards[0].props.projectId).toBe(onlyProject.id);
    expect(after.key).toBe(before.key);
    expect(after.props.project).toEqual(onlyProject);
    expect(appControls(harness.render()).filter(node => node.props.name === 'setup-project').map(node => node.props.checked)).toEqual([true, false]);
  } finally { harness.restore(); }
});

test('completed setup saving needs no second connection and stale saves cannot restore its UI', () => {
  const harness = appHarness();
  try {
    harness.choose('one'); const first = harness.guided(); first.props.onSaved(savedConnection);
    const preview = harness.savedSetups().props.preview;
    expect(preview).toBeNull();
    expect(vi.mocked(api.mutate)).not.toHaveBeenCalled();
    harness.choose('two'); const second = harness.guided();
    expect(second.key).not.toBe(first.key);
    expect(second.props.project).toEqual(projects[1]);
    expect(harness.savedSetups().props.preview).toBeNull();
    first.props.onSaved(savedConnection);
    expect(harness.savedSetups().props.preview).toBeNull();
  } finally { harness.restore(); }
});

test('a pending setup operation stays stale even after switching away and back', async () => {
  const harness = appHarness();
  let complete: (value: SharedSetupImport) => void;
  const response = { promise: new Promise<SharedSetupImport>(resolve => { complete = resolve; }), resolve: (value: SharedSetupImport) => complete(value) };
  vi.mocked(api.mutate).mockReturnValue(response.promise);
  try {
    harness.choose('one'); const first = harness.guided();
    const result = first.props.perform<SharedSetupImport>('/api/setup-review', {});
    harness.choose('two'); harness.choose('one');
    response.resolve(imported);
    expect(await result).toBeNull();
    first.props.onSaved(savedConnection);
    expect(appControls(harness.render()).some(node => node.type === SharedSetupPreview)).toBe(false);
  } finally { harness.restore(); }
});

test.each([false, true])('setup failure is visible only for its original selection: switched=%s', async switched => {
  const harness = appHarness();
  let rejectResponse: (error: Error) => void = () => { throw new Error('Response not initialized'); };
  vi.mocked(api.mutate).mockReturnValue(new Promise((_, reject) => { rejectResponse = reject; }));
  try {
    harness.choose('one');
    const result = harness.guided().props.perform('/api/setup-review', {});
    if (switched) { harness.choose('two'); harness.choose('one'); }
    rejectResponse(new Error('synthetic failure'));
    expect(await result).toBeNull();
    const markup = renderToStaticMarkup(harness.render());
    expect(markup.includes('local_operation_failed')).toBe(!switched);
  } finally { harness.restore(); }
});

const familySupport: SupportDetails = {
  context: 'real', connection_route: 'family', product: 'codex', product_version: '0.162.1',
  launch: [], ticket: 'unsupported', family: 'candidate_root_pilot', complete_cost: false, inference: false,
};
const waitingTask: Task = {
  id: 'task-waiting', name: 'Synthetic waiting task', project_id: 'one', setup_id: 'saved-one', version: '"v1"', state: 'registered', status: 'waiting_for_session',
  support_details: familySupport,
  harness: { arm: 'B', variant_id: 'variant-b', version: 'candidate-v2', application_mode: 'selected_markdown_only' },
  measurement: { state: 'waiting_connection', active_ms: null, requests: null, window: { started_at: null, ends_at: null } },
  outcome: null, attempt: 1,
  preparation: { state: 'configuration_verified', configuration_evidence: 'verified_at_preparation', native_context_evidence: 'unverified', freshness_evidence: 'unverified', tool_use_evidence: 'unavailable', assigned_variant_id: 'variant-b' },
  price: { partial_amount: null, currency: 'USD', unpriced_events: 0, basis: null },
  actions: [{ code: 'session-connect', enabled: false, reason: 'binding_provider_unavailable' }],
  startup: null, criteria: ['criterion-one'], source: null, reason: null,
};

test.each([[false, true], [true, false], [true, true], [false, false]])(
  'outcome menu honors independent failed=%s and abandoned=%s permissions',
  (failed, abandoned) => {
    const task: Task = { ...waitingTask, mode: 'ordinary', actions: [
      { code: 'finish-failed', enabled: failed, reason: failed ? null : 'external_connection_required' },
      { code: 'finish-abandoned', enabled: abandoned, reason: abandoned ? null : 'binding_scope_revoked' },
    ] };
    const harness = appHarness({ ...snapshot, tasks: [task] }, [[3, 'detail'], [4, task]]);
    vi.stubGlobal('location', { hash: '', origin: 'http://127.0.0.1:4318' });
    try {
      const menu = appControls(harness.render()).find(node => node.props['aria-expanded'] !== undefined);
      expect(menu?.props.disabled).toBe(!failed && !abandoned);
      if (!failed && !abandoned) return;
      menu?.props.onClick?.();
      const controls = appControls(harness.render());
      for (const [code, enabled] of [['finish-failed', failed], ['finish-abandoned', abandoned]] as const) {
        expect(controls.find(node => node.props['data-task-action'] === code)?.props.disabled).toBe(!enabled);
        expect(controls.some(node => node.props['data-action-blocked'] === code)).toBe(!enabled);
      }
      expect(api.mutate).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); harness.restore(); }
  },
);

test.each(['rejected', 'prepared'])('preparation retry keeps distinct application and connection identities when %s', async result => {
  const blocked: Task = { ...waitingTask, status: 'blocked_configuration', reason: 'outside_recruitment',
    application: { launchState: 'not_requested', identity: 'unverified', state: 'blocked_configuration', jobId: null,
      epoch: 0, reason: 'outside_recruitment', workspace: null, baseline: 'synthetic', capabilities: [] },
    actions: [{ code: 'prepare', enabled: true, reason: null }],
  };
  const harness = appHarness({ ...snapshot, tasks: [blocked] }, [[3, 'detail'], [4, blocked]]);
  vi.stubGlobal('location', { hash: '', origin: 'http://127.0.0.1:4318' });
  try {
    const application = appControls(harness.render()).find(node => node.type === HarnessApplication);
    if (!isValidElement<Parameters<typeof HarnessApplication>[0]>(application)) throw new Error('Missing application card');
    if (result === 'rejected') vi.mocked(api.mutate).mockRejectedValue(new api.LocalApiError('outside_recruitment'));
    else vi.mocked(api.mutate).mockResolvedValue({ ...blocked, version: '"v2"', reason: null,
      application: { ...blocked.application, state: 'awaiting_application' } });

    await application.props.onAction('prepare');

    expect(api.mutate).toHaveBeenCalledWith(`/api/tasks/${blocked.id}/prepare`, {}, blocked.version);
    const controls = appControls(harness.render());
    const applications = controls.filter(node => node.type === HarnessApplication);
    const connections = controls.filter(node => node.type === ClaudeConnection);
    expect(applications).toHaveLength(1);
    expect(connections).toHaveLength(1);
    expect(applications[0]?.key).toBe(application.key);
    expect(applications[0]?.key).not.toBe(connections[0]?.key);
    expect(isValidElement<Parameters<typeof HarnessApplication>[0]>(applications[0]) && applications[0].props.task.application?.state)
      .toBe(result === 'rejected' ? 'blocked_configuration' : 'awaiting_application');
  } finally { vi.unstubAllGlobals(); harness.restore(); }
});

test.each([
  [waitingTask, 'family'],
  [{ ...waitingTask, harness: { arm: 'B' as const, variant_id: 'variant-b', version: 'candidate-v2', application_mode: 'agent_applied' as const } }, 'agent'],
  [{ ...waitingTask, support_details: { ...familySupport, connection_route: 'ticket' as const, ticket: 'exact_version_only' as const } }, 'ticket'],
  [{ ...waitingTask, support_details: { ...familySupport, connection_route: 'ticket' as const } }, 'unsupported'],
  [{ ...waitingTask, support_details: syntheticSupport }, 'synthetic'],
] as const)('connection guidance follows the application method and route: %#', (task, route) => {
  expect(connectionRoute(task)).toBe(route);
});

test('an instruction-only task on the family route still shows its assignment and how to connect', () => {
  const harness = appHarness({ ...snapshot, tasks: [waitingTask] }, [[3, 'detail'], [4, waitingTask]]);
  vi.stubGlobal('location', { hash: '', origin: 'http://127.0.0.1:4318' });
  try {
    const html = renderToStaticMarkup(harness.render());
    expect(html).toMatch(/data-assigned-harness=""[^>]*data-harness-arm="B"[^>]*data-application-mode="selected_markdown_only"[^>]*data-connection-route="family"/);
    expect(html).toContain('candidate-v2');
    expect(html).toMatch(/<textarea[^>]*>[^<]*http:\/\/127\.0\.0\.1:4318[^<]*task-waiting/);
    expect(html).toContain('data-connect-blocked=""');
    expect(html).not.toContain('id="harness-application"');
  } finally { vi.unstubAllGlobals(); harness.restore(); }
});
