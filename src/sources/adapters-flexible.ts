import { childActivity, checkpointAllowed } from '../codex-rollout-policy.js';
import { realpathSync } from 'node:fs';
import { orderedToolVersionProfiles } from '../core/tool-version-profiles.js';
import { resolve } from 'node:path';
import { z } from 'zod';
import { metadataKey, observed, parseSnapshot, type SourceScope } from './adapters.js';
import { addTokens, IdSchema, ModelSchema, TimestampSchema, TokenSchema } from '../contracts.js';
import { EventV2Schema, RuntimeEvidenceSchema, type UsageEvent, type RuntimeEvidence } from '../flexible-contracts.js';
import { SourceFailure } from '../core/source-errors.js';
const candidates = orderedToolVersionProfiles('syntheticCandidate').map(profile => ({
  product: profile.product,
  version: profile.version,
  admitted: profile.syntheticCandidate?.admitted
}));
export interface FlexibleSnapshot {
  records: UsageEvent[];
  runtime: RuntimeEvidence[];
  gaps: { started_at: string; ended_at: string | null; reason: string }[];
  blocked: boolean;
}
export type FlexibleSourceScope = SourceScope & { taskId: string; projectId: string };
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const canonicalPath = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};
const countersSchema = z.tuple([TokenSchema, TokenSchema, TokenSchema, TokenSchema, TokenSchema]);
function fixedParse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new SourceFailure('unsupported_source', 'unsupported');
  return r.data;
}
/** Synthetic candidate semantics only. No production resolver admits this parser. */
export function parseFlexibleSnapshot(text: string, scope: FlexibleSourceScope, recordedAt: string): FlexibleSnapshot {
  fixedParse(IdSchema, scope.taskId);
  fixedParse(IdSchema, scope.projectId);
  fixedParse(IdSchema, scope.sessionId);
  fixedParse(TimestampSchema, recordedAt);
  if (!candidates.some(p => p.product === scope.product && p.version === scope.version && p.admitted === false))
    throw new SourceFailure('unsupported_source', 'unsupported');
  const result: FlexibleSnapshot = { records: [], runtime: [], gaps: [], blocked: false };
  const rows: Record<string, unknown>[] = text
    .slice(0, text.lastIndexOf('\n') + 1)
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try {
        return object(JSON.parse(line) as unknown);
      } catch {
        throw new SourceFailure('invalid_json');
      }
    });
  if (scope.product === 'claude_code') return parseClaudeCandidate(rows, scope, recordedAt);
  let intervalChanged = false;
  let identified = false;
  let current: RuntimeEvidence | null = null;
  let lastModel: string | null = null;
  let previous: z.infer<typeof countersSchema> | null = null;
  let epoch = 0;
  let previousAt: string | null = null;
  const gap = (reason: string, at: string, block: boolean) => {
    result.gaps.push({ started_at: at, ended_at: null, reason });
    if (block) result.blocked = true;
  };
  for (const row of rows) {
    const p = object(row.payload);
    if (row.type === 'session_meta') {
      if (
        identified ||
        p.id !== scope.sessionId ||
        (p.session_id !== undefined && p.session_id !== scope.sessionId) ||
        typeof p.cwd !== 'string' ||
        canonicalPath(p.cwd) !== canonicalPath(scope.projectRoot) ||
        p.cli_version !== scope.version ||
        !['cli', 'exec'].includes(String(p.source))
      )
        throw new SourceFailure('scope_mismatch', 'scope_mismatch');
      if (p.forked_from_id !== undefined && p.forked_from_id !== null) throw new SourceFailure('unsupported_source', 'unsupported');
      identified = true;
      continue;
    }
    if (!identified) throw new SourceFailure('scope_mismatch', 'scope_mismatch');
    if (!['turn_context', 'event_msg', 'response_item', 'world_state', 'token_usage_record', 'compacted'].includes(String(row.type))) {
      gap('unsupported', previousAt ?? recordedAt, true);
      continue;
    }
    const item = object(p.item);
    if (
      row.type === 'compacted' ||
      p.type === 'context_compacted' ||
      childActivity(row.type, p) ||
      item.type === 'SubAgentActivity' ||
      String(p.type).startsWith('collab_')
    ) {
      gap(row.type === 'compacted' || p.type === 'context_compacted' ? 'unsupported' : 'unknown_parent', previousAt ?? recordedAt, true);
      continue;
    }
    if (row.type === 'event_msg' && p.type === 'thread_settings_applied') {
      if (!checkpointAllowed(p, scope.sessionId, scope.projectRoot, null)) throw new SourceFailure('scope_mismatch', 'scope_mismatch');
      const nextModel = object(p.thread_settings).model;
      if (nextModel !== undefined && fixedParse(ModelSchema, nextModel) !== current?.model) intervalChanged = true;
    }
    if (row.type === 'event_msg' && p.type === 'task_started' && p.root_turn_id !== undefined && p.root_turn_id !== p.turn_id) {
      gap('unknown_parent', previousAt ?? recordedAt, true);
      continue;
    }
    if (row.type === 'turn_context') {
      if (typeof p.cwd !== 'string' || canonicalPath(p.cwd) !== canonicalPath(scope.projectRoot)) throw new SourceFailure('scope_mismatch', 'scope_mismatch');
      if (p.root_turn_id !== undefined && p.root_turn_id !== p.turn_id) {
        gap('unknown_parent', previousAt ?? recordedAt, true);
        continue;
      }
      const at = typeof row.timestamp === 'string' ? fixedParse(TimestampSchema, row.timestamp) : previousAt;
      if (!at) {
        gap('incomplete', recordedAt, true);
        continue;
      }
      const model = p.model === undefined || p.model === null ? null : fixedParse(ModelSchema, p.model);
      const turnId = p.turn_id === undefined ? null : fixedParse(IdSchema, p.turn_id);
      const effort = p.effort === undefined || p.effort === null ? null : fixedParse(IdSchema, p.effort);
      if (previous !== null && result.runtime.at(-1)?.model !== model) intervalChanged = true;
      current = fixedParse(RuntimeEvidenceSchema, {
        id: metadataKey(scope.sessionId, 'runtime', at, turnId ?? 'unknown', model ?? 'unknown', effort ?? 'unknown'),
        task_id: scope.taskId,
        session_id: scope.sessionId,
        turn_id: turnId,
        request_id: null,
        model,
        effort,
        product: scope.product,
        product_version: scope.version,
        source: 'product_log',
        occurred_at: at,
        recorded_at: recordedAt,
        boundary: turnId === null ? 'unknown' : 'turn'
      });
      result.runtime.push(current);
      continue;
    }
    if (row.type !== 'event_msg' || p.type !== 'token_count' || p.info === null) continue;
    const at = fixedParse(TimestampSchema, row.timestamp);
    if (previousAt !== null && Date.parse(at) < Date.parse(previousAt)) throw new SourceFailure('clock_regressed');
    const u = object(object(p.info).total_token_usage);
    const counts = fixedParse(countersSchema, [u.input_tokens, u.cached_input_tokens, u.output_tokens, u.reasoning_output_tokens, u.cache_write_input_tokens]);
    if (addTokens([counts[1], counts[4]]) > counts[0] || counts[3] > counts[2]) throw new SourceFailure('unsupported_source', 'unsupported');
    if (previous && counts.some((v, i) => v < previous![i]!)) {
      epoch++;
      gap('counter_reset', previousAt ?? at, false);
      previous = counts;
      previousAt = at;
      lastModel = current?.model ?? null;
      intervalChanged = false;
      continue;
    }
    if (result.blocked) continue;
    if (!previous || counts.some((v, i) => v !== previous![i]!)) {
      const d = counts.map((v, i) => v - (previous?.[i] ?? 0));
      if (addTokens([d[1]!, d[4]!]) > d[0]! || d[3]! > d[2]!) {
        gap('incomplete', at, true);
        continue;
      }
      const crossed = previous !== null && (intervalChanged || lastModel !== current?.model);
      const verified = !crossed && current?.model !== null && current !== null && current.boundary !== 'unknown';
      const key = metadataKey(scope.sessionId, 'flexible-usage', String(epoch), ...counts.map(String));
      result.records.push(
        fixedParse(EventV2Schema, {
          id: key,
          source_key: key,
          project_id: scope.projectId,
          task_id: scope.taskId,
          session_id: scope.sessionId,
          occurred_at: at,
          payload: {
            schema_version: 2,
            kind: 'usage',
            input_total: observed(d[0]!),
            cached_input: observed(d[1]!),
            output_total: observed(d[2]!),
            reasoning_output: d[3] === 0 ? observed(0) : { status: 'unmeasurable', value: null, reason: 'unsupported' },
            product: scope.product,
            product_version: scope.version,
            model: verified ? (current?.model ?? null) : null,
            epoch: `epoch-${epoch}`,
            runtime_evidence_id: current?.id ?? null,
            attribution: crossed ? 'ambiguous' : verified ? 'verified' : 'unknown',
            billing_components: verified
              ? [
                  { kind: 'ordinary_input', reading: observed(d[0]! - d[1]! - d[4]!) },
                  { kind: 'cache_read', reading: observed(d[1]!) },
                  { kind: 'cache_write', reading: observed(d[4]!) },
                  { kind: 'output', reading: observed(d[2]!) }
                ]
              : []
          }
        })
      );
    }
    previous = counts;
    previousAt = at;
    lastModel = current?.model ?? null;
    intervalChanged = false;
  }
  if (!identified) throw new SourceFailure('scope_mismatch', 'scope_mismatch');
  return result;
}
function parseClaudeCandidate(rows: Record<string, unknown>[], scope: FlexibleSourceScope, recordedAt: string): FlexibleSnapshot {
  const result: FlexibleSnapshot = { records: [], runtime: [], gaps: [], blocked: false };
  const seen = new Map<string, string>();
  const snapshot = parseSnapshot(rows.map(row => JSON.stringify(row)).join('\n') + '\n', scope);
  {
    if (snapshot.blocked) {
      result.blocked = true;
      result.gaps.push({ started_at: recordedAt, ended_at: null, reason: 'unknown_parent' });
      return result;
    }
    for (const record of snapshot.records) {
      if (record.payload.kind !== 'usage') continue;
      const payload = record.payload;
      const id = metadataKey(scope.sessionId, 'runtime', record.key);
      const runtime = fixedParse(RuntimeEvidenceSchema, {
        id,
        task_id: scope.taskId,
        session_id: scope.sessionId,
        turn_id: null,
        request_id: record.key,
        model: payload.model,
        effort: null,
        product: scope.product,
        product_version: scope.version,
        source: 'product_log',
        occurred_at: record.turnStartedAt ?? record.at,
        recorded_at: recordedAt,
        boundary: record.turnStartedAt === null ? 'unknown' : 'request'
      });
      const components = record.inputComponents;
      const key = metadataKey(scope.sessionId, 'flexible-usage', record.key);
      const event = fixedParse(EventV2Schema, {
        id: key,
        source_key: key,
        task_id: scope.taskId,
        project_id: scope.projectId,
        session_id: scope.sessionId,
        occurred_at: record.at,
        payload: {
          ...payload,
          schema_version: 2,
          runtime_evidence_id: id,
          attribution: components && record.turnStartedAt !== null ? 'verified' : 'unknown',
          billing_components: components
            ? [
                { kind: 'ordinary_input', reading: observed(components[0]) },
                { kind: 'cache_write', reading: observed(components[1]) },
                { kind: 'cache_read', reading: observed(components[2]) },
                { kind: 'output', reading: payload.output_total }
              ]
            : []
        }
      });
      const before = seen.get(key);
      const serialized = JSON.stringify(event);
      if (before && before !== serialized) throw new SourceFailure('record_conflict');
      if (!before) {
        seen.set(key, serialized);
        result.runtime.push(runtime);
        result.records.push(event);
      }
    }
  }
  return result;
}
