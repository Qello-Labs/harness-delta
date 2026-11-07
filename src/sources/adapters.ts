import { checkpointAllowed, childActivity, collaborationMode, multiAgentAllowed, multiAgentVersion } from '../codex-rollout-policy.js';
import { SourceFailure } from '../core/source-errors.js';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { addTokens, IdSchema, ModelSchema, TimestampSchema, TokenSchema, type Event, type Reading } from '../contracts.js';
import { type ClaudeRegisteredProfile, type CodexRegisteredProfile } from '../adapter-profiles.js';
import { lookupCompatibleFileProfile } from '../source-compatibility.js';
import type { SourceCompatibility } from '../contracts.js';

export interface SourceScope {
  sessionId: string;
  projectRoot: string;
  product: 'codex' | 'claude_code';
  version: string;
}
export interface SourceRecord {
  key: string;
  at: string;
  turnStartedAt: string | null;
  toolCallIds?: string[];
  inputComponents?: readonly [number, number, number];
  payload: Event['payload'];
}
export interface Snapshot {
  continuityKey: string | null;
  records: SourceRecord[];
  counters: number[] | null;
  counterAt: string | null;
  model: string | null;
  reasons: string[];
  blocked: boolean;
}
const canonicalPath = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as ObjectValue) : {});
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const id = (value: unknown): string => {
  const result = IdSchema.safeParse(value);
  if (!result.success) throw new Error('unsupported');
  return result.data;
};
const count = (value: unknown): number => {
  const result = TokenSchema.safeParse(value);
  if (!result.success) throw new Error('unsupported');
  return result.data;
};
const timestamp = (value: unknown): string => {
  const result = TimestampSchema.safeParse(value);
  if (!result.success) throw new Error('unsupported');
  return new Date(result.data).toISOString();
};
const listed = (names: readonly string[], value: unknown): boolean => names.includes(String(value));
const exactName = (names: readonly string[], value: unknown): boolean => typeof value === 'string' && names.includes(value);
export const metadataKey = (...values: string[]): string => createHash('sha256').update(JSON.stringify(values)).digest('hex');
export const observed = (value: number): Reading => ({ status: 'observed', value, reason: null });
export const unavailable = (): Reading => ({ status: 'unmeasurable', value: null, reason: 'unsupported' });
export function usagePayload(scope: SourceScope, counters: number[], model: string, epoch: string): Event['payload'] {
  if (!ModelSchema.safeParse(model).success || counters.length !== 4) throw new Error('unsupported');
  const [input, cached, output, reasoning] = counters as [number, number, number, number];
  if (cached > input || reasoning > output) throw new Error('unsupported');
  return {
    kind: 'usage',
    product: scope.product,
    product_version: scope.version,
    model,
    epoch,
    input_total: observed(input),
    cached_input: observed(cached),
    output_total: observed(output),
    // Nonzero reasoning semantics have not yet been validated for either source.
    reasoning_output: reasoning === 0 && scope.product === 'codex' ? observed(0) : unavailable()
  };
}

function linesOf(text: string): string[] {
  return text
    .slice(0, text.lastIndexOf('\n') + 1)
    .split('\n')
    .filter(Boolean);
}

function remember(records: Map<string, SourceRecord>, record: SourceRecord): void {
  const old = records.get(record.key);
  if (old && JSON.stringify(old) !== JSON.stringify(record)) throw new SourceFailure('record_conflict');
  records.set(record.key, record);
}

/** Only metadata leaves are retained. Raw JSON and tool arguments never escape. */
export function parseSnapshot(text: string, scope: SourceScope, compatibility?: SourceCompatibility): Snapshot {
  const profile = lookupCompatibleFileProfile(scope.product, scope.version, compatibility);
  if (profile === 'unsupported') throw new Error('unsupported');
  if (profile.product === 'codex') return parseCodex(text, scope, profile);
  return parseClaude(text, scope, profile);
}

