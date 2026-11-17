import { afterEach, expect, test, vi } from 'vitest';
import { collectCodexSourceEvidence } from '../scripts/tool-update/difference-source.mjs';
import { digest } from '../scripts/tool-update/manifest.mjs';
import { sourceBudgetFixture } from './helpers/tool-update-source-budget-fixture.js';

afterEach(() => vi.useRealTimers());

test('nine refs complete all comparisons within the scaled request budget', async () => {
  const wire = sourceBudgetFixture(9);
  const result = await collectCodexSourceEvidence(wire.job, { fetch: wire.fetchImpl });
  expect(result.failure).toBeNull();
  expect(result.evidence).toHaveLength(18);
  expect(result.usage.responses).toBe(200);
  expect(wire.calls).toHaveLength(200);
  expect(digest(result.evidence)).toBe('2336c5f6adf32db0fb20b0321445393f04142c72e485a96e175a4b30f48a78df');
});

test('five refs retain the prior canonical evidence bytes and request count', async () => {
  const wire = sourceBudgetFixture(5);
  const result = await collectCodexSourceEvidence(wire.job, { fetch: wire.fetchImpl });
  expect(result.failure).toBeNull();
  expect(result.evidence).toHaveLength(10);
  expect(result.usage.responses).toBe(112);
  expect(wire.calls).toHaveLength(112);
  expect(digest(result.evidence)).toBe('ade2ce89bbf2653cfacc5130e9f3c640024c50c527a6a9c4f5e85fcb8e2f54d4');
});

test('nine refs reuse shared tree and schema objects without immutable revalidation', async () => {
  const wire = sourceBudgetFixture(9, true);
  const result = await collectCodexSourceEvidence(wire.job, { fetch: wire.fetchImpl });
  expect(result.failure).toBeNull();
  expect(result.usage.responses).toBe(56);
  expect([...wire.counts].filter(([path]) => path.includes('/git/trees/'))).toHaveLength(26);
  expect([...wire.counts].filter(([path]) => path.includes('/git/blobs/'))).toHaveLength(1);
  expect([...wire.counts].filter(([path]) => /\/git\/(?:trees|blobs|tags)\//.test(path)).every(([, count]) => count === 1)).toBe(true);
});

test.each([
  [1, 32, 30000],
  [5, 128, 120000],
  [9, 224, 210000],
  [39, 944, 885000],
  [40, 968, 900000],
  [42, 1016, 900000],
  [43, 1024, 900000]
])('ref count %i has bounded responses %i and deadline %i', async (refs, responses, deadlineMs) => {
  const { codexSourceBudget } = await import('../scripts/tool-update/difference-source.mjs');
  expect(codexSourceBudget(refs)).toEqual({ responses, deadlineMs, maxRefs: 42 });
});

test('the largest admitted ref count completes within the hard ceilings', async () => {
  const wire = sourceBudgetFixture(42);
  const result = await collectCodexSourceEvidence(wire.job, { fetch: wire.fetchImpl });
  expect(result.failure).toBeNull();
  expect(result.evidence).toHaveLength(84);
  expect(result.usage.responses).toBe(926);
});

test('a job above the response ceiling fails before any fetch', async () => {
  const wire = sourceBudgetFixture(43);
  const result = await collectCodexSourceEvidence(wire.job, { fetch: wire.fetchImpl });
  expect(result.failure).toBe('source_response_limit');
  expect(result.evidence).toEqual([]);
  expect(result.usage).toEqual({ responses: 0, decodedBytes: 0 });
  expect(wire.calls).toHaveLength(0);
});

test('redirects exhaust the per-job response budget without a partial success', async () => {
  const wire = sourceBudgetFixture(9);
  const result = await collectCodexSourceEvidence(wire.job, {
    fetch: (input, init) => {
      const url = new URL(input);
      if (url.pathname.startsWith('/repos/openai/codex')) {
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: input.replace('/repos/openai/codex', '/repositories/965415649') }
          })
        );
      }
      return wire.fetchImpl(input, init);
    }
  });
  expect(result.failure).toBe('source_response_limit');
  expect(result.usage.responses).toBe(224);
  expect(result.evidence.every(record => record.availability === 'failed' && record.findings.length === 0)).toBe(true);
});

test('nine refs use their scaled deadline before cancelling an unresponsive fetch', async () => {
  vi.useFakeTimers();
  const wire = sourceBudgetFixture(9);
  const controller = new AbortController();
  let announce = () => {};
  const started = new Promise<void>(resolve => {
    announce = resolve;
  });
  let settled = false;
  const run = collectCodexSourceEvidence(wire.job, {
    signal: controller.signal,
    fetch: () => {
      announce();
      return new Promise<Response>(() => {});
    }
  }).then(result => {
    settled = true;
    return result;
  });
  try {
    await started;
    await vi.advanceTimersByTimeAsync(209999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await run;
    expect(result.failure).toBe('source_deadline');
    expect(result.usage.responses).toBe(1);
  } finally {
    controller.abort();
    await run;
  }
});
