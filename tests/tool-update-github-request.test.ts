import { afterEach, expect, test, vi } from 'vitest';
import { collectCodexSourceEvidence } from '../scripts/tool-update/difference-source.mjs';
import { discover } from '../scripts/tool-update/discovery.mjs';
import { runToolUpdate } from '../scripts/tool-update.mjs';
import { differenceJob } from './helpers/tool-update-difference-fixture.js';
import { sourceFixture, syntheticSchema } from './helpers/tool-update-source-fixture.js';
import { fixture, now } from './tool-update-discovery-fixture.js';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { differenceJobSchema } from '../scripts/tool-update/difference-records.mjs';
import { publishRecord } from '../scripts/tool-update/manifest.mjs';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

test('five version collection uses exactly 82 requests including six mutable revalidations', async () => {
  const base = differenceJob();
  const releases = Array.from({ length: 5 }, (_, i) => ({
    version: `0.${163 + i}.0`,
    commit: String(i + 1).repeat(40)
  }));
  const target = releases.at(-1);
  if (!target) throw new Error('synthetic_target_required');
  const job = {
    ...base,
    target,
    comparison: base.comparison && { ...base.comparison, to: target },
    inventory: { ...base.inventory, releases }
  };
  const wire = sourceFixture({
    job,
    annotated: true,
    change: (version, files) => {
      for (const [path, file] of files) {
        if (file.type === 'tree') {
          files.set(path, { ...file, value: version });
        }
        if (path.endsWith('config.schema.json')) {
          files.set(path, {
            ...file,
            value: JSON.stringify({
              ...syntheticSchema(),
              title: version
            })
          });
        }
      }
    }
  });
  const result = await collectCodexSourceEvidence(job, {
    fetch: wire.fetchImpl
  });
  expect(result.failure).toBeNull();
  expect(result.evidence).toHaveLength(10);
  expect(wire.calls).toHaveLength(82);
  expect(result.usage.responses).toBe(82);
  expect([...wire.counts].filter(([, count]) => count === 2)).toHaveLength(6);
  expect([...wire.counts].filter(([path]) => /\/git\/(?:trees|blobs|tags)\//.test(path)).every(([, count]) => count === 1)).toBe(true);
});

test.each([
  ['absent', undefined],
  ['empty', ''],
  ['present', 'synthetic-opt-in-token'],
  ['padded ASCII', 'AZaz09-._~+/==']
] as const)('token opt-in %s authenticates only GitHub and never npm', async (_label, token) => {
  vi.stubEnv('HARNESS_DELTA_GITHUB_TOKEN', token);
  vi.stubEnv('GITHUB_TOKEN', 'synthetic-ignored-token');
  const headers: {
    readonly host: string;
    readonly authorization: string | null;
  }[] = [];
  const wire = fixture({
    rewrite: (url, _attempt, init, response) => {
      headers.push({
        host: url.host,
        authorization: new Headers(init?.headers).get('authorization')
      });
      return response;
    }
  });
  const result = await discover('codex', {
    fetchImpl: wire.fetchImpl,
    now
  });
  expect(result.observation.result).toBe('metadata_reconciled');
  expect(headers.filter(row => row.host === 'registry.npmjs.org').map(row => row.authorization)).toEqual([null, null]);
  expect(headers.filter(row => row.host === 'api.github.com').map(row => row.authorization)).toEqual(
    Array.from({ length: 6 }, () => (token ? `Bearer ${token}` : null))
  );
});

test.each([
  ['space', 'space token'],
  ['CR', 'cr\rtoken'],
  ['LF', 'lf\ntoken']
] as const)('malformed %s token is refused before either transport fetches', async (_label, token) => {
  vi.stubEnv('HARNESS_DELTA_GITHUB_TOKEN', token);
  const source = sourceFixture();
  const discovery = fixture();
  const collected = await collectCodexSourceEvidence(source.job, {
    fetch: source.fetchImpl
  });
  const discovered = await discover('codex', {
    fetchImpl: discovery.fetchImpl,
    now
  });
  expect(collected.failure).toBe('source_identity_invalid');
  expect(discovered.observation.reasons).toContain('metadata_invalid');
  expect(source.calls).toHaveLength(0);
  expect(discovery.calls).toHaveLength(0);
  expect(JSON.stringify([collected, discovered])).not.toContain(token);
});

test('401 produces existing fixed failures without credential messages', async () => {
  const token = 'synthetic-refused-token';
  vi.stubEnv('HARNESS_DELTA_GITHUB_TOKEN', token);
  const source = sourceFixture({
    rewrite: () => new Response(token, { status: 401 })
  });
  const discovery = fixture({
    rewrite: () => new Response(token, { status: 401 })
  });
  const collected = await collectCodexSourceEvidence(source.job, {
    fetch: source.fetchImpl
  });
  const discovered = await discover('codex', {
    fetchImpl: discovery.fetchImpl,
    now
  });
  expect(collected.failure).toBe('source_http_error');
  expect(discovered.observation.reasons).toContain('http_error');
  expect(JSON.stringify([collected, discovered])).not.toContain(token);
});

test('opted-in headers are never sent to a refused cross-origin redirect', async () => {
  vi.stubEnv('HARNESS_DELTA_GITHUB_TOKEN', 'synthetic-redirect-token');
  const source = sourceFixture({
    rewrite: () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://elsewhere.invalid/resource' }
      })
  });
  const discovery = fixture({
    rewrite: () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://elsewhere.invalid/resource' }
      })
  });
  const collected = await collectCodexSourceEvidence(source.job, {
    fetch: source.fetchImpl
  });
  const discovered = await discover('codex', {
    fetchImpl: discovery.fetchImpl,
    now
  });
  expect(collected.failure).toBe('source_redirect_invalid');
  expect(discovered.observation.reasons).toContain('redirect_invalid');
  expect(source.calls.map(call => call.url.origin)).toEqual(['https://api.github.com']);
  expect(discovery.calls.map(call => new URL(call.url).origin)).toEqual(['https://api.github.com']);
});

