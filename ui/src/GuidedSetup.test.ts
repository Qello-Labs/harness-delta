import { createElement, isValidElement, useEffect, useRef, useState, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test, vi } from 'vitest';
import type { SetupReviewResult } from '../../src/local-web-setup-review.js';
import { Button } from '@/components/ui/button';
import { buildMeasurementRequest, buildSetupRequest, GuidedSetup, measurementSettingIdentifier } from './GuidedSetup';
import { setupReviewFixture } from '../../tests/helpers/setup-review-fixture.js';
import { MeasurementReview } from './MeasurementReview';

vi.mock('react', async importOriginal => {
  const react = await importOriginal<typeof import('react')>();
  return { ...react, useState: vi.fn(react.useState), useRef: vi.fn(react.useRef), useEffect: vi.fn(react.useEffect) };
});

test.each([
  ['{"id":"new-setting"}', 'new-setting'],
  ['{"id":"edited-setting"}', 'edited-setting'],
])('new settings read the supplied profile identifier from %s', (profile, expected) => {
  expect(measurementSettingIdentifier('', profile)).toBe(expected);
});

test.each([undefined, '', ' ', '{', 'null', '[]', '{}', '{"id":null}', '{"id":12}', '{"id":""}'])(
  'new settings have no identifier when the profile is missing or invalid: %s',
  profile => { expect(measurementSettingIdentifier('', profile)).toBe(''); },
);

test.each(['{"id":"different-new-setting"}', '{'])('registered selection ignores a retained profile draft: %s', profile => {
  expect(measurementSettingIdentifier('registered-setting', profile)).toBe('registered-setting');
});

test('new settings identifier can be entered directly', () => {
  const markup = renderToStaticMarkup(createElement(GuidedSetup, {
    locale: 'ko', project: null, setups: [], busy: false,
    perform: () => Promise.resolve(null), onSaved: () => undefined,
  }));
  expect(markup).not.toMatch(/<input\b[^>]*id="guided-template-id"[^>]*readonly=""/i);
  expect(markup).toMatch(/<input\b[^>]*id="guided-template-id"[^>]*aria-describedby="guided-identifier-help"/);
});

test('comparison input waits for a registered project instead of losing a typed path', () => {
  const markup = renderToStaticMarkup(createElement(GuidedSetup, {
    locale: 'ko', project: null, setups: [], busy: false,
    perform: () => Promise.resolve(null), onSaved: () => undefined,
  }));
  expect(markup).toMatch(/<input\b[^>]*id="guided-comparison"[^>]*disabled=""/);
});

test('one combined copy control requires a project and prepared instruction', () => {
  const markup = renderToStaticMarkup(createElement(GuidedSetup, {
    locale: 'ko', project: null, setups: [], busy: true,
    perform: () => Promise.resolve(null), onSaved: () => undefined,
  }));
  const buttons = Array.from(markup.matchAll(/<button\b[^>]*data-copy-skill="([^"]+)"[^>]*>/g));
  expect(buttons.map(button => button[1])).toEqual(['harness-register+harness-compare-config']);
  expect(buttons[0]?.[0]).toMatch(/\sdisabled(?:=|\s|>)/);
  expect(markup).toMatch(/<input\b[^>]*id="guided-comparison"[^>]*disabled=""/);
  expect(markup).not.toContain('data-setup-review="ready"');
});

