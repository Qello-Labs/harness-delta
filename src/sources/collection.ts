import { checkedCodexContinuation, authorizeCodexContinuation, type CodexContinuationFamily } from '../workflow/codex-continuation.js';
import { parseTaskMetadata } from '../flexible-contracts.js';
import { parseFlexibleSnapshot, type FlexibleSourceScope } from './adapters-flexible.js';
import { putUsageWithEvidence, recordObservationGap, requireActiveScope } from '../core/runtime-history.js';
import { SourceFailure, sourceCategory, type SourceDiagnosticCategory } from '../core/source-errors.js';
import { constants, closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { authorizeCandidateScope, checkedCandidateScope, type CandidateScope } from '../nested-candidate.js';
import { parseCodexCandidateRollout, type CodexCandidateSources } from '../codex-candidate-rollout.js';
import {
  assertCompatibilityAllowed,
  invalidateCompatibility,
  lookupCompatibleFileProfile,
  resolveSourceCompatibility,
  sessionCompatibility
} from '../source-compatibility.js';
import { lookupFileProfile } from '../adapter-profiles.js';
import { parseSnapshot, metadataKey, type SourceScope, type Snapshot } from './adapters.js';
import { TimestampSchema } from '../contracts.js';
import { type Clock, utcNow } from '../core/lifecycle.js';
import { Store } from '../store.js';

export interface SourceBytes {
  text: string;
  identity: string;
  size: number;
  modified: number;
}
export type SourceReader = (path: string) => SourceBytes;
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
/** A bounded, transient read of one previously authorized source. */
export const readSource: SourceReader = path => {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > MAX_SOURCE_BYTES) throw new SourceFailure('unsupported_source', 'unsupported');
    const buffer = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < buffer.length) {
      const length = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (!length) throw new SourceFailure('short_read');
      offset += length;
    }
    const after = fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new SourceFailure('unstable_read');
    return { text: buffer.toString('utf8'), identity: `${after.dev}:${after.ino}`, size: after.size, modified: after.mtimeMs };
  } finally {
    closeSync(fd);
  }
};
interface LinkedSource {
  id: string;
  project_id: string;
  task_id: string;
  source_path: string;
  product: 'codex' | 'claude_code';
  product_version: string;
  local_root: string;
  generation: number;
  metadata: string;
}
interface MemoryCheckpoint {
  generation: number;
  since: string;
  lastAt: string;
  identity: string;
  size: number;
  modified: number;
  continuityKey: string | null;
  fingerprints: Record<string, string>;
  settledKeys: string[];
}

export interface CollectionDiagnostic {
  session_id: string;
  at: string;
  category: SourceDiagnosticCategory;
}

interface CandidateCheckpoint {
  generation: number;
  since: string;
  lastAt: string;
  identity: string;
  size: number;
  modified: number;
  prefixHash: string;
  settledKeys: string[];
  initialTurnId?: string;
}
const prefixHash = (text: string, bytes: number) => createHash('sha256').update(Buffer.from(text).subarray(0, bytes)).digest('hex');

