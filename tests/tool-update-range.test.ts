import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { discover, observationSchema } from '../scripts/tool-update/discovery.mjs';
import { assessCandidate, assessmentSchema } from '../scripts/tool-update/assessment.mjs';
import { fixture, now, privateText, release } from './tool-update-discovery-fixture.js';

test.each([
  null, [], { ...release('1.0.10'), draft: true }, { ...release('1.0.10'), prerelease: true },
  { ...release('1.0.10'), tag_name: 'rust-v1.0.10-beta' },
  { ...release('1.0.10'), tag_name: privateText },
])('rejects malformed or non-stable official latest %#', async githubLatest => {
  const wire = fixture({ githubLatest });

  const result = await discover('codex', { fetchImpl: wire.fetchImpl, now });

  expect(result.observation.reasons).toContain('metadata_invalid');
  expect(result.candidate).toBeNull();
  expect(JSON.stringify(result)).not.toContain(privateText);
});

test('requires explicit scope in schema 2 while keeping legacy observations readable', async () => {
  const result = await discover('codex', { fetchImpl: fixture().fetchImpl, now });
  const fields = Object.fromEntries(Object.entries(result.observation).filter(([key]) => key !== 'inventory_scope'));

  expect(observationSchema.safeParse(fields).success).toBe(false);
  expect(observationSchema.safeParse({ ...result.observation, inventory_scope: 'all_history' }).success).toBe(false);
  expect(observationSchema.safeParse({ ...result.observation, schema_version: 1 }).success).toBe(false);
  expect(observationSchema.safeParse({ ...fields, schema_version: 1 }).success).toBe(false);
  expect(observationSchema.safeParse({ ...fields, schema_version: 1, checks: [] }).success).toBe(true);
});

test.each([1, 2])('preserves observation scope from schema %i in static assessment', async schema => {
  const result = await discover('codex', { fetchImpl: fixture().fetchImpl, now });
  if (!result.candidate) throw new Error('synthetic_candidate_missing');
  const fields = Object.fromEntries(Object.entries(result.observation).filter(([key]) => key !== 'inventory_scope'));
  const observation = schema === 1 ? { ...fields, schema_version: 1, checks: [] } : result.observation;

  const assessment = await assessCandidate({
    root: realpathSync(fileURLToPath(new URL('..', import.meta.url))), candidate: result.candidate, observation,
  });

  expect(assessment).toMatchObject({ schema_version: 2,
    inventory_scope: schema === 1 ? 'legacy_full_inventory' : 'latest_and_npm_review_range' });
  const oldFields = Object.fromEntries(Object.entries(assessment).filter(([key]) => key !== 'inventory_scope'));
  expect(assessmentSchema.safeParse({ ...oldFields, schema_version: 1 }).success).toBe(true);
});
