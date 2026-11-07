import { type DependencyList, type EffectCallback, isValidElement, type ReactNode, useEffect, useRef, useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentConnectionSetup } from './AgentConnectionSetup';
import { CodexExactVersionSetup, CodexModeSetup, OrdinaryObservationSetup } from './OrdinaryObservationSetup';
import type { CodexSetup, Locale } from './types';
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
  vi.mocked(useRef).mockReset();
  vi.mocked(useEffect).mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('Uninitialized');
  };
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

function codexSetup(overrides: Partial<CodexSetup> = {}): CodexSetup {
  return {
    project_id: 'project',
    configured: false,
    product: 'codex',
    product_version: '1.0.0',
    available_versions: ['1.0.0', '1.1.0'],
    unqualified_versions: [],
    source_roots: ['/synthetic/root'],
    installation: {
      state: 'absent',
      source: 'available',
      packageHash: null,
      installedHash: null,
      destination: '/dest',
      receiptDirectory: '/receipt',
      hookRegistration: 'unverified',
      blockers: []
    },
    readiness: {
      receipt_directory: 'missing',
      provider: 'blocked',
      reason: 'receipt_directory_missing',
      hook_trust: 'manual_confirmation_required',
      requires_new_session: true
    },
    connection: { roots: 0, observing: 0 },
    admission: {
      profile_id: 'profile',
      qualified: false,
      max_family_members: 5
    },
    ...overrides
  };
}

type Control = {
  children?: ReactNode;
  id?: string;
  value?: string;
  disabled?: boolean;
  'aria-pressed'?: boolean | 'true' | 'false';
  'data-product'?: string;
  'data-codex-action'?: string;
  'data-codex-choice'?: string;
  'data-codex-mode'?: string;
  'data-codex-version'?: string;
  'data-codex-window-collection'?: string;
  'data-codex-configured'?: string;
  'data-codex-preview'?: string;
  'data-installation-state'?: string;
  'data-agent-setup'?: string;
  'data-readiness-reason'?: string;
  onClick?: () => void;
  onChange?: (event: { target: { value: string } }) => void;
  role?: string;
  type?: unknown;
};
function controls(node: ReactNode): { type: unknown; props: Control }[] {
  if (Array.isArray(node)) return node.flatMap(controls);
  if (isValidElement<Parameters<typeof CodexModeSetup>[0]>(node) && node.type === CodexModeSetup) return controls(CodexModeSetup(node.props));
  if (isValidElement<Parameters<typeof CodexExactVersionSetup>[0]>(node) && node.type === CodexExactVersionSetup)
    return controls(CodexExactVersionSetup(node.props));
  if (!isValidElement<Control>(node)) return [];
  return [node, ...controls(node.props.children)];
}

function waitFor(subscribers: Set<() => void>, predicate: () => boolean) {
  return new Promise<void>((resolve, reject) => {
    const check = () => {
      if (predicate()) {
        clearTimeout(timer);
        subscribers.delete(check);
        resolve();
      }
    };
    const timer = setTimeout(() => {
      subscribers.delete(check);
      reject(new Error('waitFor timed out'));
    }, 1000);
    subscribers.add(check);
    check();
  });
}

