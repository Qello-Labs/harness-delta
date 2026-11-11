import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, fstatSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { open as openAsync } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { Lifecycle } from '../src/core/lifecycle.js';
import { revokeOrdinaryWindowActivation } from '../src/core/ordinary-window-store.js';
import { Deletion } from '../src/deletion.js';
import type { SessionBindingProvider } from '../src/session-binding-contract.js';
import { createSyntheticWindowCollection } from '../scripts/tool-update/codex-window-collection.mjs';
import { reserveWindowConsent } from '../scripts/tool-update/codex-window-consent.mjs';

// Every case below builds a real Store with migrations; a loaded runner needs headroom beyond the 5 s default.
const realStoreTimeoutMs = 20_000;

vi.mock('node:fs', { spy: true });
vi.mock('node:fs/promises', { spy: true });
const boundary = vi.hoisted(
  (): {
    beforeCommit: (() => void) | undefined;
    afterStaging: (() => void) | undefined;
  } => ({
    beforeCommit: undefined,
    afterStaging: undefined
  })
);
vi.mock('../dist/ordinary-window-binding.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../dist/ordinary-window-binding.js')>();
  return {
    ...actual,
    readOrdinaryWindowBatch: (options: Parameters<typeof actual.readOrdinaryWindowBatch>[0]) =>
      actual.readOrdinaryWindowBatch({
        ...options,
        provider: (...args) => {
          const provider = options.provider(...args);
          const read = provider?.readWindowUsage?.bind(provider);
          if (!provider || !read) return provider;
          return {
            product: provider.product,
            capabilities: provider.capabilities.bind(provider),
            resolveCurrent: provider.resolveCurrent.bind(provider),
            discoverChildren: provider.discoverChildren.bind(provider),
            readUsage: provider.readUsage.bind(provider),
            ...(provider.revalidateBound
              ? {
                  revalidateBound: provider.revalidateBound.bind(provider)
                }
              : {}),
            readWindowUsage: async (...readArgs) => {
              const batch = await read(...readArgs);
              return {
                ...batch,
                get records() {
                  const change = boundary.beforeCommit;
                  boundary.beforeCommit = undefined;
                  change?.();
                  return batch.records;
                },
                get gaps() {
                  boundary.afterStaging?.();
                  return batch.gaps;
                }
              };
            }
          } satisfies SessionBindingProvider;
        }
      })
  };
});

const fixtures: {
  root: string;
  session: ReturnType<typeof createSyntheticWindowCollection>;
}[] = [];
afterEach(() => {
  boundary.beforeCommit = undefined;
  boundary.afterStaging = undefined;
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) {
    try {
      f.session.close();
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
  vi.useRealTimers();
});

function consentFixture() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.parse('2026-11-11T01:00:00.000Z'));
  const now = Date.now();
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'window-collection-'));
  const pins = Object.fromEntries(
    ['native', 'host', 'source', 'build', 'instrument', 'runtime', 'lockfile', 'config', 'environment', 'egress', 'quota'].map((name, index) => [
      name,
      String(index % 10).repeat(64)
    ])
  );
  const intent = {
    schema_version: 1,
    kind: 'codex_window_disabled_intent',
    authority: 'none',
    execution_enabled: false,
    actual_qualification: false,
    case_id: 'normal',
    case_root: root,
    plan_digest: 'a'.repeat(64),
    plan: {
      schema_version: 1,
      product: 'codex',
      version: '0.167.0',
      commit: '086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a',
      route: 'codex_binding',
      policy_id: 'codex-binding-root-window-v1',
      operation: 'collect',
      topology: 'root',
      runtime: 'node24',
      platform: 'darwin_arm64',
      model: 'gpt-6.1-sol',
      effort: 'high',
      pins
    },
    owner_ms: 120000,
    cleanup_ms: 5000,
    audit_reserve_ms: 10000,
    containment_qualified: false
  };
  const intentBytes = JSON.stringify(intent);
  const intentFile = join(root, 'intent.json');
  const consentFile = join(root, 'consent.json');
  const consent = {
    schema_version: 1,
    kind: 'codex_window_b1_consent',
    consent_id: randomUUID(),
    approval_reference: 'b'.repeat(64),
    issued_at: now,
    expires_at: now + 120000,
    intent_sha256: createHash('sha256').update(intentBytes).digest('hex'),
    case_id: 'normal',
    case_root: root,
    product: 'codex',
    version: '0.167.0',
    operation: 'collect',
    topology: 'root',
    pins
  };
  writeFileSync(intentFile, intentBytes, { mode: 0o600 });
  writeFileSync(consentFile, JSON.stringify(consent), { mode: 0o600 });
  const capability = reserveWindowConsent({
    intentFile,
    consentFile,
    observedPins: pins
  });
  return { root, now, pins, intentFile, consentFile, capability };
}