test('a review response cannot restore an invalidated review after a profile file completes', async () => {
  vi.mocked(useEffect).mockImplementation(() => undefined);
  const states: unknown[] = [];
  const refs: { current: unknown }[] = [];
  let stateIndex = 0;
  let refIndex = 0;
  vi.mocked(useState).mockImplementation((initial?: unknown) => {
    const index = stateIndex++;
    if (index === states.length) states.push(initial);
    return [states[index], (value: unknown) => {
      states[index] = typeof value === 'function' ? Reflect.apply(value, undefined, [states[index]]) : value;
    }];
  });
  vi.mocked(useRef).mockImplementation((initial: unknown) => refs[refIndex++] ??= { current: initial });
  function pending<T>() {
    let complete: (value: T) => void;
    const promise = new Promise<T>(resolve => { complete = resolve; });
    return { promise, resolve: (value: T) => complete(value) };
  }
  const file = pending<string>();
  const response = pending<SetupReviewResult | null>();
  const blocked: SetupReviewResult = { ready: false, issues: [{ field: 'profile.name', code: 'invalid_type' }] };
  const perform = vi.fn().mockReturnValueOnce(response.promise).mockResolvedValueOnce(blocked);
  type Control = {
    id?: string; value?: string; children?: ReactNode; 'aria-label'?: string;
    'data-copy-skill'?: string; 'data-setup-review'?: string;
    onChange?: (event: { target: { value: string; files?: { text: () => Promise<string> }[] } }) => void;
    onClick?: () => void;
  };
  function controls(node: ReactNode): { type: unknown; props: Control }[] {
    if (Array.isArray(node)) return node.flatMap(controls);
    if (!isValidElement<Control>(node)) return [];
    return [node, ...controls(node.props.children)];
  }
  function render(busy = false) {
    stateIndex = 0; refIndex = 0;
    return controls(GuidedSetup({ locale: 'ko', project: { id: 'synthetic', name: 'Synthetic', directory: '/synthetic', baseline: null, setup_ids: [] }, setups: [], busy, perform, onSaved: vi.fn() }));
  }
  function input(id: string) {
    const control = render().find(node => node.props.id === id);
    if (!control?.props.onChange) throw new Error(`Missing input ${id}`);
    return control.props.onChange;
  }
  function reviewButton() {
    const control = render().find(node => node.type === Button && !node.props['data-copy-skill']);
    if (!control?.props.onClick) throw new Error('Missing review action');
    return control.props.onClick;
  }
  try {
    input('guided-comparison')({ target: { value: '/synthetic/comparison.json' } });
    input('guided-profile')({ target: { value: '{"id":"synthetic-old"}' } });
    const upload = render().find(node => node.props['aria-label'] === 'profile JSON file');
    if (!upload?.props.onChange) throw new Error('Missing profile upload');
    upload.props.onChange({ target: { value: '', files: [{ text: () => file.promise }] } });
    reviewButton()();
    expect(perform.mock.calls[0]?.[1]).toMatchObject({ template_id: 'synthetic-old', profile: { id: 'synthetic-old' } });
    render(true);

    // Both continuations subscribe to the same promise before its controlled completion.
    const fileCompleted = file.promise.then(() => undefined);
    file.resolve('{"id":"synthetic-new"}');
    await fileCompleted;
    expect(render(true).find(node => node.props.id === 'guided-template-id')?.props.value).toBe('synthetic-new');
    const responseCompleted = response.promise.then(() => undefined);
    response.resolve(blocked);
    await responseCompleted;
    expect(render().some(node => node.props['data-setup-review'])).toBe(false);

    reviewButton()();
    await perform.mock.results[1]?.value;
    expect(perform.mock.calls[1]?.[1]).toMatchObject({ template_id: 'synthetic-new', profile: { id: 'synthetic-new' } });
    expect(render().some(node => node.props['data-setup-review'] === 'blocked')).toBe(true);
  } finally { vi.mocked(useState).mockReset(); vi.mocked(useRef).mockReset(); vi.mocked(useEffect).mockReset(); }
});

const syntheticProject = { id: 'project-one', name: 'One', directory: '/synthetic/one', baseline: null, setup_ids: [] };

test.each(['en', 'ko'] as const)('combined request embeds selected project and relative candidate paths in %s', locale => {
  const request = buildSetupRequest(locale, syntheticProject, ' candidate/procedure.md ', ' scripts/run.sh\n\n docs/policy.md ', ' docs/readme.md ', 'agent_applied');
  const data = request?.match(/\x60\x60\x60json\n([\s\S]*?)\n\x60\x60\x60/)?.[1];
  expect(JSON.parse(data ?? 'null')).toEqual({ project: { id: syntheticProject.id, name: syntheticProject.name, directory: syntheticProject.directory }, candidate: { instruction: 'candidate/procedure.md', supporting: ['scripts/run.sh', 'docs/policy.md'], readme: 'docs/readme.md' }, application_mode: 'agent_applied' });
});

test.each(['', ' ', '/absolute.md', '../outside.md', 'dir/../outside.md', 'C:\\absolute.md', '\\absolute.md', 'one.md\ntwo.md'])('candidate request rejects missing or nonrelative primary path %j', instruction => {
  expect(buildSetupRequest('en', syntheticProject, instruction, '', '', 'selected_markdown_only')).toBeNull();
});