export function parseCodex(text: string, scope: SourceScope, profile: CodexRegisteredProfile): Snapshot {
  if (profile.counterMode !== 'cumulative_total') throw new Error('unsupported');
  const result: Snapshot = { continuityKey: null, records: [], counters: null, counterAt: null, model: null, reasons: ['incomplete'], blocked: false };
  const records = new Map<string, SourceRecord>();
  let identified = false;
  let turnStartedAt: string | null = null;
  let currentTurnId: string | null = null;
  let turnOpen = false;
  let checkpointModel: string | null = null;
  let pendingContextTurnId: unknown = undefined;
  for (const line of linesOf(text)) {
    let row: ObjectValue;
    try {
      row = object(JSON.parse(line));
    } catch {
      throw new SourceFailure('invalid_json');
    }
    const payload = object(row.payload);
    if (!listed(profile.recognizedTypes, row.type)) result.blocked = true;
    if (!identified) {
      if (
        row.type !== 'session_meta' ||
        payload.id !== scope.sessionId ||
        typeof payload.cwd !== 'string' ||
        canonicalPath(payload.cwd) !== canonicalPath(scope.projectRoot)
      )
        throw new Error('scope_mismatch');
      if (payload.cli_version !== scope.version || !listed(profile.allowedSources, payload.source)) throw new Error('unsupported');
      identified = true;
    }
    if (
      row.type === 'session_meta' &&
      (payload.id !== scope.sessionId ||
        payload.cli_version !== scope.version ||
        typeof payload.cwd !== 'string' ||
        canonicalPath(payload.cwd) !== canonicalPath(scope.projectRoot) ||
        !listed(profile.allowedSources, payload.source))
    )
      throw new Error('scope_mismatch');
    if (
      exactName(profile.blockingTypes, row.type) ||
      exactName(profile.blockingPayloadTypes, payload.type) ||
      (payload.type === 'token_count' && object(payload.info).total_token_usage === null) ||
      payload.forked_from_id ||
      (row.type === 'event_msg' && profile.blockingPayloadPrefixes.some(prefix => String(payload.type).startsWith(prefix)))
    )
      result.blocked = true;
    if (profile.boundaryMode === 'settings_checkpoint') {
      if (childActivity(row.type, payload)) {
        result.blocked = true;
        result.reasons.push('child_activity');
      }
      if (row.type === 'session_meta' && payload.session_id !== undefined && payload.session_id !== payload.id) result.blocked = true;
      if (row.type === 'event_msg' && payload.type === 'thread_settings_applied') {
        if (!checkpointAllowed(payload, scope.sessionId, scope.projectRoot, result.model)) {
          result.blocked = true;
          result.reasons.push('settings_conflict');
        }
        const nextModel = object(payload.thread_settings).model;
        if (typeof nextModel === 'string') {
          if (checkpointModel !== null && checkpointModel !== nextModel) result.blocked = true;
          checkpointModel = nextModel;
        }
      }
      if (row.type === 'event_msg' && payload.type === 'task_started' && payload.root_turn_id !== undefined && payload.root_turn_id !== payload.turn_id) {
        result.blocked = true;
        result.reasons.push('turn_topology_or_model');
      }
      if (row.type === 'turn_context') {
        if (!turnOpen) pendingContextTurnId = payload.turn_id;
        const mode = collaborationMode(payload.collaboration_mode);
        if ((mode !== 'default' && mode !== 'plan') || !multiAgentAllowed(multiAgentVersion(payload.multi_agent_version))) {
          result.blocked = true;
          result.reasons.push('settings_unsupported');
        }
        if (
          (payload.root_turn_id !== undefined && payload.root_turn_id !== payload.turn_id) ||
          !IdSchema.safeParse(payload.turn_id).success ||
          (turnOpen && currentTurnId !== null && payload.turn_id !== currentTurnId) ||
          (checkpointModel !== null && payload.model !== checkpointModel)
        ) {
          result.blocked = true;
          result.reasons.push('turn_topology_or_model');
        }
      }
    }
    if (row.type === 'event_msg' && payload.type === 'task_started') {
      if (turnOpen) result.blocked = true;
      if (profile.boundaryMode === 'settings_checkpoint' && pendingContextTurnId !== undefined && pendingContextTurnId !== payload.turn_id) {
        result.blocked = true;
        result.reasons.push('turn_topology_or_model');
      }
      pendingContextTurnId = undefined;
      currentTurnId = id(payload.turn_id);
      turnOpen = true;
      turnStartedAt = timestamp(row.timestamp);
    }
    if (row.type === 'event_msg' && payload.type === 'task_complete') {
      if (payload.turn_id !== currentTurnId || (profile.boundaryMode === 'settings_checkpoint' && !turnOpen)) result.blocked = true;
      turnOpen = false;
    }
    if (row.type === 'turn_context') {
      if (typeof payload.cwd === 'string' && canonicalPath(payload.cwd) !== canonicalPath(scope.projectRoot)) throw new Error('scope_mismatch');
      if (!ModelSchema.safeParse(payload.model).success) throw new Error('unsupported');
      if (result.model && result.model !== payload.model) result.blocked = true;
      result.model = String(payload.model);
    }
    if (row.type === 'event_msg' && payload.type === 'token_count' && payload.info !== null) {
      const usage = object(object(payload.info).total_token_usage);
      const counters = profile.counterFields.map(field => count(usage[field]));
      if (profile.boundaryMode === 'settings_checkpoint' && count(usage.cache_write_input_tokens) > counters[0]!) throw new Error('unsupported');
      if (result.counters && counters.some((value, index) => value < result.counters![index]!)) result.blocked = true;
      const previous = result.counters ?? [0, 0, 0, 0];
      // A first explicit vector is evidence even at zero. Subsequent equal
      // cumulative notifications have no new observation identity.
      if (!result.blocked && result.model && (!result.counters || counters.some((value, index) => value !== previous[index]))) {
        const deltas = counters.map((value, index) => value - previous[index]!);
        remember(records, {
          key: metadataKey(scope.sessionId, 'usage', ...counters.map(String)),
          at: timestamp(row.timestamp),
          turnStartedAt,
          payload: usagePayload(scope, deltas, result.model, 'sequential')
        });
      }
      result.counters = counters;
      result.counterAt = timestamp(row.timestamp);
    }
    if (profile.commandDiagnostics && row.type === 'event_msg' && payload.type === 'item_completed') {
      const item = object(payload.item);
      if (item.type === 'CommandExecution') {
        const callId = id(item.id);
        if (
          !currentTurnId ||
          payload.turn_id !== currentTurnId ||
          !Number.isSafeInteger(payload.started_at_ms) ||
          !Number.isSafeInteger(payload.completed_at_ms)
        ) {
          result.blocked = true;
          continue;
        }
        const actualStart = new Date(Number(payload.started_at_ms)).toISOString();
        const originStart = turnStartedAt && turnStartedAt < actualStart ? turnStartedAt : actualStart;
        const confirmed = Number.isSafeInteger(item.exit_code);
        remember(records, {
          key: metadataKey(scope.sessionId, 'command', callId),
          at: timestamp(row.timestamp),
          turnStartedAt: originStart,
          payload: {
            kind: 'tool',
            call_id: callId,
            boundary: 'codex_command',
            execution: confirmed ? 'confirmed' : 'unknown',
            outcome: confirmed && item.exit_code === 0 ? 'completed' : 'unknown',
            category: 'unclassified'
          }
        });
      }
    }
  }
  if (!identified) throw new Error('scope_mismatch');
  result.records = [...records.values()];
  if (result.blocked) result.reasons.push('unsupported');
  return result;
}

