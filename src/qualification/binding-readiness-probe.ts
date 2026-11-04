import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, unlinkSync, writeSync, type Stats } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { ChildReadinessObservation } from '../binding-child-readiness.js';

const uuid = z.string().uuid();
const timestamp = z.string().datetime();
const markerSchema = z
  .strictObject({
    schema_version: z.literal(1),
    instance_id: uuid,
    attempt_id: uuid,
    generation: z.number().int().nonnegative(),
    phase: z.enum(['hold_entered', 'rebaseline_complete']),
    elapsed_ms: z.number().finite().min(0).max(2000),
    deadline: timestamp,
    boundary: timestamp.nullable()
  })
  .refine(value => (value.phase === 'hold_entered' ? value.boundary === null : value.boundary !== null));
type Marker = z.infer<typeof markerSchema>;
interface Channel {
  directory: string;
  instanceId: string;
  currentScope(remainingMs?: number): boolean;
}
interface Selection {
  taskId: string;
  rootSessionId: string;
  generation: number;
}
const privateStat = (stat: Stats) => stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0;
function directoryIdentity(directory: string): Stats | null {
  try {
    const stat = lstatSync(directory);
    return isAbsolute(directory) && stat.isDirectory() && !stat.isSymbolicLink() && privateStat(stat) ? stat : null;
  } catch {
    return null;
  }
}
function directoryMatches(directory: string, original: Stats | null): boolean {
  const current = directoryIdentity(directory);
  return !!original && !!current && original.dev === current.dev && original.ino === current.ino;
}
function scopeCurrent(channel: Channel): boolean {
  try {
    return channel.currentScope() === true;
  } catch {
    return false;
  }
}
function readMarker(path: string): Marker | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || !privateStat(stat) || stat.nlink !== 1 || stat.size > 2048) return null;
    const bytes = Buffer.alloc(2049);
    const size = readSync(fd, bytes, 0, bytes.length, 0);
    if (size > 2048) return null;
    const parsed = markerSchema.safeParse(JSON.parse(bytes.subarray(0, size).toString('utf8')) as unknown);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined)
      try {
        closeSync(fd);
      } catch {
        /* Inconclusive only. */
      }
  }
}
/** Exclusive bounded control artifacts, separate from diagnostic/measurement data. */
function publish(channel: Channel, original: Stats | null, name: string, data: unknown): boolean {
  let lock: number | undefined;
  let fd: number | undefined;
  try {
    if (!directoryMatches(channel.directory, original) || !scopeCurrent(channel)) return false;
    lock = openSync(
      join(channel.directory, '.lock'),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600
    );
    const names = readdirSync(channel.directory).filter(item => item !== '.lock');
    if (names.length >= 8 || names.some(item => !/^[0-9a-f-]{36}\.(hold\.json|complete\.json|claim)$/.test(item))) return false;
    const text = JSON.stringify(data) + '\n';
    if (Buffer.byteLength(text) > 2048) return false;
    if (!directoryMatches(channel.directory, original) || !scopeCurrent(channel)) return false;
    fd = openSync(
      join(channel.directory, name),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600
    );
    writeSync(fd, text);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined)
      try {
        closeSync(fd);
      } catch {
        /* Preserve artifacts. */
      }
    if (lock !== undefined) {
      try {
        const owned = fstatSync(lock);
        const current = lstatSync(join(channel.directory, '.lock'));
        if (current.isFile() && current.dev === owned.dev && current.ino === owned.ino) unlinkSync(join(channel.directory, '.lock'));
      } catch {
        /* Never delete a foreign lock. */
      }
      try {
        closeSync(lock);
      } catch {
        /* No retry. */
      }
    }
  }
}