test('request requires a project and validates optional paths', () => {
  expect(buildSetupRequest('en', null, 'candidate.md', '', '', 'selected_markdown_only')).toBeNull();
  expect(buildSetupRequest('en', syntheticProject, 'candidate.md', '/external.sh', '', 'selected_markdown_only')).toBeNull();
  expect(buildSetupRequest('en', syntheticProject, 'candidate.md', '', '../readme.md', 'selected_markdown_only')).toBeNull();
  expect(buildSetupRequest('en', syntheticProject, 'candidate.md', '', '', '')).toBeNull();
  const data = buildSetupRequest('en', syntheticProject, 'candidate.md', '', '', 'selected_markdown_only')?.match(/\x60\x60\x60json\n([\s\S]*?)\n\x60\x60\x60/)?.[1];
  const input: unknown = JSON.parse(data ?? 'null');
  expect(input).toMatchObject({ candidate: { instruction: 'candidate.md', supporting: [], readme: null }, application_mode: 'selected_markdown_only' });
});

type GuidedControl = { id?: string; value?: string; children?: ReactNode; disabled?: boolean; checked?: boolean; type?: string; 'data-application-mode-mismatch'?: string; 'data-copy-skill'?: string; 'data-setup-review'?: string; 'data-setup-save'?: string; 'data-comparison-inspected'?: string; 'aria-label'?: string; onClick?: () => void; onChange?: (event: { target: { value: string; checked?: boolean; files?: { name?: string; text: () => Promise<string> }[] } }) => void };
function guidedControls(node: ReactNode): { type: unknown; props: GuidedControl }[] {
  if (Array.isArray(node)) return node.flatMap(guidedControls);
  if (!isValidElement<GuidedControl>(node)) return [];
  return [node, ...guidedControls(node.props.children)];
}
function guidedHarness(perform: <T>(route: string, input: unknown) => Promise<T | null>, onSaved = vi.fn(), project = syntheticProject) {
  const states: unknown[] = []; const refs: { current: unknown }[] = [];
  let stateIndex = 0; let refIndex = 0; let cleanup: (() => void) | undefined;
  vi.mocked(useState).mockImplementation((initial?: unknown) => { const index = stateIndex++; if (index === states.length) states.push(initial); return [states[index], (value: unknown) => { states[index] = typeof value === 'function' ? Reflect.apply(value, undefined, [states[index]]) : value; }]; });
  vi.mocked(useRef).mockImplementation((initial: unknown) => refs[refIndex++] ??= { current: initial });
  vi.mocked(useEffect).mockImplementation(effect => { if (!cleanup) { const result = effect(); if (typeof result === 'function') cleanup = result; } });
  function render(busy = false, setups: Parameters<typeof GuidedSetup>[0]['setups'] = []) { stateIndex = 0; refIndex = 0; return guidedControls(GuidedSetup({ locale: 'en', project, setups, busy, perform, onSaved })); }
  function change(id: string, value: string) { const control = render().find(node => node.props.id === id); if (!control?.props.onChange) throw new Error(id); control.props.onChange({ target: { value } }); }
  return { render, change, unmount: () => cleanup?.(), restore: () => { vi.mocked(useState).mockReset(); vi.mocked(useRef).mockReset(); vi.mocked(useEffect).mockReset(); } };
}

test('a prepared candidate with a chosen application method enables local copying even when server actions are busy', () => {
  const harness = guidedHarness(() => Promise.resolve(null));
  try {
    harness.change('guided-instruction', 'candidate.md');
    expect(harness.render(true).find(node => node.props['data-copy-skill'])?.props.disabled).toBe(true);
    harness.change('guided-mode-agent_applied', '');
    expect(harness.render(true).find(node => node.props['data-copy-skill'])?.props.disabled).toBe(false);
    expect(harness.render(true).find(node => node.props.id === 'guided-comparison')?.props.disabled).toBe(true);
  } finally { harness.restore(); }
});

