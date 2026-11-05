import { expect, test } from 'vitest';
import { parseCandidate } from '../scripts/conformance/parse-candidate.js';
import { codex01580Candidate } from '../scripts/conformance/candidate.js';
import type { SourceScope } from '../src/adapters.js';

const scope: SourceScope = {
  sessionId: 'sessA',
  projectRoot: '/synthetic',
  product: 'codex',
  version: '0.158.0'
};
const header = {
  type: 'session_meta',
  payload: { id: 'sessA', cwd: '/synthetic', cli_version: '0.158.0', source: 'exec' }
};
const text = (...rows: unknown[]) => `${rows.map(row => JSON.stringify(row)).join('\n')}\n`;
const count = (input: number, cached = 40, output = 30, reasoning = 0, at = '2026-01-01T00:00:01Z', cacheWrite = 0) => ({
  timestamp: at,
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: {
        input_tokens: input,
        cached_input_tokens: cached,
        output_tokens: output,
        reasoning_output_tokens: reasoning,
        cache_write_input_tokens: cacheWrite
      }
    }
  }
});
const model = (name = 'synthetic') => ({
  type: 'turn_context',
  payload: { model: name, turn_id: 'turn1', collaboration_mode: { mode: 'default' }, multi_agent_version: 'disabled' }
});
const parse = (body: string) => parseCandidate(body, scope, codex01580Candidate);

test('candidate token_count before a model advances the baseline and is not recovered', () => {
  const early = parse(text(header, count(100)));
  expect(early.records).toEqual([]);
  expect(early.counters).toEqual([100, 40, 30, 0]);
  expect(early.model).toBeNull();
  const same = parse(text(header, count(100), model(), count(100, 40, 30, 0, '2026-01-01T00:00:02Z')));
  expect(same.records).toEqual([]);
  const later = parse(text(header, count(100), model(), count(110, 40, 30, 0, '2026-01-01T00:00:02Z')));
  expect(later.records).toHaveLength(1);
  expect(later.records[0]?.payload).toMatchObject({ input_total: { status: 'observed', value: 10 } });
});

test('candidate counters keep advancing after a sticky compaction block', () => {
  const parsed = parse(
    text(
      header,
      model(),
      count(100, 40, 30, 0, '2026-01-01T00:00:01Z'),
      { type: 'compacted', payload: { message: 'PRIVATE_BLOCK' } },
      count(140, 40, 30, 0, '2026-01-01T00:00:02Z')
    )
  );
  expect(parsed.blocked).toBe(true);
  expect(parsed.counters).toEqual([140, 40, 30, 0]);
  expect(parsed.counterAt).toBe('2026-01-01T00:00:02.000Z');
  expect(JSON.stringify(parsed)).not.toContain('PRIVATE_BLOCK');
});

test('candidate excludes token_usage_record values and requires cache-write bounds', () => {
  const ignored = parse(
    text(header, model(), { type: 'token_usage_record', payload: { total_token_usage: { input_tokens: 999 }, note: 'PRIVATE_NESTED' } }, count(100))
  );
  expect(ignored.counters).toEqual([100, 40, 30, 0]);
  expect(JSON.stringify(ignored)).not.toContain('999');
  expect(JSON.stringify(ignored)).not.toContain('PRIVATE_NESTED');
  expect(() =>
    parse(
      text(header, model(), {
        timestamp: '2026-01-01T00:00:01Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 10,
              cached_input_tokens: 0,
              output_tokens: 1,
              reasoning_output_tokens: 0
            }
          }
        }
      })
    )
  ).toThrow(/^unsupported$/);
  expect(() => parse(text(header, model(), count(10, 0, 1, 0, '2026-01-01T00:00:01Z', 1.5)))).toThrow(/^unsupported$/);
  expect(() => parse(text(header, model(), count(10, 0, 1, 0, '2026-01-01T00:00:01Z', 11)))).toThrow(/^unsupported$/);
});

test('candidate reads total for deltas, keeps last in memory, and does not add cache-write to input', () => {
  const row = {
    timestamp: '2026-01-01T00:00:01Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: 10,
          cached_input_tokens: 8,
          output_tokens: 1,
          reasoning_output_tokens: 0,
          cache_write_input_tokens: 5
        },
        last_token_usage: {
          input_tokens: 99,
          cached_input_tokens: 0,
          output_tokens: 0,
          reasoning_output_tokens: 0,
          cache_write_input_tokens: 0,
          total_tokens: 99
        }
      }
    }
  };
  const parsed = parse(text(header, model(), row));
  expect(parsed.records).toHaveLength(1);
  expect(parsed.records[0]?.payload).toMatchObject({
    input_total: { value: 10 },
    cached_input: { value: 8 },
    output_total: { value: 1 }
  });
  expect(parsed.vectors.total).toMatchObject({ input: 10, cached: 8, cacheWrite: 5 });
  expect(parsed.vectors.last).toMatchObject({ input: 99 });
});

