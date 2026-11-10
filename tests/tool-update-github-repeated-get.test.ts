import { expect, test } from 'vitest';
import { collectCodexSourceEvidence } from '../scripts/tool-update/difference-source.mjs';
import { discover } from '../scripts/tool-update/discovery.mjs';
import { baseline, commit, fixture, json, now } from './tool-update-discovery-fixture.js';
import { differenceJob } from './helpers/tool-update-difference-fixture.js';
import { sourceFixture, sourceJson } from './helpers/tool-update-source-fixture.js';

test('repeated immutable annotated-object gets still detect in-job byte drift', async () => {
  const base = differenceJob();
  const commit = base.target.commit;
  const job = {
    ...base,
    baseline_row: base.baseline_row && { ...base.baseline_row, ref: { ...base.baseline_row.ref, commit } },
    parser_base: base.parser_base && { ...base.parser_base, commit },
    comparison: base.comparison && { ...base.comparison, from: { ...base.comparison.from, commit } },
    inventory: {
      ...base.inventory,
      releases: base.inventory.releases.map(ref => ({
        ...ref,
        commit
      }))
    }
  };
  const shared = 'f'.repeat(40);
  const wire = sourceFixture({
    job,
    annotated: true,
    rewrite: async (url, attempt, response) => {
      if (!url.pathname.includes('/git/tags/')) return response;
      if (url.pathname.endsWith(shared)) {
        const body = JSON.stringify({
          sha: shared,
          tag: 'shared',
          object: { type: 'commit', sha: commit }
        });
        return new Response(`${body}${attempt === 2 ? ' ' : ''}`);
      }
      const body: unknown = await response.json();
      if (!body || typeof body !== 'object') {
        throw new Error('synthetic_annotated_object_required');
      }
      return sourceJson({
        ...body,
        object: { type: 'tag', sha: shared }
      });
    }
  });
  const result = await collectCodexSourceEvidence(job, {
    fetch: wire.fetchImpl
  });
  expect(result.failure).toBe('source_identity_drift');
  expect(wire.counts.get(`https://api.github.com/repos/openai/codex/git/tags/${shared}`)).toBe(2);
  expect(result.evidence.every(record => record.availability === 'failed' && record.findings.length === 0)).toBe(true);
});

test.each([false, true])('shared annotated discovery object detects changed=%s bytes without extra reads', async changed => {
  const shared = 'f'.repeat(40);
  const wire = fixture({
    versions: ['1.0.1', '1.0.10'],
    etag: null,
    rewrite: (url, attempt, _init, response) => {
      if (url.pathname.includes('/git/ref/tags/')) {
        return json({ ref: `refs/tags/${url.pathname.split('/').at(-1)}`, object: { type: 'tag', sha: shared } });
      }
      if (url.pathname.endsWith(`/git/tags/${shared}`)) {
        return json({ sha: shared, object: { type: 'commit', sha: changed && attempt === 2 ? 'b'.repeat(40) : commit } });
      }
      return response;
    }
  });
  const result = await discover('codex', { fetchImpl: wire.fetchImpl, now, baseline: baseline('1.0.1') });
  expect(wire.counts.get(`https://api.github.com/repos/openai/codex/git/tags/${shared}`)).toBe(2);
  expect(wire.calls).toHaveLength(changed ? 8 : 14);
  if (changed) {
    expect(result.observation.result).toBe('discovery_incomplete');
    expect(result.observation.reasons).toContain('metadata_drift');
    expect(result.candidate).toBeNull();
    expect(result.observation.releases).toEqual([]);
  } else {
    expect(result.observation.result).toBe('metadata_reconciled');
    expect(result.observation.reasons).toEqual([]);
    expect(result.candidate?.commit).toBe(commit);
    expect(result.observation.releases.map(row => row.commit)).toEqual([commit, commit]);
  }
});