function harness(projectId = 'project', locale: Locale = 'en') {
  let busy = false;
  let stateIndex = 0;
  let effectIndex = 0;
  let refIndex = 0;
  const refs: { current: unknown }[] = [];
  const states: unknown[] = [];
  const effects: {
    callback: EffectCallback;
    deps: DependencyList | undefined;
    cleanup: ReturnType<EffectCallback>;
    pending: boolean;
  }[] = [];
  const subscribers = new Set<() => void>();
  const perform = vi.mocked(api.mutate).mockReset().mockResolvedValue(null);
  const requests: {
    url: string;
    signal: AbortSignal | null | undefined;
    response: ReturnType<typeof deferred<Response>>;
  }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const response = deferred<Response>();
      requests.push({
        url: String(input),
        signal: init?.signal,
        response
      });
      for (const notify of subscribers) notify();
      return response.promise;
    })
  );
  vi.mocked(useState).mockImplementation((initial?: unknown) => {
    const index = stateIndex++;
    if (index === states.length) states.push(initial);
    return [
      states[index],
      (value: unknown) => {
        states[index] = typeof value === 'function' ? Reflect.apply(value, undefined, [states[index]]) : value;
        for (const notify of subscribers) notify();
      }
    ];
  });
  vi.mocked(useEffect).mockImplementation((callback, deps) => {
    const index = effectIndex++;
    const previous = effects[index];
    if (!previous || !deps || !previous.deps || deps.some((value, key) => !Object.is(value, previous.deps?.[key]))) {
      effects[index] = {
        callback,
        deps,
        cleanup: previous?.cleanup,
        pending: true
      };
    }
  });
  vi.mocked(useRef).mockImplementation((initial: unknown) => (refs[refIndex++] ??= { current: initial }));
  function render() {
    stateIndex = 0;
    effectIndex = 0;
    refIndex = 0;
    return AgentConnectionSetup({
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
      if (effect.pending) {
        effect.pending = false;
        if (typeof effect.cleanup === 'function') effect.cleanup();
        effect.cleanup = effect.callback();
      }
    }
    return nodes();
  }
  function click(attribute: 'data-product' | 'data-codex-action' | 'data-codex-choice' | 'data-codex-mode', value: string) {
    const control = nodes().find(node => node.props[attribute] === value);
    if (!control?.props.onClick || control.props.disabled) {
      throw new Error(`Unavailable control: ${attribute}=${value}`);
    }
    control.props.onClick();
  }

  function respondFetch(index: number, body: unknown) {
    const request = requests[index];
    if (!request) throw new Error('Missing fetch request');
    request.response.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
  }
  function failFetch(index: number) {
    const request = requests[index];
    if (!request) throw new Error('Missing fetch request');
    request.response.resolve(
      new Response('{"error":"unknown_project"}', {
        status: 500,
        headers: { 'content-type': 'application/json' }
      })
    );
  }
  function selectVersion(value: string) {
    const control = nodes().find(node => node.type === 'select' || node.props['data-codex-version'] === 'ordinary_window');
    if (!control?.props.onChange || control.props.disabled) {
      throw new Error('Unavailable version selector');
    }
    control.props.onChange({ target: { value } });
  }
  return {
    render,
    nodes,
    flush,
    click,
    selectVersion,
    waitFor: (predicate: () => boolean) => waitFor(subscribers, predicate),
    respondFetch,
    failFetch,
    perform,
    requests,
    setBusy: (value: boolean) => {
      busy = value;
    },
    selectProject: (id: string) => {
      projectId = id;
      flush();
    }
  };
}

test('defaults to Codex product selector with aria-pressed', () => {
  const h = harness();
  const all = h.nodes();
  const codexBtn = all.find(n => n.props['data-product'] === 'codex');
  const claudeBtn = all.find(n => n.props['data-product'] === 'claude_code');
  expect(codexBtn).toBeDefined();
  expect(claudeBtn).toBeDefined();
  expect(String(codexBtn!.props['aria-pressed'])).toBe('true');
  expect(String(claudeBtn!.props['aria-pressed'])).toBe('false');
});

test('switching to Claude Code shows OrdinaryObservationSetup', () => {
  const h = harness();
  h.click('data-product', 'claude_code');
  const all = h.nodes();
  const hasOrdinary = controls(h.render()).some(n => n.type === OrdinaryObservationSetup);
  expect(hasOrdinary).toBe(true);
  expect(String(all.find(n => n.props['data-product'] === 'claude_code')!.props['aria-pressed'])).toBe('true');
  expect(String(all.find(n => n.props['data-product'] === 'codex')!.props['aria-pressed'])).toBe('false');
});

test('Codex panel fetches setup on mount and displays status badges', async () => {
  const h = harness();
  h.flush();
  expect(h.requests.length).toBe(1);
  expect(h.requests[0]?.url).toContain('/codex-setup');
  const data = codexSetup({ configured: true });
  h.respondFetch(0, data);
  await h.waitFor(() => h.nodes().some(n => n.props['data-codex-configured'] === 'true'));
  const all = h.nodes();
  expect(all.find(n => n.props['data-installation-state'] === 'absent')).toBeDefined();
});

test('configure sends correct payload using GET defaults', async () => {
  const h = harness();
  const data = codexSetup();
  h.flush();
  h.respondFetch(0, data);
  await h.waitFor(() => h.nodes().some(n => n.props['data-codex-configured'] === 'false'));
  const configureBtn = h.nodes().find(n => n.props['data-codex-action'] === 'configure');
  expect(configureBtn!.props.disabled).toBe(false);
  h.perform.mockResolvedValueOnce(codexSetup({ configured: true }));
  h.click('data-codex-action', 'configure');
  expect(h.perform).toHaveBeenCalledWith(expect.stringContaining('/codex-setup'), {
    operation: 'configure',
    product_version: '1.0.0',
    source_roots: ['/synthetic/root']
  });
});

