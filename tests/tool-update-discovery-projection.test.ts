import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { discover } from '../scripts/tool-update/discovery.mjs';
import { transport } from '../scripts/tool-update/discovery-transport.mjs';
import { baseline, commit, fixture, integrity, json, now, release } from './tool-update-discovery-fixture.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const sources = ['github_latest', 'github_release'] as const;
const boundaries = ['repeated_get', 'revalidation'] as const;
const cases = sources.flatMap(source => boundaries.map(boundary => ({ source, boundary })));
const body = release('1.0.10');
const url = 'https://api.github.com/repos/openai/codex/releases/latest';
const expectedCandidate = {
  schema_version: 1,
  kind: 'candidate',
  product: 'codex',
  target: '1.0.10',
  release_id: 11,
  tag: 'rust-v1.0.10',
  commit,
  npm_integrity: integrity
};

test('keeps candidate identity through whitespace-only latest release changes without ETags', async () => {
  const wire = fixture({
    etag: null,
    rewrite: async (resource, attempt, _init, response) =>
      resource.pathname.endsWith('/latest') && attempt === 2 ? new Response(`${await response.text()} `) : response
  });
  const result = await discover('codex', { fetchImpl: wire.fetchImpl, now });
  expect(result.observation.result).toBe('metadata_reconciled');
  expect(result.candidate).toEqual(expectedCandidate);
});

test.each(sources)('keeps the same candidate and initial raw receipts through volatile %s changes', async source => {
  const version = source === 'github_latest' ? '1.0.10' : '1.0.1';
  const initial = { ...release(version), assets: [{ download_count: 1 }] };
  const wire = fixture({
    versions: ['1.0.1', '1.0.10'],
    rewrite: (resource, attempt, _init, response) => {
      const matches = source === 'github_latest' ? resource.pathname.endsWith('/latest') : resource.pathname.includes('/releases/tags/');
      return matches ? json({ ...release(version), assets: [{ download_count: attempt }] }, { etag: attempt === 1 ? '"first"' : '"later"' }) : response;
    }
  });
  const result = await discover('codex', { fetchImpl: wire.fetchImpl, now, baseline: baseline('1.0.1') });
  expect(result.observation.result).toBe('metadata_reconciled');
  expect(result.candidate).toEqual(expectedCandidate);
  expect(result.observation.checks.find(check => check.source === source)).toMatchObject({
    sha256: hash(JSON.stringify(initial)),
    validator: hash('"first"')
  });
});

test.each(cases)('accepts ignored fields and canonical ordering for $source at $boundary', async ({ source, boundary }) => {
  const values = [body, { tag_name: body.tag_name, id: body.id, prerelease: false, draft: false, assets: [{ download_count: 99 }] }];
  let index = 0;
  const io = transport(() => Promise.resolve(json(values[index++])), now, new AbortController().signal);
  await io.get(url, source, source === 'github_latest' ? '1' : '1.0.10');
  if (boundary === 'repeated_get') {
    await expect(io.get(url, source, source === 'github_latest' ? '1' : '1.0.10')).resolves.toHaveProperty('body', values[1]);
  } else {
    await expect(io.revalidate()).resolves.toBeUndefined();
  }
});

const mutations = [
  { field: 'id', value: 12 },
  { field: 'tag_name', value: 'rust-v1.0.11' },
  { field: 'draft', value: true },
  { field: 'prerelease', value: true },
  { field: 'id', value: null },
  { field: 'tag_name', value: null },
  { field: 'draft', value: null },
  { field: 'prerelease', value: null }
];
const drifts = cases.flatMap(entry => mutations.map(mutation => ({ ...entry, ...mutation })));

