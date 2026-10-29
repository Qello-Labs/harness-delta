import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { afterEach, expect, test, vi } from 'vitest';
import {
  boundedParse, canonical, compareVersions, digest, loadRecord, maxRecordBytes, parseBaseline,
  publishRecord, ToolUpdateError,
} from '../scripts/tool-update/manifest.mjs';
import { candidateSchema } from '../scripts/tool-update/discovery.mjs';

const roots: string[] = [];
async function temporaryRoot() {
  const root = await mkdtemp(join(realpathSync(tmpdir()), 'tool-update-records-'));
  roots.push(root); return root;
}
afterEach(async () => {
  vi.restoreAllMocks(); syncBuiltinESMExports();
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
const candidate = {
  schema_version: 1, kind: 'candidate', product: 'codex', target: '0.163.0',
  release_id: 101, tag: 'rust-v0.163.0', commit: 'a'.repeat(40),
  npm_integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
} as const;
const baselineRow = {
  product: 'codex', route: 'file', profile_id: 'codex-file-checkpoint-v1',
  operation: 'collect', topology: 'root', last_reviewed_version: '0.162.0',
  contract_revision: 'consumed-v1', evidence_ids: ['b'.repeat(64), 'a'.repeat(64)],
  source_digest: 'c'.repeat(64),
} as const;

test('review baselines sort explicit evidence without changing the reviewed version', () => {
  const baseline = parseBaseline({ schema_version: 1, kind: 'baseline', rows: [baselineRow] });
  expect(baseline.rows[0]?.last_reviewed_version).toBe('0.162.0');
  expect(baseline.rows[0]?.evidence_ids).toEqual(['a'.repeat(64), 'b'.repeat(64)]);
});
test('duplicate baseline lane keys cannot override review evidence', () => {
  expect(() => parseBaseline({ schema_version: 1, kind: 'baseline',
    rows: [baselineRow, { ...baselineRow, last_reviewed_version: '0.163.0' }],
  })).toThrow(ToolUpdateError);
});
test.each(['prompt', 'response', 'local_path', 'secret'])('baselines reject private field %s recursively', field => {
  expect(() => parseBaseline({ schema_version: 1, kind: 'baseline',
    rows: [{ ...baselineRow, [field]: 'synthetic-secret' }],
  })).toThrow(ToolUpdateError);
});
test('a parser base cannot be silently inferred for a baseline without a version', () => {
  expect(() => parseBaseline({ schema_version: 1, kind: 'baseline',
    rows: [{ ...baselineRow, last_reviewed_version: undefined }],
  })).toThrow(ToolUpdateError);
});

test('canonical records preserve value identity across object key order', () => {
  expect(canonical({ b: { d: 2, c: 1 }, a: [3, 2] })).toBe('{"a":[3,2],"b":{"c":1,"d":2}}\n');
  expect(digest({ b: 2, a: 1 })).toBe(digest({ a: 1, b: 2 }));
  expect(digest({ a: 1, b: 2 })).not.toBe(digest({ a: 1, b: 3 }));
});
test('version comparison uses numeric components and rejects suffixed identities', () => {
  expect(compareVersions('0.9.0', '0.10.0')).toBeLessThan(0);
  expect(compareVersions('2.1.306', '2.1.306')).toBe(0);
  expect(() => compareVersions('2.1.306+private', '2.1.306')).toThrow();
});
test('concurrent same-input publication returns one immutable record', async () => {
  const root = await temporaryRoot();
  const ids = await Promise.all(Array.from({ length: 8 }, () => publishRecord(root, candidate, candidateSchema)));
  expect(new Set(ids).size).toBe(1);
  expect(await readdir(join(root, 'candidates'))).toEqual([`${digest(candidate)}.json`]);
  expect(await readFile(join(root, 'candidates', `${digest(candidate)}.json`), 'utf8')).toBe(canonical(candidate));
});
test('another writer unlinking its temporary hard link cannot cause a content conflict', async () => {
  const root = await temporaryRoot();
  const id = await publishRecord(root, candidate, candidateSchema);
  const destination = join(root, 'candidates', `${id}.json`);
  const peer = join(root, 'candidates', 'peer-temporary');
  await fsPromises.link(destination, peer);
  const originalOpen = fsPromises.open;
  let removed = false;
  vi.spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] === destination) {
      const originalStat = handle.stat.bind(handle);
      vi.spyOn(handle, 'stat').mockImplementation(async () => {
        const stat = await originalStat();
        if (!removed) { await fsPromises.unlink(peer); removed = true; }
        return stat;
      });
    }
    return handle;
  });
  syncBuiltinESMExports();
  await expect(publishRecord(root, candidate, candidateSchema)).resolves.toBe(id);
  expect(removed).toBe(true);
});
test('different targets coexist instead of retargeting an existing candidate', async () => {
  const root = await temporaryRoot();
  const next = { ...candidate, target: '0.164.0', tag: 'rust-v0.164.0', release_id: 102 };
  const ids = await Promise.all([publishRecord(root, candidate, candidateSchema), publishRecord(root, next, candidateSchema)]);
  expect(ids[0]).not.toBe(ids[1]);
  expect((await readdir(join(root, 'candidates'))).sort()).toEqual(ids.map(id => `${id}.json`).sort());
});
test('a conflicting existing record is never overwritten', async () => {
  const root = await temporaryRoot();
  await mkdir(join(root, 'candidates'));
  const destination = join(root, 'candidates', `${digest(candidate)}.json`);
  const other = { ...candidate, release_id: 102 };
  await writeFile(destination, canonical(other));
  await expect(publishRecord(root, candidate, candidateSchema)).rejects.toMatchObject({ code: 'record_conflict' });
  expect(await readFile(destination, 'utf8')).toBe(canonical(other));
});
test.each(['whitespace', 'invalid_json'])('different existing bytes fail closed for %s', async mode => {
  const root = await temporaryRoot();
  await mkdir(join(root, 'candidates'));
  const destination = join(root, 'candidates', `${digest(candidate)}.json`);
  const existing = mode === 'whitespace' ? JSON.stringify(candidate, null, 2) : 'synthetic-corrupt-record';
  await writeFile(destination, existing);
  await expect(publishRecord(root, candidate, candidateSchema)).rejects.toMatchObject({ code: 'record_conflict' });
  expect(await readFile(destination, 'utf8')).toBe(existing);
});
test('a destination symlink cannot disclose or replace the referenced file', async () => {
  const root = await temporaryRoot();
  await mkdir(join(root, 'candidates'));
  const victim = join(root, 'private.json');
  await writeFile(victim, '{"secret":"synthetic-secret"}');
  await symlink(victim, join(root, 'candidates', `${digest(candidate)}.json`));
  await expect(publishRecord(root, candidate, candidateSchema)).rejects.toBeInstanceOf(ToolUpdateError);
  expect(await readFile(victim, 'utf8')).toBe('{"secret":"synthetic-secret"}');
});
test('symlink output ancestors are rejected before publication', async () => {
  const root = await temporaryRoot();
  const alias = join(root, 'alias');
  await symlink(root, alias);
  await expect(publishRecord(alias, candidate, candidateSchema)).rejects.toMatchObject({ code: 'unsafe_output' });
});
test.each(['prompt', 'response', 'transcript_path', 'secret', 'stderr', 'source_text'])(
  'portable candidate rejects private field %s', field => {
    expect(() => boundedParse({ ...candidate, [field]: 'synthetic-secret' }, candidateSchema))
      .toThrow(ToolUpdateError);
  });
test.each(['target', 'tag', 'commit', 'npm_integrity'])('candidate identity rejects free text in %s', field => {
  expect(() => boundedParse({ ...candidate, [field]: '/Users/synthetic/private secret' }, candidateSchema))
    .toThrow(ToolUpdateError);
});
test('oversized input is rejected before its data is parsed', async () => {
  const root = await temporaryRoot();
  const path = join(root, 'oversized.json');
  await writeFile(path, ' '.repeat(maxRecordBytes + 1));
  await expect(loadRecord(path, candidateSchema)).rejects.toBeInstanceOf(ToolUpdateError);
});
test('record loads reject invalid JSON without echoing input', async () => {
  const root = await temporaryRoot();
  const path = join(root, 'invalid.json');
  await writeFile(path, 'synthetic-secret /Users/synthetic/private');
  await expect(loadRecord(path, candidateSchema)).rejects.toMatchObject({
    code: 'record_read_failed', message: 'record_read_failed',
  });
});
