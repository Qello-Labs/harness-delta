import { replaceOrdinaryWindowTrialRoot as replaceRoot } from './helpers/ordinary-window-trial-fixture.js';
import { prepareOrdinaryWindowTrialFixture } from './helpers/ordinary-window-trial-fixture.js';
import { afterEach, expect, test } from 'vitest';

import { revokeOrdinaryWindowDecision } from '../src/core/ordinary-window-store.js';

import { aggregateOrdinaryWindowReport } from '../src/comparison/reports/ordinary-window.js';
import type { OrdinaryWindowUsageBatch } from '../src/session-binding-contract.js';
import { ordinaryWindowFixture } from './helpers/ordinary-window-fixture.js';
import { windowRevocationPacket } from './helpers/ordinary-window-decision-fixture.js';

const fixtures: ReturnType<typeof ordinaryWindowFixture>[] = [];
function fixture(tokenLimit = 100) {
  const f = ordinaryWindowFixture();
  fixtures.push(f);
  return prepareOrdinaryWindowTrialFixture(f, tokenLimit);
}
afterEach(() => {
  for (const f of fixtures.splice(0)) f.store.close();
});
function decision(f: ReturnType<typeof fixture>) {
  return f.store.get<{
    trial_tokens_consumed: number;
    revoked_at: string | null;
    revocation_reason: string | null;
  }>('SELECT trial_tokens_consumed,revoked_at,revocation_reason FROM ordinary_window_activations');
}
function scopeRows(f: ReturnType<typeof fixture>) {
  return {
    activations: f.store.all('SELECT * FROM ordinary_window_activations'),
    segments: f.store.all('SELECT * FROM binding_root_segments'),
    bindings: f.store.all('SELECT * FROM session_bindings'),
    tasks: f.store.all('SELECT * FROM tasks'),
    coverage: f.store.all('SELECT * FROM ordinary_window_segments'),
    intervals: f.store.all('SELECT * FROM active_intervals'),
    ...f.snapshot()
  };
}
function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>(accept => {
    resolve = accept;
  });
  if (!resolve) throw new Error('fixture_resolver_missing');
  return { promise, resolve };
}
function readiness() {
  let accept: (() => void) | undefined;
  const promise = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('readiness_deadline')), 3000);
    accept = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  if (!accept) throw new Error('fixture_resolver_missing');
  return { promise, resolve: accept };
}

test('charges only root input plus output once, with cache/reasoning subsets and replays excluded', async () => {
  const f = fixture();
  f.onRead(() => Promise.resolve(f.batch([f.usage(), f.usage()])));
  await f.read();
  expect(decision(f)?.trial_tokens_consumed).toBe(15);
  expect(f.store.eventCount()).toBe(1);
  await f.read();
  expect(decision(f)?.trial_tokens_consumed).toBe(15);
  expect(f.store.eventCount()).toBe(1);
});

test('counts baseline and excluded root requests but never counts replayed exclusions again', async () => {
  const f = fixture();
  f.onRead(boundary => {
    boundary.baselineLedger?.add('provider-only');
    return Promise.resolve(f.batch([f.usage()]));
  });
  await f.read(true);
  expect(decision(f)?.trial_tokens_consumed).toBe(15);
  expect(f.store.eventCount()).toBe(0);
  await f.read(true);
  expect(decision(f)?.trial_tokens_consumed).toBe(15);
  f.onRead(() =>
    Promise.resolve({
      ...f.batch([]),
      excludedRecords: [f.usage('excluded')]
    })
  );
  await f.read();
  expect(decision(f)?.trial_tokens_consumed).toBe(30);
  expect(f.store.eventCount()).toBe(0);
});

test('rejects an over-budget mixed batch atomically and persists its owned trial termination', async () => {
  const f = fixture(20);
  const before = f.snapshot();
  f.onRead(boundary => {
    boundary.baselineLedger?.add('staged');
    return Promise.resolve(f.batch([f.usage('one'), f.usage('two')]));
  });
  await expect(f.read()).rejects.toThrow('binding_window_trial_budget_exhausted');
  expect(f.snapshot()).toEqual(before);
  expect(decision(f)).toMatchObject({
    trial_tokens_consumed: 0,
    revoked_at: f.clock(),
    revocation_reason: 'trial_budget_exhausted'
  });
  expect(f.life.state(f.taskId)).toBe('paused');
  expect(f.store.all('SELECT * FROM source_compatibility_blocks')).toEqual([]);
  const calls = [...f.calls];
  await expect(f.read()).rejects.toThrow('binding_scope_revoked');
  expect(f.calls).toEqual(calls);
});

test('commits an exact-limit batch and its revocation together, preserving descriptive saved evidence', async () => {
  const f = fixture(15);
  await f.read();
  expect(decision(f)).toMatchObject({
    trial_tokens_consumed: 15,
    revoked_at: f.clock(),
    revocation_reason: 'trial_budget_exhausted'
  });
  expect(f.store.eventCount()).toBe(1);
  expect(f.store.all('SELECT * FROM binding_requests')).toHaveLength(1);
  expect(f.store.get<{ cursor: string }>('SELECT cursor FROM session_bindings')?.cursor).toBe('next');
  const report = aggregateOrdinaryWindowReport(f.store, f.taskId, '2026-11-06T01:00:10.000Z');
  expect(report.usage.compatibility_unverified.partial_tokens).toBe(15);
  expect(report.usage.verified.partial_tokens).toBeNull();
  expect(report.usage.complete_tokens).toBeNull();
  expect(report.collection.state).toBe('disabled');
});

