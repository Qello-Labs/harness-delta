import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import {
  promotionImplementationDigest,
  promotionImplementationExcludedPaths,
  promotionImplementationFiles,
  promotionImplementationScheme
} from '../scripts/tool-update/promotion-implementation.mjs';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const fixtureBytes = (path: string) => Buffer.from(`synthetic:${path}\n`);
async function fixture() {
  const root = await mkdtemp(join(realpathSync(tmpdir()), 'promotion-implementation-'));
  roots.push(root);
  await Promise.all(
    [...promotionImplementationFiles, ...promotionImplementationExcludedPaths].map(async path => {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), fixtureBytes(path));
    })
  );
  return root;
}

test('promotion implementation identity uses its named domain and ordered relative input bytes', async () => {
  const root = await fixture();
  const expected = createHash('sha256').update('promotion-implementation-v1').update('\0');
  for (const path of promotionImplementationFiles) {
    expected.update(path).update('\0').update(fixtureBytes(path)).update('\0');
  }

  expect(promotionImplementationScheme).toBe('promotion-implementation-v1');
  expect(await promotionImplementationDigest(root)).toBe(expected.digest('hex'));
  expect(await promotionImplementationDigest(await fixture())).toBe(await promotionImplementationDigest(root));
});

test('appending a result ledger or regenerating result digests does not invalidate tested implementation', async () => {
  const root = await fixture();
  await writeFile(join(root, 'src/core/tool-version-promotions.json'), JSON.stringify({ schema_version: 1, records: [] }));
  const before = await promotionImplementationDigest(root);
  await writeFile(
    join(root, 'src/core/tool-version-promotions.json'),
    JSON.stringify({
      schema_version: 1,
      records: [{ decision: 'approve', id: '1'.repeat(64) }]
    })
  );
  await writeFile(
    join(root, 'src/core/tool-version-promotion-result.json'),
    JSON.stringify({
      implementation_digest: '2'.repeat(64),
      projection_digest: '3'.repeat(64)
    })
  );

  expect(await promotionImplementationDigest(root)).toBe(before);
  expect(promotionImplementationExcludedPaths).toEqual(['src/core/tool-version-promotions.json', 'src/core/tool-version-promotion-result.json']);
});

test('every listed definition, algorithm and dependency invalidates the identity when its bytes change', async () => {
  const root = await fixture();
  const before = await promotionImplementationDigest(root);
  expect(new Set(promotionImplementationFiles).size).toBe(promotionImplementationFiles.length);
  for (const path of promotionImplementationFiles) {
    await writeFile(join(root, path), 'synthetic changed implementation\n');
    expect(await promotionImplementationDigest(root), path).not.toBe(before);
    await writeFile(join(root, path), fixtureBytes(path));
  }
}, 30000);

test.each([
  'src/core/tool-version-profiles.ts',
  'src/core/tool-version-profiles.json',
  'src/core/tool-version-recipes.json',
  'src/core/tool-version-identities.json',
  'src/core/tool-version-promotion.ts',
  'src/claude-process-binary.ts',
  'src/session-binding-codex.ts',
  'src/session-binding-claude.ts',
  'src/session-binding-service.ts',
  'src/sources/adapters.ts',
  'src/codex-candidate-rollout.ts',
  'src/binding/session-binding-qualification-lease.ts',
  'scripts/tool-update/promotion-implementation.mjs',
  'scripts/tool-update/promotion-implementation.d.mts',
  'scripts/tool-update/promotion-records.mjs',
  'scripts/tool-update/promotion-gates.mjs',
  'scripts/tool-update/manifest.mjs',
  'scripts/generate-tool-version-assets.mjs',
  'src/migrations/001_initial.sql',
  'src/migrations/037_ordinary_window_decisions.sql',
  'package.json',
  'package-lock.json'
])('promotion identity requires consumed input %s instead of treating it as result data', async path => {
  const root = await fixture();
  expect(promotionImplementationFiles).toContain(path);
  await rm(join(root, path));

  await expect(promotionImplementationDigest(root)).rejects.toMatchObject({ code: 'ENOENT' });
});