test.each([false, true])('version selector retains the returned version when configured=%s', async configured => {
  const h = harness();
  const data = codexSetup({
    configured,
    available_versions: ['1.1.0', '1.0.0']
  });
  h.flush();
  h.respondFetch(0, data);
  await h.waitFor(() => h.nodes().some(n => n.type === 'select'));

  const selector = h.nodes().find(n => n.type === 'select');
  expect(selector?.props.value).toBe(data.product_version);
  expect(
    h
      .nodes()
      .filter(n => n.type === 'option')
      .map(n => n.props.value)
  ).toEqual(data.available_versions);
  expect(h.nodes().find(n => n.type === 'label')?.props.children).toContainEqual(expect.objectContaining({ type: 'select' }));
  expect(h.nodes().find(n => n.props['data-codex-action'] === 'configure')?.props.disabled).toBe(configured);
  expect(h.perform).not.toHaveBeenCalled();
});

function text(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (Array.isArray(node)) return node.map(text).join('');
  if (isValidElement<Parameters<typeof CodexModeSetup>[0]>(node) && node.type === CodexModeSetup) return text(CodexModeSetup(node.props));
  if (isValidElement<Parameters<typeof CodexExactVersionSetup>[0]>(node) && node.type === CodexExactVersionSetup)
    return text(CodexExactVersionSetup(node.props));
  return isValidElement<Control>(node) ? text(node.props.children) : '';
}

test.each([
  {
    locale: 'en' as const,
    suffix: 'unqualified candidate',
    notice: 'Unqualified candidate: qualified support is pending. Usage is labeled compatibility-unverified.'
  },
  {
    locale: 'ko' as const,
    suffix: '미검증 후보',
    notice: '미검증 후보: 지원 검증이 아직 끝나지 않았습니다. 사용량은 호환성 미검증으로 표시됩니다.'
  }
])('labels draft and saved unqualified versions in $locale while saving the bare version', async ({ locale, suffix, notice }) => {
  const h = harness('project', locale);
  const data = codexSetup({
    configured: true,
    product_version: '0.163.0',
    available_versions: ['0.162.1', '0.163.0', '0.166.0'],
    unqualified_versions: ['0.166.0']
  });
  h.flush();
  h.respondFetch(0, data);
  await h.waitFor(() => h.nodes().some(n => n.type === 'select'));
  expect(text(h.nodes().find(n => n.type === 'option' && n.props.value === '0.166.0')?.props.children)).toBe(`0.166.0 (${suffix})`);
  for (const version of ['0.162.1', '0.163.0']) {
    expect(text(h.nodes().find(n => n.type === 'option' && n.props.value === version)?.props.children)).toBe(version);
  }
  expect(text(h.render())).not.toContain(notice);

  h.selectVersion('0.166.0');
  expect(h.nodes().find(n => n.type === 'select')?.props.value).toBe('0.166.0');
  expect(h.nodes().filter(n => n.type === 'p' && text(n.props.children) === notice)).toHaveLength(1);
  h.perform.mockResolvedValueOnce({
    ...data,
    product_version: '0.166.0'
  });
  h.click('data-codex-action', 'configure');
  expect(h.perform).toHaveBeenLastCalledWith('/api/projects/project/codex-setup', {
    operation: 'configure',
    product_version: '0.166.0',
    source_roots: data.source_roots
  });
  await h.waitFor(
    () =>
      h.nodes().find(n => n.props['data-codex-action'] === 'configure')?.props.disabled === true &&
      h.nodes().find(n => n.type === 'select')?.props.disabled === false
  );
  expect(h.nodes().find(n => n.type === 'select')?.props.value).toBe('0.166.0');
  expect(h.nodes().filter(n => n.type === 'p' && text(n.props.children) === notice)).toHaveLength(1);

  h.selectVersion('0.163.0');
  expect(text(h.render())).not.toContain(notice);
  h.click('data-codex-action', 'refresh');
  h.respondFetch(1, { ...data, product_version: '0.166.0' });
  await h.waitFor(() => h.nodes().find(n => n.type === 'select')?.props.disabled === false);
  expect(h.nodes().find(n => n.type === 'select')?.props.value).toBe('0.163.0');
  expect(text(h.render())).not.toContain(notice);
});

test.each(['en', 'ko'] as const)('shows an unqualified saved version on initial load in %s', async locale => {
  const h = harness('project', locale);
  h.flush();
  h.respondFetch(
    0,
    codexSetup({
      configured: true,
      product_version: '0.166.0',
      available_versions: ['0.163.0', '0.166.0'],
      unqualified_versions: ['0.166.0']
    })
  );
  await h.waitFor(() => h.nodes().some(n => n.type === 'select'));
  expect(h.nodes().find(n => n.type === 'select')?.props.value).toBe('0.166.0');
  expect(text(h.nodes().find(n => n.type === 'option' && n.props.value === '0.166.0')?.props.children)).toBe(
    locale === 'en' ? '0.166.0 (unqualified candidate)' : '0.166.0 (미검증 후보)'
  );
  expect(h.nodes().filter(n => n.type === 'p' && text(n.props.children).startsWith(locale === 'en' ? 'Unqualified candidate:' : '미검증 후보:'))).toHaveLength(
    1
  );
  expect(h.perform).not.toHaveBeenCalled();
});

