import { expect, test, vi, afterEach } from 'vitest';
import { candidateSchema, discover, discoveryReasonCodes, observationSchema } from '../scripts/tool-update/discovery.mjs';
import { digest } from '../scripts/tool-update/manifest.mjs';
import { commit, integrity, privateText, now, json, release, baseline, fixture } from './tool-update-discovery-fixture.js';

afterEach(() => vi.useRealTimers());

test('each response check records its final revalidation time', async () => {
  const wire = fixture();
  let tick = 0;
  const clock = () => new Date(Date.parse('2026-10-24T00:00:00.000Z') + tick++ * 1000).toISOString();
  const result = await discover('codex', { fetchImpl: wire.fetchImpl, now: clock });
  expect(result.observation.checked_at).toBe('2026-10-24T00:00:00.000Z');
  expect(result.observation.checks.map(row => row.queried_at)).toEqual([
    '2026-10-24T00:00:02.000Z', '2026-10-24T00:00:01.000Z',
    '2026-10-24T00:00:04.000Z', '2026-10-24T00:00:03.000Z',
  ]);
  expect(result.observation.checks.map(row => row.checked_at)).toEqual([
    '2026-10-24T00:00:06.000Z', '2026-10-24T00:00:05.000Z',
    '2026-10-24T00:00:08.000Z', '2026-10-24T00:00:07.000Z',
  ]);
});

test.each(['cycle', 'depth'] as const)('bounds annotated tag %s', async mode => {
  let index = 1;
  const wire = fixture({
    rewrite: (url, _attempt, _init, response) => {
      if (url.pathname.includes('/git/ref/')) return json({ ref: 'refs/tags/rust-v1.0.10', object: { type: 'tag', sha: commit } });
      if (url.pathname.includes('/git/tags/')) {
        const sha = mode === 'cycle' ? commit : (++index).toString(16).padStart(40, '0');
        return json({ sha: url.pathname.split('/').at(-1), object: { type: 'tag', sha } });
      }
      return response;
    },
  });
  const result = await discover('codex', { fetchImpl: wire.fetchImpl, now });
  expect(result.observation.reasons).toContain(mode === 'cycle' ? 'tag_cycle' : 'tag_depth_limit');
  expect(result.candidate).toBeNull();
});

test.each(['github_latest', 'npm', 'github_tag'] as const)('rejects digest drift in %s without ETags', async source => {
  const matches = (url: URL) => source === 'npm' ? url.host === 'registry.npmjs.org' :
    source === 'github_tag' ? url.pathname.includes('/git/ref/') : url.pathname.endsWith('/releases/latest');
  const wire = fixture({
    etag: null,
    rewrite: async (url, attempt, _init, response) => matches(url) && attempt === 2
      ? new Response(`${await response.text()} `) : response,
  });
  const result = await discover('codex', { fetchImpl: wire.fetchImpl, now });
  expect(result.observation.reasons).toContain('metadata_drift');
  expect(result.candidate).toBeNull();
});

test('rejects changed metadata even when server ignores conditional request', async () => {
  const wire = fixture({
    rewrite: (url, attempt, _init, response) => attempt === 2 && url.host === 'registry.npmjs.org'
      ? json({ private: privateText }) : response,
  });
  const result = await discover('codex', { fetchImpl: wire.fetchImpl, now });
  expect(result.observation.reasons).toContain('metadata_drift');
});

test('ignores pagination links outside the approved latest and review range', async () => {
  const wire = fixture({
    etag: null,
    rewrite: (url, attempt, _init, response) => {
      if (url.pathname.endsWith('/releases/latest') && attempt === 2) response.headers.set('link', '<https://api.github.com/repos/openai/codex/releases?per_page=100&page=2>; rel="next"');
      return response;
    },
  });
  const result = await discover('codex', { fetchImpl: wire.fetchImpl, now });
  expect(result.observation.result).toBe('metadata_reconciled');
});

