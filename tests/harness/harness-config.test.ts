import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { registerHarness, generateComparison, readComparison, checkOriginalTools } from '../../src/harness/harness-config.js';
import { canonicalJson, readRepositoryFile, readStrictJson, hashBytes } from '../../src/core/repository-files.js';
const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'harness-config-synthetic-'));
  roots.push(root);
  mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'policy.md'), 'Synthetic instruction\n');
  writeFileSync(join(root, 'scripts/tool.py'), '# synthetic supporting tool\n');
  writeFileSync(join(root, 'readme.md'), 'Synthetic configuration and manual verification\n');
  return root;
}
const input = (version: string) => ({
  schema_version: 1 as const,
  harness_id: 'search',
  version,
  policy_version: 'policy-v1',
  readme_path: 'readme.md',
  artifacts: [
    { artifact_id: 'policy', role: 'instruction' as const, source_path: 'policy.md', target_path: 'harness.md' },
    { artifact_id: 'tool', role: 'tool' as const, source_path: 'scripts/tool.py', target_path: 'scripts/tool.py' }
  ]
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
test('canonical JSON normalizes metadata and key order but rejects duplicate keys and unsafe values', () => {
  expect(canonicalJson({ z: 'e\u0301', a: 1 })).toBe('{"a":1,"z":"é"}');
  expect(() => canonicalJson({ a: 1.5 })).toThrow('invalid_shared_config');
  expect(() => readStrictJson(Buffer.from('{"a":1,"a":2}'))).toThrow('invalid_shared_config');
  expect(() => canonicalJson({ a: '\ud800' })).toThrow('invalid_shared_config');
});
test('independent roots produce identical manifests and pair bytes; repeats do not overwrite', () => {
  const a = fixture(),
    b = fixture();
  for (const root of [a, b]) {
    registerHarness(root, input('baseline'));
    registerHarness(root, { ...input('v2'), base: { path: 'harness-config/baseline/manifest.json' } });
    generateComparison(root, { schema_version: 1, id: 'baseline-vs-v2', name: 'Baseline vs v2', arm_a: 'baseline', arm_b: 'v2' });
  }
  for (const path of ['harness-config/baseline/manifest.json', 'harness-config/v2/manifest.json', 'harness-config/comparisons/baseline-vs-v2.json'])
    expect(readFileSync(join(a, path))).toEqual(readFileSync(join(b, path)));
  expect(registerHarness(a, input('baseline')).status).toBe('already_registered');
  expect(generateComparison(a, { schema_version: 1, id: 'baseline-vs-v2', name: 'Baseline vs v2', arm_a: 'baseline', arm_b: 'v2' }).status).toBe(
    'already_generated'
  );
  expect(readFileSync(join(a, 'policy.md'), 'utf8')).toBe('Synthetic instruction\n');
});
test('tool bytes change bundle identity while instruction digest remains stable and originals are separately checked', () => {
  const root = fixture();
  const a = registerHarness(root, input('baseline'));
  writeFileSync(join(root, 'scripts/tool.py'), '# changed synthetic tool\n');
  const b = registerHarness(root, input('v2'));
  expect(a.manifest.bundle_hash).not.toBe(b.manifest.bundle_hash);
  expect(a.manifest.instruction_manifest_hash).toBe(b.manifest.instruction_manifest_hash);
  expect(checkOriginalTools(root, a.manifest)).toBe('mismatch');
  expect(checkOriginalTools(root, b.manifest)).toBe('matched');
  expect(() => registerHarness(root, input('baseline'))).toThrow('harness_version_conflict');
});
test('shared reader catches changed and missing snapshot files without accepting drift', () => {
  const root = fixture();
  registerHarness(root, input('baseline'));
  registerHarness(root, input('v2'));
  generateComparison(root, { schema_version: 1, id: 'pair', name: 'Pair', arm_a: 'baseline', arm_b: 'v2' });
  writeFileSync(join(root, 'harness-config/v2/harness.md'), 'changed');
  expect(() => readComparison(root, 'harness-config/comparisons/pair.json')).toThrow('shared_content_mismatch');
});
test.each(['../outside', '/outside', 'C:/outside', 'a\\b', 'a//b', 'a/./b', '%2e%2e/outside'])('rejects out-of-scope path %s', path => {
  expect(() => readRepositoryFile(fixture(), path)).toThrow('shared_path_invalid');
});
test('rejects symlink ancestors and leaves', () => {
  const root = fixture();
  symlinkSync(join(root, 'scripts'), join(root, 'linked'));
  symlinkSync(join(root, 'policy.md'), join(root, 'alias.md'));
  expect(() => readRepositoryFile(root, 'linked/tool.py')).toThrow('shared_path_invalid');
  expect(() => readRepositoryFile(root, 'alias.md')).toThrow('shared_path_invalid');
});
test('rejects duplicate artifacts and portable path collisions', () => {
  const root = fixture();
  const value = input('baseline');
  expect(() => registerHarness(root, { ...value, artifacts: [...value.artifacts, value.artifacts[0]] })).toThrow('invalid_shared_config');
  expect(() =>
    registerHarness(root, {
      ...value,
      artifacts: [value.artifacts[0], { artifact_id: 'other', role: 'instruction', source_path: 'policy.md', target_path: 'HARNESS.md' }]
    })
  ).toThrow('invalid_shared_config');
});

test('selected local Markdown references must resolve inside the explicit snapshot', () => {
  const root = fixture();
  writeFileSync(join(root, 'policy.md'), 'Synthetic [tool](scripts/tool.py)\n');
  expect(registerHarness(root, input('baseline')).status).toBe('registered');
  writeFileSync(join(root, 'policy.md'), 'Synthetic [missing](missing.md)\n');
  expect(() => registerHarness(root, input('v2'))).toThrow('shared_reference_invalid');
});
test('parent-relative source links preserve exact bytes and selected renamed snapshot mappings', () => {
  const root = fixture();
  mkdirSync(join(root, 'docs/harness'), { recursive: true });
  mkdirSync(join(root, 'scripts/repo-map'));
  const policy = Buffer.from('\uFEFFSynthetic [tool](../../scripts/tool.py#usage)\r\n[guide](../../scripts/repo-map/README.md)\r\n');
  const guide = Buffer.from('Synthetic [policy](../../docs/harness/POLICY.md)\r\n');
  const readme = Buffer.from('Synthetic [policy](docs/harness/POLICY.md)\r\n');
  writeFileSync(join(root, 'docs/harness/POLICY.md'), policy);
  writeFileSync(join(root, 'scripts/repo-map/README.md'), guide);
  writeFileSync(join(root, 'readme.md'), readme);
  const config = {
    ...input('baseline'),
    artifacts: [
      { artifact_id: 'policy', role: 'instruction', source_path: 'docs/harness/POLICY.md', target_path: 'harness.md' },
      { artifact_id: 'tool', role: 'tool', source_path: 'scripts/tool.py', target_path: 'tools/selected.py' },
      { artifact_id: 'guide', role: 'documentation', source_path: 'scripts/repo-map/README.md', target_path: 'docs/guide.md' }
    ]
  };
  const result = registerHarness(root, config);
  expect(result.status).toBe('registered');
  for (const row of result.manifest.artifacts) {
    const original = readFileSync(join(root, row.source_path));
    expect(readFileSync(join(root, row.path))).toEqual(original);
    expect(row.sha256).toBe(hashBytes(original));
  }
  expect(result.manifest.artifacts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        artifact_id: 'policy',
        source_path: 'docs/harness/POLICY.md',
        path: 'harness-config/baseline/harness.md',
        sha256: hashBytes(policy)
      }),
      expect.objectContaining({ artifact_id: 'tool', source_path: 'scripts/tool.py', path: 'harness-config/baseline/tools/selected.py' }),
      expect.objectContaining({
        artifact_id: 'guide',
        source_path: 'scripts/repo-map/README.md',
        path: 'harness-config/baseline/docs/guide.md',
        sha256: hashBytes(guide)
      })
    ])
  );
  expect(readFileSync(join(root, 'docs/harness/POLICY.md'))).toEqual(policy);
  expect(readFileSync(join(root, 'scripts/repo-map/README.md'))).toEqual(guide);
  expect(readFileSync(join(root, 'readme.md'))).toEqual(readme);
  expect(registerHarness(root, config).status).toBe('already_registered');
});
test.each(['../../../scripts/tool.py', '../../scripts/unselected.py', '../../scripts/missing.py'])(
  'rejects an escaped, unselected or missing source reference %s',
  reference => {
    const root = fixture();
    mkdirSync(join(root, 'docs/harness'), { recursive: true });
    writeFileSync(join(root, 'scripts/unselected.py'), 'Synthetic unselected tool\n');
    writeFileSync(join(root, 'docs/harness/POLICY.md'), `Synthetic [tool](${reference})\n`);
    const value = input('baseline');
    expect(() =>
      registerHarness(root, {
        ...value,
        artifacts: [{ artifact_id: 'policy', role: 'instruction', source_path: 'docs/harness/POLICY.md', target_path: 'harness.md' }, value.artifacts[1]]
      })
    ).toThrow('shared_reference_invalid');
    expect(existsSync(join(root, 'harness-config'))).toBe(false);
  }
);
test('a matching snapshot path cannot substitute for an unselected source reference', () => {
  const root = fixture();
  writeFileSync(join(root, 'policy.md'), 'Synthetic [tool](scripts/unselected.py)\n');
  writeFileSync(join(root, 'scripts/unselected.py'), 'Synthetic unselected tool\n');
  const value = input('baseline');
  expect(() =>
    registerHarness(root, {
      ...value,
      artifacts: [value.artifacts[0], { artifact_id: 'tool', role: 'tool', source_path: 'scripts/tool.py', target_path: 'scripts/unselected.py' }]
    })
  ).toThrow('shared_reference_invalid');
});
test.each(['./scripts/tool.py', 'scripts/../scripts/tool.py'])('accepts in-root source navigation %s', reference => {
  const root = fixture();
  writeFileSync(join(root, 'policy.md'), `Synthetic [tool](${reference})\n`);
  expect(registerHarness(root, input('baseline')).status).toBe('registered');
});
test.each(['linked/../scripts/tool.py', 'missing/../scripts/tool.py', 'policy.md/../scripts/tool.py'])(
  'rejects a non-directory or symbolic traversal hidden by normalization %s',
  reference => {
    const root = fixture();
    symlinkSync(join(root, 'scripts'), join(root, 'linked'));
    writeFileSync(join(root, 'policy.md'), `Synthetic [tool](${reference})\n`);
    expect(() => registerHarness(root, input('baseline'))).toThrow('shared_reference_invalid');
  }
);
test.each(['../harness.md', '/harness.md', 'docs/../harness.md', 'docs\\harness.md', 'CON.md'])(
  'keeps portable target path validation strict for %s',
  targetPath => {
    const root = fixture();
    const value = input('baseline');
    expect(() =>
      registerHarness(root, {
        ...value,
        artifacts: [{ artifact_id: 'policy', role: 'instruction', source_path: 'policy.md', target_path: targetPath }, value.artifacts[1]]
      })
    ).toThrow('invalid_shared_config');
  }
);
test.each(['linked/tool.py', 'alias.py'])('rejects selected symlink sources for relative references %s', sourcePath => {
  const root = fixture();
  symlinkSync(join(root, 'scripts'), join(root, 'linked'));
  symlinkSync(join(root, 'scripts/tool.py'), join(root, 'alias.py'));
  writeFileSync(join(root, 'policy.md'), `Synthetic [tool](./${sourcePath})\n`);
  const value = input('baseline');
  expect(() =>
    registerHarness(root, {
      ...value,
      artifacts: [value.artifacts[0], { artifact_id: 'tool', role: 'tool', source_path: sourcePath, target_path: 'scripts/tool.py' }]
    })
  ).toThrow('shared_path_invalid');
});
test('binary tools may contain NUL bytes and snapshot checks still hash raw bytes', () => {
  const root = fixture();
  writeFileSync(join(root, 'scripts/tool.py'), Buffer.from([0, 1, 255]));
  registerHarness(root, input('baseline'));
  registerHarness(root, input('v2'));
  generateComparison(root, { schema_version: 1, id: 'pair', name: 'Pair', arm_a: 'baseline', arm_b: 'v2' });
  expect(readComparison(root, 'harness-config/comparisons/pair.json').bundles).toHaveLength(2);
});

