import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { promotionImplementationDigest, promotionImplementationFiles } from '../scripts/tool-update/promotion-implementation.mjs';
import { projectToolVersionPromotions, promotionProjectionDigest, promotionRegistryDigest } from '../src/core/tool-version-promotion.js';
import { appendPromotionDecision, promotionFixture } from './helpers/tool-version-promotion.js';

const repository = fileURLToPath(new URL('../', import.meta.url));
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'tool-version-assets-'));
  roots.push(root);
  for (const path of [
    ...promotionImplementationFiles,
    'src/core/tool-version-promotions.json',
    'scripts/generate-tool-version-assets.mjs',
    'scripts/session-binding-codex-hook.template.mjs',
    'src/core/tool-version-profiles.json',
    'src/core/tool-version-recipes.json',
    'src/core/tool-version-identities.json',
    'docs/runbooks/harness-connect.md',
    'docs/runbooks/harness-connect.ko.md',
    'docs/runbooks/workflow-quickstart.md',
    'docs/runbooks/workflow-quickstart.ko.md'
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(repository, path), join(root, path));
  }
  symlinkSync(join(repository, 'node_modules'), join(root, 'node_modules'));
  expect(run(root).status).toBe(0);
  return root;
}

function run(root: string, args: readonly string[] = []) {
  const result = spawnSync(process.execPath, [join(root, 'scripts/generate-tool-version-assets.mjs'), ...args], {
    encoding: 'utf8',
    timeout: 10000
  });
  if (result.error) throw result.error;
  return result;
}

function snapshot(root: string) {
  const rows: unknown[] = [];
  const visit = (path: string) => {
    for (const entry of readdirSync(join(root, path), {
      withFileTypes: true
    })) {
      const name = join(path, entry.name);
      if (entry.isSymbolicLink()) {
        rows.push({
          path: name,
          target: readlinkSync(join(root, name))
        });
      } else if (entry.isDirectory()) visit(name);
      else {
        const stat = statSync(join(root, name), { bigint: true });
        rows.push({
          path: name,
          mode: stat.mode,
          mtime: stat.mtimeNs,
          ctime: stat.ctimeNs,
          inode: stat.ino,
          digest: createHash('sha256')
            .update(readFileSync(join(root, name)))
            .digest('hex')
        });
      }
    }
  };
  visit('');
  return rows;
}

test('checking current generated assets preserves every file byte and metadata', () => {
  const root = fixture();
  const before = snapshot(root);
  const result = run(root, ['--check']);
  expect(result.status).toBe(0);
  const output: unknown = JSON.parse(result.stdout);
  expect(output).toMatchObject({ status: 'tool_version_assets_current' });
  expect(snapshot(root)).toEqual(before);
});

test.each(['stale', 'missing', 'read_only'] as const)('checking a %s generated asset fails without repairs', condition => {
  const root = fixture();
  const target = join(root, 'scripts/generated/tool-version-data.mjs');
  if (condition === 'stale') {
    writeFileSync(target, 'Synthetic stale artifact');
  } else if (condition === 'missing') unlinkSync(target);
  else chmodSync(target, 0o444);
  const before = snapshot(root);
  const result = run(root, ['--check']);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`tool_version_assets_${condition}:scripts/generated/tool-version-data.mjs`);
  expect(snapshot(root)).toEqual(before);
});

test('generation emits a deterministic promotion identity without changing legacy asset bytes', () => {
  const root = fixture();
  for (const path of [
    'scripts/session-binding-codex-hook.mjs',
    'scripts/generated/tool-version-data.mjs',
    'scripts/generated/tool-version-data.d.mts',
    'scripts/generated/current-support.json',
    'docs/support-matrix.md',
    'docs/support-matrix.ko.md'
  ]) {
    expect(readFileSync(join(root, path))).toEqual(readFileSync(join(repository, path)));
  }
  const target = join(root, 'src/core/tool-version-promotion-result.json');
  const bytes = readFileSync(target);
  const result: unknown = JSON.parse(bytes.toString());
  const digestMatcher: unknown = expect.stringMatching(/^[a-f0-9]{64}$/);
  expect(result).toEqual({
    schema_version: 1,
    implementation_scheme: 'promotion-implementation-v1',
    implementation_digest: digestMatcher,
    effective_projection_digest: digestMatcher
  });
  expect(run(root).status).toBe(0);
  expect(readFileSync(target)).toEqual(bytes);
});

function readJson(root: string, path: string): unknown {
  return JSON.parse(readFileSync(join(root, path), 'utf8'));
}

test.each(['stale', 'missing', 'read_only'] as const)('checking a %s promotion result fails without repairs', condition => {
  const root = fixture();
  const path = 'src/core/tool-version-promotion-result.json';
  const target = join(root, path);
  if (condition === 'stale') writeFileSync(target, '{}\n');
  else if (condition === 'missing') unlinkSync(target);
  else chmodSync(target, 0o444);
  const before = snapshot(root);
  const result = run(root, ['--check']);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`tool_version_assets_${condition}:${path}`);
  expect(snapshot(root)).toEqual(before);
});

