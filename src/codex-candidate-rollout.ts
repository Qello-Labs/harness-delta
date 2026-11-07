import type { SourceCompatibility } from './contracts.js';
import { resolve } from 'node:path';
import { z } from 'zod';
import { IdSchema, TimestampSchema, TokenSchema } from './contracts.js';
import { projectCandidateObservation, type CandidateProjection, type CandidateScope } from './nested-candidate.js';

/** Internal opt-in reader for pinned Codex 0.160 metadata. Never follows history_base
 * paths. Paginated child projection starts at the native own-history ordinal.
 * Source: a956835d020762cb2b570053af06f643a11c0ecc, SessionMeta,
 * TurnContextItem, TokenUsageRecord and rollout/ordinal.rs. No completeness claim.
 */
export interface CodexCandidateSources {
  projectRoot: string;
  paths: Record<string, string>;
}
export interface CodexCandidateRecord {
  projection: Extract<CandidateProjection, { kind: 'usage' }>;
  contextAt: string;
}
export interface CodexCandidateSnapshot {
  records: CodexCandidateRecord[];
  hasGap: boolean;
}
const envelopeSchema = z.object({ type: z.string(), timestamp: TimestampSchema.optional(), ordinal: TokenSchema.optional(), payload: z.unknown() });
const headerSchema = z.object({
  cwd: z.string(),
  history_mode: z.enum(['legacy', 'paginated']).optional(),
  subagent_history_start_ordinal: TokenSchema.nullish(),
  forked_from_id: IdSchema.nullish(),
  forked_from_ordinal_exclusive: TokenSchema.nullish(),
  history_base: z.unknown().optional()
});
const contextSchema = z.object({
  turn_id: IdSchema.nullish(),
  root_turn_id: IdSchema.nullish(),
  model: z.string().optional(),
  effort: IdSchema.nullish(),
  cwd: z.string()
});
const responseIdentity = z.object({ turn_id: IdSchema, thread_id: IdSchema });
const eventType = z.object({ type: z.string() });
export function parseCodexCandidateRollout(
  text: string,
  scope: CandidateScope,
  sourceId: string,
  projectRoot: string,
  recordedAt: string,
  compatibility?: SourceCompatibility
): CodexCandidateSnapshot {
  const lines = text.split('\n');
  const partial = lines.pop()!;
  if (lines.length === 0 || lines.length > 65536) throw new Error('candidate_invalid_metadata');
  let meta: unknown;
  let context: unknown = null;
  let contextAt: string | null = null;
  let ownStart: number | null = null;
  let nextOrdinal: number | null = null;
  let hasGap = partial.length > 0;
  const records: CodexCandidateRecord[] = [];
  const seen = new Map<string, string>();
  for (let index = 0; index < lines.length; index++) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(lines[index]!) as unknown;
    } catch {
      throw new Error('candidate_invalid_metadata');
    }
    const parsed = envelopeSchema.safeParse(decoded);
    if (!parsed.success) throw new Error('candidate_invalid_metadata');
    const row = parsed.data;
    if (index === 0) {
      if (row.type !== 'session_meta') throw new Error('candidate_invalid_metadata');
      const header = headerSchema.safeParse(row.payload);
      if (!header.success || resolve(header.data.cwd) !== projectRoot) throw new Error('candidate_scope_mismatch');
      meta = row.payload;
      const marked =
        header.data.forked_from_id != null ||
        header.data.history_base != null ||
        header.data.forked_from_ordinal_exclusive != null ||
        header.data.subagent_history_start_ordinal != null;
      if (marked) {
        if (header.data.history_mode !== 'paginated' || header.data.subagent_history_start_ordinal == null || row.ordinal == null)
          throw new Error('candidate_unsupported_history');
        const base = z.object({ end_ordinal_exclusive: TokenSchema }).safeParse(header.data.history_base);
        if (!base.success || row.ordinal !== base.data.end_ordinal_exclusive) throw new Error('candidate_unsupported_history');
        ownStart = header.data.subagent_history_start_ordinal;
      }
      if (header.data.history_mode === 'paginated') {
        if (row.ordinal == null) throw new Error('candidate_unsupported_history');
        nextOrdinal = row.ordinal;
      } else if (row.ordinal != null) throw new Error('candidate_unsupported_history');
      const identity = projectCandidateObservation(
        scope,
        sourceId,
        {
          kind: 'codex_response',
          occurredAt: recordedAt,
          sessionMeta: meta,
          turnContext: null,
          record: null,
          ...(ownStart === null ? {} : { recordOrdinal: ownStart })
        },
        recordedAt,
        compatibility
      );
      if (identity.kind === 'unattributed' && identity.reason === 'unsupported_history') throw new Error('candidate_unsupported_history');
    } else if (row.type === 'session_meta') throw new Error('candidate_unsupported_history');
    if (nextOrdinal !== null) {
      if (row.ordinal !== nextOrdinal || !Number.isSafeInteger(nextOrdinal + 1)) throw new Error('candidate_unsupported_history');
      nextOrdinal++;
    } else if (row.ordinal != null) throw new Error('candidate_unsupported_history');
    if (ownStart !== null && row.ordinal! < ownStart) continue;
    if (row.type === 'turn_context') {
      const turn = contextSchema.safeParse(row.payload);
      if (!turn.success || resolve(turn.data.cwd) !== projectRoot) throw new Error('candidate_scope_mismatch');
      context = turn.data.turn_id != null && turn.data.model != null ? turn.data : null;
      contextAt = row.timestamp ?? null;
    } else if (row.type === 'event_msg') {
      const event = eventType.safeParse(row.payload);
      if (!event.success) throw new Error('candidate_invalid_metadata');
      if (['task_started', 'task_complete', 'turn_aborted'].includes(event.data.type)) {
        context = null;
        contextAt = null;
      }
      // EventMsg token_count is a cumulative mirror (including inherited history).
    } else if (row.type === 'compacted' || row.type === 'retained_context') {
      context = null;
      contextAt = null;
      hasGap = true;
    } else if (row.type === 'token_usage_record') {
      const identity = responseIdentity.safeParse(row.payload);
      if (!identity.success || row.timestamp == null) throw new Error('candidate_invalid_metadata');
      const matching = contextSchema.safeParse(context);
      const paired =
        matching.success && matching.data.turn_id === identity.data.turn_id && contextAt !== null && Date.parse(contextAt) <= Date.parse(row.timestamp);
      if (!paired) {
        context = null;
        contextAt = null;
      }
      const projection = projectCandidateObservation(
        scope,
        sourceId,
        {
          kind: 'codex_response',
          occurredAt: row.timestamp,
          sessionMeta: meta,
          turnContext: paired ? context : null,
          record: row.payload,
          ...(row.ordinal == null ? {} : { recordOrdinal: row.ordinal })
        },
        recordedAt,
        compatibility
      );
      if (projection.kind === 'usage') {
        const fingerprint = JSON.stringify({ event: projection.event, runtime: { ...projection.runtime, recorded_at: null } });
        const before = seen.get(projection.event.id);
        if (before != null && before !== fingerprint) throw new Error('candidate_conflict');
        if (before == null) records.push({ projection, contextAt: contextAt! });
        seen.set(projection.event.id, fingerprint);
      } else if (projection.kind === 'unattributed') hasGap = true;
    }
    // All other native records (including prompt/response items) are transient
    // and never enter events, evidence, diagnostics or cursor data.
  }
  return { records, hasGap };
}