test('only the selected project’s nonshared measurement templates are selectable', () => {
  const harness = guidedHarness(() => Promise.resolve(null));
  const setup = { id: 'local-one', name: 'Local', project_id: syntheticProject.id, arm_a: 'a', arm_b: 'b', types: [], sizes: [], support: 'synthetic' };
  try {
    const controls = harness.render(false, [setup, { ...setup, id: 'other', project_id: 'project-two' }, { ...setup, id: 'shared', shared: { revision_id: 'revision', template_id: 'template', template_name: 'Template', runtime: { model: null, effort: null } } }]);
    const template = controls.find(node => node.props.id === 'guided-template');
    expect(guidedControls(template?.props.children).filter(node => node.type === 'option').map(node => node.props.value)).toEqual(['', 'local-one']);
  } finally { harness.restore(); }
});

test('pending file and review completions cannot update an unmounted project form', async () => {
  let completeFile: (value: string) => void;
  let completeResponse: (value: SetupReviewResult | null) => void;
  const file = { promise: new Promise<string>(resolve => { completeFile = resolve; }), resolve: (value: string) => completeFile(value) };
  const response = { promise: new Promise<SetupReviewResult | null>(resolve => { completeResponse = resolve; }), resolve: (value: SetupReviewResult | null) => completeResponse(value) };
  const harness = guidedHarness(vi.fn().mockReturnValue(response.promise));
  try {
    harness.change('guided-comparison', '/synthetic/comparison.json'); harness.change('guided-profile', '{"id":"before"}');
    const upload = harness.render().find(node => node.props['aria-label'] === 'profile JSON file');
    upload?.props.onChange?.({ target: { value: '', files: [{ text: () => file.promise }] } });
    harness.render().find(node => node.type === Button && !node.props['data-copy-skill'])?.props.onClick?.();
    harness.unmount();
    const fileCompleted = file.promise.then(() => undefined); file.resolve('{"id":"stale"}'); await fileCompleted;
    response.resolve({ ready: false, issues: [] }); await response.promise;
    expect(harness.render().find(node => node.props.id === 'guided-template-id')?.props.value).toBe('before');
    expect(harness.render().some(node => node.props['data-setup-review'])).toBe(false);
  } finally { harness.restore(); }
});

const proposedId = 'setup-' + 'b'.repeat(64);
const inspectedComparison: SetupReviewResult = {
  ready: false,
  issues: [{ field: 'profile', code: 'shared_registration_required' }, { field: 'profile.setup.workflow.assignment.metadata.criterion_ids', code: 'decision_required' }],
  comparison: {
    project_id: syntheticProject.id, comparison_id: 'pair-one', descriptor_path: 'harness-config/comparisons/pair.json',
    settings_hash: 'a'.repeat(64), proposed_profile_id: proposedId, application_mode: 'selected_markdown_only',
    arm_a: { harness_id: 'search', version: 'v1', path: 'harness-config/v1/manifest.json', bundle_hash: 'c'.repeat(64), policy_version: 'policy-v1', instruction_manifest_hash: 'd'.repeat(64), proposed_variant_id: 'variant-' + '1'.repeat(64) },
    arm_b: { harness_id: 'search', version: 'v2', path: 'harness-config/v2/manifest.json', bundle_hash: 'e'.repeat(64), policy_version: 'policy-v1', instruction_manifest_hash: 'f'.repeat(64), proposed_variant_id: 'variant-' + '2'.repeat(64) },
  },
};

test.each(['en', 'ko'] as const)('measurement request carries verified identities and unresolved policy choices in %s', locale => {
  const request = buildMeasurementRequest(locale, syntheticProject, '/synthetic/comparison.json',
    inspectedComparison.comparison, proposedId, { arm_a: null, arm_b: null });
  const data = request?.match(/\x60\x60\x60json\n([\s\S]*?)\n\x60\x60\x60/)?.[1];
  const input: unknown = JSON.parse(data ?? 'null');
  expect(input).toMatchObject({
    project: { id: syntheticProject.id, directory: syntheticProject.directory },
    comparison: { path: '/synthetic/comparison.json', project_id: syntheticProject.id,
      arm_a: { version: 'v1', proposed_variant_id: 'variant-' + '1'.repeat(64) },
      arm_b: { version: 'v2', proposed_variant_id: 'variant-' + '2'.repeat(64) } },
    proposed_profile_id: proposedId,
    policy_status: { arm_a: null, arm_b: null },
  });
  const selected = buildMeasurementRequest(locale, syntheticProject, '/synthetic/comparison.json',
    inspectedComparison.comparison, 'reviewed-setting', { arm_a: 'eligible', arm_b: 'ineligible' });
  const selectedData = selected?.match(/\x60\x60\x60json\n([\s\S]*?)\n\x60\x60\x60/)?.[1];
  const selectedInput: unknown = JSON.parse(selectedData ?? 'null');
  expect(selectedInput).toMatchObject({
    proposed_profile_id: 'reviewed-setting',
    policy_status: { arm_a: 'eligible', arm_b: 'ineligible' },
  });
  expect(buildMeasurementRequest(locale, null, '/synthetic/comparison.json', inspectedComparison.comparison,
    proposedId, { arm_a: null, arm_b: null })).toBeNull();
});