test.each([
  ['off host', '<https://private.invalid/releases?page=2>; rel="next"', 'pagination_invalid'],
  ['wrong repository', '<https://api.github.com/repos/other/codex/releases?per_page=100&page=2>; rel="next"', 'pagination_invalid'],
  ['userinfo', '<https://user@api.github.com/repos/openai/codex/releases?per_page=100&page=2>; rel="next"', 'pagination_invalid'],
  ['extra query', '<https://api.github.com/repos/openai/codex/releases?per_page=100&page=2&secret=x>; rel="next"', 'pagination_invalid'],
  ['skipped page', '<https://api.github.com/repos/openai/codex/releases?per_page=100&page=3>; rel="next"', 'pagination_invalid'],
  ['cycle', '<https://api.github.com/repos/openai/codex/releases?page=1&per_page=100>; rel="next"', 'pagination_cycle'],
  ['limit', '<https://api.github.com/repos/openai/codex/releases?per_page=100&page=101>; rel="next"', 'page_limit'],
  ['malformed', privateText, 'pagination_invalid'],
] satisfies readonly [string, string, string][])('does not follow %s inventory pagination links', async (_name, link) => {
  const wire = fixture({
    rewrite: (url, _attempt, _init, response) => {
      if (url.pathname.endsWith('/releases/latest')) response.headers.set('link', link);
      return response;
    },
  });
  const result = await discover('codex', { fetchImpl: wire.fetchImpl, now });
  expect(result.candidate?.target).toBe('1.0.10');
  expect(wire.calls.every(call => !new URL(call.url).search)).toBe(true);
  expect(JSON.stringify(result)).not.toContain(privateText);
});

test('does not enumerate historical inventories when no baseline exists', async () => {
  const wire = fixture({ pages: Array.from({ length: 100 }, (_, index) => index === 99 ? [release('1.0.10')] : []) });
  const result = await discover('codex', { fetchImpl: wire.fetchImpl, now });
  expect(result.candidate?.target).toBe('1.0.10');
  expect(result.observation.checks.filter(row => row.source === 'github_latest')).toHaveLength(1);
});

test.each([
  ['off host', 'https://private.invalid/secret'],
  ['wrong resource', 'https://api.github.com/repos/openai/codex/releases?per_page=100&page=2'],
  ['cycle', 'https://api.github.com/repos/openai/codex/releases?per_page=100&page=1'],
] satisfies readonly [string, string][])('rejects %s redirects before following', async (_name, destination) => {
  const wire = fixture({ rewrite: () => new Response(null, { status: 302, headers: { location: destination } }) });
  const result = await discover('codex', { fetchImpl: wire.fetchImpl, now });
  expect(result.observation.reasons).toContain('redirect_invalid');
  expect(wire.calls).toHaveLength(1);
});

test('follows a bounded same-resource official redirect', async () => {
  const wire = fixture({
    rewrite: (url, _attempt, _init, response) => url.pathname === '/repos/openai/codex/releases/latest'
      ? new Response(null, { status: 307, headers: { location: 'https://api.github.com/repositories/42/releases/latest' } }) : response,
  });
  const result = await discover('codex', { fetchImpl: wire.fetchImpl, now });
  expect(result.candidate?.target).toBe('1.0.10');
});

test.each([
  ['rate limit', () => new Response(privateText, { status: 429 }), 'rate_limited'],
  ['server failure', () => new Response(privateText, { status: 500 }), 'http_error'],
  ['malformed body', () => new Response(privateText), 'metadata_invalid'],
  ['non-object latest', () => json(Array.from({ length: 101 }, () => release('1.0.10'))), 'metadata_invalid'],
  ['declared body limit', () => new Response('[]', { headers: { 'content-length': String(64 * 1024 * 1024 + 1) } }), 'response_limit'],
  ['streamed body limit', () => new Response('x'.repeat(64 * 1024 * 1024 + 1)), 'response_limit'],
  ['empty latest', () => json([]), 'metadata_invalid'],
] satisfies readonly [string, () => Response, string][])('sanitizes %s failures', async (_name, make, reason) => {
  const wire = fixture({ rewrite: (url, _attempt, _init, response) => url.pathname.endsWith('/releases/latest') ? make() : response });
  const result = await discover('codex', { fetchImpl: wire.fetchImpl, now });
  expect(result.observation.reasons).toContain(reason);
  expect(result.candidate).toBeNull();
  expect(JSON.stringify(result)).not.toContain(privateText);
});

test('sanitizes transport exceptions without leaking diagnostics', async () => {
  const result = await discover('codex', { now, fetchImpl: () => Promise.reject(new Error(privateText)) });
  expect(result.observation.reasons).toContain('request_failed');
  expect(JSON.stringify(result)).not.toContain(privateText);
});

test('aborts at the invocation deadline when transport never completes', async () => {
  vi.useFakeTimers();
  let started: (() => void) | undefined;
  const requestStarted = new Promise<void>(resolve => { started = resolve; });
  const pending = discover('codex', {
    now,
    fetchImpl: () => {
      started?.();
      return new Promise<Response>(() => {});
    },
  });
  await requestStarted;
  await vi.advanceTimersByTimeAsync(120000);
  const result = await pending;
  expect(result.observation.reasons).toContain('deadline_exceeded');
  expect(result.candidate).toBeNull();
});

