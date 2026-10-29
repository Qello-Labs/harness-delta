import { expect, test } from 'vitest';
import { discover } from '../scripts/tool-update/discovery.mjs';
import { fixture, json, now, release } from './tool-update-discovery-fixture.js';

test.each([false, true])('reconciles large release asset metadata with declared length %s', async declared => {
  const padding = 'x'.repeat(5 * 1024 * 1024);
  const wire = fixture({
    rewrite: (url, _attempt, _init, response) => {
      if (!url.pathname.endsWith('/releases/latest') || response.status !== 200) return response;
      const body = { ...release('1.0.10'), assets: [{ padding }] };
      const large = json(body, {
        etag: '"opaque-validator"',
      });
      if (declared) large.headers.set('content-length', String(Buffer.byteLength(JSON.stringify(body))));
      return large;
    },
  });

  const result = await discover('codex', { fetchImpl: wire.fetchImpl, now });

  expect(result.observation.result).toBe('metadata_reconciled');
  expect(result.candidate?.target).toBe('1.0.10');
  expect(JSON.stringify(result)).not.toContain(padding);
});

test.each([false, true])('keeps non-release GitHub responses bounded with declared length %s', async declared => {
  const wire = fixture({
    rewrite: (url, _attempt, _init, response) => {
      if (url.pathname !== '/repos/openai/codex') return response;
      const oversized = new Response('x'.repeat(4 * 1024 * 1024 + 1));
      if (declared) oversized.headers.set('content-length', String(4 * 1024 * 1024 + 1));
      return oversized;
    },
  });

  const result = await discover('codex', { fetchImpl: wire.fetchImpl, now });

  expect(result.observation.reasons).toContain('response_limit');
  expect(result.candidate).toBeNull();
  expect(wire.calls).toHaveLength(1);
});
