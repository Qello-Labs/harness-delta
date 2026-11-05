import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { dirname, join, resolve, posix } from 'node:path';
import { z } from 'zod';
import { canonicalJson, ensureRepositoryDirectory, hashBytes, readRepositoryFile, readStrictJson, safeRelativePath } from '../core/repository-files.js';

const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/);
const artifactId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const pathSchema = z.string().min(1).max(2048).refine(safeRelativePath);
const role = z.enum(['instruction', 'tool', 'documentation']);
const artifact = z.strictObject({ artifact_id: artifactId, role, path: pathSchema, source_path: pathSchema, sha256: digest });
const reference = z.strictObject({ harness_id: id, version: id, path: pathSchema, bundle_hash: digest });
export const HarnessManifestSchema = z.strictObject({
  kind: z.literal('harness-delta.harness'),
  schema_version: z.literal(1),
  harness_id: id,
  version: id,
  policy_version: artifactId,
  base: reference.nullable(),
  artifacts: z.array(artifact).min(1).max(256),
  instruction_manifest_hash: digest,
  bundle_hash: digest
});
export type HarnessManifest = z.infer<typeof HarnessManifestSchema>;
const LegacyComparisonSchema = z.strictObject({
  kind: z.literal('harness-delta.comparison'),
  schema_version: z.literal(1),
  id,
  name: z.string().min(1).max(200),
  arm_a: reference,
  arm_b: reference,
  application: z.literal('selected_markdown_only'),
  settings_hash: digest
});
export const SharedComparisonSchema = z.discriminatedUnion('schema_version', [
  LegacyComparisonSchema,
  LegacyComparisonSchema.extend({ schema_version: z.literal(2), application: z.literal('agent_applied') })
]);
export type SharedComparison = z.infer<typeof SharedComparisonSchema>;
const RegistrationSchema = z.strictObject({
  schema_version: z.literal(1),
  harness_id: id,
  version: id,
  policy_version: artifactId,
  base: z.strictObject({ path: pathSchema }).optional(),
  readme_path: pathSchema,
  artifacts: z
    .array(z.strictObject({ artifact_id: artifactId, role, source_path: pathSchema, target_path: pathSchema }))
    .min(1)
    .max(255)
});
const legacyComparisonInput = z.strictObject({ schema_version: z.literal(1), id, name: z.string().min(1).max(200), arm_a: id, arm_b: id });
const ComparisonInputSchema = z.discriminatedUnion('schema_version', [
  legacyComparisonInput,
  legacyComparisonInput.extend({ schema_version: z.literal(2), application: z.literal('agent_applied') })
]);
const fail = (code = 'invalid_shared_config'): never => {
  throw new Error(code);
};
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  return result.success ? result.data : fail();
}
function writeDurable(path: string, bytes: Buffer | string, mode: number) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function validateReferences(root: string, files: { path: string; sourcePath: string; bytes: Buffer }[]) {
  const anchor = realpathSync(root),
    paths = new Set(files.map(file => file.sourcePath));
  for (const file of files.filter(file => file.sourcePath.endsWith('.md') || file.path.endsWith('.md'))) {
    for (const match of file.bytes.toString('utf8').matchAll(/!?\[[^\]\n]*\]\(<?([^\s)>]+)>?(?:\s+[^)]*)?\)/g)) {
      const target = match[1]!;
      if (target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const relative = target.split('#')[0]!,
        components = relative.split('/');
      const resolved = posix.join(posix.dirname(file.sourcePath), relative);
      if (
        relative.length > 2048 ||
        components.some(part => part !== '.' && part !== '..' && !safeRelativePath(part)) ||
        !safeRelativePath(resolved) ||
        !paths.has(resolved)
      )
        fail('shared_reference_invalid');
      let directory = posix.dirname(file.sourcePath);
      for (const component of components.slice(0, -1)) {
        directory = posix.join(directory, component);
        if (directory !== '.' && !safeRelativePath(directory)) fail('shared_reference_invalid');
        try {
          const stat = lstatSync(join(anchor, directory));
          if (stat.isSymbolicLink() || !stat.isDirectory()) fail('shared_reference_invalid');
        } catch {
          fail('shared_reference_invalid');
        }
      }
    }
  }
}
const documentHash = (domain: 'bundle' | 'comparison', value: unknown) => hashBytes(`harness-delta:${domain}:v1\n${canonicalJson(value)}`);
function instructionHash(rows: HarnessManifest['artifacts']): string {
  const manifest = rows
    .filter(row => row.role === 'instruction')
    .map(row => ({ artifact_id: row.artifact_id, sha256: row.sha256 }))
    .sort((a, b) => (a.artifact_id < b.artifact_id ? -1 : a.artifact_id > b.artifact_id ? 1 : 0));
  if (!manifest.length) fail();
  return hashBytes(JSON.stringify(manifest));
}
function validateArtifacts(rows: HarnessManifest['artifacts'], version: string) {
  const ids = new Set<string>(),
    paths = new Set<string>();
  if (
    rows.some((row, i) => i > 0 && rows[i - 1]!.artifact_id >= row.artifact_id) ||
    rows.some(row => row.role === 'instruction' && (!row.path.endsWith('.md') || !row.source_path.endsWith('.md')))
  )
    fail();
  for (const row of rows) {
    const lower = row.path.toLowerCase();
    if (ids.has(row.artifact_id) || paths.has(lower) || !row.path.startsWith(`harness-config/${version}/`)) fail();
    ids.add(row.artifact_id);
    paths.add(lower);
  }
  if (!rows.some(row => row.role === 'instruction' && row.path === `harness-config/${version}/harness.md`)) fail();
}
export function readHarness(root: string, path: string): HarnessManifest {
  const value = parse(HarnessManifestSchema, readStrictJson(readRepositoryFile(root, path)));
  if (path !== `harness-config/${value.version}/manifest.json`) fail('shared_path_invalid');
  validateArtifacts(value.artifacts, value.version);
  const { bundle_hash: expected, ...rest } = value;
  if (documentHash('bundle', rest) !== expected || instructionHash(value.artifacts) !== value.instruction_manifest_hash) fail('shared_content_mismatch');
  let total = 0;
  for (const row of value.artifacts) {
    const bytes = readRepositoryFile(root, row.path);
    total += bytes.length;
    if (total > 16 * 1048576 || hashBytes(bytes) !== row.sha256) fail('shared_content_mismatch');
    if (row.role === 'instruction' && (!Buffer.from(bytes.toString('utf8')).equals(bytes) || bytes.includes(0))) fail();
  }
  return value;
}
function asReference(manifest: HarnessManifest) {
  return {
    harness_id: manifest.harness_id,
    version: manifest.version,
    path: `harness-config/${manifest.version}/manifest.json`,
    bundle_hash: manifest.bundle_hash
  };
}
export function registerHarness(root: string, input: unknown) {
  const config = parse(RegistrationSchema, input);
  if (config.version === 'comparisons') fail();
  const base = config.base ? asReference(readHarness(root, config.base.path)) : null;
  if (base?.version === config.version || (base && base.harness_id !== config.harness_id)) fail();
  const files: { path: string; sourcePath: string; bytes: Buffer }[] = [];
  const rows: HarnessManifest['artifacts'] = config.artifacts.map(row => {
    const bytes = readRepositoryFile(root, row.source_path);
    const path = `harness-config/${config.version}/${row.target_path}`;
    if (row.target_path === 'manifest.json' || row.target_path === 'README.md' || row.source_path.startsWith('harness-config/')) fail();
    files.push({ path: row.target_path, sourcePath: row.source_path, bytes });
    return { artifact_id: row.artifact_id, role: row.role, path, source_path: row.source_path, sha256: hashBytes(bytes) };
  });
  const readme = readRepositoryFile(root, config.readme_path);
  files.push({ path: 'README.md', sourcePath: config.readme_path, bytes: readme });
  rows.push({
    artifact_id: 'readme',
    role: 'documentation',
    path: `harness-config/${config.version}/README.md`,
    source_path: config.readme_path,
    sha256: hashBytes(readme)
  });
  rows.sort((a, b) => (a.artifact_id < b.artifact_id ? -1 : a.artifact_id > b.artifact_id ? 1 : 0));
  validateArtifacts(rows, config.version);
  if (files.reduce((n, file) => n + file.bytes.length, 0) > 16 * 1048576) fail();
  for (const row of rows.filter(row => row.role === 'instruction')) {
    const bytes = files.find(file => `harness-config/${config.version}/${file.path}` === row.path)!.bytes;
    if (!Buffer.from(bytes.toString('utf8')).equals(bytes) || bytes.includes(0)) fail();
  }
  validateReferences(root, files);
  const data = {
    kind: 'harness-delta.harness' as const,
    schema_version: 1 as const,
    harness_id: config.harness_id,
    version: config.version,
    policy_version: config.policy_version,
    base,
    artifacts: rows,
    instruction_manifest_hash: instructionHash(rows)
  };
  const manifest = { ...data, bundle_hash: documentHash('bundle', data) };
  const parent = ensureRepositoryDirectory(root, 'harness-config');
  const target = join(parent, config.version);
  if (existsSync(target)) {
    const old = readHarness(root, `harness-config/${config.version}/manifest.json`);
    if (canonicalJson(old) !== canonicalJson(manifest)) fail('harness_version_conflict');
    return { status: 'already_registered' as const, manifest };
  }
  const stage = join(parent, `.stage-${randomUUID()}`);
  mkdirSync(stage, { mode: 0o700 });
  try {
    for (const file of files) {
      const folder = dirname(file.path);
      if (folder !== '.') ensureRepositoryDirectory(stage, folder);
      writeDurable(join(stage, file.path), file.bytes, 0o644);
    }
    writeDurable(join(stage, 'manifest.json'), canonicalJson(manifest) + '\n', 0o644);
    const lock = join(parent, `.lock-${config.version}`);
    let locked = false;
    try {
      mkdirSync(lock, { mode: 0o700 });
      locked = true;
      if (existsSync(target)) fail('harness_version_conflict');
      renameSync(stage, target);
    } finally {
      if (locked) rmSync(lock, { recursive: true });
    }
  } finally {
    if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
  }
  readHarness(root, `harness-config/${config.version}/manifest.json`);
  return { status: 'registered' as const, manifest };
}
export function readComparison(root: string, path: string) {
  const descriptor = parse(SharedComparisonSchema, readStrictJson(readRepositoryFile(root, path)));
  if (path !== `harness-config/comparisons/${descriptor.id}.json` || descriptor.arm_a.version === descriptor.arm_b.version) fail('shared_path_invalid');
  const { settings_hash: expected, ...rest } = descriptor;
  if (comparisonHash(rest) !== expected) fail('shared_content_mismatch');
  const bundles = [descriptor.arm_a, descriptor.arm_b].map(ref => {
    const bundle = readHarness(root, ref.path);
    if (canonicalJson(asReference(bundle)) !== canonicalJson(ref)) fail('shared_content_mismatch');
    return bundle;
  });
  return { descriptor, bundles: bundles as [HarnessManifest, HarnessManifest] };
}
function comparisonHash(value: { schema_version: number }): string {
  return value.schema_version === 1 ? documentHash('comparison', value) : hashBytes(`harness-delta:comparison:v2\n${canonicalJson(value)}`);
}
export function generateComparison(root: string, input: unknown) {
  const config = parse(ComparisonInputSchema, input);
  if (config.arm_a === config.arm_b) fail();
  const data = {
    kind: 'harness-delta.comparison' as const,
    schema_version: config.schema_version,
    id: config.id,
    name: config.name.normalize('NFC'),
    arm_a: asReference(readHarness(root, `harness-config/${config.arm_a}/manifest.json`)),
    arm_b: asReference(readHarness(root, `harness-config/${config.arm_b}/manifest.json`)),
    application: config.schema_version === 2 ? ('agent_applied' as const) : ('selected_markdown_only' as const)
  };
  const descriptor = { ...data, settings_hash: comparisonHash(data) };
  const folder = ensureRepositoryDirectory(root, 'harness-config/comparisons');
  const path = `harness-config/comparisons/${config.id}.json`;
  if (existsSync(join(folder, config.id + '.json'))) {
    if (canonicalJson(readComparison(root, path).descriptor) !== canonicalJson(descriptor)) fail('shared_settings_conflict');
    return { status: 'already_generated' as const, descriptor };
  }
  const temporary = join(folder, `.stage-${randomUUID()}`);
  writeDurable(temporary, canonicalJson(descriptor) + '\n', 0o644);
  try {
    linkSync(temporary, join(folder, config.id + '.json'));
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    if (canonicalJson(readComparison(root, path).descriptor) !== canonicalJson(descriptor)) fail('shared_settings_conflict');
    return { status: 'already_generated' as const, descriptor };
  } finally {
    unlinkSync(temporary);
  }
  return { status: 'generated' as const, descriptor };
}
export function checkOriginalTools(root: string, bundle: HarnessManifest): 'matched' | 'mismatch' {
  try {
    for (const row of bundle.artifacts.filter(row => row.role === 'tool'))
      if (hashBytes(readRepositoryFile(root, row.source_path)) !== row.sha256) return 'mismatch';
    return 'matched';
  } catch {
    return 'mismatch';
  }
}
export function comparisonRelativePath(root: string, selected: string): string {
  const anchor = realpathSync(root);
  const path = resolve(selected);
  if (!path.startsWith(anchor + '/')) fail('shared_path_invalid');
  const relative = path.slice(anchor.length + 1);
  if (!safeRelativePath(relative)) fail('shared_path_invalid');
  return relative;
}