function fixture() {
  const { root, now, pins, intentFile, consentFile, capability } = consentFixture();
  const session = createSyntheticWindowCollection(capability, pins);
  const nativeId = 'synthetic-exact-root';
  const source = join(session.sourceRoot, 'root.jsonl');
  writeFileSync(
    source,
    JSON.stringify({
      type: 'session_meta',
      payload: {
        id: nativeId,
        session_id: nativeId,
        cli_version: '0.167.0',
        cwd: session.projectRoot,
        source: 'cli'
      }
    }) + '\n',
    { mode: 0o600 }
  );
  const receipt = {
    schemaVersion: 2,
    kind: 'codex_window_pending',
    receipt: randomUUID(),
    product: 'codex',
    event: 'SessionStart',
    lifecycle: 'startup',
    nativeSessionId: nativeId,
    nativeRootSessionId: nativeId,
    agentId: null,
    turnId: null,
    cwd: session.projectRoot,
    sourceRef: source,
    recordedAt: new Date().toISOString()
  };
  writeFileSync(join(session.receiptDirectory, `${receipt.receipt}.json`), JSON.stringify(receipt), { mode: 0o600 });
  const append = () => {
    vi.setSystemTime(now + 1000);
    const timestamp = new Date().toISOString();
    appendFileSync(
      source,
      [
        {
          type: 'turn_context',
          timestamp,
          payload: {
            cwd: session.projectRoot,
            turn_id: 'turn',
            root_turn_id: 'turn',
            model: 'gpt-6.1-sol',
            effort: 'high'
          }
        },
        {
          type: 'token_usage_record',
          timestamp,
          payload: {
            thread_id: nativeId,
            session_id: nativeId,
            turn_id: 'turn',
            root_turn_id: 'turn',
            response_id: 'synthetic-response',
            usage: {
              input_tokens: 100,
              cached_input_tokens: 10,
              output_tokens: 20,
              reasoning_output_tokens: 5,
              total_tokens: 120
            }
          }
        }
      ]
        .map(row => JSON.stringify(row))
        .join('\n') + '\n'
    );
  };
  const f = {
    root,
    now,
    pins,
    intentFile,
    consentFile,
    session,
    source,
    receipt,
    append
  };
  fixtures.push(f);
  return f;
}

function snapshot(f: ReturnType<typeof fixture>) {
  return {
    events: f.session.store.all('SELECT * FROM events'),
    requests: f.session.store.all('SELECT * FROM binding_requests'),
    bindings: f.session.store.all('SELECT session_id,cursor FROM session_bindings'),
    baseline: f.session.store.all('SELECT * FROM binding_baseline_exclusions'),
    trial: f.session.store.all('SELECT trial_tokens_consumed FROM ordinary_window_activations')
  };
}

const changes = [
  'consent_bytes',
  'intent_bytes',
  'consent_replacement',
  'reservation_removed',
  'pins',
  'consent_expired',
  'trial_expired',
  'revoked',
  'deleted',
  'generation'
] as const;
function changeAuthority(f: ReturnType<typeof fixture>, change: (typeof changes)[number]) {
  switch (change) {
    case 'consent_bytes':
      appendFileSync(f.consentFile, '\n');
      break;
    case 'intent_bytes':
      appendFileSync(f.intentFile, '\n');
      break;
    case 'consent_replacement': {
      const replacement = join(f.root, 'replacement.json');
      writeFileSync(replacement, readFileSync(f.consentFile), {
        mode: 0o600
      });
      renameSync(replacement, f.consentFile);
      break;
    }
    case 'reservation_removed':
      renameSync(join(f.root, '.codex-window-launch-reservation.json'), join(f.root, 'removed-reservation.json'));
      break;
    case 'pins':
      f.pins.native = 'f'.repeat(64);
      break;
    case 'consent_expired':
      vi.setSystemTime(f.now + 120000);
      break;
    case 'trial_expired':
      vi.setSystemTime(f.now + 60000);
      break;
    case 'revoked':
      revokeOrdinaryWindowActivation(f.session.store, f.session.taskId, new Date().toISOString());
      break;
    case 'deleted':
      new Deletion(f.session.store, () => new Date().toISOString()).deleteTask(f.session.taskId);
      break;
    case 'generation': {
      const lifecycle = new Lifecycle(f.session.store, () => new Date().toISOString());
      lifecycle.pause(f.session.taskId);
      lifecycle.resume(f.session.taskId);
      break;
    }
  }
}