test('comparison path alone starts inspection and keeps the generated identifier during later input', async () => {
  const perform = vi.fn().mockResolvedValue(inspectedComparison);
  const harness = guidedHarness(perform);
  try {
    const action = () => harness.render().find(node => node.type === Button && !node.props['data-copy-skill']);
    expect(action()?.props.disabled).toBe(true);
    harness.change('guided-comparison', '/synthetic/comparison.json');
    expect(action()?.props.disabled).toBe(false);
    action()?.props.onClick?.();
    await perform.mock.results[0]?.value;
    expect(perform.mock.calls[0]?.[1]).toEqual({ comparison_path: '/synthetic/comparison.json', project_id: syntheticProject.id });
    expect(harness.render().some(node => node.props['data-comparison-inspected'] === '')).toBe(true);
    expect(harness.render().some(node => node.props['data-copy-skill'] === 'measurement-request')).toBe(true);
    expect(harness.render().find(node => node.props.id === 'guided-template-id')?.props.value).toBe(proposedId);
    expect(harness.render().some(node => node.props['data-setup-review'] === 'ready')).toBe(false);

    harness.change('guided-arm_a-status', 'eligible');
    harness.change('guided-arm_b-status', 'ineligible');
    expect(harness.render().some(node => node.props['data-comparison-inspected'] === '')).toBe(true);
    action()?.props.onClick?.();
    await perform.mock.results[1]?.value;
    expect(perform.mock.calls[1]?.[1]).toMatchObject({ policy_status: { arm_a: 'eligible', arm_b: 'ineligible' } });
    harness.change('guided-profile', '{"name":"Candidate"}');
    expect(harness.render().find(node => node.props.id === 'guided-template-id')?.props.value).toBe(proposedId);
    harness.change('guided-template-id', 'my-reviewed-setting');
    action()?.props.onClick?.();
    await perform.mock.results[2]?.value;
    expect(perform.mock.calls[2]?.[1]).toMatchObject({
      template_id: 'my-reviewed-setting',
      profile: { name: 'Candidate', id: 'my-reviewed-setting' },
      policy_status: { arm_a: 'eligible', arm_b: 'ineligible' },
    });
    harness.change('guided-comparison', '/synthetic/another.json');
    expect(harness.render().find(node => node.props.id === 'guided-template-id')?.props.value).toBe('my-reviewed-setting');
    expect(harness.render().some(node => node.props.id === 'guided-arm_a-status')).toBe(false);
    expect(harness.render().some(node => node.props['data-copy-skill'] === 'measurement-request')).toBe(false);
  } finally { harness.restore(); }
});

test('automatic identifier is cleared when the comparison changes', async () => {
  const perform = vi.fn().mockResolvedValue(inspectedComparison);
  const harness = guidedHarness(perform);
  try {
    harness.change('guided-comparison', '/synthetic/one.json');
    harness.render().find(node => node.type === Button && !node.props['data-copy-skill'])?.props.onClick?.();
    await perform.mock.results[0]?.value;
    expect(harness.render().find(node => node.props.id === 'guided-template-id')?.props.value).toBe(proposedId);
    harness.change('guided-comparison', '/synthetic/two.json');
    expect(harness.render().find(node => node.props.id === 'guided-template-id')?.props.value).toBe('');
  } finally { harness.restore(); }
});

