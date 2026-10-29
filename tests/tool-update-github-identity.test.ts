import { expect, test } from 'vitest';
import { discover } from '../scripts/tool-update/discovery.mjs';
import { baseline, fixture, now } from './tool-update-discovery-fixture.js';

test('numeric latest redirects are accepted only after official identity reconciliation', async () => {
  const wire = fixture({
    rewrite: (url, _attempt, _init, response) => url.pathname === '/repos/openai/codex/releases/latest'
      ? new Response(null, { status: 302, headers: { location: 'https://api.github.com/repositories/42/releases/latest' } })
      : response,
  });
  const result = await discover('codex', { fetchImpl: wire.fetchImpl, now });
  expect(result.candidate?.target).toBe('1.0.10');
  expect(wire.calls.some(call => new URL(call.url).pathname === '/repositories/42/releases/latest')).toBe(true);
});
test('redirects to another numeric repository are refused before access', async () => {
  const wire = fixture({
    rewrite: (url, _attempt, _init, response) => {
      if (url.pathname.endsWith('/latest'))
        return new Response(null, { status: 302, headers: { location: 'https://api.github.com/repositories/43/releases/latest' } });
      return response;
    },
  });
  const result = await discover('codex', { fetchImpl: wire.fetchImpl, now });
  expect(result.candidate).toBeNull();
  expect(result.observation.reasons).toContain('redirect_invalid');
  expect(wire.calls.every(call => !call.url.includes('/repositories/43/'))).toBe(true);
});
test('the verified numeric exact-tag path is permitted as a same-resource redirect', async () => {
  const wire = fixture({
    rewrite: (url, _attempt, _init, response) => url.pathname.startsWith('/repos/openai/codex/releases/tags/')
      ? new Response(null, { status: 302,
        headers: { location: `https://api.github.com/repositories/42/releases/tags/${url.pathname.split('/').at(-1)}` } })
      : response,
  });
  const result = await discover('codex', { fetchImpl: wire.fetchImpl, now, baseline: baseline('1.0.1') });
  expect(result.candidate?.target).toBe('1.0.10');
});
test('a renamed or wrong official repository cannot supply candidate metadata', async () => {
  const wire = fixture({
    rewrite: (url, _attempt, _init, response) => url.pathname === '/repos/openai/codex'
      ? Response.json({ id: 42, full_name: 'synthetic/other' }) : response,
  });
  const result = await discover('codex', { fetchImpl: wire.fetchImpl, now });
  expect(result.observation.result).toBe('metadata_conflict');
  expect(wire.calls).toHaveLength(1);
});