test('checking detects consumed implementation drift before regenerating the result identity', async () => {
  const root = fixture();
  const path = 'src/core/tool-version-promotion-result.json';
  const before = readJson(root, path);
  const metadata = join(root, 'package.json');
  writeFileSync(metadata, readFileSync(metadata, 'utf8') + '\n');
  const files = snapshot(root);
  const check = run(root, ['--check']);
  expect(check.status).toBe(1);
  expect(check.stderr).toContain(`tool_version_assets_stale:${path}`);
  expect(snapshot(root)).toEqual(files);
  expect(run(root).status).toBe(0);
  const after = readJson(root, path);
  expect(after).not.toEqual(before);
  expect(after).toMatchObject({
    implementation_digest: await promotionImplementationDigest(root)
  });
  expect(run(root, ['--check']).status).toBe(0);
});

test.each(['pending', 'root_admission', 'root_qualification', 'children'] as const)(
  'generation reports exactly the effective scopes for a %s descriptor',
  async state => {
    const root = fixture();
    const synthetic = promotionFixture();
    const descriptor = synthetic.descriptors[0];
    if (!descriptor) throw new Error('synthetic_descriptor_required');
    const profiles = readJson(root, 'src/core/tool-version-profiles.json');
    const identities = readJson(root, 'src/core/tool-version-identities.json');
    if (!Array.isArray(profiles) || identities === null || typeof identities !== 'object' || !('entries' in identities)) {
      throw new Error('synthetic_registry_required');
    }
    const legacyProfiles: readonly unknown[] = profiles;
    const rawProfiles: readonly unknown[] = [...legacyProfiles, descriptor];
    writeFileSync(join(root, 'src/core/tool-version-profiles.json'), JSON.stringify(rawProfiles));
    synthetic.registryDigest = promotionRegistryDigest({
      profiles: rawProfiles,
      recipes: readJson(root, 'src/core/tool-version-recipes.json'),
      identities: identities.entries
    });
    synthetic.implementationDigest = await promotionImplementationDigest(root);
    const grants =
      state === 'children' ? (['admission', 'children'] as const) : state === 'root_qualification' ? (['qualification'] as const) : (['admission'] as const);
    const topology = state === 'children' ? 'bounded_family' : 'root';
    if (state !== 'pending') {
      appendPromotionDecision(synthetic, {
        requested_grants: [...grants],
        grants: [...grants],
        scope: {
          target: {
            version: descriptor.version,
            commit: descriptor.sourceRef
          },
          lane: {
            product: descriptor.product,
            route: descriptor.route,
            profile_id: descriptor.profileId,
            operation: 'collect',
            topology
          },
          platform: 'darwin_arm64',
          runtime: 'node24'
        }
      });
    }
    writeFileSync(join(root, 'src/core/tool-version-promotions.json'), JSON.stringify(synthetic.ledger));
    const result = run(root);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const support = readJson(root, 'scripts/generated/current-support.json');
    const legacy = readJson(repository, 'scripts/generated/current-support.json');
    if (legacy === null || typeof legacy !== 'object' || !('profiles' in legacy) || !Array.isArray(legacy.profiles)) {
      throw new Error('synthetic_support_required');
    }
    const legacySupport: readonly unknown[] = legacy.profiles;
    expect(support).toEqual({
      schemaVersion: 1,
      profiles: [
        ...legacySupport,
        {
          product: descriptor.product,
          version: descriptor.version,
          promotion: {
            status: state === 'pending' ? 'pending' : 'effective',
            profileId: descriptor.profileId,
            route: descriptor.route,
            declaredScopes: descriptor.scopes,
            effectiveScopes:
              state === 'pending'
                ? []
                : [
                    {
                      operation: 'collect',
                      topology,
                      maxDepth: topology === 'root' ? 0 : 1,
                      maxFamilyMembers: topology === 'root' ? 1 : 3,
                      platform: 'darwin_arm64',
                      runtime: 'node24',
                      grants
                    }
                  ]
          }
        }
      ]
    });
    expect(readJson(root, 'src/core/tool-version-promotion-result.json')).toEqual({
      schema_version: 1,
      implementation_scheme: 'promotion-implementation-v1',
      implementation_digest: synthetic.implementationDigest,
      effective_projection_digest: promotionProjectionDigest(projectToolVersionPromotions(synthetic))
    });
    for (const path of ['scripts/session-binding-codex-hook.mjs', 'scripts/generated/tool-version-data.mjs', 'scripts/generated/tool-version-data.d.mts']) {
      expect(readFileSync(join(root, path))).toEqual(readFileSync(join(repository, path)));
    }
    expect(run(root, ['--check']).status).toBe(0);
  }
);
