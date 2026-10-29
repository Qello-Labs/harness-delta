import { expect, test } from 'vitest';
import type { FixtureOptions } from './tool-update-discovery-fixture.js';
import { discover } from '../scripts/tool-update/discovery.mjs';
import { digest } from '../scripts/tool-update/manifest.mjs';
import { commit, integrity, privateText, now, json, release, baseline, fixture } from './tool-update-discovery-fixture.js';

test('reconciles the npm review range against exact GitHub releases and revalidates every identity', async () => {
  const wire = fixture({
    pages: [[release('1.0.10'), release('1.0.2')], [release('1.0.1'), release('1.0.2')]],
    versions: ['1.0.10', '1.0.1', '1.0.2'],
  });
  const result = await discover('codex', { fetchImpl: wire.fetchImpl, now, baseline: baseline('1.0.1') });
  expect(result.candidate).toEqual({
    schema_version: 1, kind: 'candidate', product: 'codex', target: '1.0.10',
    release_id: 11, tag: 'rust-v1.0.10', commit, npm_integrity: integrity,
  });
  expect(result.observation.result).toBe('metadata_reconciled');
  expect(result.observation.releases.map(row => row.version)).toEqual(['1.0.1', '1.0.2', '1.0.10']);
  expect(result.observation.candidate_id).toBe(digest(result.candidate));
  expect([...wire.counts.values()]).toEqual([2, 2, 2, 2, 2, 2, 2, 2]);
  expect(wire.calls.every(call => call.signal instanceof AbortSignal)).toBe(true);
  expect(wire.calls.filter(call => call.conditional !== null)).toHaveLength(8);
  expect(result.observation.checks.map(check => [check.source, check.key])).toEqual([
    ['github_latest', '1'], ['github_release', '1.0.1'], ['github_release', '1.0.2'], ['github_repository', '1'],
    ['github_tag', '1.0.1'], ['github_tag', '1.0.2'], ['github_tag', '1.0.10'], ['npm', '1'],
  ]);
});

test('keeps missing baseline explicit while checking only the official latest target', async () => {
  const wire = fixture({ pages: [[release('1.0.10')], [release('1.0.1')]] });
  const result = await discover('codex', { fetchImpl: wire.fetchImpl, now });
  expect(result.observation.reasons).toEqual(['baseline_missing']);
  expect(result.observation.releases.map(row => row.version)).toEqual(['1.0.10']);
  expect(result.observation.checks.filter(row => row.source === 'github_latest')).toHaveLength(1);
  expect(result.candidate?.target).toBe('1.0.10');
});

test('accepts canonical Claude tags without retaining upstream private fields', async () => {
  const wire = fixture({ product: 'claude_code', pages: [[{ ...release('1.0.10', 'claude_code'), tag_name: '1.0.10' }]], etag: privateText });
  const result = await discover('claude_code', { fetchImpl: wire.fetchImpl, now });
  expect(result.candidate?.tag).toBe('1.0.10');
  expect(JSON.stringify(result)).not.toContain(privateText);
  expect(JSON.stringify(result)).not.toMatch(/https?:|tarball|readme|description|opaque-validator/);
  expect(result.observation.checks.every(check => /^[a-f0-9]{64}$/.test(check.validator ?? ''))).toBe(true);
});

test('excludes draft prerelease suffixed malformed and wrong-product tags', async () => {
  const wire = fixture({
    pages: [[release('1.0.10'),
      { ...release('9.0.0'), draft: true }, { ...release('9.0.1'), prerelease: true },
      { ...release('9.0.2'), tag_name: 'rust-v9.0.2-beta.1' },
      { ...release('9.0.3'), tag_name: 'rust-v9.0.3+build' },
      { ...release('9.0.4'), tag_name: 'v9.0.4' },
      { ...release('9.0.5'), tag_name: privateText },
    ]],
    versions: ['1.0.10', '9.0.0-beta.1', '9.0.0+build'],
  });
  const result = await discover('codex', { fetchImpl: wire.fetchImpl, now });
  expect(result.candidate?.target).toBe('1.0.10');
  expect(result.observation.heads).toEqual({ github: '1.0.10', npm_latest: '1.0.10', npm_stable: '1.0.10' });
});

test.each([
  ['latest points below stable maximum', { latest: '1.0.2' }, 'npm_latest_mismatch'],
  ['latest contains a suffix', { latest: '1.0.10-beta' }, 'npm_latest_mismatch'],
  ['latest contains arbitrary private text', { latest: privateText }, 'npm_latest_mismatch'],
  ['GitHub and npm stable maxima differ', { pages: [[release('1.0.2')]] }, 'stable_head_mismatch'],
] satisfies readonly [string, FixtureOptions, string][])('reports release mismatch when %s', async (_name, options, reason) => {
  const wire = fixture(options);
  const result = await discover('codex', { fetchImpl: wire.fetchImpl, now });
  expect(result.candidate).toBeNull();
  expect(result.observation.result).toBe('release_mismatch');
  expect(result.observation.reasons).toContain(reason);
  expect(JSON.stringify(result)).not.toContain(privateText);
});

