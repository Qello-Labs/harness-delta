import { afterEach, expect, test, vi } from 'vitest';
import { codexSourceLimits, collectClaudeDocumentationEvidence } from '../scripts/tool-update/difference-source.mjs';
import { judgeDifferences } from '../scripts/tool-update/difference-judgment.mjs';
import { parseDifferenceEvidence, parseDifferenceJudgment } from '../scripts/tool-update/difference-records.mjs';
import { currentIdentities } from './helpers/tool-update-difference-fixture.js';
import { claudeJob, documentationWire, privateMarker } from './helpers/tool-update-claude-evidence-fixture.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
test.each([false, true])('quiet pinned documentation authenticates and revalidates without claiming unchanged, annotated=%s', async annotated => {
  const wire = documentationWire({ annotated });
  const result = await collectClaudeDocumentationEvidence(wire.job, {
    fetch: wire.fetchImpl
  });
  const judgment = parseDifferenceJudgment(judgeDifferences(wire.job, result.evidence, currentIdentities));
  expect(result.failure).toBeNull();
  expect(result.evidence.map(record => [record.comparison.comparison_kind, record.comparison.from.version, record.comparison.to.version])).toEqual([
    ['adjacent_release', '2.1.306', '2.1.307'],
    ['adjacent_release', '2.1.307', '2.1.308'],
    ['parser_base', '2.1.306', '2.1.308']
  ]);
  expect(result.evidence.flatMap(record => record.findings).every(row => row.result === 'unknown')).toBe(true);
  expect(judgment.groups.map(group => group.result)).toEqual(Array.from({ length: 8 }, () => 'unknown'));
  expect([...wire.counts.values()].every(count => count === 2)).toBe(true);
  expect(new Set(wire.calls.map(url => url.host))).toEqual(new Set(['api.github.com']));
  expect(result.evidence.every(record => parseDifferenceEvidence(record).to_content_hash !== null)).toBe(true);
});
test('a documented removal contradicts only the consumed identity guarantee and only its release interval', async () => {
  const wire = documentationWire({
    lines: {
      '2.1.308': '- Removed `requestId` from assistant transcript records.'
    }
  });
  const result = await collectClaudeDocumentationEvidence(wire.job, {
    fetch: wire.fetchImpl
  });
  expect(result.evidence.map(record => record.findings.filter(row => row.result === 'affected').map(row => [row.contract_id, row.facet]))).toEqual([
    [],
    [['identity_source_mapping', 'serialized_shape']],
    [['identity_source_mapping', 'serialized_shape']]
  ]);
  const judgment = judgeDifferences(wire.job, result.evidence, currentIdentities);
  expect(judgment.groups.map(group => group.result)).toEqual(['affected', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown']);
  expect(judgment.groups[0]?.required_validation).toContain('source_review');
});
test.each([
  ['- synthetic permission adjustment', 'invocation_permissions_config_model_effort'],
  ['- synthetic cache adjustment', 'counters_cache_reasoning_reset_overflow'],
  ['- synthetic hook adjustment', 'hooks_order_receipts_loading'],
  ['- synthetic compaction adjustment', 'history_topology_resume_compaction'],
  ['- synthetic checkpoint adjustment', 'partial_rotation_checkpoint'],
  ['- synthetic terminal adjustment', 'finality_replay_conflict_stop_flush_sigint'],
  ['- synthetic field adjustment', 'fields_types_enums'],
  ['- synthetic request_id adjustment', 'identity_source_mapping']
])('disclosure %s requests only its mapped contract check', async (line, contractId) => {
  const wire = documentationWire({ lines: { '2.1.308': line } });
  const result = await collectClaudeDocumentationEvidence(wire.job, {
    fetch: wire.fetchImpl
  });
  expect(result.evidence[2]?.findings.filter(row => row.reason === 'documentation_check_required').map(row => row.contract_id)).toEqual([contractId]);
  expect(result.evidence.flatMap(record => record.findings).every(row => row.result === 'unknown')).toBe(true);
});
test.each([
  ['negated', '- Never removed `requestId` from assistant transcript records.'],
  ['quotation', '> - Removed `requestId` from assistant transcript records.'],
  ['example', 'Example: - Removed `requestId` from assistant transcript records.'],
  ['fenced example', '```text\n- Removed `requestId` from assistant transcript records.\n```'],
  ['commented example', '<!--\n- Removed `requestId` from assistant transcript records.\n-->']
])('%s disclosure cannot confirm a contradiction', async (_name, line) => {
  const wire = documentationWire({ lines: { '2.1.308': line } });
  const result = await collectClaudeDocumentationEvidence(wire.job, {
    fetch: wire.fetchImpl
  });
  expect(judgeDifferences(wire.job, result.evidence, currentIdentities).groups.every(group => group.result === 'unknown')).toBe(true);
});
test.each([
  ['unavailable', 'source_material_absent'],
  ['truncated', 'source_fetch_failed'],
  ['drifted', 'source_identity_drift'],
  ['oversized', 'source_document_limit'],
  ['wrong repository', 'source_identity_invalid'],
  ['wrong commit', 'source_commit_mismatch'],
  ['truncated tree', 'source_identity_invalid'],
  ['changed blob', 'source_identity_invalid'],
  ['cross-host redirect', 'source_redirect_invalid'],
  ['rate limit', 'source_rate_limited']
])('%s documentation discards prior success with fixed failure %s', async (state, failure) => {
  const wire = documentationWire({
    rewrite: (url, attempt, response) => {
      if (state === 'wrong repository' && url.pathname.endsWith('claude-code')) {
        return new Response(
          JSON.stringify({
            id: 937253475,
            name: 'claude-code',
            full_name: 'other/claude-code',
            owner: { login: 'anthropics', id: 76263028 },
            fork: false
          })
        );
      }
      if (state === 'wrong commit' && url.pathname.includes('/git/ref/')) {
        return new Response(
          JSON.stringify({
            ref: `refs/tags/${url.pathname.split('/').at(-1)}`,
            object: { type: 'commit', sha: '9'.repeat(40) }
          })
        );
      }
      if (state === 'truncated tree' && url.pathname.includes('/git/trees/')) {
        return new Response(
          JSON.stringify({
            sha: url.pathname.split('/').at(-1),
            truncated: true,
            tree: []
          })
        );
      }
      if (!url.pathname.includes('/git/blobs/')) return response;
      switch (state) {
        case 'unavailable':
          return new Response(null, { status: 404 });
        case 'truncated':
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error(privateMarker));
              }
            })
          );
        case 'drifted':
          return attempt === 2 ? new Response(privateMarker) : response;
        case 'oversized':
          return new Response(privateMarker, {
            headers: {
              'content-length': String(codexSourceLimits.documentBytes + 1)
            }
          });
        case 'changed blob':
          return new Response(privateMarker);
        case 'cross-host redirect':
          return new Response(null, {
            status: 307,
            headers: {
              location: 'https://example.invalid/source'
            }
          });
        case 'rate limit':
          return new Response(null, { status: 429 });
        default:
          return response;
      }
    }
  });
  const result = await collectClaudeDocumentationEvidence(wire.job, {
    fetch: wire.fetchImpl
  });
  expect(result.failure).toBe(failure);
  expect(result.evidence.every(record => record.availability === 'failed' && record.findings.length === 0)).toBe(true);
  expect(judgeDifferences(wire.job, result.evidence, currentIdentities).groups.every(group => group.result === 'unknown')).toBe(true);
  expect(JSON.stringify(result)).not.toContain(privateMarker);
});
test('unversioned documentation retains only context hash and time, with no release attribution', async () => {
  const wire = documentationWire();
  const result = await collectClaudeDocumentationEvidence(wire.job, {
    fetch: wire.fetchImpl,
    documentation: 'unversioned_doc'
  });
  expect(result.failure).toBeNull();
  expect(result.documents).toHaveLength(1);
  expect(result.documents[0]).toMatchObject({
    path_id: 'release_documentation',
    release: null,
    limitation: 'unversioned_doc'
  });
  expect(result.documents[0]?.content_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(result.documents[0]?.fetched_at).toMatch(/^\d{4}-\d\d-\d\dT/);
  expect(
    result.evidence.every(record => record.reasons.includes('unversioned_doc') && record.from_content_hash === null && record.to_content_hash === null)
  ).toBe(true);
  expect(judgeDifferences(wire.job, result.evidence, currentIdentities).groups.every(group => group.result === 'unknown')).toBe(true);
  expect(JSON.stringify(result)).not.toContain(privateMarker);
});
test('a missing or unsupported exact-version section cannot extract a release claim', async () => {
  const wire = documentationWire({
    lines: { '2.1.308': '## moving-section\n- synthetic cache adjustment' }
  });
  const result = await collectClaudeDocumentationEvidence(wire.job, {
    fetch: wire.fetchImpl
  });
  expect(result.failure).toBeNull();
  expect(result.evidence.filter(record => record.comparison.to.version === '2.1.308').every(record => record.extraction_completeness === 'incomplete')).toBe(
    true
  );
  expect(judgeDifferences(wire.job, result.evidence, currentIdentities).groups.every(group => group.result === 'unknown')).toBe(true);
});
test('same-resource numeric repository redirects preserve pinned evidence', async () => {
  const wire = documentationWire({
    rewrite: (url, _attempt, response) =>
      url.pathname.includes('/repos/anthropics/claude-code/git/')
        ? new Response(null, {
            status: 307,
            headers: {
              location: url.pathname.replace('/repos/anthropics/claude-code', '/repositories/937253475')
            }
          })
        : response
  });
  const result = await collectClaudeDocumentationEvidence(wire.job, {
    fetch: wire.fetchImpl
  });
  expect(result.failure).toBeNull();
  expect(result.evidence).toHaveLength(3);
});
test('caller-controlled paths are rejected before transport effects', async () => {
  const fetchImpl = vi.fn<Parameters<typeof collectClaudeDocumentationEvidence>[1]['fetch']>();
  const options = { fetch: fetchImpl, paths: ['private'] };
  await expect(collectClaudeDocumentationEvidence(claudeJob(), options)).rejects.toThrow('source_options_invalid');
  expect(fetchImpl).not.toHaveBeenCalled();
});
test('unversioned documentation drift discards the context receipt as well as release claims', async () => {
  const wire = documentationWire({
    rewrite: (url, attempt, response) => (url.pathname.includes('/contents/') && attempt === 2 ? new Response('synthetic changed context') : response)
  });
  const result = await collectClaudeDocumentationEvidence(wire.job, {
    fetch: wire.fetchImpl,
    documentation: 'unversioned_doc'
  });
  expect(result.failure).toBe('source_identity_drift');
  expect(result.documents).toEqual([]);
  expect(result.evidence.every(record => record.availability === 'failed')).toBe(true);
});
test('pre-aborted Claude collection performs zero transport operations', async () => {
  const fetchImpl = vi.fn<Parameters<typeof collectClaudeDocumentationEvidence>[1]['fetch']>();
  const result = await collectClaudeDocumentationEvidence(claudeJob(), {
    fetch: fetchImpl,
    signal: AbortSignal.abort()
  });
  expect(result.failure).toBe('source_deadline');
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(result.evidence.every(record => record.availability === 'failed')).toBe(true);
});