test(
  'unchanged consent preserves real trial charging and replay deduplication',
  async () => {
    const f = fixture();
    await f.session.connect(f.receipt);
    f.append();
    await f.session.collect();
    await f.session.collect();
    expect(f.session.store.eventCount()).toBe(1);
    expect(f.session.store.get('SELECT decision_kind,trial_tokens_consumed FROM ordinary_window_activations')).toEqual({
      decision_kind: 'trial',
      trial_tokens_consumed: 120
    });
  },
  realStoreTimeoutMs
);

test(
  'connect refuses changed consent before the next synchronous header read',
  async () => {
    const f = fixture();
    const native = await vi.importActual<typeof import('node:fs')>('node:fs');
    let sourceFd: number | undefined;
    let changed = false;
    let sourceReads = 0;
    vi.mocked(openSync).mockImplementation((...args) => {
      const fd = native.openSync(...args);
      if (args[0] === f.source) sourceFd = fd;
      else if (fd === sourceFd) sourceFd = undefined;
      return fd;
    });
    vi.mocked(fstatSync).mockImplementation((...args) => {
      const stat = native.fstatSync(...args);
      if (!changed && args[0] === sourceFd) {
        changed = true;
        changeAuthority(f, 'consent_bytes');
      }
      return stat;
    });
    vi.mocked(readSync).mockImplementation((...args) => {
      if (args[0] === sourceFd) sourceReads++;
      return native.readSync(...args);
    });
    await expect(f.session.connect(f.receipt)).rejects.toThrow();
    expect(changed).toBe(true);
    expect(sourceReads).toBe(0);
    expect(f.session.store.all('SELECT * FROM ordinary_window_segments')).toEqual([]);
    expect(f.session.store.eventCount()).toBe(0);
  },
  realStoreTimeoutMs
);

test.each(changes)(
  'pending source open refuses %s before the next stat or read',
  async change => {
    const f = fixture();
    await f.session.connect(f.receipt);
    f.append();
    const native = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let opened = false;
    let assertNoRead: () => void = () => {
      throw new Error('source_open_not_observed');
    };
    vi.mocked(openAsync).mockImplementationOnce(async (...args) => {
      const file = await native.open(...args);
      const stat = vi.spyOn(file, 'stat');
      const read = vi.spyOn(file, 'read');
      assertNoRead = () => {
        expect(stat).not.toHaveBeenCalled();
        expect(read).not.toHaveBeenCalled();
      };
      opened = true;
      changeAuthority(f, change);
      return file;
    });
    await expect(f.session.collect()).rejects.toThrow();
    expect(opened).toBe(true);
    assertNoRead();
    expect(f.session.store.eventCount()).toBe(0);
    expect(f.session.store.all('SELECT * FROM binding_requests')).toEqual([]);
  },
  realStoreTimeoutMs
);

test.each(['consent_bytes', 'intent_bytes', 'consent_replacement', 'reservation_removed', 'pins'] as const)(
  'final transaction authorization rolls back staged usage after %s',
  async change => {
    const f = fixture();
    await f.session.connect(f.receipt);
    f.append();
    const before = snapshot(f);
    let staged = false;
    boundary.afterStaging = () => {
      if (staged || f.session.store.eventCount() === 0) return;
      staged = true;
      changeAuthority(f, change);
    };
    await expect(f.session.collect()).rejects.toThrow();
    expect(staged).toBe(true);
    expect(snapshot(f)).toEqual(before);
    expect(f.session.store.eventCount()).toBe(0);
    expect(f.session.store.all('SELECT * FROM binding_requests')).toEqual([]);
  },
  realStoreTimeoutMs
);

test.each(changes)(
  'transaction authorization denies %s after provider return without committing staged usage',
  async change => {
    const f = fixture();
    await f.session.connect(f.receipt);
    f.append();
    let changed = false;
    let before: ReturnType<typeof snapshot> | undefined;
    boundary.beforeCommit = () => {
      changed = true;
      changeAuthority(f, change);
      before = snapshot(f);
    };
    await expect(f.session.collect()).rejects.toThrow();
    expect(changed).toBe(true);
    expect(snapshot(f)).toEqual(before);
    expect(f.session.store.eventCount()).toBe(0);
    expect(f.session.store.all('SELECT * FROM binding_requests')).toEqual([]);
  },
  realStoreTimeoutMs
);