test('version changes require explicit configure and keep busy and reading guards', async () => {
  const h = harness();
  const data = codexSetup({ configured: true });
  h.flush();
  h.respondFetch(0, data);
  await h.waitFor(() => h.nodes().some(n => n.type === 'select'));

  h.selectVersion('1.1.0');
  expect(h.perform).not.toHaveBeenCalled();
  expect(h.nodes().find(n => n.props['data-codex-action'] === 'configure')?.props.disabled).toBe(false);
  h.selectVersion('1.0.0');
  expect(h.nodes().find(n => n.props['data-codex-action'] === 'configure')?.props.disabled).toBe(true);
  h.selectVersion('1.1.0');
  h.setBusy(true);
  expect(h.nodes().find(n => n.type === 'select')?.props.disabled).toBe(true);
  expect(h.nodes().find(n => n.props['data-codex-action'] === 'configure')?.props.disabled).toBe(true);
  h.setBusy(false);
  const pending = deferred<CodexSetup | null>();
  h.perform.mockReturnValueOnce(pending.promise);
  h.click('data-codex-action', 'configure');
  expect(h.perform).toHaveBeenLastCalledWith('/api/projects/project/codex-setup', {
    operation: 'configure',
    product_version: '1.1.0',
    source_roots: data.source_roots
  });
  expect(h.nodes().find(n => n.type === 'select')?.props.disabled).toBe(true);
  pending.resolve({ ...data, product_version: '1.1.0' });
  await h.waitFor(() => h.nodes().find(n => n.type === 'select')?.props.disabled === false);
  expect(h.nodes().find(n => n.type === 'select')?.props.value).toBe('1.1.0');
  expect(h.nodes().find(n => n.props['data-codex-action'] === 'configure')?.props.disabled).toBe(true);
});

test.each(['install', 'remove'] as const)('changing version clears %s preview without submitting the draft version', async operation => {
  const h = harness();
  const data = codexSetup({ configured: true });
  data.installation.installedHash = 'installed';
  h.flush();
  h.respondFetch(0, data);
  await h.waitFor(() => h.nodes().some(n => n.type === 'select'));
  const preview = {
    ...data,
    changes: [
      {
        path: 'hook.sh',
        action: 'update' as const,
        beforeHash: 'installed',
        afterHash: 'updated'
      }
    ]
  };
  h.perform.mockResolvedValueOnce(preview);
  h.click('data-codex-action', `preview-${operation}`);
  await h.waitFor(() => h.nodes().some(n => n.props['data-codex-preview'] === operation));

  h.selectVersion('1.1.0');
  expect(h.nodes().some(n => n.props['data-codex-preview'])).toBe(false);
  expect(h.nodes().some(n => n.props['data-codex-choice'])).toBe(false);
  expect(h.perform).toHaveBeenCalledTimes(1);
  h.perform.mockResolvedValueOnce(preview);
  h.click('data-codex-action', `preview-${operation}`);
  await h.waitFor(() => h.nodes().some(n => n.props['data-codex-preview'] === operation));
  expect(h.perform).toHaveBeenLastCalledWith('/api/projects/project/codex-setup', { operation: `preview-${operation}` });
  expect(h.nodes().find(n => n.type === 'select')?.props.value).toBe('1.1.0');
});

test('a saved version absent from admission choices stays selected without automatic replacement', async () => {
  const h = harness();
  h.flush();
  h.respondFetch(0, codexSetup({ configured: true, available_versions: ['1.1.0'] }));
  await h.waitFor(() => h.nodes().some(n => n.type === 'select'));

  expect(h.nodes().find(n => n.type === 'select')?.props.value).toBe('1.0.0');
  expect(h.nodes().find(n => n.type === 'option' && n.props.value === '1.0.0')?.props.disabled).toBe(true);
  expect(h.perform).not.toHaveBeenCalled();
});