test('candidate identity and topology fail closed without retaining private values', () => {
  const matched = parse(text({ ...header, payload: { ...header.payload, session_id: 'sessA' } }));
  expect(matched.blocked).toBe(false);
  expect(matched.topology.sessionMetaId).toBe('sessA');
  expect(matched.topology.linkedSessionId).toBe('sessA');
  expect(JSON.stringify(matched.records)).not.toContain('sessA');
  const mismatched = parse(text({ ...header, payload: { ...header.payload, session_id: 'SECRET_SID' } }));
  expect(mismatched.blocked).toBe(true);
  expect(mismatched.topology.sessionMetaSessionId).toBe('SECRET_SID');
  expect(JSON.stringify(mismatched.records)).not.toContain('SECRET_SID');
  expect(JSON.stringify(mismatched.reasons)).not.toContain('SECRET_SID');
  const creators = parse(
    text({
      ...header,
      payload: { ...header.payload, creator_account_id: 'SECRET_ACCOUNT', creator_user_id: 'SECRET_USER' }
    })
  );
  expect(JSON.stringify(creators)).not.toContain('SECRET_ACCOUNT');
  expect(JSON.stringify(creators)).not.toContain('SECRET_USER');
  expect(parse(text(header, { type: 'turn_context', payload: { model: 'synthetic', turn_id: 't1', root_turn_id: 'other' } })).blocked).toBe(true);
  expect(
    parse(
      text(header, {
        type: 'turn_context',
        payload: { model: 'synthetic', turn_id: 't1', root_turn_id: 't1', collaboration_mode: { mode: 'default' }, multi_agent_version: 'disabled' }
      })
    ).blocked
  ).toBe(false);
  expect(
    parse(text(header, { type: 'turn_context', payload: { model: 'synthetic', turn_id: 't1', root_turn_id: 't1', collaboration_mode: 'code' } })).blocked
  ).toBe(true);
  expect(
    parse(text(header, { type: 'turn_context', payload: { model: 'synthetic', turn_id: 't1', root_turn_id: 't1', multi_agent_version: 1 } })).blocked
  ).toBe(true);
  const settings = parse(
    text(header, {
      type: 'event_msg',
      payload: { type: 'thread_settings_applied', detail: 'SECRET_SETTINGS' }
    })
  );
  expect(settings.blocked).toBe(true);
  expect(JSON.stringify(settings)).not.toContain('SECRET_SETTINGS');
});

test('candidate turn ids, commands, reasoning, partial lines, and resets stay fail-closed', () => {
  expect(() =>
    parse(
      text(header, {
        timestamp: '2026-01-01T00:00:01Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: '' }
      })
    )
  ).toThrow(/^unsupported$/);
  expect(
    parse(
      text(
        header,
        { timestamp: '2026-01-01T00:00:01Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn1' } },
        { timestamp: '2026-01-01T00:00:02Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn2' } }
      )
    ).blocked
  ).toBe(true);
  const command = parse(
    text(header, { timestamp: '2026-01-01T00:00:00Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn1' } }, model(), count(10, 0, 1, 0), {
      timestamp: '2026-01-01T00:00:02Z',
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        turn_id: 'turn1',
        started_at_ms: Date.parse('2026-01-01T00:00:01Z'),
        completed_at_ms: Date.parse('2026-01-01T00:00:02Z'),
        item: { type: 'CommandExecution', id: 'exec1', exit_code: 0, command: 'SECRET_COMMAND' }
      }
    })
  );
  expect(command.blocked).toBe(false);
  expect(command.records.some(record => record.payload.kind === 'tool')).toBe(false);
  expect(JSON.stringify(command)).not.toContain('SECRET_COMMAND');
  expect(parse(text(header, model(), count(10, 0, 5, 1))).records[0]?.payload).toMatchObject({
    output_total: { status: 'observed', value: 5 },
    reasoning_output: { status: 'unmeasurable', value: null }
  });
  expect(parse(text(header, model(), count(10, 0, 5, 0))).records[0]?.payload).toMatchObject({
    reasoning_output: { status: 'observed', value: 0 }
  });
  const partial = parse(`${text(header, count(100))}{"type":"compacted","payload":{"message":"PRIVATE_PARTIAL"}`);
  expect(partial.blocked).toBe(false);
  expect(partial.counters).toEqual([100, 40, 30, 0]);
  expect(parse(text(header, model(), count(100), count(90, 40, 30, 0, '2026-01-01T00:00:02Z'))).blocked).toBe(true);
});