function parseClaude(text: string, scope: SourceScope, profile: ClaudeRegisteredProfile): Snapshot {
  if (profile.counterMode !== 'message_components') throw new Error('unsupported');
  const result: Snapshot = { continuityKey: null, records: [], counters: null, counterAt: null, model: null, reasons: ['incomplete'], blocked: false };
  const origins: string[] = [];
  const records = new Map<string, SourceRecord>();
  let identified = false;
  let turnStartedAt: string | null = null;
  const bashIds = new Map<string, string | null>();
  for (const line of linesOf(text)) {
    let row: ObjectValue;
    try {
      row = object(JSON.parse(line));
    } catch {
      throw new SourceFailure('invalid_json');
    }
    // The verified transcript identifies each message. Auxiliary records do not
    // contribute usage; absence of complete topology evidence remains partial.
    if (row.sessionId !== undefined && row.sessionId !== scope.sessionId) throw new Error('scope_mismatch');
    if (listed(profile.identityTypes, row.type) || row.cwd !== undefined || row.version !== undefined) {
      if (row.sessionId !== scope.sessionId || typeof row.cwd !== 'string' || canonicalPath(row.cwd) !== canonicalPath(scope.projectRoot))
        throw new Error('scope_mismatch');
      if (row.version !== scope.version) throw new Error('unsupported');
      identified = true;
    }
    if (row.isSidechain === true || (row.type === 'system' && row.subtype === 'compact_boundary')) result.blocked = true;
    if (
      row.type === 'user' &&
      row.toolUseResult === undefined &&
      row.sessionId === scope.sessionId &&
      typeof row.promptId === 'string' &&
      !array(object(row.message).content).some(value => object(value).type === 'tool_result')
    ) {
      turnStartedAt = timestamp(row.timestamp);
      origins.push(turnStartedAt);
    }
    if (row.type === 'assistant') {
      if (row.sessionId !== scope.sessionId) throw new Error('scope_mismatch');
      const message = object(row.message);
      const usage = object(message.usage);
      const callId = id(message.id);
      const key = metadataKey(scope.sessionId, 'message', callId);
      // Replayed messages keep their original origin, including an unknown one.
      // Payload and timestamp still pass through add()'s conflict check.
      const origin = records.has(key) ? records.get(key)!.turnStartedAt : turnStartedAt;
      // Retain only recognized invocation IDs so revisions cannot invent tools.
      // Including this metadata in the record also protects cross-poll fingerprints.
      const toolCallIds = [
        ...new Set(
          array(message.content).flatMap(value => {
            const block = object(value);
            return block.type === 'tool_use' && block.name === 'Bash' ? [id(block.id)] : [];
          })
        )
      ].sort();
      // Preserve validated ordinary/cache-create/cache-read counts before
      // normalization. Record equality checks both replays and every later poll,
      // even when size grows or mtime stays unchanged. Only metadata is hashed;
      // these internal components never enter the stored event payload.
      const counted = profile.componentFields.map(field => count(usage[field]));
      const ordinary = counted[0];
      const created = counted[1];
      const read = counted[2];
      if (ordinary === undefined || created === undefined || read === undefined) throw new Error('unsupported');
      const components: [number, number, number] = [ordinary, created, read];
      const input = addTokens(components);
      const model = ModelSchema.safeParse(message.model);
      if (!model.success) throw new Error('unsupported');
      const counters = [input, read, count(usage.output_tokens), 0];
      remember(records, {
        key,
        at: timestamp(row.timestamp),
        turnStartedAt: origin,
        toolCallIds,
        inputComponents: components,
        payload: usagePayload(scope, counters, model.data, 'sequential')
      });
      for (const toolId of toolCallIds) if (!bashIds.has(toolId)) bashIds.set(toolId, origin);
    }
    if (row.type === 'user' && row.toolUseResult !== undefined) {
      const toolResult = object(row.toolUseResult);
      for (const value of array(object(row.message).content)) {
        const block = object(value);
        // Only the observed Bash result shape confirms a completed operation.
        if (
          block.type === 'tool_result' &&
          bashIds.has(String(block.tool_use_id)) &&
          typeof toolResult.stdout === 'string' &&
          typeof toolResult.stderr === 'string'
        ) {
          const callId = id(block.tool_use_id);
          const confirmed = block.is_error === false && toolResult.interrupted === false;
          remember(records, {
            key: metadataKey(scope.sessionId, 'bash', callId),
            at: timestamp(row.timestamp),
            turnStartedAt: bashIds.get(callId) ?? null,
            payload: {
              kind: 'tool',
              call_id: callId,
              boundary: 'claude_bash',
              execution: confirmed ? 'confirmed' : 'unknown',
              outcome: confirmed ? 'completed' : 'unknown',
              category: 'unclassified'
            }
          });
        }
      }
    }
  }
  if (!identified) throw new Error('scope_mismatch');
  result.records = [...records.values()];
  if (result.blocked) result.reasons.push('unsupported');
  // Only validated measurement metadata enters this fingerprint. Origins matter
  // even before usage arrives; a metadata-only snapshot of usage is insufficient.
  // Raw lines, contents and hashes of contents are never checkpointed.
  result.continuityKey = metadataKey(
    JSON.stringify({
      records: result.records,
      blocked: result.blocked,
      origins,
      incompleteLine: text.length > text.lastIndexOf('\n') + 1
    })
  );
  return result;
}