test('version 2 explicitly selects agent application without reinterpreting a version 1 comparison', () => {
  const root = fixture();
  registerHarness(root, input('baseline'));
  registerHarness(root, input('v2'));
  const old = generateComparison(root, { schema_version: 1, id: 'legacy', name: 'Legacy', arm_a: 'baseline', arm_b: 'v2' });
  const bytes = readFileSync(join(root, 'harness-config/comparisons/legacy.json'));
  const created = generateComparison(root, { schema_version: 2, id: 'agent', name: 'Agent', arm_a: 'baseline', arm_b: 'v2', application: 'agent_applied' });
  expect(created.descriptor).toMatchObject({ schema_version: 2, application: 'agent_applied' });
  expect(readComparison(root, 'harness-config/comparisons/agent.json').descriptor).toEqual(created.descriptor);
  expect(readComparison(root, 'harness-config/comparisons/legacy.json').descriptor).toEqual(old.descriptor);
  expect(readFileSync(join(root, 'harness-config/comparisons/legacy.json'))).toEqual(bytes);
  expect(() =>
    generateComparison(root, { schema_version: 2, id: 'invalid', name: 'Invalid', arm_a: 'baseline', arm_b: 'v2', application: 'selected_markdown_only' })
  ).toThrow('invalid_shared_config');
});
