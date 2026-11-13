import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexContractDescriptors, codexSourcePaths } from '../scripts/tool-update/difference-contracts.mjs';
import { codexSourceLimits, collectCodexSourceEvidence } from '../scripts/tool-update/difference-source.mjs';
import type { CodexSourceResult } from '../scripts/tool-update/difference-source.mjs';
import { judgeDifferences } from '../scripts/tool-update/difference-judgment.mjs';
import {
  differenceEvidenceSchema,
  differenceJudgmentSchema,
  parseDifferenceEvidence,
  parseDifferenceJob,
  parseDifferenceJudgment
} from '../scripts/tool-update/difference-records.mjs';
import { canonical, loadRecord, publishRecord, ToolUpdateError } from '../scripts/tool-update/manifest.mjs';
import { currentIdentities, differenceJob } from './helpers/tool-update-difference-fixture.js';
import { sourceFixture, sourceJson, sourcePrivateText, syntheticSchema } from './helpers/tool-update-source-fixture.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function noPass(result: CodexSourceResult) {
  expect(result.evidence).toHaveLength(6);
  expect(result.evidence.flatMap(record => record.findings).filter(finding => finding.result === 'unaffected')).toEqual([]);
  expect(judgeDifferences(differenceJob(), result.evidence, currentIdentities).groups.every(group => group.result !== 'unaffected')).toBe(true);
}
test.each([false, true])('identical complete closures establish only client facets with annotated=%s', async annotated => {
  const wire = sourceFixture({ annotated, etag: true });
  const result = await collectCodexSourceEvidence(wire.job, {
    fetch: wire.fetchImpl
  });
  const judgment = judgeDifferences(wire.job, result.evidence, currentIdentities);
  expect(result.failure).toBeNull();
  expect(judgment.groups.map(group => [group.contract_id, group.result])).toEqual([
    ['identity_source_mapping', 'unknown'],
    ['fields_types_enums', 'unaffected'],
    ['partial_rotation_checkpoint', 'unknown'],
    ['counters_cache_reasoning_reset_overflow', 'unknown'],
    ['hooks_order_receipts_loading', 'unknown'],
    ['invocation_permissions_config_model_effort', 'unknown'],
    ['history_topology_resume_compaction', 'unaffected'],
    ['finality_replay_conflict_stop_flush_sigint', 'unknown']
  ]);
  expect(
    judgment.groups
      .flatMap(group => group.facets)
      .filter(facet => ['native_execution', 'backend_counter_meaning'].includes(facet.facet))
      .every(facet => facet.result === 'unknown')
  ).toBe(true);
  expect([...wire.counts].every(([path, count]) => count === (path.includes('/git/ref/') || path.endsWith('/codex') ? 2 : 1))).toBe(true);
  expect(new Set(wire.calls.map(call => call.url.host))).toEqual(new Set(['api.github.com']));
  expect(wire.calls.every(call => call.init.redirect === 'manual' && call.init.signal instanceof AbortSignal)).toBe(true);
});
test('collects every adjacent edge and cumulative comparison and publishes a parsed judgment only in a temporary root', async () => {
  const wire = sourceFixture();
  const result = await collectCodexSourceEvidence(wire.job, {
    fetch: wire.fetchImpl
  });
  expect(
    result.evidence.map(record => [record.method, record.comparison.comparison_kind, record.comparison.from.version, record.comparison.to.version])
  ).toEqual([
    ['codex_source_identity', 'adjacent_release', '0.163.0', '0.164.0'],
    ['serialized_schema', 'adjacent_release', '0.163.0', '0.164.0'],
    ['codex_source_identity', 'adjacent_release', '0.164.0', '0.165.0'],
    ['serialized_schema', 'adjacent_release', '0.164.0', '0.165.0'],
    ['codex_source_identity', 'parser_base', '0.163.0', '0.165.0'],
    ['serialized_schema', 'parser_base', '0.163.0', '0.165.0']
  ]);
  const judgment = parseDifferenceJudgment(judgeDifferences(wire.job, result.evidence, currentIdentities));
  const root = await mkdtemp(join(realpathSync(tmpdir()), 'difference-source-'));
  try {
    for (const evidence of result.evidence) {
      expect(parseDifferenceEvidence(evidence)).toEqual(evidence);
      await publishRecord(root, evidence, differenceEvidenceSchema);
    }
    const published = await publishRecord(root, judgment, differenceJudgmentSchema);
    expect(await loadRecord(join(root, 'difference-judgments', `${published}.json`), differenceJudgmentSchema)).toEqual(judgment);
    expect(judgment.coverage_reasons).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test.each([
  ['workspace implementation', 'codex-rs/protocol', 'source_changed_impact_unknown'],
  ['dependency lock', 'codex-rs/Cargo.lock', 'source_changed_impact_unknown'],
  ['missing dependency', 'codex-rs/Cargo.lock', 'unresolved_dependency'],
  ['unsupported workspace', 'codex-rs/protocol', 'unsupported_extractor'],
  ['missing schema', 'codex-rs/core/config.schema.json', 'unsupported_extractor']
] as const)('%s gaps never establish unchanged behavior', async (name, path, reason) => {
  const wire = sourceFixture({
    change: (version, files) => {
      if (version !== '0.165.0') return;
      if (name.startsWith('missing') || name.startsWith('unsupported')) {
        files.delete(path);
      } else {
        const file = files.get(path);
        if (!file) throw new Error('invalid_synthetic_path');
        files.set(path, {
          ...file,
          value: 'different-synthetic-identity'
        });
      }
    }
  });
  const result = await collectCodexSourceEvidence(wire.job, {
    fetch: wire.fetchImpl
  });
  expect(result.failure).toBeNull();
  const target = result.evidence.filter(record => record.comparison.to.version === '0.165.0' && record.method === 'codex_source_identity');
  expect(target).toHaveLength(2);
  for (const record of target) {
    expect(record.findings).toContainEqual({
      contract_id: 'fields_types_enums',
      facet: 'serialized_shape',
      result: 'unknown',
      reason,
      impact: 'undetermined',
      field_id: null,
      expected: null,
      actual: null
    });
  }
  expect(target.flatMap(record => record.findings).every(finding => finding.result === 'unknown' && finding.reason === reason)).toBe(true);
  expect(judgeDifferences(wire.job, result.evidence, currentIdentities).groups.every(group => group.result === 'unknown')).toBe(true);
});
test('unconsumed root documentation changes preserve consumed results without fetching its body', async () => {
  const wire = sourceFixture({
    change: (version, files) => {
      files.set('README.md', { type: 'blob', value: version });
    }
  });
  const result = await collectCodexSourceEvidence(wire.job, {
    fetch: wire.fetchImpl
  });
  expect(result.failure).toBeNull();
  expect(result.evidence).toHaveLength(6);
  expect(result.evidence[0]?.findings).toContainEqual({
    contract_id: 'fields_types_enums',
    facet: 'serialized_shape',
    result: 'unaffected',
    reason: 'established_unchanged',
    impact: 'none_established',
    field_id: null,
    expected: null,
    actual: null
  });
  expect(
    result.evidence
      .filter(record => record.method === 'codex_source_identity')
      .flatMap(record => record.findings)
      .every(finding => finding.result === 'unaffected')
  ).toBe(true);
});
test.each([
  [
    'field removal',
    (schema: ReturnType<typeof syntheticSchema>) => {
      Reflect.deleteProperty(schema.properties, 'model');
    },
    'model',
    'string',
    'absent'
  ],
  [
    'field type',
    (schema: ReturnType<typeof syntheticSchema>) => {
      schema.properties.model.type = 'integer';
    },
    'model',
    'string',
    'integer'
  ],
  [
    'consumed enum',
    (schema: ReturnType<typeof syntheticSchema>) => {
      schema.definitions.Permission.enum = ['read-only'];
    },
    'permission_mode',
    'string_enum',
    'string_enum'
  ]
] as const)('%s establishes affected serialized shape with independent expected facts', async (_name, change, fieldId, expected, actual) => {
  const wire = sourceFixture({
    change: (version, files) => {
      if (version !== '0.165.0') return;
      const schema = syntheticSchema();
      change(schema);
      files.set('codex-rs/core/config.schema.json', {
        type: 'blob',
        value: JSON.stringify(schema)
      });
    }
  });
  const result = await collectCodexSourceEvidence(wire.job, {
    fetch: wire.fetchImpl
  });
  const judgment = judgeDifferences(wire.job, result.evidence, currentIdentities);
  expect(result.failure).toBeNull();
  expect(
    result.evidence.filter(record => record.method === 'serialized_schema' && record.comparison.to.version === '0.165.0').flatMap(record => record.findings)
  ).toEqual(
    Array.from({ length: 2 }, () => ({
      contract_id: 'invocation_permissions_config_model_effort',
      facet: 'serialized_shape',
      result: 'affected',
      reason: 'confirmed_contract_change',
      impact: 'shape_changed',
      field_id: fieldId,
      expected: { kind: 'field_shape', value: expected },
      actual: { kind: 'field_shape', value: actual }
    }))
  );
  expect(judgment.groups.find(group => group.contract_id === 'invocation_permissions_config_model_effort')?.result).toBe('affected');
});
test.each([
  [
    'unsupported effort',
    {
      anyOf: [{ type: 'string' }, { type: 'null' }]
    }
  ],
  ['unresolved effort', { $ref: '#/definitions/Missing' }]
] as const)('mixed supported model change and %s preserve the established contradiction', async (_name, effort) => {
  const wire = sourceFixture({
    change: (version, files) => {
      if (version !== '0.165.0') return;
      const schema = syntheticSchema();
      files.set('codex-rs/core/config.schema.json', {
        type: 'blob',
        value: JSON.stringify({
          ...schema,
          properties: {
            ...schema.properties,
            model: { type: 'integer' },
            model_reasoning_effort: effort
          }
        })
      });
    }
  });
  const result = await collectCodexSourceEvidence(wire.job, {
    fetch: wire.fetchImpl
  });
  const judgment = judgeDifferences(wire.job, result.evidence, currentIdentities);
  expect(result.failure).toBeNull();
  expect(
    result.evidence.filter(record => record.method === 'serialized_schema' && record.comparison.to.version === '0.165.0').flatMap(record => record.findings)
  ).toEqual(
    Array.from({ length: 2 }, () => ({
      contract_id: 'invocation_permissions_config_model_effort',
      facet: 'serialized_shape',
      result: 'affected',
      reason: 'confirmed_contract_change',
      impact: 'shape_changed',
      field_id: 'model',
      expected: { kind: 'field_shape', value: 'string' },
      actual: { kind: 'field_shape', value: 'integer' }
    }))
  );
  expect(judgment.groups.find(group => group.contract_id === 'invocation_permissions_config_model_effort')?.result).toBe('affected');
});
test.each([
  [{ type: 'string' }, { type: 'string', minLength: 0 }],
  [
    { type: 'string', enum: ['a'], pattern: '^a$' },
    {
      type: 'string',
      enum: ['a', 'b'],
      pattern: '^a$'
    }
  ],
  [
    { type: 'integer', minimum: 0, maximum: 0 },
    {
      type: 'number',
      minimum: 0,
      maximum: 0
    }
  ]
])('neutral accepted-value differences never establish a consumed contradiction: %j to %j', async (before, after) => {
  const wire = sourceFixture({
    change: (version, files) => {
      const schema = syntheticSchema();
      files.set('codex-rs/core/config.schema.json', {
        type: 'blob',
        value: JSON.stringify({
          ...schema,
          properties: {
            ...schema.properties,
            model: version === '0.165.0' ? after : before
          }
        })
      });
    }
  });
  const result = await collectCodexSourceEvidence(wire.job, {
    fetch: wire.fetchImpl
  });
  const judgment = judgeDifferences(wire.job, result.evidence, currentIdentities);
  const findings = result.evidence.flatMap(record => record.findings);
  expect(result.failure).toBeNull();
  expect(findings.some(finding => finding.result === 'affected' || finding.reason === 'confirmed_contract_change')).toBe(false);
  expect(judgment.groups.find(group => group.contract_id === 'invocation_permissions_config_model_effort')?.result).toBe('unknown');
});
test('a newly required supported field establishes its consumed schema change', async () => {
  const wire = sourceFixture({
    change: (version, files) => {
      if (version !== '0.165.0') return;
      files.set('codex-rs/core/config.schema.json', {
        type: 'blob',
        value: JSON.stringify({
          ...syntheticSchema(),
          required: ['model']
        })
      });
    }
  });
  const result = await collectCodexSourceEvidence(wire.job, {
    fetch: wire.fetchImpl
  });
  const judgment = judgeDifferences(wire.job, result.evidence, currentIdentities);
  expect(result.failure).toBeNull();
  expect(judgment.groups.find(group => group.contract_id === 'invocation_permissions_config_model_effort')?.result).toBe('affected');
});
test.each([
  ['unresolved reference', { $ref: '#/definitions/Missing' }, 'unresolved_dependency'],
  [
    'unsupported Rust-only schema',
    {
      anyOf: [{ type: 'string' }, { type: 'null' }]
    },
    'unsupported_extractor'
  ]
])('%s is unknown even with identical source identities', async (_name, shape, reason) => {
  const wire = sourceFixture({
    change: (_version, files) => {
      const schema = {
        ...syntheticSchema(),
        properties: {
          ...syntheticSchema().properties,
          model: shape
        }
      };
      files.set('codex-rs/core/config.schema.json', {
        type: 'blob',
        value: JSON.stringify(schema)
      });
    }
  });
  const result = await collectCodexSourceEvidence(wire.job, {
    fetch: wire.fetchImpl
  });
  const schemas = result.evidence.filter(record => record.method === 'serialized_schema');
  expect(schemas).toHaveLength(3);
  for (const record of schemas) {
    expect(record.findings).toEqual([
      {
        contract_id: 'invocation_permissions_config_model_effort',
        facet: 'serialized_shape',
        result: 'unknown',
        reason,
        impact: 'undetermined',
        field_id: null,
        expected: null,
        actual: null
      }
    ]);
  }
  expect(
    judgeDifferences(wire.job, result.evidence, currentIdentities).groups.find(group => group.contract_id === 'invocation_permissions_config_model_effort')
      ?.result
  ).toBe('unknown');
});
test('only hashes and finite facts escape transport, never upstream text, URLs, paths or validators', async () => {
  const liveFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('live_network_forbidden'));
  const wire = sourceFixture({ etag: true });
  const result = await collectCodexSourceEvidence(wire.job, {
    fetch: wire.fetchImpl
  });
  expect(result.failure).toBeNull();
  expect(JSON.stringify(result)).not.toContain(sourcePrivateText);
  expect(JSON.stringify(result)).not.toMatch(/https?:|config\.schema|codex-rs|synthetic-etag/);
  expect(result.evidence.every(record => parseDifferenceEvidence(record))).toBe(true);
  expect(liveFetch).not.toHaveBeenCalled();
});
test.each([
  ['empty', () => new Response(''), 'source_document_invalid'],
  [
    'untrusted error code',
    () => {
      throw new ToolUpdateError(sourcePrivateText);
    },
    'source_fetch_failed'
  ],
  [
    'failed',
    () => {
      throw new Error(sourcePrivateText);
    },
    'source_fetch_failed'
  ],
  ['rate limited 403', () => new Response(null, { status: 403 }), 'source_rate_limited'],
  ['rate limited 429', () => new Response(null, { status: 429 }), 'source_rate_limited'],
  ['HTTP failure', () => new Response(null, { status: 500 }), 'source_http_error'],
  ['absent', () => new Response(null, { status: 404 }), 'source_material_absent'],
  ['invalid JSON', () => new Response('{'), 'source_document_invalid'],
  ['wrong numeric identity', () => sourceJson({ id: 1 }), 'source_identity_invalid'],
  [
    'oversize declared',
    () =>
      new Response('x', {
        headers: { 'content-length': String(4 * 1024 * 1024 + 1) }
      }),
    'source_document_limit'
  ],
  ['oversize decoded', () => new Response('x'.repeat(4 * 1024 * 1024 + 1)), 'source_document_limit'],
  [
    'off-origin redirect',
    () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://invalid.example/private' }
      }),
    'source_redirect_invalid'
  ],
  [
    'changed resource',
    () =>
      new Response(null, {
        status: 302,
        headers: {
          location: '/repos/openai/codex/git/ref/heads/main'
        }
      }),
    'source_redirect_invalid'
  ],
  [
    'redirect loop',
    (url: URL) =>
      new Response(null, {
        status: 302,
        headers: { location: url.href }
      }),
    'source_redirect_invalid'
  ]
] satisfies readonly [string, (url: URL) => Response, string][])('%s is a fixed failure with no unaffected evidence', async (_name, rewrite, failure) => {
  const wire = sourceFixture({ rewrite: url => rewrite(url) });
  const result = await collectCodexSourceEvidence(wire.job, {
    fetch: wire.fetchImpl
  });
  expect(result.failure).toBe(failure);
  expect(wire.calls).toHaveLength(1);
  noPass(result);
});
test.each([
  ['tag drift', '/git/ref/tags/', 'source_identity_drift'],
  ['repository drift', '/repos/openai/codex', 'source_identity_drift'],
  ['late tag drift', '/git/ref/tags/rust-v0.165.0', 'source_identity_drift']
] as const)('%s during revalidation discards all earlier successes', async (_name, path, failure) => {
  const wire = sourceFixture({
    rewrite: async (url, attempt, response) => (url.pathname.includes(path) && attempt === 2 ? new Response(`${await response.text()} `) : response)
  });
  const result = await collectCodexSourceEvidence(wire.job, {
    fetch: wire.fetchImpl
  });
  expect(result.failure).toBe(failure);
  noPass(result);
});
test.each([
  [
    'truncated tree',
    (body: unknown) => {
      if (!body || typeof body !== 'object') {
        throw new Error('invalid_synthetic_tree');
      }
      return { ...body, truncated: true };
    },
    'source_identity_invalid'
  ],
  [
    'empty tree',
    (body: unknown) => {
      if (!body || typeof body !== 'object') {
        throw new Error('invalid_synthetic_tree');
      }
      return { ...body, tree: [] };
    },
    'source_identity_invalid'
  ],
  [
    'wrong commit',
    () => ({
      ref: 'refs/tags/rust-v0.163.0',
      object: { type: 'commit', sha: '9'.repeat(40) }
    }),
    'source_commit_mismatch'
  ],
  [
    'moving ref',
    () => ({
      ref: 'refs/heads/main',
      object: { type: 'commit', sha: '1'.repeat(40) }
    }),
    'source_identity_invalid'
  ]
] satisfies readonly [string, (body: unknown) => unknown, string][])('%s never produces an unaffected result', async (name, change, failure) => {
  const wire = sourceFixture({
    rewrite: async (url, _attempt, response) => {
      const matches = name.includes('tree') ? url.pathname.includes('/git/trees/') : url.pathname.includes('/git/ref/');
      return matches ? sourceJson(change(await response.json())) : response;
    }
  });
  const result = await collectCodexSourceEvidence(wire.job, {
    fetch: wire.fetchImpl
  });
  expect(result.failure).toBe(failure);
  noPass(result);
});
test('same-resource numeric repository redirects succeed without changing hosts or refs', async () => {
  const wire = sourceFixture({
    rewrite: (url, _attempt, response) =>
      url.pathname.includes('/repos/openai/codex/git/')
        ? new Response(null, {
            status: 307,
            headers: {
              location: url.pathname.replace('/repos/openai/codex', '/repositories/965415649')
            }
          })
        : response
  });
  const result = await collectCodexSourceEvidence(wire.job, {
    fetch: wire.fetchImpl
  });
  expect(result.failure).toBeNull();
  expect(new Set(wire.calls.map(call => call.url.host))).toEqual(new Set(['api.github.com']));
});
test('decoded job bytes include revalidation and stop at the fixed cumulative limit', async () => {
  const wire = sourceFixture({
    rewrite: async (url, _attempt, response) => {
      if (response.status !== 200 || url.pathname.includes('/git/blobs/')) return response;
      const text = await response.text();
      return new Response(`${text}${' '.repeat(680 * 1024 - text.length)}`);
    }
  });
  const result = await collectCodexSourceEvidence(wire.job, {
    fetch: wire.fetchImpl
  });
  expect(result.failure).toBe('source_job_limit');
  expect(result.usage.decodedBytes).toBeGreaterThan(16 * 1024 * 1024);
  expect(result.usage.decodedBytes).toBeLessThanOrEqual(17 * 1024 * 1024);
  expect([...wire.counts.values()]).toContain(2);
  noPass(result);
});
test.each([40, 128])('128 responses bounds a %s-release job including revalidation', async releaseCount => {
  const base = differenceJob();
  const releases = Array.from({ length: releaseCount }, (_, index) => ({
    version: `0.${163 + index}.0`,
    commit: (index + 1).toString(16).padStart(40, '0')
  }));
  const first = releases[0];
  const last = releases.at(-1);
  if (!first || !last || !base.baseline_row) {
    throw new Error('invalid_synthetic_inventory');
  }
  const job = {
    ...base,
    baseline_row: { ...base.baseline_row, ref: first },
    parser_base: { ...first, profile_id: base.lane.profile_id },
    target: last,
    comparison: {
      comparison_kind: 'adjacent_release' as const,
      from: first,
      to: last
    },
    inventory: { ...base.inventory, releases }
  };
  const wire = sourceFixture({ job });
  const result = await collectCodexSourceEvidence(job, {
    fetch: wire.fetchImpl
  });
  expect(result.failure).toBe('source_response_limit');
  expect(result.usage.responses).toBe(128);
  expect(wire.calls).toHaveLength(128);
  if (releaseCount === 40) expect([...wire.counts.values()]).toContain(2);
  expect(result.evidence.every(record => record.availability === 'failed')).toBe(true);
});
test.each([129, 256])(
  'large schema-valid %s-release failures still reduce with every required comparison',
  async releaseCount => {
    const base = differenceJob();
    const releases = Array.from({ length: releaseCount }, (_, index) => ({
      version: `0.${163 + index}.0`,
      commit: (index + 1).toString(16).padStart(40, '0')
    }));
    const first = releases[0];
    const last = releases.at(-1);
    if (!first || !last || !base.baseline_row) {
      throw new Error('invalid_synthetic_inventory');
    }
    const job = parseDifferenceJob({
      ...base,
      baseline_row: { ...base.baseline_row, ref: first },
      parser_base: { ...first, profile_id: base.lane.profile_id },
      target: last,
      comparison: {
        comparison_kind: 'adjacent_release',
        from: first,
        to: last
      },
      inventory: { ...base.inventory, releases }
    });
    const wire = sourceFixture({ job });
    const result = await collectCodexSourceEvidence(job, {
      fetch: wire.fetchImpl
    });
    const judgment = parseDifferenceJudgment(judgeDifferences(job, result.evidence, currentIdentities));
    expect(result.failure).toBe('source_response_limit');
    expect(judgment.groups).toHaveLength(8);
    expect(judgment.groups.every(group => group.result === 'unknown')).toBe(true);
    expect(judgment.comparisons).toEqual([
      ...releases.slice(1).map((to, index) => ({
        comparison_kind: 'adjacent_release',
        from: releases[index],
        to
      })),
      { comparison_kind: 'parser_base', from: first, to: last }
    ]);
    expect(wire.calls).toHaveLength(0);
  },
  30000
);
test.each([
  ['redirected', false, 'source_redirect_invalid'],
  ['redirected', true, 'source_redirect_invalid'],
  ['final_url', false, 'source_redirect_invalid'],
  ['final_url', true, 'source_redirect_invalid'],
  ['blob_sha', false, 'source_identity_invalid'],
  ['blob_sha', true, 'source_identity_invalid']
] as const)('%s identity failure with late=%s invalidates all earlier material', async (kind, late, failure) => {
  let blobReads = 0;
  const wire = sourceFixture({
    change: (version, files) => {
      if (!late || version !== '0.165.0') return;
      const schema = syntheticSchema();
      schema.properties.model.description = 'SYNTHETIC_LATE_IDENTITY';
      files.set('codex-rs/core/config.schema.json', {
        type: 'blob',
        value: JSON.stringify(schema)
      });
    },
    rewrite: async (url, attempt, response) => {
      const isBlob = url.pathname.includes('/git/blobs/');
      if (isBlob && attempt === 1) blobReads++;
      const trigger = late ? isBlob && attempt === 1 && blobReads === 2 : kind === 'blob_sha' ? isBlob : url.pathname === '/repos/openai/codex';
      if (!trigger) return response;
      switch (kind) {
        case 'redirected':
          Object.defineProperty(response, 'redirected', {
            value: true
          });
          return response;
        case 'final_url':
          Object.defineProperty(response, 'url', {
            value: 'https://api.github.com/repos/openai/codex/git/trees/9999999999999999999999999999999999999999'
          });
          return response;
        case 'blob_sha':
          return new Response(`${await response.text()} `);
        default:
          throw new Error('invalid_synthetic_guard');
      }
    }
  });
  const result = await collectCodexSourceEvidence(wire.job, {
    fetch: wire.fetchImpl
  });
  expect(result.failure).toBe(failure);
  if (late) expect(blobReads).toBe(2);
  noPass(result);
});
test('the 120-second deadline bounds a transport that never resolves or honors cancellation', async () => {
  vi.useFakeTimers();
  let signalStarted = () => {};
  const started = new Promise<void>(resolve => {
    signalStarted = resolve;
  });
  const run = collectCodexSourceEvidence(differenceJob(), {
    fetch: () => {
      signalStarted();
      return new Promise<Response>(() => {});
    }
  });
  await started;
  await vi.advanceTimersByTimeAsync(120000);
  const result = await run;
  expect(result.failure).toBe('source_deadline');
  expect(result.usage.responses).toBe(1);
  noPass(result);
});
test('moving versions and arbitrary caller paths are refused before any transport effect', async () => {
  const fetchImpl = vi.fn<Parameters<typeof collectCodexSourceEvidence>[1]['fetch']>();
  const base = differenceJob();
  await expect(
    collectCodexSourceEvidence(
      {
        ...base,
        target: { ...base.target, version: 'main' }
      },
      { fetch: fetchImpl }
    )
  ).rejects.toThrow('invalid_record');
  const options = { fetch: fetchImpl, paths: ['private/path'] };
  await expect(collectCodexSourceEvidence(base, options)).rejects.toThrow('source_options_invalid');
  expect(fetchImpl).not.toHaveBeenCalled();
});
test('the declared bounds apply to a complete synthetic collection', async () => {
  const wire = sourceFixture();
  const result = await collectCodexSourceEvidence(wire.job, {
    fetch: wire.fetchImpl
  });
  expect(result.failure).toBeNull();
  expect(result.evidence).toHaveLength(6);
  expect(result.usage.responses).toBe(wire.calls.length);
  expect(result.usage.responses).toBeLessThanOrEqual(codexSourceLimits.responses);
  expect(result.usage.decodedBytes).toBeLessThanOrEqual(codexSourceLimits.jobBytes);
  expect(canonical(result.evidence)).not.toContain(sourcePrivateText);
});
test.each([
  { full_name: 'other/codex' },
  { name: 'other' },
  { owner: { login: 'other', id: 14957082 } },
  { owner: { login: 'openai', id: 1 } },
  { fork: true }
])('repository identity mismatch %j fails even with the expected numeric repository ID', async change => {
  const wire = sourceFixture({
    rewrite: async (url, _attempt, response) => {
      if (url.pathname !== '/repos/openai/codex') return response;
      const value: unknown = await response.json();
      if (!value || typeof value !== 'object') {
        throw new Error('invalid_synthetic_identity');
      }
      return sourceJson({ ...value, ...change });
    }
  });
  const result = await collectCodexSourceEvidence(wire.job, {
    fetch: wire.fetchImpl
  });
  expect(result.failure).toBe('source_identity_invalid');
  noPass(result);
});
test('a failed or truncated decoded body is discarded without exposing its error text', async () => {
  const wire = sourceFixture({
    rewrite: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{'));
            controller.error(new Error(sourcePrivateText));
          }
        })
      )
  });
  const result = await collectCodexSourceEvidence(wire.job, {
    fetch: wire.fetchImpl
  });
  expect(result.failure).toBe('source_fetch_failed');
  expect(JSON.stringify(result)).not.toContain(sourcePrivateText);
  noPass(result);
});
test('the deadline also bounds a stalled decoded body after headers arrive', async () => {
  vi.useFakeTimers();
  let signalRead = () => {};
  const reading = new Promise<void>(resolve => {
    signalRead = resolve;
  });
  const wire = sourceFixture({
    rewrite: () =>
      new Response(
        new ReadableStream(
          {
            pull() {
              signalRead();
            }
          },
          { highWaterMark: 0 }
        )
      )
  });
  const run = collectCodexSourceEvidence(wire.job, { fetch: wire.fetchImpl });
  await reading;
  await vi.advanceTimersByTimeAsync(120000);
  const result = await run;
  expect(result.failure).toBe('source_deadline');
  noPass(result);
});
test('a pre-aborted caller signal causes no transport effect', async () => {
  const fetchImpl = vi.fn<Parameters<typeof collectCodexSourceEvidence>[1]['fetch']>();
  const result = await collectCodexSourceEvidence(differenceJob(), {
    fetch: fetchImpl,
    signal: AbortSignal.abort()
  });
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(result.failure).toBe('source_deadline');
  noPass(result);
});