test('a blocked registration keeps explicitly chosen policy statuses visible', async () => {
  const blocked: SetupReviewResult = { ready: false, issues: [{ field: 'registrations', code: 'invalid_ui_setup' }] };
  const perform = vi.fn().mockResolvedValueOnce(inspectedComparison).mockResolvedValueOnce(blocked);
  const harness = guidedHarness(perform);
  try {
    harness.change('guided-comparison', '/synthetic/one.json');
    const action = () => harness.render().find(node => node.type === Button && !node.props['data-copy-skill']);
    action()?.props.onClick?.();
    await perform.mock.results[0]?.value;
    harness.change('guided-arm_a-status', 'eligible');
    harness.change('guided-arm_b-status', 'ineligible');
    harness.change('guided-profile', '{"name":"Candidate"}');
    action()?.props.onClick?.();
    await perform.mock.results[1]?.value;
    expect(harness.render().find(node => node.props.id === 'guided-arm_a-status')?.props.value).toBe('eligible');
    expect(harness.render().find(node => node.props.id === 'guided-arm_b-status')?.props.value).toBe('ineligible');
    expect(harness.render().some(node => node.props['data-setup-review'] === 'blocked')).toBe(true);
    expect(harness.render().some(node => node.props['data-comparison-inspected'] === '')).toBe(true);
  } finally { harness.restore(); }
});

test('explicit existing setting selection reuses its profile instead of a retained draft', async () => {
  const perform = vi.fn().mockResolvedValue(null);
  const harness = guidedHarness(perform);
  const setup = { id: 'saved-setting', name: 'Saved', project_id: syntheticProject.id, arm_a: 'a', arm_b: 'b', types: [], sizes: [], support: 'synthetic' };
  try {
    harness.change('guided-comparison', '/synthetic/comparison.json');
    harness.change('guided-profile', '{"id":"stale-draft"}');
    harness.render(false, [setup]).find(node => node.props.id === 'guided-template')?.props.onChange?.({ target: { value: setup.id } });
    const chosen = harness.render(false, [setup]);
    expect(chosen.find(node => node.props.id === 'guided-template-id')?.props.value).toBe(setup.id);
    chosen.find(node => node.type === Button && !node.props['data-copy-skill'])?.props.onClick?.();
    await perform.mock.results[0]?.value;
    expect(perform.mock.calls[0]?.[1]).toEqual({ comparison_path: '/synthetic/comparison.json', project_id: syntheticProject.id, template_id: setup.id });
  } finally { harness.restore(); }
});

test('changed comparison ignores a late inspection result', async () => {
  let resolve!: (value: SetupReviewResult) => void;
  const response = new Promise<SetupReviewResult>(done => { resolve = done; });
  const perform = vi.fn().mockReturnValue(response);
  const harness = guidedHarness(perform);
  try {
    harness.change('guided-comparison', '/synthetic/one.json');
    harness.render().find(node => node.type === Button && !node.props['data-copy-skill'])?.props.onClick?.();
    harness.change('guided-comparison', '/synthetic/two.json');
    const completed = response.then(() => undefined);
    resolve(inspectedComparison);
    await completed;
    expect(harness.render().find(node => node.props.id === 'guided-template-id')?.props.value).toBe('');
    expect(harness.render().some(node => node.props['data-comparison-inspected'] === '')).toBe(false);
  } finally { harness.restore(); }
});

const bundleInput = {
  comparison_path: '/synthetic/comparison.json', project_id: syntheticProject.id,
  profile: { id: 'bundle-setting' }, protocol: { id: 'protocol-one', schema_version: 2 },
  policy_status: { arm_a: 'eligible', arm_b: 'ineligible' },
};
function bundleFile(input: unknown = bundleInput) {
  return { name: 'measurement-setup.json', text: () => Promise.resolve(JSON.stringify({ kind: 'harness-delta.measurement-setup', schema_version: 1, input })) };
}
function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('Promise not initialized'); };
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

test('one bundle fills all inputs and requests a read-only review without saving or a manual freeze time', async () => {
  const reviewed = deferred<void>();
  const perform = vi.fn().mockImplementation(() => { reviewed.resolve(); return Promise.resolve(inspectedComparison); });
  const harness = guidedHarness(perform);
  try {
    harness.change('guided-profile', '{"id":"old-draft"}');
    harness.change('guided-freeze', '2099-01-01T00:00:00Z');
    const file = bundleFile();
    harness.render().find(node => node.props.id === 'guided-bundle')?.props.onChange?.({ target: { value: '', files: [file] } });
    await reviewed.promise;
    expect(perform.mock.calls).toEqual([['/api/setup-review', bundleInput]]);
    expect(harness.render().find(node => node.props.id === 'guided-profile')?.props.value).toBe(JSON.stringify(bundleInput.profile, null, 2));
    expect(harness.render().find(node => node.props.id === 'guided-template-id')?.props.value).toBe('bundle-setting');
    expect(harness.render().find(node => node.props.id === 'guided-freeze')?.props.value).toBe('');
  } finally { harness.restore(); }
});

