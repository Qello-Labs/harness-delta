import { expect, test } from 'vitest';
import { collectClaudeDocumentationEvidence, collectCodexSourceEvidence } from '../scripts/tool-update/difference-source.mjs';
import { canonical, digest } from '../scripts/tool-update/manifest.mjs';
import { documentationWire } from './helpers/tool-update-claude-evidence-fixture.js';
import { sourceFixture, sourceJson } from './helpers/tool-update-source-fixture.js';

test('size-only repository changes preserve evidence bytes and IDs across initial and revalidation reads', async () => {
  const unchanged = sourceFixture();
  const expected = await collectCodexSourceEvidence(unchanged.job, { fetch: unchanged.fetchImpl });
  const wire = sourceFixture({
    rewrite: async (url, attempt, response) => {
      if (url.pathname !== '/repos/openai/codex') return response;
      const body: unknown = await response.json();
      if (!body || typeof body !== 'object') throw new Error('invalid_synthetic_repository');
      return sourceJson({ ...body, size: attempt === 1 ? 771008 : 770986 });
    }
  });

  const result = await collectCodexSourceEvidence(wire.job, { fetch: wire.fetchImpl });

  expect(result.failure).toBeNull();
  expect(result.evidence.map(record => [canonical(record), digest(record)])).toEqual(expected.evidence.map(record => [canonical(record), digest(record)]));
});

const malformedRepositoryBodies = [
  ['unparsable', '{', 'source_document_invalid'],
  ['null', 'null', 'source_identity_invalid'],
  ['array', '[]', 'source_identity_invalid'],
  ['missing fields', '{}', 'source_identity_invalid'],
  ['deep body', '['.repeat(10000) + '0' + ']'.repeat(10000), 'source_identity_invalid'],
  ['deep identity', '{"id":' + '['.repeat(10000) + '0' + ']'.repeat(10000) + '}', 'source_identity_invalid'],
  ['deep owner', '{"owner":' + '['.repeat(10000) + '0' + ']'.repeat(10000) + '}', 'source_identity_invalid']
] as const;

test.each([
  ['id', { id: 1 }],
  ['name', { name: 'other' }],
  ['full_name', { full_name: 'other/codex' }],
  ['owner.login', { owner: { login: 'other', id: 14957082 } }],
  ['owner.id', { owner: { login: 'openai', id: 1 } }],
  ['fork', { fork: true }]
] as const)('changed repository %s during revalidation discards all prior evidence', async (_field, change) => {
  const wire = sourceFixture({
    rewrite: async (url, attempt, response) => {
      if (url.pathname !== '/repos/openai/codex' || attempt !== 2) return response;
      const body: unknown = await response.json();
      if (!body || typeof body !== 'object') throw new Error('invalid_synthetic_repository');
      return sourceJson({ ...body, ...change });
    }
  });

  const result = await collectCodexSourceEvidence(wire.job, { fetch: wire.fetchImpl });

  expect(result.failure).toBe('source_identity_drift');
  expect(result.evidence.map(record => [record.availability, record.findings])).toEqual(Array.from({ length: 6 }, () => ['failed', []]));
});

test.each(malformedRepositoryBodies.flatMap(([name, text, initialFailure]) => [1, 2].map(boundary => ({ name, text, initialFailure, boundary }))))(
  '$name repository body fails closed at read $boundary',
  async ({ text, initialFailure, boundary }) => {
    const wire = sourceFixture({
      rewrite: (url, attempt, response) => (url.pathname === '/repos/openai/codex' && attempt === boundary ? new Response(text) : response)
    });

    const result = await collectCodexSourceEvidence(wire.job, { fetch: wire.fetchImpl });

    expect(result.failure).toBe(boundary === 1 ? initialFailure : 'source_identity_drift');
    expect(result.evidence.map(record => [record.availability, record.findings])).toEqual(Array.from({ length: 6 }, () => ['failed', []]));
  }
);

test('Claude repository whitespace drift still discards all prior evidence', async () => {
  const wire = documentationWire({
    rewrite: async (url, attempt, response) =>
      url.pathname === '/repos/anthropics/claude-code' && attempt === 2 ? new Response(`${await response.text()} `) : response
  });

  const result = await collectClaudeDocumentationEvidence(wire.job, { fetch: wire.fetchImpl });

  expect(result.failure).toBe('source_identity_drift');
  expect(result.evidence.map(record => [record.availability, record.findings])).toEqual(Array.from({ length: 3 }, () => ['failed', []]));
});