export class Collector {
  private candidateCheckpoints = new Map<string, CandidateCheckpoint>();
  private checkpoints = new Map<string, MemoryCheckpoint>();
  constructor(
    private readonly store: Store,
    private readonly clock: Clock = utcNow,
    private readonly read: SourceReader = readSource,
    private readonly resolveFlexible: (product: string, version: string) => typeof parseFlexibleSnapshot | null = () => null
  ) {}
  /** Explicit offline candidate opt-in. Does not discover/link sessions, admit
   * versions, or alter tick/CLI defaults. Every root/child source must be linked
   * before access through the explicit candidate-only Lifecycle binder.
   */
  tickCodexCandidate(inputScope: CandidateScope, sources: CodexCandidateSources, initialTurns: Readonly<Record<string, string>> = {}): CollectionDiagnostic[] {
    return this.collectCodexCandidateFamily(inputScope, sources, initialTurns);
  }
  /** Explicit bounded continuation: two independently authorized root families.
   * Sources lost in one family cannot prevent fresh observations in the other.
   * Each family commits atomically; prior successful families remain partial if
   * a later family fails. Native assignment and production defaults stay closed.
   */
  tickCodexContinuation(input: readonly CodexContinuationFamily[]): CollectionDiagnostic[] {
    const families = checkedCodexContinuation(input);
    const authorize = () => authorizeCodexContinuation(this.store, families);
    authorize();
    const diagnostics: CollectionDiagnostic[] = [];
    for (const family of families) {
      authorize();
      try {
        this.collectCodexCandidateFamily(family.scope, family.sources, {}, authorize);
      } catch (error) {
        const code = error instanceof Error ? error.message : '';
        if (!['candidate_source_error', 'candidate_source_changed'].includes(code)) throw error;
        authorize();
        const now = new Date(TimestampSchema.parse(this.clock())).toISOString();
        this.store.immediateTransaction(() => {
          authorize();
          for (const session of family.scope.sessions) {
            recordObservationGap(
              this.store,
              family.scope.taskId,
              session.sessionId,
              this.candidateCheckpoints.get(session.sessionId)?.lastAt ?? now,
              now,
              'source_error',
              now
            );
          }
        });
        for (const session of family.scope.sessions) this.candidateCheckpoints.delete(session.sessionId);
        const root = family.scope.sessions.find(session => session.parentSessionId === null)!;
        diagnostics.push({ session_id: root.sessionId, at: now, category: code === 'candidate_source_error' ? 'read_failed' : 'record_changed' });
      }
    }
    return diagnostics;
  }
  private collectCodexCandidateFamily(
    inputScope: CandidateScope,
    sources: CodexCandidateSources,
    initialTurns: Readonly<Record<string, string>>,
    authorizeManifest?: () => void
  ): CollectionDiagnostic[] {
    const scope = checkedCandidateScope(inputScope);
    const pending = new Map(this.candidateCheckpoints);
    this.store.immediateTransaction(() => {
      const authorizeSources = (): LinkedSource[] => {
        authorizeManifest?.();
        authorizeCandidateScope(this.store, scope);
        if (
          scope.sessions.length > 2 ||
          scope.sessions.some(s => s.product !== 'codex' || (s.parentSessionId !== null && s.parentSessionId !== s.rootSessionId))
        )
          throw new Error('candidate_scope_mismatch');
        const taskLinks = this.store.all<LinkedSource>(
          `SELECT s.*,p.local_root,t.generation,t.metadata FROM sessions s
          JOIN tasks t ON t.id=s.task_id JOIN projects p ON p.id=s.project_id WHERE t.id=?`,
          [scope.taskId]
        );
        const links = authorizeManifest ? taskLinks.filter(link => scope.sessions.some(session => session.sessionId === link.id)) : taskLinks;
        if (
          links.length !== scope.sessions.length ||
          !isAbsolute(sources.projectRoot) ||
          resolve(sources.projectRoot) !== sources.projectRoot ||
          Object.keys(sources.paths).length !== scope.sessions.length
        )
          throw new Error('candidate_scope_mismatch');
        // Authorize the ENTIRE exact prelinked set before even the first bounded read.
        for (const mapping of scope.sessions) {
          const link = links.find(l => l.id === mapping.sessionId);
          const path = sources.paths[mapping.sourceId];
          if (
            !link ||
            link.project_id !== scope.projectId ||
            link.local_root !== sources.projectRoot ||
            typeof path !== 'string' ||
            !isAbsolute(path) ||
            resolve(path) !== path ||
            link.source_path !== path
          )
            throw new Error('candidate_scope_mismatch');
          let metadata: unknown;
          try {
            metadata = JSON.parse(link.metadata) as unknown;
          } catch {
            throw new Error('candidate_scope_mismatch');
          }
          if (typeof metadata !== 'object' || metadata === null || !('product' in metadata) || metadata.product !== 'codex')
            throw new Error('candidate_scope_mismatch');
        }
        return links;
      };
      authorizeSources();
      const tickAt = new Date(TimestampSchema.parse(this.clock())).toISOString();
      for (const mapping of scope.sessions) {
        const link = authorizeSources().find(l => l.id === mapping.sessionId)!;
        let previous = pending.get(mapping.sessionId);
        if (previous?.generation !== link.generation) previous = undefined;
        let bytes: SourceBytes;
        try {
          bytes = this.read(link.source_path);
        } catch {
          throw new Error('candidate_source_error');
        }
        const after = authorizeSources().find(l => l.id === mapping.sessionId)!;
        if (after.generation !== link.generation) throw new Error('candidate_inactive_scope');
        // A native response can arrive during the synchronous bounded read.
        // Its observation timestamp must follow the bytes actually observed.
        const now = new Date(TimestampSchema.parse(this.clock())).toISOString();
        if (Date.parse(now) < Date.parse(tickAt)) throw new Error('candidate_clock_regressed');
        // Stable append, including ignored/native content and partial trailing bytes.
        // Raw-prefix hash is memory-only, never persisted or exported.
        if (Buffer.byteLength(bytes.text) !== bytes.size || bytes.size > MAX_SOURCE_BYTES) throw new Error('candidate_source_error');
        if (
          previous &&
          (bytes.identity !== previous.identity ||
            bytes.size < previous.size ||
            prefixHash(bytes.text, previous.size) !== previous.prefixHash ||
            (bytes.size === previous.size && bytes.modified !== previous.modified))
        )
          throw new Error('candidate_source_changed');
        if (previous && Date.parse(now) < Date.parse(previous.lastAt)) throw new Error('candidate_clock_regressed');
        const snapshot = parseCodexCandidateRollout(bytes.text, scope, mapping.sourceId, sources.projectRoot, now);
        const initialTurnId = previous?.initialTurnId ?? initialTurns[mapping.sourceId];
        if (initialTurns[mapping.sourceId] !== undefined && (previous !== undefined || snapshot.records.length !== 0 || !scope.allowedRootTurnIds.length))
          throw new Error('candidate_late_handshake');
        const settled = new Set(previous?.settledKeys ?? snapshot.records.map(r => r.projection.event.id));
        if (previous) {
          for (const { projection, contextAt } of snapshot.records) {
            if (settled.has(projection.event.id)) continue;
            if (Date.parse(contextAt) <= Date.parse(previous.since) && projection.runtime.turn_id !== previous.initialTurnId) {
              settled.add(projection.event.id);
              continue;
            }
            if (Date.parse(projection.event.occurred_at) > Date.parse(now)) continue;
            let failure: string | null = null;
            try {
              putUsageWithEvidence(this.store, projection.event, projection.runtime);
            } catch (error) {
              failure =
                error instanceof Error && ['runtime_conflict', 'event_conflict'].includes(error.message) ? 'candidate_conflict' : 'candidate_storage_error';
            }
            if (failure) throw new Error(failure);
            settled.add(projection.event.id);
          }
        }
        // Best-effort rollouts never establish complete request/child coverage.
        recordObservationGap(this.store, scope.taskId, mapping.sessionId, previous?.lastAt ?? now, now, previous ? 'incomplete' : 'offline', now);
        if (snapshot.hasGap) recordObservationGap(this.store, scope.taskId, mapping.sessionId, previous?.lastAt ?? now, now, 'not_available', now);
        pending.set(mapping.sessionId, {
          generation: link.generation,
          since: previous?.since ?? now,
          lastAt: now,
          identity: bytes.identity,
          size: bytes.size,
          modified: bytes.modified,
          prefixHash: prefixHash(bytes.text, bytes.size),
          settledKeys: [...settled],
          ...(initialTurnId === undefined ? {} : { initialTurnId })
        });
      }
      authorizeSources();
    });
    this.candidateCheckpoints = pending;
    return [];
  }
  tick(taskId: string): CollectionDiagnostic[] {
    const diagnostics: CollectionDiagnostic[] = [];
    const pending = new Map(this.checkpoints);
    try {
      this.store.transaction(() => {
        // Acquire SQLite's writer lock before scope checks and bounded sync I/O.
        // Other processes cannot pause/delete/change scope until this batch ends.
        this.store.execute('UPDATE tasks SET generation = generation WHERE id = ?', [taskId]);
        const links = this.store.all<LinkedSource>(
          `SELECT s.*,p.local_root,t.generation,t.metadata FROM sessions s
          JOIN tasks t ON t.id=s.task_id JOIN projects p ON p.id=s.project_id
          WHERE t.id=? AND t.state='active' AND p.local_root IS NOT NULL
          AND s.source_path IS NOT NULL AND s.parent_id IS NULL`,
          [taskId]
        );
        if (!links.length) {
          for (const [key] of pending) pending.delete(key);
          return;
        }
        const now = new Date(TimestampSchema.parse(this.clock())).toISOString();
        for (const link of links) {
          let bytes: SourceBytes;
          let snapshot: Snapshot;
          const scope: SourceScope = { sessionId: link.id, projectRoot: link.local_root, product: link.product, version: link.product_version };
          let previous = pending.get(link.id);
          if (previous && previous.generation !== link.generation) previous = undefined;
          let stage: SourceDiagnosticCategory = 'read_failed';
          const compatibility = sessionCompatibility(this.store, link.id);
          try {
            if (this.store.get('SELECT 1 FROM claude_workflow_runs WHERE task_id=?', [taskId])) throw new SourceFailure('unsupported_source', 'unsupported');
            if (compatibility && (compatibility.product !== link.product || compatibility.product_version !== link.product_version))
              throw new Error('unsupported');
            // Access checks also apply to old exact sessions without provenance.
            // Resolving here grants no historical trust and does not persist a pin.
            const accessCompatibility = compatibility ?? resolveSourceCompatibility(link.product, link.product_version, 'file');
            if (accessCompatibility) assertCompatibilityAllowed(this.store, accessCompatibility);
            const taskMetadata = parseTaskMetadata(JSON.parse(link.metadata) as unknown);
            if ('schema_version' in taskMetadata && taskMetadata.schema_version === 2) {
              const checkpoint = this.collectFlexible(link, now, previous);
              if (checkpoint) pending.set(link.id, checkpoint);
              else pending.delete(link.id);
              continue;
            }
            if (
              lookupCompatibleFileProfile(link.product, link.product_version, compatibility ?? undefined) === 'unsupported' ||
              (!compatibility && lookupFileProfile(link.product, link.product_version) === 'unsupported')
            )
              throw new Error('unsupported');
            bytes = this.read(link.source_path);
            if (previous && bytes.identity !== previous.identity) throw new SourceFailure('identity_changed');
            if (previous && bytes.size < previous.size) throw new SourceFailure('source_truncated');
            if (previous && now < previous.lastAt) throw new SourceFailure('clock_regressed');
            stage = 'parse_failed';
            snapshot = parseSnapshot(bytes.text, scope, compatibility ?? undefined);
            if (snapshot.blocked && compatibility?.state === 'compatibility_unverified') throw new SourceFailure('parse_failed', 'unsupported');
            // A stable same-size Claude rewrite may leave every measurement
            // field unchanged. Preserve the interval only with positive semantic
            // equality; new/revised metadata and other products still fail closed.
            if (
              previous &&
              bytes.size === previous.size &&
              bytes.modified !== previous.modified &&
              (!snapshot.continuityKey || snapshot.continuityKey !== previous.continuityKey)
            )
              throw new SourceFailure('same_size_modified');
            const metadata = JSON.parse(link.metadata) as { model: string; product: string };
            if (
              metadata.product !== link.product ||
              (snapshot.model && snapshot.model !== metadata.model) ||
              snapshot.records.some(r => r.payload.kind === 'usage' && r.payload.model !== metadata.model)
            )
              throw new SourceFailure('model_mismatch', 'unsupported');
          } catch (error) {
            if (compatibility?.state === 'compatibility_unverified' && stage === 'parse_failed')
              invalidateCompatibility(this.store, compatibility, 'contract_failed');
            const reason = error instanceof Error && ['unsupported', 'scope_mismatch'].includes(error.message) ? error.message : 'source_error';
            diagnostics.push({
              session_id: link.id,
              at: now,
              category:
                error instanceof Error && error.message === 'compatibility_invalidated'
                  ? 'compatibility_invalidated'
                  : sourceCategory(error, reason === 'scope_mismatch' ? 'scope_mismatch' : reason === 'unsupported' ? 'unsupported_source' : stage)
            });
            this.observe(taskId, now, now, 'error', reason);
            pending.delete(link.id);
            this.store.execute('DELETE FROM cursors WHERE session_id=?', [link.id]);
            continue;
          }
          const current = this.store.get<{ state: string; generation: number }>('SELECT state,generation FROM tasks WHERE id=?', [taskId]);
          if (!current || current.state !== 'active' || current.generation !== link.generation) {
            pending.delete(link.id);
            continue;
          }
          const fingerprints = Object.fromEntries(snapshot.records.map(row => [row.key, metadataKey(JSON.stringify(row))]));
          if (previous && Object.entries(previous.fingerprints).some(([key, value]) => fingerprints[key] !== value)) {
            if (compatibility?.state === 'compatibility_unverified') invalidateCompatibility(this.store, compatibility, 'contract_failed');
            diagnostics.push({ session_id: link.id, at: now, category: 'record_changed' });
            this.observe(taskId, now, now, 'error', 'source_error');
            pending.delete(link.id);
            this.store.execute('DELETE FROM cursors WHERE session_id=?', [link.id]);
            continue;
          }
          // Baseline and blocked records are permanently excluded from this
          // interval. Otherwise fingerprint future records without settling them.
          // Copy nested state so a failed transaction cannot consume eligibility.
          const settledKeys = new Set(previous && !snapshot.blocked ? previous.settledKeys : Object.keys(fingerprints));
          if (previous && !snapshot.blocked) {
            for (const record of snapshot.records) {
              if (settledKeys.has(record.key)) continue;
              if (!record.turnStartedAt || record.turnStartedAt <= previous.since) {
                settledKeys.add(record.key);
                continue;
              }
              if (record.at > now) continue;
              const key = metadataKey(link.id, record.key);
              this.store.putEvent({
                id: key,
                source_key: key,
                project_id: link.project_id,
                task_id: link.task_id,
                session_id: link.id,
                occurred_at: record.at,
                payload: record.payload
              });
              settledKeys.add(record.key);
            }
          }
          const checkpoint: MemoryCheckpoint = {
            generation: link.generation,
            since: previous?.since ?? now,
            lastAt: now,
            identity: bytes.identity,
            size: bytes.size,
            modified: bytes.modified,
            continuityKey: snapshot.continuityKey,
            fingerprints,
            settledKeys: [...settledKeys]
          };
          pending.set(link.id, checkpoint);
          // Persist metadata-only position for diagnostics. A new Collector never
          // resumes it: every process/run establishes its own current-tail baseline.
          this.store.execute(
            `INSERT INTO cursors(session_id,checkpoint) VALUES (?,?)
            ON CONFLICT(session_id) DO UPDATE SET checkpoint=excluded.checkpoint`,
            [link.id, JSON.stringify(checkpoint)]
          );
          this.observe(
            taskId,
            previous?.lastAt ?? now,
            now,
            previous ? 'unmeasurable' : 'excluded',
            snapshot.blocked
              ? (snapshot.reasons.find(reason => reason !== 'incomplete' && reason !== 'unsupported') ?? 'unsupported')
              : previous
                ? 'incomplete'
                : 'offline'
          );
        }
      });
      this.checkpoints = pending;
      return diagnostics;
    } catch {
      throw new Error('collection_error');
    }
  }
  private collectFlexible(link: LinkedSource, now: string, previous: MemoryCheckpoint | undefined): MemoryCheckpoint | null {
    requireActiveScope(this.store, link.task_id, link.id);
    const parser = this.resolveFlexible(link.product, link.product_version);
    if (!parser) throw new SourceFailure('unsupported_source', 'unsupported');
    if (this.store.get('SELECT id FROM otel_processes WHERE task_id=?', [link.task_id])) throw new SourceFailure('unsupported_source', 'unsupported');
    const metadata = parseTaskMetadata(JSON.parse(link.metadata) as unknown);
    if (metadata.product !== link.product) throw new SourceFailure('scope_mismatch', 'scope_mismatch');
    const bytes = this.read(link.source_path);
    const current = this.store.get<{ state: string; generation: number }>('SELECT state,generation FROM tasks WHERE id=?', [link.task_id]);
    if (!current || current.state !== 'active' || current.generation !== link.generation) return null;
    if (previous && bytes.identity !== previous.identity) throw new SourceFailure('identity_changed');
    if (previous && bytes.size < previous.size) throw new SourceFailure('source_truncated');
    if (previous && now < previous.lastAt) throw new SourceFailure('clock_regressed');
    const scope: FlexibleSourceScope = {
      sessionId: link.id,
      projectRoot: link.local_root,
      product: link.product,
      version: link.product_version,
      taskId: link.task_id,
      projectId: link.project_id
    };
    const snapshot = parser(bytes.text, scope, now);
    const fingerprints = Object.fromEntries(snapshot.records.map(row => [row.id, metadataKey(JSON.stringify(row))]));
    if (previous && Object.entries(previous.fingerprints).some(([key, value]) => fingerprints[key] !== value)) throw new SourceFailure('record_changed');
    if (
      previous &&
      bytes.size === previous.size &&
      bytes.modified !== previous.modified &&
      JSON.stringify(fingerprints) !== JSON.stringify(previous.fingerprints)
    )
      throw new SourceFailure('same_size_modified');
    const settledKeys = new Set(previous?.settledKeys ?? Object.keys(fingerprints));
    if (!previous) recordObservationGap(this.store, link.task_id, link.id, now, now, 'offline', now);
    for (const gap of snapshot.gaps) recordObservationGap(this.store, link.task_id, link.id, gap.started_at, gap.ended_at, gap.reason, now);
    if (this.store.get('SELECT id FROM sessions WHERE task_id=? AND parent_id IS NOT NULL', [link.task_id]))
      recordObservationGap(this.store, link.task_id, link.id, previous?.lastAt ?? now, null, 'unknown_parent', now);
    if (previous) {
      for (const event of snapshot.records) {
        if (settledKeys.has(event.id)) continue;
        const evidenceId = 'runtime_evidence_id' in event.payload ? event.payload.runtime_evidence_id : null;
        const evidence = snapshot.runtime.find(r => r.id === evidenceId) ?? null;
        if (Date.parse(event.occurred_at) > Date.parse(now)) continue;
        // A setting boundary must originate after this process's baseline.
        if (!evidence || evidence.boundary === 'unknown' || Date.parse(evidence.occurred_at) <= Date.parse(previous.since)) {
          settledKeys.add(event.id);
          continue;
        }
        putUsageWithEvidence(this.store, event, evidence);
        settledKeys.add(event.id);
      }
    }
    const checkpoint: MemoryCheckpoint = {
      generation: link.generation,
      since: previous?.since ?? now,
      lastAt: now,
      identity: bytes.identity,
      size: bytes.size,
      modified: bytes.modified,
      continuityKey: metadataKey(JSON.stringify(fingerprints)),
      fingerprints,
      settledKeys: [...settledKeys]
    };
    this.store.execute(`INSERT INTO cursors(session_id,checkpoint) VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET checkpoint=excluded.checkpoint`, [
      link.id,
      JSON.stringify(checkpoint)
    ]);
    this.observe(link.task_id, previous?.lastAt ?? now, now, previous ? 'unmeasurable' : 'excluded', previous ? 'incomplete' : 'offline');
    return checkpoint;
  }
  private observe(taskId: string, start: string, end: string, status: string, reason: string): void {
    this.store.execute('INSERT INTO observations(id,task_id,started_at,ended_at,status,reason) VALUES (?,?,?,?,?,?)', [
      randomUUID(),
      taskId,
      start,
      end,
      status,
      reason
    ]);
  }
}