test.each([
  bundleFile({ ...bundleInput, project_id: 'another-project' }),
  { name: 'invalid.json', text: () => Promise.resolve('{') },
])('invalid or different-project bundles cannot replace the selected inputs or save', async file => {
  const perform = vi.fn();
  const harness = guidedHarness(perform);
  const text = file.text();
  try {
    harness.change('guided-profile', '{"id":"keep-this"}');
    harness.render().find(node => node.props.id === 'guided-bundle')?.props.onChange?.({ target: { value: '', files: [{ ...file, text: () => text }] } });
    await text;
    expect(perform).not.toHaveBeenCalled();
    expect(harness.render().find(node => node.props.id === 'guided-profile')?.props.value).toBe('{"id":"keep-this"}');
  } finally { harness.restore(); }
});

test('changing inputs invalidates a pending bundle before it can replace them', async () => {
  const text = deferred<string>();
  const perform = vi.fn();
  const harness = guidedHarness(perform);
  try {
    harness.render().find(node => node.props.id === 'guided-bundle')?.props.onChange?.({ target: { value: '', files: [{ name: 'pending.json', text: () => text.promise }] } });
    harness.change('guided-profile', '{"id":"newer-input"}');
    text.resolve(await bundleFile().text());
    await text.promise;
    expect(perform).not.toHaveBeenCalled();
    expect(harness.render().find(node => node.props.id === 'guided-profile')?.props.value).toBe('{"id":"newer-input"}');
  } finally { harness.restore(); }
});

test('ready review needs confirmation and the matching application method before one save returns the connected setup', async () => {
  const fixture = setupReviewFixture();
  try {
    if (!fixture.domain.reviewSetup) throw new Error('Review unavailable');
    const review = await fixture.domain.reviewSetup(fixture.input);
    if (!review.ready) throw new Error('Synthetic review failed');
    const bound = { imported: true, already_connected: false, profile_id: 'shared-reviewed', local_setup_path: '.harness-delta/setup/synthetic.json' };
    const saved = deferred<unknown>();
    const onSaved = vi.fn((value: unknown) => saved.resolve(value));
    const perform = vi.fn().mockResolvedValueOnce(review).mockResolvedValueOnce(bound);
    const harness = guidedHarness(perform, onSaved, { ...syntheticProject, id: review.protocol.project_id });
    try {
      harness.change('guided-comparison', fixture.input.comparison_path);
      harness.render().find(node => node.type === Button && !node.props['data-copy-skill'])?.props.onClick?.();
      await perform.mock.results[0]?.value;
      expect(harness.render().find(node => node.props['data-setup-save'] === '')?.props.disabled).toBe(true);
      harness.render().find(node => node.props.id === 'guided-confirm')?.props.onChange?.({ target: { value: '', checked: true } });
      const save = () => harness.render().find(node => node.props['data-setup-save'] === '');
      expect(save()?.props.disabled).toBe(true);
      harness.change('guided-mode-agent_applied', '');
      expect(save()?.props.disabled).toBe(true);
      harness.change('guided-mode-selected_markdown_only', '');
      const action = save();
      expect(action?.props.disabled).toBe(false);
      action?.props.onClick?.();
      expect(await saved.promise).toEqual(bound);
      expect(perform.mock.calls.map(call => call[0])).toEqual(['/api/setup-review', '/api/setup-save-reviewed']);
      expect(perform.mock.calls[1]?.[1]).toEqual({ token: review.token });
      expect(onSaved).toHaveBeenCalledTimes(1);
      expect(harness.render().some(node => node.props['data-setup-review'] === 'ready')).toBe(false);
    } finally { harness.restore(); }
  } finally { await fixture.domain.close?.(); fixture.cleanup(); }
});

