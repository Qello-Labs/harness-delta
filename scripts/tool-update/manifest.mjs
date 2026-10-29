import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, link, unlink } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { z } from 'zod';
import { laneSchema } from './lanes.mjs';

export const versionSchema = z.string().regex(/^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/);
export const shaSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const maxRecordBytes = 256 * 1024;
export class ToolUpdateError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ToolUpdateError';
    this.code = code;
  }
}
export function fail(code) { throw new ToolUpdateError(code); }
export function compareVersions(a, b) {
  const left = versionSchema.parse(a).split('.').map(Number);
  const right = versionSchema.parse(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]));
  }
  return value;
}
export function canonical(value) { return `${JSON.stringify(sorted(value))}\n`; }
export function digest(value) { return createHash('sha256').update(canonical(value)).digest('hex'); }
export const baselineSchema = z.strictObject({
  schema_version: z.literal(1), kind: z.literal('baseline'),
  rows: z.array(laneSchema.extend({
    last_reviewed_version: versionSchema, contract_revision: z.literal('consumed-v1'),
    evidence_ids: z.array(shaSchema).min(1).max(64),
    source_digest: shaSchema,
  })).max(256),
});
export function laneKey(row) {
  return [row.product, row.route, row.profile_id, row.operation, row.topology].join(':');
}
export function parseBaseline(input) {
  let parsed;
  try { parsed = boundedParse(input, baselineSchema); }
  catch (error) {
    if (error instanceof ToolUpdateError && error.code === 'invalid_record') fail('invalid_baseline');
    throw error;
  }
  const keys = parsed.rows.map(laneKey);
  if (new Set(keys).size !== keys.length ||
    parsed.rows.some(row => new Set(row.evidence_ids).size !== row.evidence_ids.length)) fail('invalid_baseline');
  return { ...parsed, rows: parsed.rows.map(row => ({
    ...row, evidence_ids: [...row.evidence_ids].sort(),
  })).sort((a, b) => laneKey(a).localeCompare(laneKey(b), 'en')) };
}
export function boundedParse(input, schema) {
  let bytes;
  try { bytes = Buffer.byteLength(canonical(input)); }
  catch { return fail('invalid_record'); }
  if (bytes > maxRecordBytes) fail('record_too_large');
  const parsed = schema.safeParse(input);
  if (!parsed.success) fail('invalid_record');
  return parsed.data;
}
function ioCode(error, code) {
  return error instanceof Error && 'code' in error && error.code === code;
}
async function readRecordBytes(path, checkCtime = true) {
  let file;
  try {
    await checkAncestors(dirname(resolve(path)));
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await file.stat();
    if (!before.isFile() || before.size > maxRecordBytes) fail('invalid_record');
    const buffer = Buffer.alloc(maxRecordBytes + 1);
    let length = 0;
    for (;;) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      length += bytesRead;
      if (length > maxRecordBytes) fail('record_too_large');
      if (bytesRead === 0) break;
    }
    const after = await file.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
      checkCtime && before.ctimeMs !== after.ctimeMs) fail('record_conflict');
    return buffer.subarray(0, length);
  } catch (error) {
    if (error instanceof ToolUpdateError) throw error;
    return fail('record_read_failed');
  } finally { await file?.close(); }
}
export async function loadRecord(path, schema) {
  const bytes = await readRecordBytes(path);
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { return fail('record_read_failed'); }
  return boundedParse(value, schema);
}
async function checkAncestors(path, create = false) {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split('/').filter(Boolean)) {
    current = join(current, part);
    if (create) await mkdir(current, { mode: 0o700 }).catch(error => {
      if (!ioCode(error, 'EEXIST')) throw error;
    });
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('unsafe_output');
  }
}
export async function publishRecord(root, input, schema) {
  const record = boundedParse(input, schema);
  const folders = { candidate: 'candidates', observation: 'observations', assessment: 'assessments' };
  const folder = folders[record.kind];
  if (!folder) fail('invalid_record');
  const id = digest(record);
  const directory = join(resolve(root), folder);
  const destination = join(directory, `${id}.json`);
  const temporary = join(directory, `.pending-${randomUUID()}`);
  const content = canonical(record);
  let file;
  let owned = false;
  try {
    await checkAncestors(directory, true);
    file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    owned = true;
    await file.writeFile(content); await file.sync(); await file.close(); file = undefined;
    try { await link(temporary, destination); }
    catch (error) {
      if (!ioCode(error, 'EEXIST')) throw error;
      // Removing a concurrent writer's temporary hard link changes ctime, not bytes.
      const existing = await readRecordBytes(destination, false);
      if (!existing.equals(Buffer.from(content))) fail('record_conflict');
    }
    const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await parent.sync(); } finally { await parent.close(); }
    return id;
  } catch (error) {
    if (error instanceof ToolUpdateError) throw error;
    return fail('record_write_failed');
  } finally {
    await file?.close();
    if (owned) await unlink(temporary);
  }
}