/** Internal local operator wiring only. Does not install hooks or activate collection. */
export function createReadinessProbeSink(options: Channel & { selection: Selection }): (event: Readonly<ChildReadinessObservation>) => void {
  const original = directoryIdentity(options.directory);
  return event => {
    try {
      if (
        !uuid.safeParse(options.instanceId).success ||
        !directoryMatches(options.directory, original) ||
        !scopeCurrent(options) ||
        event.taskId !== options.selection.taskId ||
        event.rootSessionId !== options.selection.rootSessionId ||
        event.generation !== options.selection.generation ||
        event.starts.length !== 1
      )
        return;
      const start = event.starts[0]!;
      if (
        !uuid.safeParse(start.receiptId).success ||
        !timestamp.safeParse(start.recordedAt).success ||
        event.deadline !== new Date(Date.parse(start.recordedAt) + 2000).toISOString() ||
        Date.now() >= Date.parse(event.deadline)
      )
        return;
      const parsed = markerSchema.safeParse({
        schema_version: 1,
        instance_id: options.instanceId,
        attempt_id: event.attemptId,
        generation: event.generation,
        phase: event.phase,
        elapsed_ms: event.elapsedMs,
        deadline: event.deadline,
        boundary: event.boundary
      });
      if (!parsed.success) return;
      const marker = parsed.data;
      if (
        marker.boundary !== null &&
        (Date.parse(marker.boundary) < Date.parse(start.recordedAt) || Date.parse(marker.boundary) >= Date.parse(marker.deadline))
      )
        return;
      if (marker.phase === 'rebaseline_complete') {
        const held = readMarker(join(options.directory, start.receiptId + '.hold.json'));
        if (
          !held ||
          held.phase !== 'hold_entered' ||
          held.instance_id !== marker.instance_id ||
          held.attempt_id !== marker.attempt_id ||
          held.generation !== marker.generation ||
          held.deadline !== marker.deadline
        )
          return;
      }
      publish(options, original, start.receiptId + (marker.phase === 'hold_entered' ? '.hold.json' : '.complete.json'), marker);
    } catch {
      /* Scope or diagnostic I/O failure cannot change a collector decision. */
    }
  };
}

/** Invoke only after a new normal selected Start receipt was successfully persisted.
 * The caller must revalidate selected native/task scope before stdin and on every poll.
 * This bounded diagnostic wait returns no native blocking decision and never waits for a source.
 */
export async function waitForReadinessProbeHold(
  options: Channel & { receiptId: string; recordedAt: string; generation: number; maxWaitMs?: number }
): Promise<{ status: 'acknowledged' | 'inconclusive'; attemptId: string | null; elapsedMs: number }> {
  const began = performance.now();
  const limit = Math.min(500, Math.max(0, Number.isFinite(options.maxWaitMs ?? 500) ? (options.maxWaitMs ?? 500) : 0));
  const result = (attemptId: string | null = null) => ({
    status: attemptId === null ? ('inconclusive' as const) : ('acknowledged' as const),
    attemptId,
    elapsedMs: performance.now() - began
  });
  const original = directoryIdentity(options.directory);
  const channel: Channel = { ...options, currentScope: () => options.currentScope(Math.max(0, limit - (performance.now() - began))) };
  if (
    !uuid.safeParse(options.instanceId).success ||
    !uuid.safeParse(options.receiptId).success ||
    !timestamp.safeParse(options.recordedAt).success ||
    !Number.isSafeInteger(options.generation) ||
    options.generation < 0 ||
    !scopeCurrent(channel) ||
    performance.now() - began >= limit
  )
    return result();
  const deadline = Date.parse(options.recordedAt) + 2000;
  if (Date.now() >= deadline || Date.now() < Date.parse(options.recordedAt) || !publish(channel, original, options.receiptId + '.claim', { schema_version: 1 }))
    return result();
  while (performance.now() - began < limit) {
    if (!directoryMatches(options.directory, original) || !scopeCurrent(channel) || Date.now() >= deadline || performance.now() - began >= limit)
      return result();
    const path = join(options.directory, options.receiptId + '.hold.json');
    try {
      lstatSync(path);
      const marker = readMarker(path);
      if (
        !marker ||
        marker.phase !== 'hold_entered' ||
        marker.instance_id !== options.instanceId ||
        marker.generation !== options.generation ||
        Date.parse(marker.deadline) !== deadline
      )
        return result();
      if (!directoryMatches(options.directory, original) || !scopeCurrent(channel) || Date.now() >= deadline || performance.now() - began >= limit)
        return result();
      return result(marker.attempt_id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return result();
    }
    await delay(Math.min(10, Math.max(0, limit - (performance.now() - began))));
  }
  return result();
}