test.each([
  ['GitHub intermediate', { pages: [[release('1.0.1'), release('1.0.10')]] }, 'github_release_missing'],
  ['baseline reference', { versions: ['1.0.2', '1.0.10'] }, 'github_release_missing'],
] satisfies readonly [string, FixtureOptions, string][])('rejects interval missing %s', async (_name, options, reason) => {
  const wire = fixture(options);
  const result = await discover('codex', { fetchImpl: wire.fetchImpl, now, baseline: baseline('1.0.1') });
  expect(result.candidate).toBeNull();
  expect(result.observation.reasons).toContain(reason);
});

test.each([
  ['ahead', baseline('1.0.11'), 'baseline_ahead'],
  ['invalid', { ...baseline('1.0.1'), private: privateText }, 'baseline_invalid'],
  ['duplicate lane', { ...baseline('1.0.1'), rows: [...baseline('1.0.1').rows, ...baseline('1.0.1').rows] }, 'baseline_invalid'],
] satisfies readonly [string, unknown, string][])('rejects %s baselines', async (_name, input, reason) => {
  const wire = fixture();
  const result = await discover('codex', { fetchImpl: wire.fetchImpl, now, baseline: input });
  expect(result.candidate).toBeNull();
  expect(result.observation.reasons).toContain(reason);
  expect(JSON.stringify(result)).not.toContain(privateText);
});

test('pins an equal baseline without inventing interval releases', async () => {
  const wire = fixture();
  const result = await discover('codex', { fetchImpl: wire.fetchImpl, now, baseline: baseline('1.0.10') });
  expect(result.observation.releases.map(row => row.version)).toEqual(['1.0.10']);
  expect(result.observation.reasons).toEqual([]);
});

test.each([
  release('1.0.10', 'codex', 42),
  { ...release('1.0.1'), tag_name: '1.0.1' },
  { ...release('1.0.1'), id: 11 },
])('rejects contradictory exact release identity %#', async row => {
  const wire = fixture({ rewrite: (url, _attempt, _init, response) =>
    url.pathname.includes('/releases/tags/') && response.status === 200 ? json(row) : response });
  const result = await discover('codex', { fetchImpl: wire.fetchImpl, now, baseline: baseline('1.0.1') });
  expect(result.observation.result).toBe('metadata_conflict');
  expect(result.candidate).toBeNull();
});

test('labels the npm-only review universe instead of claiming full GitHub history', async () => {
  const wire = fixture({ versions: ['1.0.1', '1.0.10'], pages: [[release('1.0.1'), release('1.0.2'), release('1.0.10')]] });
  const result = await discover('codex', { fetchImpl: wire.fetchImpl, now, baseline: baseline('1.0.1') });
  expect(result.observation).toMatchObject({ schema_version: 2, inventory_scope: 'latest_and_npm_review_range' });
  expect(result.observation.releases.map(row => row.version)).toEqual(['1.0.1', '1.0.10']);
  expect(result.candidate?.target).toBe('1.0.10');
});

test('resolves annotated tags to exact commits and revalidates every peel', async () => {
  const tagSha = 'b'.repeat(40);
  const wire = fixture({
    rewrite: (url, _attempt, init, response) => {
      if (new Headers(init?.headers).has('if-none-match')) return response;
      if (url.pathname.includes('/git/ref/')) return json({ ref: 'refs/tags/rust-v1.0.10', object: { type: 'tag', sha: tagSha } });
      if (url.pathname.endsWith(`/git/tags/${tagSha}`)) return json({ sha: tagSha, object: { type: 'commit', sha: commit } });
      return response;
    },
  });
  const result = await discover('codex', { fetchImpl: wire.fetchImpl, now });
  expect(result.candidate?.commit).toBe(commit);
  expect(wire.calls.filter(row => row.url.includes('/git/tags/'))).toHaveLength(2);
  expect(result.observation.checks.filter(row => row.source === 'github_tag')).toHaveLength(1);
});

test.each([
  ['missing', () => new Response(privateText, { status: 404 }), 'tag_missing'],
  ['wrong ref', () => json({ ref: privateText, object: { type: 'commit', sha: commit } }), 'tag_invalid'],
  ['malformed SHA', () => json({ ref: 'refs/tags/rust-v1.0.10', object: { type: 'commit', sha: privateText } }), 'tag_invalid'],
  ['noncommit object', () => json({ ref: 'refs/tags/rust-v1.0.10', object: { type: 'tree', sha: commit } }), 'tag_invalid'],
] satisfies readonly [string, () => Response, string][])('rejects %s tag identity', async (_name, make, reason) => {
  const wire = fixture({ rewrite: (url, _attempt, _init, response) => url.pathname.includes('/git/ref/') ? make() : response });
  const result = await discover('codex', { fetchImpl: wire.fetchImpl, now });
  expect(result.candidate).toBeNull();
  expect(result.observation.reasons).toContain(reason);
  expect(JSON.stringify(result)).not.toContain(privateText);
});