async function outputBytes(root: string): Promise<readonly (readonly [string, Buffer])[]> {
  const files: [string, Buffer][] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      for (const [child, bytes] of await outputBytes(path)) {
        files.push([`${entry.name}/${child}`, bytes]);
      }
    } else files.push([entry.name, await readFile(path)]);
  }
  return files.sort(([a], [b]) => a.localeCompare(b));
}

test('published discovery and collector bytes exclude credentials and match without opt-in', async () => {
  const token = 'synthetic-published-secret-token';
  const roots = await Promise.all(Array.from({ length: 2 }, () => mkdtemp(join(realpathSync(tmpdir()), 'github-token-'))));
  const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  const outputs = [];
  try {
    for (const [index, root] of roots.entries()) {
      vi.stubEnv('HARNESS_DELTA_GITHUB_TOKEN', index === 0 ? undefined : token);
      const wire = fixture();
      const discoveryFetch: typeof fetch = (input, init) => wire.fetchImpl(String(input instanceof Request ? input.url : input), init);
      const discovery = await runToolUpdate(['discover', '--product', 'codex', '--out', root], { fetchImpl: discoveryFetch, now });
      expect(discovery.exitCode).toBe(0);
      const source = sourceFixture();
      const id = await publishRecord(root, source.job, differenceJobSchema);
      const sourceFetch: typeof fetch = (input, init) => source.fetchImpl(String(input instanceof Request ? input.url : input), init ?? {});
      const collection = await runToolUpdate(['collect-difference-evidence', '--job', join(root, 'difference-jobs', `${id}.json`), '--out', root], {
        fetchImpl: sourceFetch
      });
      expect(collection.exitCode).toBe(0);
      expect(source.calls.every(call => new Headers(call.init.headers).get('authorization') === (index === 0 ? null : `Bearer ${token}`))).toBe(true);
      outputs.push([discovery, collection]);
    }
    const first = await outputBytes(roots[0] ?? '');
    const second = await outputBytes(roots[1] ?? '');
    expect(second).toEqual(first);
    expect(second.map(([, bytes]) => bytes.toString('utf8')).join('')).not.toContain(token);
    expect(
      JSON.stringify({
        outputs,
        stdout: stdout.mock.calls,
        stderr: stderr.mock.calls
      })
    ).not.toContain(token);
  } finally {
    await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
  }
});
