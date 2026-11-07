import { type DependencyList, type EffectCallback, isValidElement, type ReactNode, useEffect, useRef, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, test, vi } from 'vitest';
import { CodexModeSetup, OrdinaryObservationSetup } from './OrdinaryObservationSetup';
import { ClaudeConnection, ordinaryWindowReason } from './ClaudeConnection';
import type { Locale, OrdinarySetup, Task } from './types';
import * as api from './api';

vi.mock('./api', async importOriginal => ({
  ...(await importOriginal<typeof import('./api')>()),
  mutate: vi.fn()
}));

vi.mock('react', async importOriginal => {
  const react = await importOriginal<typeof import('react')>();
  return {
    ...react,
    useState: vi.fn(react.useState),
    useRef: vi.fn(react.useRef),
    useEffect: vi.fn(react.useEffect)
  };
});
afterEach(() => {
  vi.mocked(useState).mockReset();
  vi.mocked(useEffect).mockReset();
  vi.mocked(useRef).mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test.each(['en', 'ko'] as const)('installation provenance and blocker codes remain in closed %s diagnostics', locale => {
  const status: OrdinarySetup = {
    project_id: 'synthetic-project',
    configured: true,
    product: 'claude_code',
    product_version: 'synthetic-version',
    installation: {
      state: 'blocked',
      source: 'available',
      packageHash: null,
      installedHash: null,
      destination: '/synthetic/package-destination',
      receiptDirectory: '/synthetic/receipt-directory',
      hookRegistration: 'unverified',
      blockers: ['installation_recovery_required']
    },
    admission: {
      profile_id: 'synthetic-profile',
      admitted: true,
      qualified: false,
      max_family_members: 8,
      model_family: 'claude'
    }
  };
  let stateIndex = 0;
  vi.mocked(useState).mockImplementation((initial?: unknown) => [stateIndex++ === 0 ? status : initial, () => undefined]);
  vi.mocked(useEffect).mockImplementation(() => undefined);
  vi.mocked(useRef).mockReturnValue({ current: 0 });
  const markup = renderToStaticMarkup(
    OrdinaryObservationSetup({
      projectId: status.project_id,
      locale,
      busy: false,
      perform: () => Promise.resolve(null)
    })
  );
  const disclosures = [...markup.matchAll(/<details\b([^>]*)>([\s\S]*?)<\/details>/g)];
  expect(disclosures).toHaveLength(1);
  expect(disclosures[0]?.[1]).not.toMatch(/\bopen\b/);
  const primary = markup.replace(/<details\b[^>]*>[\s\S]*?<\/details>/g, '');
  for (const value of [status.installation.destination, status.installation.receiptDirectory, status.installation.hookRegistration]) {
    expect(disclosures[0]?.[2]).toContain(value);
    expect(primary).not.toContain(value);
  }
  expect(disclosures[0]?.[2]).toContain('<code>installation_recovery_required</code>');
  expect(primary).not.toContain('<code>installation_recovery_required</code>');
  expect(primary).toContain('role="alert"');
  expect(primary).toContain('data-admission="true"');
  expect(primary).not.toContain(status.product_version);
});

test.each(['en', 'ko'] as const)('Codex window %s renders a disabled collection notice without activation controls', locale => {
  const markup = renderToStaticMarkup(
    CodexModeSetup({
      mode: 'ordinary_window',
      version: '1.9.0',
      disabled: true,
      locale,
      onModeChange: () => undefined,
      onVersionChange: () => undefined
    })
  );
  expect(markup).toContain('data-codex-window-collection="disabled"');
  expect(markup).toContain('data-codex-version="ordinary_window"');
  expect(markup).toContain('value="1.9.0"');
  expect([...markup.matchAll(/<button\b([^>]*)>/g)].map(match => match[1])).toEqual([expect.stringContaining('disabled'), expect.stringContaining('disabled')]);
  expect([...markup.matchAll(/<input\b([^>]*)>/g)].map(match => match[1])).toEqual([expect.stringContaining('disabled')]);
  expect(markup).not.toMatch(/data-(?:admission|qualified|activate|active-support)/);
});

function setup(window = false): OrdinarySetup {
  return {
    project_id: 'project',
    configured: true,
    product: 'claude_code',
    product_version: window ? '2.1.307' : '2.1.306',
    ...(window
      ? {
          bundle_mode: 'ordinary_window' as const,
          window: {
            policy_id: 'claude-binding-root-window-v1' as const,
            policy_revision: 'claude-ordinary-root-window-v1' as const,
            evidence_mode: 'publisher_verified_local_pin' as const,
            collection_enabled: false as const,
            reason: 'binding_window_activation_required'
          }
        }
      : {}),
    installation: {
      state: 'installed',
      source: 'available',
      packageHash: 'package',
      installedHash: 'installed',
      destination: '/synthetic/destination',
      receiptDirectory: '/synthetic/receipts',
      hookRegistration: 'unverified',
      blockers: []
    },
    admission: {
      profile_id: 'synthetic-profile',
      admitted: !window,
      qualified: false,
      max_family_members: 1,
      model_family: 'claude'
    }
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('Uninitialized');
  };
  const promise = new Promise<T>(ready => {
    resolve = ready;
  });
  return { promise, resolve };
}

type Control = {
  children?: ReactNode;
  disabled?: boolean;
  value?: string;
  'aria-pressed'?: boolean;
  'data-claude-mode'?: string;
  'data-claude-action'?: string;
  'data-claude-version'?: string;
  'data-install-choice'?: string;
  'data-install-preview'?: string;
  onClick?: () => void;
  onChange?: (event: { target: { value: string } }) => void;
};
function controls(node: unknown): { type: unknown; props: Control }[] {
  if (Array.isArray(node)) return node.flatMap(controls);
  if (!isValidElement<Control>(node)) return [];
  if (typeof node.type === 'function') {
    const rendered: unknown = Reflect.apply(node.type, undefined, [node.props]);
    return controls(rendered);
  }
  return [node, ...controls(node.props.children)];
}

function harness(locale: Locale = 'en') {
  let projectId = 'project';
  let busy = false;
  let stateIndex = 0;
  let effectIndex = 0;
  const states: unknown[] = [];
  const generation = { current: 0 };
  const effects: {
    deps: DependencyList | undefined;
    run: EffectCallback;
    cleanup: ReturnType<EffectCallback>;
    pending: boolean;
  }[] = [];
  const subscribers = new Set<() => void>();
  const requests: {
    route: string;
    signal: AbortSignal | null | undefined;
    response: ReturnType<typeof deferred<Response>>;
    json: ReturnType<typeof deferred<OrdinarySetup>>;
  }[] = [];
  const perform = vi.mocked(api.mutate).mockReset().mockResolvedValue(null);
  vi.stubGlobal(
    'fetch',
    vi.fn((route: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const response = deferred<Response>();
      const json = deferred<OrdinarySetup>();
      requests.push({
        route: String(route),
        signal: init?.signal,
        response,
        json
      });
      return response.promise;
    })
  );
  vi.mocked(useRef).mockReturnValue(generation);
  vi.mocked(useState).mockImplementation((initial?: unknown) => {
    const index = stateIndex++;
    if (index === states.length) states.push(initial);
    return [
      states[index],
      (value: unknown) => {
        states[index] = value;
        for (const notify of subscribers) notify();
      }
    ];
  });
  vi.mocked(useEffect).mockImplementation((run, deps) => {
    const index = effectIndex++;
    const previous = effects[index];
    if (!previous || deps?.some((value, key) => !Object.is(value, previous.deps?.[key]))) {
      effects[index] = {
        deps,
        run,
        cleanup: previous?.cleanup,
        pending: true
      };
    }
  });
  function render() {
    stateIndex = 0;
    effectIndex = 0;
    return OrdinaryObservationSetup({
      projectId,
      locale,
      busy,
      perform: api.mutate
    });
  }
  function nodes() {
    return controls(render());
  }
  function flush() {
    render();
    for (const effect of effects) {
      if (!effect.pending) continue;
      effect.pending = false;
      if (typeof effect.cleanup === 'function') effect.cleanup();
      effect.cleanup = effect.run();
    }
    return nodes();
  }
  function waitFor(predicate: () => boolean) {
    return new Promise<void>((resolve, reject) => {
      const check = () => {
        if (!predicate()) return;
        clearTimeout(timer);
        subscribers.delete(check);
        resolve();
      };
      const timer = setTimeout(() => {
        subscribers.delete(check);
        reject(new Error('State transition timed out'));
      }, 1000);
      subscribers.add(check);
      check();
    });
  }
  return {
    nodes,
    render,
    flush,
    waitFor,
    perform,
    requests,
    click(attribute: 'data-claude-mode' | 'data-claude-action' | 'data-install-choice', value: string) {
      const node = nodes().find(candidate => candidate.props[attribute] === value);
      if (!node?.props.onClick || node.props.disabled) {
        throw new Error('Unavailable control');
      }
      node.props.onClick();
    },
    version(value: string) {
      const node = nodes().find(candidate => candidate.props['data-claude-version']);
      if (!node?.props.onChange || node.props.disabled) {
        throw new Error('Unavailable version input');
      }
      node.props.onChange({ target: { value } });
    },
    respond(index: number, body: OrdinarySetup) {
      const request = requests[index];
      if (!request) throw new Error('Missing request');
      const reply = new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
      vi.spyOn(reply, 'json').mockImplementation(() => request.json.promise);
      request.response.resolve(reply);
      request.json.resolve(body);
    },
    project(value: string) {
      projectId = value;
      flush();
    },
    busy(value: boolean) {
      busy = value;
    }
  };
}

async function load(h: ReturnType<typeof harness>, status: OrdinarySetup) {
  h.flush();
  const ready = h.waitFor(() => h.nodes().find(node => node.props['data-claude-mode'] === 'exact')?.props.disabled === false);
  h.respond(0, status);
  await ready;
}

test.each([false, true])('configure omits unchanged stored mode, window=%s', async window => {
  const h = harness();
  const initial = setup(window);
  initial.configured = window;
  await load(h, initial);
  if (window) h.version('2.1.308');
  const saved = {
    ...initial,
    configured: true,
    product_version: window ? '2.1.308' : initial.product_version
  };
  h.perform.mockResolvedValueOnce(saved);
  const ready = h.waitFor(
    () =>
      h.nodes().find(node => node.props['data-claude-action'] === 'configure')?.props.disabled === true &&
      h.nodes().find(node => node.props['data-claude-mode'] === 'exact')?.props.disabled === false
  );
  h.click('data-claude-action', 'configure');
  expect(h.perform).toHaveBeenLastCalledWith('/api/projects/project/ordinary-setup', {
    operation: 'configure',
    product_version: saved.product_version
  });
  await ready;
  expect(h.nodes().find(node => node.props['data-claude-mode'] === (window ? 'ordinary_window' : 'exact'))?.props['aria-pressed']).toBe(true);
});

test.each([false, true])('switching mode requires an explicit stable version, from window=%s', async window => {
  const h = harness();
  await load(h, setup(window));
  const mode = window ? 'exact' : 'ordinary_window';
  h.click('data-claude-mode', mode);
  expect(h.nodes().find(node => node.props['data-claude-version'])?.props.value).toBe('');
  expect(h.nodes().find(node => node.props['data-claude-action'] === 'configure')?.props.disabled).toBe(true);
  for (const version of ['2.1.308-beta', '02.1.308', '2.1']) {
    h.version(version);
    expect(h.nodes().find(node => node.props['data-claude-action'] === 'configure')?.props.disabled).toBe(true);
  }
  h.version(window ? '2.1.306' : '2.1.308');
  expect(
    h
      .nodes()
      .filter(node => ['preview-install', 'preview-remove'].includes(node.props['data-claude-action'] ?? ''))
      .map(node => node.props.disabled)
  ).toEqual([true, true]);
  h.busy(true);
  expect(h.nodes().find(node => node.props['data-claude-version'])?.props.disabled).toBe(true);
  h.busy(false);
  expect(h.perform).not.toHaveBeenCalled();
  const saved = {
    ...setup(!window),
    product_version: window ? '2.1.306' : '2.1.308'
  };
  h.perform.mockResolvedValueOnce(saved);
  const ready = h.waitFor(
    () =>
      h.nodes().find(node => node.props['data-claude-action'] === 'configure')?.props.disabled === true &&
      h.nodes().find(node => node.props['data-claude-mode'] === mode)?.props.disabled === false
  );
  h.click('data-claude-action', 'configure');
  expect(h.perform).toHaveBeenLastCalledWith('/api/projects/project/ordinary-setup', {
    operation: 'configure',
    bundle_mode: mode,
    product_version: saved.product_version
  });
  await ready;
  expect(h.nodes().find(node => node.props['data-claude-mode'] === mode)?.props['aria-pressed']).toBe(true);
});

test.each(['mode', 'version'] as const)('editing window %s discards preview and requires saving before another preview', async change => {
  const h = harness();
  const status = setup(true);
  await load(h, status);
  h.perform.mockResolvedValueOnce({
    ...status,
    changes: [
      {
        path: 'hook.mjs',
        action: 'update',
        beforeHash: 'old',
        afterHash: 'new'
      }
    ]
  });
  const ready = h.waitFor(() => h.nodes().some(node => node.props['data-install-choice'] === 'install'));
  h.click('data-claude-action', 'preview-install');
  await ready;
  if (change === 'mode') h.click('data-claude-mode', 'exact');
  else h.version('2.1.308');
  expect(h.nodes().some(node => node.props['data-install-preview'] || node.props['data-install-choice'])).toBe(false);
  expect(h.nodes().find(node => node.props['data-claude-action'] === 'preview-install')?.props.disabled).toBe(true);
  expect(h.perform).toHaveBeenCalledTimes(1);
});

test.each([false, true])('a previous project preview readback cannot replace the current project, window=%s', async window => {
  const h = harness();
  const first = setup(window);
  await load(h, first);
  const pending = deferred<OrdinarySetup | null>();
  h.perform.mockReturnValueOnce(pending.promise);
  h.click('data-claude-action', 'preview-install');
  h.project('other');
  expect(h.nodes().some(node => node.props['data-install-choice'])).toBe(false);
  const ready = h.waitFor(() => h.nodes().find(node => node.props['data-claude-mode'] === 'exact')?.props.disabled === false);
  h.respond(1, { ...setup(), project_id: 'other' });
  await ready;
  pending.resolve({
    ...first,
    changes: [
      {
        path: 'stale.mjs',
        action: 'create',
        beforeHash: null,
        afterHash: 'stale'
      }
    ]
  });
  await pending.promise;
  expect(h.nodes().some(node => node.props['data-install-preview'])).toBe(false);
  expect(h.nodes().find(node => node.props['data-claude-mode'] === 'exact')?.props['aria-pressed']).toBe(true);
});

test.each([
  { window: false, operation: 'install' },
  { window: false, operation: 'remove' },
  { window: true, operation: 'install' },
  { window: true, operation: 'remove' }
] as const)('reviewed $operation pins hashes without changing stored mode, window=$window', async ({ window, operation }) => {
  const h = harness();
  const status = setup(window);
  await load(h, status);
  h.perform.mockResolvedValueOnce({
    ...status,
    changes: [
      {
        path: 'hook.mjs',
        action: operation === 'install' ? 'update' : 'delete',
        beforeHash: 'installed',
        afterHash: operation === 'install' ? 'updated' : null
      }
    ]
  });
  const previewed = h.waitFor(() => h.nodes().find(node => node.props['data-install-choice'] === operation)?.props.disabled === false);
  h.click('data-claude-action', `preview-${operation}`);
  await previewed;
  expect(h.perform).toHaveBeenLastCalledWith('/api/projects/project/ordinary-setup', { operation: `preview-${operation}` });
  const pending = deferred<OrdinarySetup | null>();
  h.perform.mockReturnValueOnce(pending.promise);
  const applied = h.waitFor(
    () =>
      !h.nodes().some(node => node.props['data-install-preview']) &&
      h.nodes().find(node => node.props['data-claude-mode'] === 'exact')?.props.disabled === false
  );
  h.click('data-install-choice', operation);
  expect(h.perform).toHaveBeenLastCalledWith('/api/projects/project/ordinary-setup', {
    operation,
    expected_package_hash: 'package',
    expected_installed_hash: 'installed'
  });
  pending.resolve(status);
  await applied;
  expect(h.nodes().find(node => node.props['data-claude-mode'] === (window ? 'ordinary_window' : 'exact'))?.props['aria-pressed']).toBe(true);
});

test('a late initial GET is ignored after a project switch', async () => {
  const h = harness();
  h.flush();
  h.project('other');
  expect(h.requests[0]?.signal?.aborted).toBe(true);
  const ready = h.waitFor(() => h.nodes().find(node => node.props['data-claude-mode'] === 'exact')?.props.disabled === false);
  h.respond(1, { ...setup(), project_id: 'other' });
  await ready;
  const stale = h.requests[0];
  if (!stale) throw new Error('Missing initial GET');
  h.respond(0, setup(true));
  await stale.response.promise;
  await stale.json.promise;
  expect(h.nodes().find(node => node.props['data-claude-mode'] === 'exact')?.props['aria-pressed']).toBe(true);
});

test.each(['en', 'ko'] as const)('window reasons and blockers never leak codes in %s markup', async locale => {
  const h = harness(locale);
  const status = setup(true);
  const raw = 'SYNTHETIC_PRIVATE_REASON_DO_NOT_RENDER';
  if (status.window) status.window = { ...status.window, reason: raw };
  status.installation.blockers = [raw, 'installation_recovery_required'];
  await load(h, status);
  const markup = renderToStaticMarkup(h.render());
  expect(markup).not.toContain(raw);
  expect(markup).not.toContain('installation_recovery_required');
  expect(markup).not.toMatch(/data-(?:admission|qualified|activate|active-support)=/);
  expect(markup).toContain('data-window-collection="disabled"');
  expect(ordinaryWindowReason('binding_scope_revoked', locale)).not.toBe(ordinaryWindowReason(raw, locale));
  expect(ordinaryWindowReason('binding_scope_mismatch', locale)).not.toBe(ordinaryWindowReason('binding_scope_revoked', locale));
  expect(ordinaryWindowReason('__proto__', locale)).toBe(ordinaryWindowReason(raw, locale));
  expect(ordinaryWindowReason('binding_scope_revoked', 'en')).not.toBe(ordinaryWindowReason('binding_scope_revoked', 'ko'));
});

test.each(['codex', 'claude_code'] as const)('a closed %s window task offers no connection or activation controls', product => {
  vi.mocked(useState).mockImplementation((initial?: unknown) => [initial, () => undefined]);
  const task: Task = {
    id: 'task',
    name: 'Synthetic task',
    mode: 'ordinary',
    project_id: 'project',
    setup_id: 'synthetic',
    version: '"synthetic"',
    state: 'prepared',
    status: 'waiting_for_session',
    ordinary_window: {
      product,
      policy_id: 'synthetic-policy',
      policy_revision: 'synthetic-revision',
      evidence_mode: product === 'codex' ? 'source_only' : 'publisher_verified_local_pin',
      collection_enabled: false,
      reason: 'SYNTHETIC_PRIVATE_REASON_DO_NOT_RENDER'
    },
    measurement: {
      state: 'waiting_connection',
      active_ms: null,
      requests: null,
      window: { started_at: null, ends_at: null }
    },
    outcome: null,
    attempt: 1,
    preparation: {
      state: 'prepared',
      configuration_evidence: 'pinned',
      native_context_evidence: 'unverified',
      freshness_evidence: 'unverified',
      tool_use_evidence: 'unavailable'
    },
    price: {
      partial_amount: null,
      currency: 'USD',
      unpriced_events: 0,
      basis: null
    },
    actions: [{ code: 'session-connect', enabled: true, reason: null }],
    startup: null,
    criteria: [],
    source: null,
    reason: null
  };
  const action = vi.fn();
  const markup = renderToStaticMarkup(
    ClaudeConnection({
      task,
      projectName: 'Synthetic project',
      origin: 'http://localhost:3000',
      locale: 'en',
      busy: false,
      online: true,
      onAction: action,
      reason: code => code
    })
  );
  expect(markup).toContain('data-ordinary-window-task="task"');
  expect(markup).toContain('data-window-collection="disabled"');
  expect(markup).toContain(product === 'codex' ? 'Codex' : 'Claude');
  expect(markup).not.toContain(product === 'codex' ? 'Claude' : 'Codex');
  expect(markup).not.toContain('SYNTHETIC_PRIVATE_REASON_DO_NOT_RENDER');
  expect(markup).not.toMatch(/<button\b|data-connection-prompt|harness-connect/);
  expect(action).not.toHaveBeenCalled();
});