test('preview-install then explicit apply pins hashes', async () => {
  const h = harness();
  const initial = codexSetup({
    configured: true,
    installation: {
      state: 'absent',
      source: 'available',
      packageHash: 'pkg-hash',
      installedHash: null,
      destination: '/dest',
      receiptDirectory: '/receipt',
      hookRegistration: 'unverified',
      blockers: []
    }
  });
  h.flush();
  h.respondFetch(0, initial);
  await h.waitFor(() => !h.nodes().find(n => n.props['data-codex-action'] === 'preview-install')?.props.disabled);
  const withChanges = {
    ...initial,
    changes: [
      {
        path: 'hook.sh',
        action: 'create' as const,
        beforeHash: null,
        afterHash: 'new-hash'
      }
    ]
  };
  h.perform.mockResolvedValueOnce(withChanges);
  h.click('data-codex-action', 'preview-install');
  await h.waitFor(() => h.nodes().some(n => n.props['data-codex-preview'] === 'install'));
  h.perform.mockResolvedValueOnce(
    codexSetup({
      configured: true,
      installation: {
        ...initial.installation,
        state: 'installed',
        installedHash: 'new-hash'
      }
    })
  );
  h.click('data-codex-choice', 'install');
  expect(h.perform).toHaveBeenLastCalledWith(
    expect.stringContaining('/codex-setup'),
    expect.objectContaining({
      operation: 'install',
      expected_package_hash: 'pkg-hash',
      expected_installed_hash: null
    })
  );
});

test('preview-remove then explicit remove pins installed hash', async () => {
  const h = harness();
  const initial = codexSetup({
    configured: true,
    installation: {
      state: 'installed',
      source: 'available',
      packageHash: 'pkg',
      installedHash: 'inst',
      destination: '/dest',
      receiptDirectory: '/receipt',
      hookRegistration: 'unverified',
      blockers: []
    }
  });
  h.flush();
  h.respondFetch(0, initial);
  await h.waitFor(() => !h.nodes().find(n => n.props['data-codex-action'] === 'preview-remove')?.props.disabled);
  const withChanges = {
    ...initial,
    changes: [
      {
        path: 'hook.sh',
        action: 'delete' as const,
        beforeHash: 'inst',
        afterHash: null
      }
    ]
  };
  h.perform.mockResolvedValueOnce(withChanges);
  h.click('data-codex-action', 'preview-remove');
  await h.waitFor(() => h.nodes().some(n => n.props['data-codex-preview'] === 'remove'));
  h.perform.mockResolvedValueOnce(
    codexSetup({
      configured: true,
      installation: {
        ...initial.installation,
        state: 'absent',
        installedHash: null
      }
    })
  );
  h.click('data-codex-choice', 'remove');
  expect(h.perform).toHaveBeenLastCalledWith(
    expect.stringContaining('/codex-setup'),
    expect.objectContaining({
      operation: 'remove',
      expected_package_hash: 'pkg',
      expected_installed_hash: 'inst'
    })
  );
});

test('blockers disable the apply button in preview', async () => {
  const h = harness();
  const blocked = codexSetup({
    configured: true,
    installation: {
      state: 'blocked',
      source: 'available',
      packageHash: 'pkg',
      installedHash: null,
      destination: '/dest',
      receiptDirectory: '/receipt',
      hookRegistration: 'unverified',
      blockers: ['external_preimage_unapproved']
    },
    changes: [
      {
        path: 'hook.sh',
        action: 'create',
        beforeHash: null,
        afterHash: 'h'
      }
    ]
  });
  h.flush();
  h.respondFetch(0, blocked);
  await h.waitFor(() => h.nodes().some(n => n.props['data-installation-state'] === 'blocked'));
  h.perform.mockResolvedValueOnce(blocked);
  h.click('data-codex-action', 'preview-install');
  await h.waitFor(() => h.nodes().some(n => n.props['data-codex-preview'] === 'install'));
  const applyBtn = h.nodes().find(n => n.props['data-codex-choice'] === 'install');
  expect(applyBtn!.props.disabled).toBe(true);
});

test('stale project resets Codex state', async () => {
  const h = harness('project-a');
  h.flush();
  const data = codexSetup({ project_id: 'project-a', configured: true });
  h.respondFetch(0, data);
  await h.waitFor(() => h.nodes().some(n => n.props['data-codex-configured'] === 'true'));
  h.selectVersion('1.1.0');
  h.selectProject('project-b');
  const loadingNodes = h.nodes();
  expect(loadingNodes.some(n => n.props.role === 'status')).toBe(true);
  expect(loadingNodes.some(n => n.props['data-codex-configured'])).toBe(false);
  h.respondFetch(1, codexSetup({ project_id: 'project-b' }));
  await h.waitFor(() => h.nodes().some(n => n.type === 'select'));
  expect(h.nodes().find(n => n.type === 'select')?.props.value).toBe('1.0.0');
});