test.each(drifts)('rejects consumed $field=$value drift in $source at $boundary', async ({ source, boundary, field, value }) => {
  let count = 0;
  const io = transport(() => Promise.resolve(json(count++ === 0 ? body : { ...body, [field]: value })), now, new AbortController().signal);
  const key = source === 'github_latest' ? '1' : '1.0.10';
  await io.get(url, source, key);
  await expect(boundary === 'repeated_get' ? io.get(url, source, key) : io.revalidate()).rejects.toMatchObject({
    code: 'metadata_drift'
  });
});

const invalid = cases.flatMap(entry => ['{', 'null', '[]', '{}'].map(text => ({ ...entry, text })));
test.each(invalid)('fails closed for $text in $source at $boundary', async ({ source, boundary, text }) => {
  let count = 0;
  const io = transport(() => Promise.resolve(count++ === 0 ? json(body) : new Response(text)), now, new AbortController().signal);
  const key = source === 'github_latest' ? '1' : '1.0.10';
  await io.get(url, source, key);
  await expect(boundary === 'repeated_get' ? io.get(url, source, key) : io.revalidate()).rejects.toMatchObject({
    code: 'metadata_drift'
  });
});

const deepValues = [
  { shape: 'array', text: `${'['.repeat(10000)}0${']'.repeat(10000)}` },
  { shape: 'object', text: `${'{"nested":'.repeat(10000)}0${'}'.repeat(10000)}` }
];
const deepBodies = deepValues.flatMap(({ shape, text }) => [
  { shape, field: 'whole_body', text },
  ...['id', 'tag_name', 'draft', 'prerelease'].map(field => ({
    shape,
    field,
    text: `{${Object.entries(body)
      .map(([key, value]) => `${JSON.stringify(key)}:${key === field ? text : JSON.stringify(value)}`)
      .join(',')}}`
  }))
]);
const deepDrifts = cases.flatMap(entry => deepBodies.map(value => ({ ...entry, ...value })));

test.each(deepDrifts)('rejects deep $shape in $field with metadata_drift for $source at $boundary', async ({ source, boundary, text }) => {
  let count = 0;
  const io = transport(() => Promise.resolve(count++ === 0 ? json(body) : new Response(text)), now, new AbortController().signal);
  const key = source === 'github_latest' ? '1' : '1.0.10';
  await io.get(url, source, key);
  await expect(boundary === 'repeated_get' ? io.get(url, source, key) : io.revalidate()).rejects.toMatchObject({
    code: 'metadata_drift'
  });
});

const deepInitial = sources.flatMap(source => deepBodies.map(value => ({ source, ...value })));
test.each(deepInitial)('retains metadata_invalid and raw receipts for initial $source with deep $shape in $field', async ({ source, text }) => {
  const wire = fixture({
    versions: ['1.0.1', '1.0.10'],
    etag: null,
    rewrite: (resource, _attempt, _init, response) => {
      const matches = source === 'github_latest' ? resource.pathname.endsWith('/latest') : resource.pathname.includes('/releases/tags/');
      return matches ? new Response(text) : response;
    }
  });
  const result = await discover('codex', { fetchImpl: wire.fetchImpl, now, baseline: baseline('1.0.1') });
  expect(result.observation.reasons).toEqual(['metadata_invalid']);
  expect(result.candidate).toBeNull();
  expect(result.observation.checks.find(check => check.source === source)).toMatchObject({
    sha256: hash(text),
    validator: null
  });
});

test.each(boundaries)('keeps repository metadata raw-byte drift checks at %s', async boundary => {
  let count = 0;
  const io = transport(
    () => Promise.resolve(new Response(`${JSON.stringify({ id: 42, full_name: 'openai/codex' })}${count++ === 0 ? '' : ' '}`)),
    now,
    new AbortController().signal
  );
  await io.get('https://api.github.com/repos/openai/codex', 'github_repository', '1');
  await expect(
    boundary === 'repeated_get' ? io.get('https://api.github.com/repos/openai/codex', 'github_repository', '1') : io.revalidate()
  ).rejects.toMatchObject({ code: 'metadata_drift' });
});
