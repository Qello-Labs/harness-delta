import { isValidElement, useEffect, useState, type DependencyList, type EffectCallback, type ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { HarnessApplication } from './HarnessApplication';
import type { Task } from './types';

vi.mock('react', async importOriginal => {
 const react = await importOriginal<typeof import('react')>();
 return { ...react, useState: vi.fn(react.useState), useEffect: vi.fn(react.useEffect) };
});
afterEach(() => { vi.mocked(useState).mockReset(); vi.mocked(useEffect).mockReset(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function deferred<T>() {
 let resolve: (value: T) => void = () => { throw new Error('Uninitialized response'); };
 const promise = new Promise<T>(complete => { resolve = complete; });
 return { promise, resolve };
}
const registered = { root: '/synthetic/registered', branch: 'main', head: 'a'.repeat(40), digest: 'b'.repeat(64) };
function task(): Task {
 return {
  id: 'task', name: 'Synthetic task', project_id: 'project', setup_id: 'setup', version: 'v1',
  state: 'registered', status: 'preparation_needed', outcome: null, attempt: 1, criteria: [], startup: null, source: null, reason: null,
  measurement: { state: 'waiting_connection', active_ms: null, requests: null, window: { started_at: null, ends_at: null } },
  preparation: { state: 'preparation_needed', configuration_evidence: 'unverified', native_context_evidence: 'unavailable', freshness_evidence: 'unavailable', tool_use_evidence: 'unavailable' },
  price: { partial_amount: null, currency: 'USD', unpriced_events: 0, basis: null },
  actions: [{ code: 'application-prepare', enabled: true, reason: null }],
  application: { workspace: registered.root, launchState: 'not_requested', identity: 'unavailable', state: 'awaiting_application',
   jobId: null, epoch: 0, reason: null, baseline: 'synthetic', capabilities: [] },
 };
}
type Control = {
 children?: ReactNode; id?: string; value?: string; disabled?: boolean; open?: boolean;
 'data-workspace-state'?: string; 'data-workspace-action'?: string; 'data-application-action'?: string;
 onClick?: () => void; onChange?: (event: { target: { value: string } }) => void;
};
function controls(node: ReactNode): { type: unknown; props: Control }[] {
 if (Array.isArray(node)) return node.flatMap(controls);
 if (!isValidElement<Control>(node)) return [];
 return [node, ...controls(node.props.children)];
}
function harness(initial = task()) {
 let current = initial; let busy = false; let stateIndex = 0; let effectIndex = 0;
 const states: unknown[] = [];
 const effects: { callback: EffectCallback; deps: DependencyList | undefined; cleanup: ReturnType<EffectCallback>; pending: boolean }[] = [];
 const subscribers = new Set<() => void>();
 const shownHandoffs = new Set<string>();
 const onApply = vi.fn<Parameters<typeof HarnessApplication>[0]['onApply']>().mockResolvedValue(undefined);
 const onAction = vi.fn<Parameters<typeof HarnessApplication>[0]['onAction']>().mockResolvedValue(undefined);
 const requests: { url: string; signal: AbortSignal | null | undefined; response: ReturnType<typeof deferred<Response>> }[] = [];
 vi.stubGlobal('fetch', vi.fn((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const response = deferred<Response>(); requests.push({ url: String(input), signal: init?.signal, response });
  return response.promise;
 }));
 vi.mocked(useState).mockImplementation((initial?: unknown) => {
  const index = stateIndex++; if (index === states.length) states.push(initial);
  return [states[index], (value: unknown) => {
   states[index] = typeof value === 'function' ? Reflect.apply(value, undefined, [states[index]]) : value;
   for (const notify of subscribers) notify();
  }];
 });
 vi.mocked(useEffect).mockImplementation((callback, deps) => {
  const index = effectIndex++; const previous = effects[index];
  if (!previous || !deps || !previous.deps || deps.some((value, key) => !Object.is(value, previous.deps?.[key])))
   effects[index] = { callback, deps, cleanup: previous?.cleanup, pending: true };
 });
 function render() { stateIndex = 0; effectIndex = 0; return HarnessApplication({ task: current, locale: 'en', busy, onApply, onAction, shownHandoffs }); }
 function nodes() { return controls(render()); }
 function flush() {
  render();
  for (const effect of effects) if (effect.pending) {
   effect.pending = false;
   if (typeof effect.cleanup === 'function') effect.cleanup();
   effect.cleanup = effect.callback();
  }
  return nodes();
 }
 function click(attribute: 'data-workspace-action' | 'data-application-action', action: string) {
  const control = nodes().find(node => node.props[attribute] === action);
  if (!control?.props.onClick || control.props.disabled) throw new Error(`Unavailable control: ${action}`);
  control.props.onClick();
 }
 function change(directory: string) {
  click('data-workspace-action', 'change');
  const input = nodes().find(node => node.props.id === 'application-target');
  if (!input?.props.onChange) throw new Error('Missing workspace input');
  input.props.onChange({ target: { value: directory } });
 }
 function waitFor(state: string) {
  return new Promise<void>((resolve, reject) => {
   const check = () => {
    if (nodes().some(node => node.props['data-workspace-state'] === state)) {
     clearTimeout(timer); subscribers.delete(check); resolve();
    }
   };
   const timer = setTimeout(() => { subscribers.delete(check); reject(new Error(`Workspace did not reach ${state}`)); }, 1000);
   subscribers.add(check); check();
  });
 }
 async function respond(index: number, value = registered, status = 200) {
  const request = requests[index]; if (!request) throw new Error('Missing workspace request');
  const settled = waitFor(status === 200 ? 'ready' : 'error');
  request.response.resolve(Response.json(value, { status })); await settled;
 }
 function applyDisabled() { return nodes().find(node => node.props['data-application-action'] === 'apply')?.props.disabled; }
 function dispose() { for (const effect of effects) if (typeof effect.cleanup === 'function') effect.cleanup(); subscribers.clear(); }
 return { nodes, flush, requests, click, change, respond, applyDisabled, onApply, onAction, dispose,
  update: (value: Task) => { current = value; }, setBusy: (value: boolean) => { busy = value; } };
}

test('automatically checks the registered workspace without exposing a path form or starting application', async () => {
 const h = harness();
 try {
  h.flush();
  expect(h.requests.map(request => request.url)).toEqual([`/api/tasks/task/application-workspace?directory=${encodeURIComponent(registered.root)}`]);
  expect(h.nodes().some(node => node.props.id === 'application-target')).toBe(false);
  expect(h.applyDisabled()).toBe(true);
  await h.respond(0);
  expect(h.applyDisabled()).toBe(false);
  expect(h.onApply).not.toHaveBeenCalled();
  expect(h.onAction).not.toHaveBeenCalled();
 } finally { h.dispose(); }
});

test('checks only a committed workspace change and carries its canonical root and digest into explicit confirmation', async () => {
 const h = harness(); const changed = { ...registered, root: '/synthetic/worktree', branch: 'topic', digest: 'c'.repeat(64) };
 try {
  h.flush(); await h.respond(0);
  h.change(`${changed.root}/`); h.flush();
  expect(h.requests).toHaveLength(1);
  expect(h.applyDisabled()).toBe(true);
  h.click('data-workspace-action', 'use'); h.flush();
  expect(h.requests).toHaveLength(2);
  expect(h.applyDisabled()).toBe(true);
  await h.respond(1, changed);
  expect(h.applyDisabled()).toBe(false);
  h.setBusy(true); expect(h.applyDisabled()).toBe(true); h.setBusy(false);
  h.click('data-application-action', 'apply');
  expect(h.onApply).not.toHaveBeenCalled();
  h.click('data-application-action', 'confirm');
  expect(h.onApply).toHaveBeenCalledExactlyOnceWith({ workspace: changed.root, workspaceDigest: changed.digest, product: 'codex' });
 } finally { h.dispose(); }
});

test('cancelling a workspace edit retains the checked default without another request', async () => {
 const h = harness();
 try {
  h.flush(); await h.respond(0);
  h.change('/synthetic/other');
  h.click('data-workspace-action', 'cancel'); h.flush();
  expect(h.requests).toHaveLength(1);
  expect(h.nodes().some(node => node.props.id === 'application-target')).toBe(false);
  expect(h.applyDisabled()).toBe(false);
 } finally { h.dispose(); }
});

test('failed automatic inspection blocks application and retries the same workspace explicitly', async () => {
 const h = harness();
 try {
  h.flush(); await h.respond(0, registered, 400);
  expect(h.applyDisabled()).toBe(true);
  h.click('data-workspace-action', 'retry'); h.flush();
  expect(h.requests).toHaveLength(2);
  expect(h.requests[1]?.url).toBe(h.requests[0]?.url);
  expect(h.requests[0]?.signal?.aborted).toBe(true);
  await h.respond(1);
  expect(h.applyDisabled()).toBe(false);
 } finally { h.dispose(); }
});

test('an aborted earlier inspection cannot replace the selected workspace result', async () => {
 const h = harness(); const changed = { ...registered, root: '/synthetic/worktree', digest: 'c'.repeat(64) };
 try {
  h.flush();
  const earlier = h.requests[0]; if (!earlier) throw new Error('Missing initial request');
  h.change(changed.root); h.click('data-workspace-action', 'use'); h.flush();
  expect(earlier.signal?.aborted).toBe(true);
  await h.respond(1, changed);
  const decoding = deferred<void>(); const decoded = deferred<unknown>();
  const stale = Response.json(registered);
  vi.spyOn(stale, 'json').mockImplementation(() => { decoding.resolve(); return decoded.promise; });
  earlier.response.resolve(stale); await decoding.promise;
  decoded.resolve(registered); await decoded.promise;
  h.click('data-application-action', 'apply'); h.click('data-application-action', 'confirm');
  expect(h.onApply).toHaveBeenCalledExactlyOnceWith({ workspace: changed.root, workspaceDigest: changed.digest, product: 'codex' });
 } finally { h.dispose(); }
});

test('waits for preparation authority and uses a registered workspace supplied after preparation', async () => {
 const initial = task();
 if (!initial.application) throw new Error('Missing application fixture');
 initial.actions = []; initial.application.workspace = null;
 const h = harness(initial);
 try {
  h.flush(); expect(h.requests).toHaveLength(0);
  h.update(task()); h.flush();
  expect(h.requests).toHaveLength(1);
  await h.respond(0);
  expect(h.applyDisabled()).toBe(false);
 } finally { h.dispose(); }
});