test.each([false, true])('a previous project operation cannot replace the newly selected project status, window=%s', async window => {
  const h = harness('project-a');
  h.flush();
  const first = window ? windowSetup({ project_id: 'project-a' }) : codexSetup({ project_id: 'project-a', configured: true });
  h.respondFetch(0, first);
  await h.waitFor(() => h.nodes().some(n => n.props['data-codex-configured'] === 'true'));
  const pending = deferred<CodexSetup | null>();
  h.perform.mockReturnValueOnce(pending.promise);
  h.click('data-codex-action', 'preview-install');
  h.selectProject('project-b');
  h.respondFetch(1, codexSetup({ project_id: 'project-b', configured: false }));
  await h.waitFor(() => h.nodes().some(n => n.props['data-codex-configured'] === 'false'));
  pending.resolve({
    ...first,
    changes: [
      {
        path: '.codex/hooks.json',
        action: 'create',
        beforeHash: null,
        afterHash: 'review'
      }
    ]
  });
  await pending.promise;
  expect(h.nodes().some(n => n.props['data-codex-configured'] === 'true')).toBe(false);
  expect(h.nodes().some(n => n.props['data-codex-preview'])).toBe(false);
});

test('fetch failure shows error alert', async () => {
  const h = harness();
  h.flush();
  h.failFetch(0);
  await h.waitFor(() => h.nodes().some(n => n.props.role === 'alert'));
  const alert = h.nodes().find(n => n.props.role === 'alert');
  expect(alert).toBeDefined();
});

test('readiness reason displays mapped label', async () => {
  const h = harness();
  const data = codexSetup({
    readiness: {
      receipt_directory: 'missing',
      provider: 'blocked',
      reason: 'receipt_directory_missing',
      hook_trust: 'manual_confirmation_required',
      requires_new_session: true
    }
  });
  h.flush();
  h.respondFetch(0, data);
  await h.waitFor(() => h.nodes().some(n => n.props['data-readiness-reason'] === 'receipt_directory_missing'));
  const reason = h.nodes().find(n => n.props['data-readiness-reason'] === 'receipt_directory_missing');
  expect(reason).toBeDefined();
});

test('missing receipts allow the installation preview that creates the directory', async () => {
  const h = harness();
  const data = codexSetup({ configured: true });
  h.flush();
  h.respondFetch(0, data);
  await h.waitFor(() => h.nodes().some(n => n.props['data-codex-configured'] === 'true'));
  const btn = h.nodes().find(n => n.props['data-codex-action'] === 'preview-install');
  expect(btn!.props.disabled).toBe(false);
});

test('cancel discards preview without calling operate', async () => {
  const h = harness();
  const initial = codexSetup({
    configured: true,
    installation: {
      state: 'absent',
      source: 'available',
      packageHash: 'pkg',
      installedHash: null,
      destination: '/dest',
      receiptDirectory: '/receipt',
      hookRegistration: 'unverified',
      blockers: []
    }
  });
  h.flush();
  h.respondFetch(0, initial);
  await h.waitFor(() => !h.nodes().find(n => n.props['data-codex-action'] === 'preview-install')?.props.disabled);
  const withChanges = {
    ...initial,
    changes: [
      {
        path: 'hook.sh',
        action: 'create' as const,
        beforeHash: null,
        afterHash: 'h'
      }
    ]
  };
  h.perform.mockResolvedValueOnce(withChanges);
  h.click('data-codex-action', 'preview-install');
  await h.waitFor(() => h.nodes().some(n => n.props['data-codex-preview'] === 'install'));
  h.click('data-codex-action', 'cancel-preview');
  expect(h.nodes().some(n => n.props['data-codex-preview'])).toBe(false);
  expect(h.perform).toHaveBeenCalledTimes(1);
});

test('independent product panels maintain separate state', async () => {
  const h = harness();
  h.flush();
  const data = codexSetup({ configured: true });
  h.respondFetch(0, data);
  await h.waitFor(() => h.nodes().some(n => n.props['data-codex-configured'] === 'true'));
  h.click('data-product', 'claude_code');
  expect(controls(h.render()).some(n => n.type === OrdinaryObservationSetup)).toBe(true);
  h.click('data-product', 'codex');
  expect(h.nodes().some(n => n.props['data-codex-configured'] === 'true')).toBe(true);
});

function windowSetup(overrides: Partial<CodexSetup> = {}): CodexSetup {
  return codexSetup({
    configured: true,
    mode: 'ordinary_window',
    schema_version: 2,
    product_version: '1.9.0',
    window: {
      policy_id: 'synthetic-window-policy',
      policy_revision: 'synthetic-window-revision',
      evidence_mode: 'source_only',
      collection_enabled: false,
      reason: 'ordinary_window_collection_disabled'
    },
    ...overrides
  });
}