test('a ready review for a different project cannot expose confirmation or saving', async () => {
  const fixture = setupReviewFixture();
  try {
    if (!fixture.domain.reviewSetup) throw new Error('Review unavailable');
    const review = await fixture.domain.reviewSetup(fixture.input);
    const perform = vi.fn().mockResolvedValue(review);
    const harness = guidedHarness(perform);
    try {
      harness.change('guided-comparison', fixture.input.comparison_path);
      harness.render().find(node => node.type === Button && !node.props['data-copy-skill'])?.props.onClick?.();
      await perform.mock.results[0]?.value;
      expect(harness.render().some(node => node.props.id === 'guided-confirm' || node.props['data-setup-save'] === '')).toBe(false);
    } finally { harness.restore(); }
  } finally { await fixture.domain.close?.(); fixture.cleanup(); }
});

test('effect-study thresholds are visible while functional pilots omit them', async () => {
  const fixture = setupReviewFixture();
  try {
    if (!fixture.domain.reviewSetup) throw new Error('Review unavailable');
    const review = await fixture.domain.reviewSetup(fixture.input);
    if (!review.ready) throw new Error('Synthetic review failed');
    const experiment = { ...review, protocol: { ...review.protocol, purpose: 'real_experiment' as const, minimum_effect: 0.123, quality_margin: 0.045, confidence_level: 0.987 } };
    const markup = renderToStaticMarkup(createElement(MeasurementReview, { review: experiment, projectName: 'Synthetic', locale: 'ko' }));
    for (const [key, value] of [['minimum_effect', '0.123'], ['quality_margin', '0.045'], ['confidence_level', '0.987']])
      expect(markup).toContain(`data-metric="${key}">${value}</dd>`);
    expect([...markup.matchAll(/<time datetime="([^"]+)"/gi)].map(match => match[1])).toEqual([review.protocol.recruitment_start, review.protocol.recruitment_end]);
    const pilot = { ...experiment, protocol: { ...experiment.protocol, purpose: 'functional_pilot' as const } };
    const pilotMarkup = renderToStaticMarkup(createElement(MeasurementReview, { review: pilot, projectName: 'Synthetic', locale: 'ko' }));
    expect(pilotMarkup).not.toContain('data-metric=');
  } finally { await fixture.domain.close?.(); fixture.cleanup(); }
});

test('the chosen application method is checked against the comparison file and a different file is flagged', async () => {
  const perform = vi.fn().mockResolvedValue(inspectedComparison);
  const harness = guidedHarness(perform);
  try {
    harness.change('guided-mode-agent_applied', '');
    harness.change('guided-comparison', '/synthetic/comparison.json');
    harness.render().find(node => node.type === Button && !node.props['data-copy-skill'])?.props.onClick?.();
    await perform.mock.results[0]?.value;
    expect(perform.mock.calls[0]?.[1]).toEqual({ comparison_path: '/synthetic/comparison.json', project_id: syntheticProject.id, application_mode: 'agent_applied' });
    expect(harness.render().some(node => node.props['data-application-mode-mismatch'] === '')).toBe(true);
    harness.change('guided-mode-selected_markdown_only', '');
    expect(harness.render().some(node => node.props['data-application-mode-mismatch'] === '')).toBe(false);
  } finally { harness.restore(); }
});

test('a loaded bundle never chooses or replaces the application method and a differing choice stays flagged', async () => {
  let reviewed = deferred<void>();
  const perform = vi.fn().mockImplementation(() => { reviewed.resolve(); return Promise.resolve(inspectedComparison); });
  const harness = guidedHarness(perform);
  const input = { ...bundleInput, application_mode: 'selected_markdown_only' };
  const checked = () => ['selected_markdown_only', 'agent_applied'].filter(mode => harness.render().find(node => node.props.id === `guided-mode-${mode}`)?.props.checked);
  const load = async () => {
    reviewed = deferred<void>();
    harness.render().find(node => node.props.id === 'guided-bundle')?.props.onChange?.({ target: { value: '', files: [bundleFile(input)] } });
    await reviewed.promise; await perform.mock.results.at(-1)?.value;
  };
  try {
    await load();
    expect(checked()).toEqual([]);
    harness.change('guided-mode-agent_applied', '');
    await load();
    expect(perform.mock.calls).toEqual([['/api/setup-review', input], ['/api/setup-review', input]]);
    expect(checked()).toEqual(['agent_applied']);
    expect(harness.render().some(node => node.props['data-application-mode-mismatch'] === '')).toBe(true);
  } finally { harness.restore(); }
});