const sourcePath = (pathId: string) => {
  const descriptor = codexSourcePaths[pathId];
  if (!descriptor) throw new Error('invalid_synthetic_path');
  return descriptor;
};

test('history topology evidence closure includes the TUI thread-start history mode sources', () => {
  const closure = codexContractDescriptors.history_topology_resume_compaction.pathIds;
  expect(closure).toEqual(expect.arrayContaining(['tui_app_server_session', 'app_server_thread_history_mode']));
  expect(sourcePath('tui_app_server_session')).toEqual({
    path: 'codex-rs/tui/src/app_server_session.rs',
    type: 'blob'
  });
  expect(sourcePath('app_server_thread_history_mode')).toEqual({
    path: 'codex-rs/app-server-protocol/src/protocol/v2/thread_data.rs',
    type: 'blob'
  });
});

test('a TUI thread-start history-mode change is visible to history topology', async () => {
  const path = sourcePath('tui_app_server_session').path;
  const wire = sourceFixture({
    change: (version, files) => {
      if (version !== '0.165.0') return;
      const file = files.get(path);
      if (!file) throw new Error('invalid_synthetic_path');
      files.set(path, { ...file, value: 'different-history-mode' });
    }
  });
  const result = await collectCodexSourceEvidence(wire.job, { fetch: wire.fetchImpl });
  const judgment = judgeDifferences(wire.job, result.evidence, currentIdentities);
  expect(judgment.groups.find(group => group.contract_id === 'history_topology_resume_compaction')?.result).toBe('unknown');
});