test.each(['missing', 'noncanonical', 'conflict'] as const)('rejects %s npm identity or integrity', async mode => {
  const wire = fixture({
    rewrite: (url, _attempt, _init, response) => {
      if (url.host !== 'registry.npmjs.org') return response;
      return json({
        name: '@openai/codex', 'dist-tags': { latest: '1.0.10' },
        versions: { '1.0.10': {
          name: '@openai/codex', version: mode === 'conflict' ? '1.0.2' : '1.0.10',
          dist: mode === 'missing' ? {} : { integrity: `${integrity} ${privateText}` },
        } },
      });
    },
  });
  const result = await discover('codex', { fetchImpl: wire.fetchImpl, now });
  expect(result.observation.reasons).toContain(mode === 'conflict' ? 'metadata_conflict' : 'npm_integrity_missing');
  expect(result.candidate).toBeNull();
  expect(JSON.stringify(result)).not.toContain(privateText);
});

test('charges revalidation bytes against the aggregate budget', async () => {
  const versions = Array.from({ length: 8 }, (_, i) => '1.0.' + (i + 1));
  const wire = fixture({
    etag: null, versions, latest: '1.0.8', githubLatest: release('1.0.8'),
    rewrite: (url, _attempt, _init, response) => {
      if (!url.pathname.includes('/releases/')) return response;
      const version = url.pathname.endsWith('/latest') ? '1.0.8' : url.pathname.split('/').at(-1)?.replace('rust-v', '');
      if (!version) throw new Error('synthetic_version_missing');
      const empty = { ...release(version), body: '' };
      return json({ ...empty, body: 'x'.repeat(32 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(empty))) });
    },
  });
  const result = await discover('codex', { fetchImpl: wire.fetchImpl, now, baseline: baseline('1.0.1') });
  expect(result.observation.reasons).toContain('total_limit');
  expect(result.candidate).toBeNull();
  expect(wire.counts.get('https://api.github.com/repos/openai/codex/releases/latest')).toBe(2);
}, 30000);

test('caps selected review references within the shared retrieval budget', async () => {
  const versions = Array.from({ length: 513 }, (_, index) => `1.0.${index}`);
  const pages = Array.from({ length: 6 }, (_, index) => versions.slice(index * 100, index * 100 + 100).map(version => release(version)));
  const wire = fixture({ versions, pages, latest: '1.0.512', githubLatest: release('1.0.512') });
  const result = await discover('codex', { fetchImpl: wire.fetchImpl, now, baseline: baseline('1.0.0') });
  expect(result.observation.reasons).toContain('reference_limit');
  expect(result.candidate).toBeNull();
});

test('keeps semantic candidate identity independent of time and upstream body layout', async () => {
  const firstWire = fixture();
  const secondWire = fixture({
    etag: null,
    rewrite: async (_url, _attempt, _init, response) => new Response(`${await response.text()}\n`),
  });
  const first = await discover('codex', { fetchImpl: firstWire.fetchImpl, now });
  const second = await discover('codex', { fetchImpl: secondWire.fetchImpl, now: () => '2026-10-25T00:00:00.000Z' });
  expect(first.candidate).toEqual(second.candidate);
  expect(first.observation.candidate_id).toBe(second.observation.candidate_id);
  expect(digest(first.observation)).not.toBe(digest(second.observation));
});

test('portable schemas reject recursively unknown fields and malformed identities', async () => {
  const wire = fixture();
  const result = await discover('codex', { fetchImpl: wire.fetchImpl, now });
  const candidate = result.candidate;
  const observation = result.observation;
  for (const input of [
    { ...candidate, private: privateText }, { ...candidate, target: '01.0.10' },
    { ...candidate, tag: 'v1.0.10' }, { ...candidate, release_id: Number.MAX_SAFE_INTEGER + 1 },
    { ...candidate, npm_integrity: `${integrity} ` }, { ...candidate, commit: privateText },
  ]) expect(candidateSchema.safeParse(input).success).toBe(false);
  for (const input of [
    { ...observation, private: privateText },
    { ...observation, heads: { ...observation.heads, private: privateText } },
    { ...observation, checks: observation.checks.map(row => ({ ...row, private: privateText })) },
    { ...observation, releases: observation.releases.map(row => ({ ...row, private: privateText })) },
    { ...observation, checks: [...observation.checks].reverse() },
    { ...observation, checks: Array.from({ length: 513 }, () => observation.checks[0]) },
    { ...observation, reasons: [privateText] },
    { ...observation, checked_at: privateText },
    { ...observation, candidate_id: null },
  ]) expect(observationSchema.safeParse(input).success).toBe(false);
  expect(observation.reasons.every(reason => discoveryReasonCodes.includes(reason))).toBe(true);
});
