import { z } from 'zod';
import { IdSchema, ModelSchema, ProductVersionSchema, TimestampSchema, TokenSchema } from '../contracts.js';

/** Internal OTLP http/json log decoding and allowlist projection. No product support is claimed:
 * every accepted version needs an injected, separately validated profile. Raw attribute values
 * outside the allowlist never leave this module.
 */
export type QuerySourceCategory = 'main' | 'compact' | 'subagent' | 'auxiliary' | 'other';
export interface OtelVersionProfile {
  readonly id: string;
  readonly product: 'claude_code';
  readonly version: string;
  /** Validated per version: the sequence value the session-start event must carry. */
  readonly sessionStartSequence: number;
  /** Exact raw query_source values; anything else maps to `other`. */
  readonly querySources: Readonly<Record<string, QuerySourceCategory>>;
}
export const profileSchema = z.strictObject({
  id: IdSchema,
  product: z.literal('claude_code'),
  version: ProductVersionSchema,
  sessionStartSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  querySources: z.record(z.string().min(1).max(128), z.enum(['main', 'compact', 'subagent', 'auxiliary', 'other']))
});

export type OtelEventType = 'api_request' | 'api_error' | 'managed_settings_resolved' | 'other';
export interface UsageFields {
  model: string;
  request_id: string | null;
  client_request_id: string | null;
  success: boolean;
  status_code: number | null;
  attempt: number | null;
  duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  query_source_category: QuerySourceCategory;
}
export interface ProjectedRecord {
  eventType: OtelEventType;
  sequence: number;
  occurredAt: string;
  sessionId: string;
  productVersion: string | null;
  processAttribute: string | null;
  fields: UsageFields | { trigger: 'startup' | 'change' | 'refused' | 'other' } | null;
  /** Session-start/change evidence only: whether any managed policy source exists. */
  managedSources: boolean | null;
}
export type Projection = { ok: true; record: ProjectedRecord } | { ok: false; reason: 'invalid_record' | 'content_enabled' };

// Structural OTLP/JSON shape only; attribute values stay opaque until projected.
const keyValues = z.array(z.looseObject({ key: z.string(), value: z.unknown() })).max(1024);
const logsSchema = z.looseObject({
  resourceLogs: z
    .array(
      z.looseObject({
        resource: z.looseObject({ attributes: keyValues.optional() }).optional(),
        scopeLogs: z
          .array(
            z.looseObject({
              logRecords: z
                .array(z.looseObject({ timeUnixNano: z.unknown().optional(), attributes: keyValues.optional() }))
                .max(10000)
                .optional()
            })
          )
          .max(1024)
          .optional()
      })
    )
    .max(1024)
    .optional()
});
export interface DecodedRecord {
  attributes: ReadonlyMap<string, unknown>;
  resource: ReadonlyMap<string, unknown>;
  timeUnixNano: unknown;
}