test('an unknown required total is not a zero budget charge', async () => {
  const f = fixture();
  const record = f.usage();
  f.onRead(() =>
    Promise.resolve(
      f.batch([
        {
          ...record,
          payload: {
            ...record.payload,
            input_total: {
              status: 'missing',
              value: null,
              reason: 'not_available'
            }
          }
        }
      ])
    )
  );
  const before = f.snapshot();
  await expect(f.read()).rejects.toThrow('binding_window_trial_usage_unmeasurable');
  expect(f.snapshot()).toEqual(before);
  expect(decision(f)).toMatchObject({
    trial_tokens_consumed: 0,
    revocation_reason: 'trial_failed'
  });
  expect(f.store.all('SELECT * FROM source_compatibility_blocks')).toEqual([]);
});

test('conflicting duplicate baseline counters cannot conceal a budget charge', async () => {
  const f = fixture();
  const record = f.usage();
  f.onRead(() =>
    Promise.resolve(
      f.batch([
        record,
        {
          ...record,
          payload: {
            ...record.payload,
            output_total: {
              status: 'observed',
              value: 6,
              reason: null
            }
          }
        }
      ])
    )
  );
  await expect(f.read(true)).rejects.toThrow('binding_request_conflict');
  expect(f.store.eventCount()).toBe(0);
  expect(decision(f)).toMatchObject({
    trial_tokens_consumed: 0,
    revocation_reason: 'trial_failed'
  });
  expect(f.store.all('SELECT * FROM binding_baseline_exclusions')).toEqual([]);
  expect(f.store.all('SELECT * FROM source_compatibility_blocks')).toHaveLength(1);
});

test.each([60_000, -2000])('deadline/clock regression %i refuses construction and durably closes the trial', async change => {
  const f = fixture();
  f.advance(change);
  await expect(f.read()).rejects.toThrow('binding_window_trial_expired');
  expect(f.calls).toEqual([]);
  expect(decision(f)).toMatchObject({
    revoked_at: f.clock(),
    revocation_reason: 'trial_expired'
  });
  expect(f.store.eventCount()).toBe(0);
});

test.each(['owned', 'cursor', 'revision', 'generation', 'root', 'receipt', 'identity'] as const)(
  'after-await expiry respects the captured %s owner',
  async change => {
    const f = fixture();
    const entered = readiness();
    const release = deferred<OrdinaryWindowUsageBatch>();
    f.onRead(boundary => {
      boundary.baselineLedger?.add('staged');
      entered.resolve();
      return release.promise;
    });
    const pending = f.read().then(
      () => null,
      (error: unknown) => error
    );
    await entered.promise;
    if (change === 'cursor') {
      f.store.execute("UPDATE session_bindings SET cursor='newer'", []);
    }
    if (change === 'revision') {
      f.store.execute('UPDATE binding_root_segments SET revision=revision+1', []);
    }
    if (change === 'generation') {
      f.store.execute('UPDATE tasks SET generation=generation+1', []);
    }
    if (change === 'root') replaceRoot(f);
    if (change === 'receipt') {
      f.store.execute("UPDATE session_bindings SET connect_receipt='replacement-receipt'", []);
    }
    if (change === 'identity') {
      expect(() => f.store.execute("UPDATE session_bindings SET identity=json_set(identity,'$.sourceIdentity','replacement-source')", [])).toThrow(
        'binding_identity_mismatch'
      );
    }
    f.advance(60_000);
    const before = scopeRows(f);
    release.resolve(f.batch());
    expect(await pending).toBeInstanceOf(Error);
    if (change === 'owned' || change === 'identity') {
      expect(decision(f)).toMatchObject({
        revoked_at: f.clock(),
        revocation_reason: 'trial_expired'
      });
      expect(f.life.state(f.taskId)).toBe('paused');
      expect(f.store.eventCount()).toBe(0);
      expect(f.store.all('SELECT * FROM binding_baseline_exclusions')).toEqual([]);
    } else {
      expect(scopeRows(f)).toEqual(before);
      expect(decision(f)?.revoked_at).toBeNull();
    }
    expect(f.store.all('SELECT * FROM source_compatibility_blocks')).toEqual([]);
  }
);

test('explicit trial revocation does not pause a replacement native root', () => {
  const f = fixture();
  replaceRoot(f);
  const roots = f.store.all('SELECT * FROM binding_root_segments');
  const tasks = f.store.all('SELECT * FROM tasks');
  revokeOrdinaryWindowDecision(f.store, windowRevocationPacket(f.selection), f.clock());
  expect(decision(f)?.revoked_at).toBe(f.clock());
  expect(f.store.all('SELECT * FROM binding_root_segments')).toEqual(roots);
  expect(f.store.all('SELECT * FROM tasks')).toEqual(tasks);
});