test.each(['en', 'ko'] as const)('explicit window transition in %s requires a declared stable version', async locale => {
  const h = harness('project', locale);
  const data = codexSetup({ configured: true });
  h.flush();
  const ready = h.waitFor(() => h.nodes().some(n => n.props['data-codex-configured'] === 'true'));
  h.respondFetch(0, data);
  await ready;

  h.click('data-codex-mode', 'ordinary_window');
  expect(h.nodes().find(n => n.props['data-codex-version'])?.props.value).toBe('');
  expect(h.nodes().find(n => n.props['data-codex-action'] === 'configure')?.props.disabled).toBe(true);
  expect(h.nodes().find(n => n.props['data-codex-action'] === 'preview-install')?.props.disabled).toBe(true);
  h.selectVersion('1.9.0-beta');
  expect(h.nodes().find(n => n.props['data-codex-action'] === 'configure')?.props.disabled).toBe(true);
  h.selectVersion('1.9.0');
  expect(h.perform).not.toHaveBeenCalled();
  h.setBusy(true);
  expect(h.nodes().find(n => n.props['data-codex-mode'] === 'exact')?.props.disabled).toBe(true);
  expect(h.nodes().find(n => n.props['data-codex-version'])?.props.disabled).toBe(true);
  h.setBusy(false);
  const pending = deferred<CodexSetup | null>();
  h.perform.mockReturnValueOnce(pending.promise);
  const saved = h.waitFor(
    () =>
      h.nodes().find(n => n.props['data-codex-action'] === 'configure')?.props.disabled === true &&
      h.nodes().find(n => n.props['data-codex-version'])?.props.disabled === false
  );
  h.click('data-codex-action', 'configure');
  expect(h.perform).toHaveBeenLastCalledWith('/api/projects/project/codex-setup', {
    operation: 'configure',
    mode: 'ordinary_window',
    product_version: '1.9.0',
    source_roots: data.source_roots
  });
  expect(h.nodes().find(n => n.props['data-codex-mode'] === 'exact')?.props.disabled).toBe(true);
  pending.resolve(windowSetup());
  await saved;
  expect(h.nodes().find(n => n.props['data-codex-mode'] === 'ordinary_window')?.props['aria-pressed']).toBe(true);
  expect(h.nodes().find(n => n.props['data-codex-version'])?.props.value).toBe('1.9.0');
  expect(h.nodes().some(n => n.type === 'select')).toBe(false);
});

test('saving a window version omits mode and retains the saved mode', async () => {
  const h = harness();
  const data = windowSetup();
  h.flush();
  const ready = h.waitFor(() => h.nodes().some(n => n.props['data-codex-version']));
  h.respondFetch(0, data);
  await ready;
  h.selectVersion('1.10.0');
  const pending = deferred<CodexSetup | null>();
  h.perform.mockReturnValueOnce(pending.promise);
  const saved = h.waitFor(
    () =>
      h.nodes().find(n => n.props['data-codex-action'] === 'configure')?.props.disabled === true &&
      h.nodes().find(n => n.props['data-codex-version'])?.props.disabled === false
  );
  h.click('data-codex-action', 'configure');
  expect(h.perform).toHaveBeenLastCalledWith('/api/projects/project/codex-setup', {
    operation: 'configure',
    product_version: '1.10.0',
    source_roots: data.source_roots
  });
  pending.resolve(windowSetup({ product_version: '1.10.0' }));
  await saved;
  expect(h.nodes().find(n => n.props['data-codex-mode'] === 'ordinary_window')?.props['aria-pressed']).toBe(true);
});

test('returning from window to exact requires explicit exact version selection', async () => {
  const h = harness();
  h.flush();
  const ready = h.waitFor(() => h.nodes().some(n => n.props['data-codex-version']));
  h.respondFetch(0, windowSetup());
  await ready;
  h.click('data-codex-mode', 'exact');
  expect(h.nodes().find(n => n.type === 'select')?.props.value).toBe('');
  expect(h.nodes().find(n => n.props['data-codex-action'] === 'configure')?.props.disabled).toBe(true);
  h.selectVersion('1.0.0');
  h.perform.mockResolvedValueOnce(codexSetup({ configured: true }));
  const saved = h.waitFor(
    () =>
      h.nodes().find(n => n.props['data-codex-action'] === 'configure')?.props.disabled === true &&
      h.nodes().find(n => n.type === 'select')?.props.disabled === false
  );
  h.click('data-codex-action', 'configure');
  expect(h.perform).toHaveBeenLastCalledWith('/api/projects/project/codex-setup', {
    operation: 'configure',
    mode: 'exact',
    product_version: '1.0.0',
    source_roots: ['/synthetic/root']
  });
  await saved;
  expect(h.nodes().find(n => n.props['data-codex-mode'] === 'exact')?.props['aria-pressed']).toBe(true);
});

