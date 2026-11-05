import { expect, test } from 'vitest';
import { parseCandidate } from '../scripts/conformance/parse-candidate.js';
import { codex01580Candidate } from '../scripts/conformance/candidate.js';
import { classifySessionTopology } from '../scripts/conformance/checks.js';

const scope = { product: 'codex' as const, version: '0.158.0', sessionId: 's1', projectRoot: '/synthetic' };
const meta = { type: 'session_meta', payload: { id: 's1', source: 'exec', cli_version: scope.version, cwd: scope.projectRoot } };
const context = {
  type: 'turn_context',
  payload: {
    model: 'synthetic',
    turn_id: 't1',
    root_turn_id: 't1',
    collaboration_mode: { mode: 'default', settings: { developer_instructions: 'PRIVATE_INSTRUCTIONS' } },
    multi_agent_version: 'disabled'
  }
};
const checkpoint = {
  type: 'event_msg',
  payload: {
    type: 'thread_settings_applied',
    thread_id: 's1',
    thread_settings: { cwd: '/synthetic', model: 'synthetic', collaboration_mode: { settings: { developer_instructions: 'PRIVATE_SNAPSHOT' } } }
  }
};
const parse = (...rows: unknown[]) => parseCandidate([meta, ...rows].map(row => JSON.stringify(row)).join('\n') + '\n', scope, codex01580Candidate);

test('normal mode metadata and a same-thread settings checkpoint permit partial inspection', () => {
  const result = parse(context, checkpoint);
  expect(result.blocked).toBe(false);
  expect(classifySessionTopology(result.topology)).toMatchObject({ root_turn_topology: 'pass', thread_settings_applied: 'pass' });
  expect(result.traversal.matchedPaths).toEqual(
    expect.arrayContaining([
      'turn_context.collaboration_mode.mode',
      'event_msg.thread_settings_applied.thread_id',
      'event_msg.thread_settings_applied.thread_settings.cwd'
    ])
  );
  expect(JSON.stringify(result)).not.toContain('PRIVATE_');
});

test.each(['SubAgentActivity', 'CollabAgentToolCall'])('actual %s item blocks even when multi-agent is disabled', type => {
  expect(parse(context, { type: 'event_msg', payload: { type: 'item_completed', item: { type } } }).blocked).toBe(true);
});

test('persisted child activity blocks', () => {
  expect(parse(context, { type: 'event_msg', payload: { type: 'sub_agent_activity' } }).blocked).toBe(true);
});

test.each([
  { ...checkpoint.payload, thread_id: 'other' },
  { ...checkpoint.payload, thread_settings: { cwd: '/other' } },
  { ...checkpoint.payload, thread_settings: { cwd: '/synthetic', model: 'other' } }
])('conflicting settings checkpoint blocks', payload => {
  expect(parse(context, { type: 'event_msg', payload }).blocked).toBe(true);
});

test.each([undefined, 'private-enum', 1, null])('missing or unknown settings fail closed without retaining values', value => {
  const result = parse({ ...context, payload: { ...context.payload, multi_agent_version: value } });
  expect(result.blocked).toBe(true);
  expect(JSON.stringify(result)).not.toContain('private-enum');
});

test.each(['disabled', 'v1', 'v2'])('M2 accepts capability %s, not actual child activity', value => {
  const result = parse({ ...context, payload: { ...context.payload, multi_agent_version: value } });
  expect(result.blocked).toBe(false);
  expect(classifySessionTopology(result.topology).multi_agent_version_allowed).toBe('pass');
});

test('a root task_started supplies topology when optional turn_context root is absent', () => {
  const payload: Record<string, unknown> = { ...context.payload };
  delete payload.root_turn_id;
  const result = parse(
    { timestamp: '2026-01-01T00:00:00Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 't1', root_turn_id: 't1' } },
    { ...context, payload }
  );
  expect(result.blocked).toBe(false);
  expect(classifySessionTopology(result.topology).root_turn_topology).toBe('pass');
  expect(result.traversal.matchedPaths).toContain('event_msg.task_started.root_turn_id');
});

test('an inherited task_started root cannot hide behind a safe turn_context', () => {
  const result = parse(
    { timestamp: '2026-01-01T00:00:00Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 't1', root_turn_id: 'parent' } },
    context
  );
  expect(result.blocked).toBe(true);
  expect(classifySessionTopology(result.topology).root_turn_topology).toBe('fail');
});

test('a context preceding task_started must identify the same turn', () => {
  const result = parse(context, { timestamp: '2026-01-01T00:00:00Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'other' } });
  expect(result.blocked).toBe(true);
});