function toMap(values: readonly { key: string; value: unknown }[] | undefined): Map<string, unknown> {
  const map = new Map<string, unknown>();
  for (const item of values ?? []) map.set(item.key, item.value);
  return map;
}
/** Returns null for an undecodable request. Callers must drop it without storing or logging it. */
export function decodeLogsRequest(input: unknown): DecodedRecord[] | null {
  const parsed = logsSchema.safeParse(input);
  if (!parsed.success) return null;
  const records: DecodedRecord[] = [];
  for (const resourceLogs of parsed.data.resourceLogs ?? []) {
    const resource = toMap(resourceLogs.resource?.attributes);
    for (const scopeLogs of resourceLogs.scopeLogs ?? []) {
      for (const record of scopeLogs.logRecords ?? []) {
        records.push({ attributes: toMap(record.attributes), resource, timeUnixNano: record.timeUnixNano });
      }
    }
  }
  return records;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function text(value: unknown): string | undefined {
  return isObject(value) && typeof value.stringValue === 'string' ? value.stringValue : undefined;
}
/** OTLP/JSON encodes 64-bit integers as decimal strings; unsafe or fractional values are rejected. */
function integer(value: unknown): number | undefined {
  if (!isObject(value)) return undefined;
  const raw = value.intValue ?? value.doubleValue;
  const number = typeof raw === 'string' && /^-?[0-9]{1,20}$/.test(raw) ? Number(raw) : raw;
  return typeof number === 'number' && Number.isSafeInteger(number) ? number : undefined;
}
function strings(value: unknown): string[] | undefined {
  if (!isObject(value) || !isObject(value.arrayValue)) return undefined;
  const values = value.arrayValue.values ?? [];
  if (!Array.isArray(values)) return undefined;
  const result = values.map(text);
  return result.every((item): item is string => item !== undefined) ? result : undefined;
}
const optionalId = (value: unknown): string | null => {
  const parsed = IdSchema.safeParse(text(value));
  return parsed.success ? parsed.data : null;
};
const token = (value: unknown): number | null => {
  const parsed = TokenSchema.safeParse(integer(value));
  return parsed.success ? parsed.data : null;
};
function timestamp(record: DecodedRecord): string | undefined {
  const raw = record.attributes.get('event.timestamp');
  if (raw !== undefined) {
    const parsed = TimestampSchema.safeParse(text(raw));
    return parsed.success ? new Date(parsed.data).toISOString() : undefined;
  }
  const nanos = typeof record.timeUnixNano === 'string' && /^[0-9]{1,20}$/.test(record.timeUnixNano) ? BigInt(record.timeUnixNano) : undefined;
  if (nanos === undefined || nanos === 0n) return undefined;
  const date = new Date(Number(nanos / 1000000n));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

const contentEvents = new Set(['api_request_body', 'api_response_body']);
// Documented as present with this exact value unless content logging is enabled.
const contentAttributes = ['prompt', 'response'];
const redacted = '<REDACTED>';
const triggers = new Set(['startup', 'change', 'refused']);
export function projectRecord(record: DecodedRecord, profile: OtelVersionProfile): Projection {
  const name = text(record.attributes.get('event.name'));
  if (name !== undefined && contentEvents.has(name)) return { ok: false, reason: 'content_enabled' };
  if (contentAttributes.some(key => record.attributes.has(key) && text(record.attributes.get(key)) !== redacted)) {
    return { ok: false, reason: 'content_enabled' };
  }
  const sequence = integer(record.attributes.get('event.sequence'));
  const occurredAt = timestamp(record);
  const sessionId = IdSchema.safeParse(text(record.attributes.get('session.id')));
  if (sequence === undefined || sequence < 0 || !occurredAt || !sessionId.success) return { ok: false, reason: 'invalid_record' };
  const version = ProductVersionSchema.safeParse(text(record.attributes.get('app.version')));
  const recordProcess = text(record.attributes.get('harness_delta.process_id'));
  const resourceProcess = text(record.resource.get('harness_delta.process_id'));
  // Disagreeing record and resource attributes are unusable, not resolved by precedence.
  const processAttribute =
    recordProcess !== undefined && resourceProcess !== undefined && recordProcess !== resourceProcess ? undefined : (recordProcess ?? resourceProcess);
  const base = {
    sequence,
    occurredAt,
    sessionId: sessionId.data,
    productVersion: version.success ? version.data : null,
    processAttribute: processAttribute !== undefined && IdSchema.safeParse(processAttribute).success ? processAttribute : null
  };

  if (name === 'managed_settings_resolved') {
    const trigger = text(record.attributes.get('managed_settings.trigger'));
    const sources = strings(record.attributes.get('managed_settings.sources'));
    return {
      ok: true,
      record: {
        ...base,
        eventType: name,
        fields: { trigger: trigger !== undefined && triggers.has(trigger) ? (trigger as 'startup' | 'change' | 'refused') : 'other' },
        // Unreadable source evidence is treated as a possible override.
        managedSources: sources === undefined ? true : sources.length > 0
      }
    };
  }
  if (name !== 'api_request' && name !== 'api_error') return { ok: true, record: { ...base, eventType: 'other', fields: null, managedSources: null } };

  const model = ModelSchema.safeParse(text(record.attributes.get('model')));
  if (!model.success) return { ok: false, reason: 'invalid_record' };
  const raw = text(record.attributes.get('query_source'));
  const duration = integer(record.attributes.get('duration_ms'));
  const fields: UsageFields = {
    model: model.data,
    request_id: optionalId(record.attributes.get('request_id')),
    client_request_id: optionalId(record.attributes.get('client_request_id')),
    success: name === 'api_request',
    status_code: null,
    attempt: null,
    duration_ms: duration !== undefined && duration >= 0 ? duration : null,
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_creation_tokens: null,
    query_source_category: raw !== undefined && Object.hasOwn(profile.querySources, raw) ? profile.querySources[raw]! : 'other'
  };
  if (name === 'api_error') {
    const status = integer(record.attributes.get('status_code'));
    const attempt = integer(record.attributes.get('attempt'));
    fields.status_code = status !== undefined && status >= 100 && status <= 599 ? status : null;
    fields.attempt = attempt !== undefined && attempt >= 1 ? attempt : null;
  } else {
    fields.input_tokens = token(record.attributes.get('input_tokens'));
    fields.output_tokens = token(record.attributes.get('output_tokens'));
    fields.cache_read_tokens = token(record.attributes.get('cache_read_tokens'));
    fields.cache_creation_tokens = token(record.attributes.get('cache_creation_tokens'));
    // Every documented component is required; a partial split cannot form input_total.
    if ([fields.input_tokens, fields.output_tokens, fields.cache_read_tokens, fields.cache_creation_tokens].includes(null)) {
      return { ok: false, reason: 'invalid_record' };
    }
  }
  return { ok: true, record: { ...base, eventType: name, fields, managedSources: null } };
}