test.each(['mode', 'version', 'project'] as const)('changing window %s discards the reviewed preview', async change => {
  const h = harness();
  const data = windowSetup();
  h.flush();
  const ready = h.waitFor(() => h.nodes().some(n => n.props['data-codex-version']));
  h.respondFetch(0, data);
  await ready;
  h.perform.mockResolvedValueOnce({
    ...data,
    changes: [
      {
        path: 'window-hook.mjs',
        action: 'create',
        beforeHash: null,
        afterHash: 'window-hash'
      }
    ]
  });
  const previewed = h.waitFor(() => h.nodes().some(n => n.props['data-codex-preview'] === 'install'));
  h.click('data-codex-action', 'preview-install');
  await previewed;
  expect(h.perform).toHaveBeenLastCalledWith('/api/projects/project/codex-setup', { operation: 'preview-install' });
  expect(h.nodes().find(n => n.props['data-codex-choice'] === 'install')?.props.disabled).toBe(false);

  if (change === 'mode') h.click('data-codex-mode', 'exact');
  if (change === 'version') h.selectVersion('1.10.0');
  if (change === 'project') {
    h.selectProject('other-project');
    const loaded = h.waitFor(() => h.nodes().some(n => n.type === 'select'));
    h.respondFetch(1, codexSetup({ project_id: 'other-project' }));
    await loaded;
    expect(h.nodes().find(n => n.props['data-codex-mode'] === 'exact')?.props['aria-pressed']).toBe(true);
    expect(h.nodes().find(n => n.type === 'select')?.props.value).toBe('1.0.0');
  }
  expect(h.nodes().some(n => n.props['data-codex-preview'] || n.props['data-codex-choice'])).toBe(false);
  expect(h.perform).toHaveBeenCalledTimes(1);
});

test('window installation requires preview and applies only the reviewed hashes', async () => {
  const h = harness();
  const data = windowSetup();
  data.installation.packageHash = 'window-package';
  h.flush();
  const ready = h.waitFor(() => h.nodes().some(n => n.props['data-codex-version']));
  h.respondFetch(0, data);
  await ready;
  expect(h.nodes().some(n => n.props['data-codex-choice'])).toBe(false);
  h.perform.mockResolvedValueOnce({
    ...data,
    changes: [
      {
        path: 'window-hook.mjs',
        action: 'create',
        beforeHash: null,
        afterHash: 'window-hash'
      }
    ]
  });
  const previewed = h.waitFor(() => h.nodes().some(n => n.props['data-codex-preview'] === 'install'));
  h.click('data-codex-action', 'preview-install');
  await previewed;
  const pending = deferred<CodexSetup | null>();
  h.perform.mockReturnValueOnce(pending.promise);
  const applied = h.waitFor(
    () =>
      h.nodes().some(n => n.props['data-installation-state'] === 'installed') &&
      h.nodes().find(n => n.props['data-codex-action'] === 'refresh')?.props.disabled === false
  );
  h.click('data-codex-choice', 'install');
  expect(h.perform).toHaveBeenLastCalledWith('/api/projects/project/codex-setup', {
    operation: 'install',
    expected_package_hash: 'window-package',
    expected_installed_hash: null
  });
  pending.resolve({
    ...data,
    installation: {
      ...data.installation,
      state: 'installed',
      installedHash: 'window-hash'
    }
  });
  await applied;
  expect(h.nodes().some(n => n.props['data-installation-state'] === 'installed')).toBe(true);
  expect(h.nodes().some(n => n.props['data-codex-window-collection'] === 'disabled')).toBe(true);
});

test.each(['en', 'ko'] as const)('window %s UI suppresses unknown categorical reasons and refresh errors', async locale => {
  const h = harness('project', locale);
  const raw = 'synthetic-private-unknown-reason';
  const data = windowSetup();
  data.readiness.reason = raw;
  data.installation.blockers = [raw];
  if (data.window) data.window.reason = raw;
  h.flush();
  const ready = h.waitFor(() => h.nodes().some(n => n.props['data-codex-version']));
  h.respondFetch(0, data);
  await ready;
  expect(text(h.render())).not.toContain(raw);
  expect(renderToStaticMarkup(h.render())).not.toContain(raw);
  expect(h.nodes().map(n => n.props['data-readiness-reason'])).not.toContain(raw);
  const failed = h.waitFor(() => h.nodes().some(n => n.props.role === 'alert' && n.type === 'p'));
  h.click('data-codex-action', 'refresh');
  h.failFetch(1);
  await failed;
  expect(text(h.render())).not.toContain('unknown_project');
  expect(renderToStaticMarkup(h.render())).not.toContain('unknown_project');
});

test('card has correct data attribute for project', () => {
  const h = harness('my-project');
  const card = h.nodes().find(n => n.props['data-agent-setup'] === 'my-project');
  expect(card).toBeDefined();
});
