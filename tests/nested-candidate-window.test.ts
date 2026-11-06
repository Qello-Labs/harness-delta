import { expect, test } from 'vitest';
import type { SourceCompatibility } from '../src/contracts.js';
import { resolveOrdinaryWindow } from '../src/core/ordinary-window-policy.js';
import { parseCodexCandidateRollout } from '../src/codex-candidate-rollout.js';
import { authorizeCandidateScope, type CandidateScope, ingestCandidateObservation, projectCandidateObservation } from '../src/nested-candidate.js';
import { resolveSourceCompatibility } from '../src/source-compatibility.js';
import { Store } from '../src/store.js';

const at = '2026-01-01T00:00:01Z';
const recordedAt = '2026-01-01T00:00:02Z';
const projectRoot = '/synthetic/project';
function scope(): CandidateScope {
  return {
    projectId: 'project',
    taskId: 'task',
    allowedRootTurnIds: ['root-turn'],
    sessions: [
      {
        sessionId: 'root',
        rootSessionId: 'root',
        parentSessionId: null,
        sourceId: 'root-source',
        product: 'codex',
        nativeSessionId: 'native-root',
        processId: null,
        agentId: null
      }
    ]
  };
}
function compatibility(version = '0.169.0'): SourceCompatibility {
  const resolved = resolveOrdinaryWindow('codex', version, 'codex-binding-root-window-v1');
  if (!resolved) throw new Error('expected_window');
  return resolved.compatibility;
}
function response(version = '0.169.0') {
  return {
    kind: 'codex_response',
    occurredAt: at,
    sessionMeta: {
      id: 'native-root',
      session_id: 'native-root',
      cli_version: version,
      source: 'cli',
      cwd: projectRoot
    },
    turnContext: {
      turn_id: 'root-turn',
      model: 'gpt-6.1-sol',
      effort: 'high',
      cwd: projectRoot
    },
    record: {
      thread_id: 'native-root',
      session_id: 'native-root',
      turn_id: 'root-turn',
      root_turn_id: 'root-turn',
      response_id: 'root-response',
      usage: {
        input_tokens: 83,
        cached_input_tokens: 17,
        cache_write_input_tokens: 9,
        output_tokens: 23,
        reasoning_output_tokens: 7,
        total_tokens: 106
      },
      turn_token_usage: { input_tokens: 999 },
      thread_token_usage: { input_tokens: 999 }
    }
  };
}
const project = (input: unknown = response(), mapped = scope(), selected = compatibility()) =>
  projectCandidateObservation(mapped, 'root-source', input, recordedAt, selected);
function rollout(input = response()) {
  return (
    [
      { type: 'session_meta', payload: input.sessionMeta },
      { type: 'turn_context', timestamp: at, payload: input.turnContext },
      {
        type: 'token_usage_record',
        timestamp: at,
        payload: input.record
      }
    ]
      .map(row => JSON.stringify(row))
      .join('\n') + '\n'
  );
}

test.each(['0.164.0', '0.165.0', '0.166.0', '0.167.0', '0.169.0'])('window projection preserves actual %s version and own response counters', version => {
  const result = project(response(version), scope(), compatibility(version));
  expect(result.kind).toBe('usage');
  if (result.kind !== 'usage') throw new Error('expected_usage');
  expect(result.runtime).toMatchObject({
    product: 'codex',
    product_version: version,
    session_id: 'root',
    request_id: 'root-response'
  });
  expect(result.event.payload).toMatchObject({
    product_version: version,
    input_total: { status: 'observed', value: 83 },
    cached_input: { value: 17 },
    output_total: { value: 23 },
    reasoning_output: { value: 7 }
  });
  expect(result.event.payload.billing_components.map(component => component.reading.value)).toEqual([57, 17, 9, 23]);
});

test('window rollout projects the unchanged actual header and rejects declaration mismatch', () => {
  const selected = compatibility();
  const snapshot = parseCodexCandidateRollout(rollout(), scope(), 'root-source', projectRoot, recordedAt, selected);
  expect(snapshot.hasGap).toBe(false);
  expect(snapshot.records).toHaveLength(1);
  expect(snapshot.records[0]?.projection.runtime.product_version).toBe('0.169.0');
  expect(() => parseCodexCandidateRollout(rollout(response('0.167.0')), scope(), 'root-source', projectRoot, recordedAt, selected)).toThrow(
    'candidate_invalid_metadata'
  );
});

test.each(['0.163.0', '0.170.0', '0.171.0', '0.169.0-beta.1', '0.169.0+build', '0.169', '00.169.0', 'not-a-version'])(
  'window projection refuses forged out-of-window version %s',
  version => {
    expect(() =>
      project(response(version), scope(), {
        ...compatibility(),
        product_version: version
      })
    ).toThrow('candidate_scope_mismatch');
  }
);

test.each([
  { state: 'verified' },
  { product: 'claude_code' },
  { source: 'codex_workflow' },
  { parser_version: '0.169.0' },
  { parser_revision: 'codex-binding-01630-direct-family-v1' },
  { profile_id: 'codex-binding-01660-direct-family-v1' },
  { rule_revision: 'forward-version-v1' }
] satisfies Partial<SourceCompatibility>[])('window projection refuses forged tuple %j', changed => {
  expect(() => project(response(), scope(), { ...compatibility(), ...changed })).toThrow('candidate_scope_mismatch');
});

test.each([{ parentSessionId: 'other' }, { rootSessionId: 'other' }, { processId: 'process' }, { agentId: 'agent' }] satisfies Partial<
  CandidateScope['sessions'][number]
>[])('window projection refuses non-Codex-root mapping %j', changed => {
  const mapped = scope();
  mapped.sessions = mapped.sessions.map(root => ({ ...root, ...changed }));
  expect(() => project(response(), mapped)).toThrow('candidate_invalid_mapping');
});

test('window projection refuses a valid Claude root mapping', () => {
  const mapped = scope();
  mapped.sessions = mapped.sessions.map(root => ({
    ...root,
    product: 'claude_code',
    processId: 'process'
  }));
  expect(() => project(response(), mapped)).toThrow('candidate_scope_mismatch');
});

test('window projection refuses an otherwise valid family mapping for either source', () => {
  const mapped = scope();
  mapped.sessions.push({
    sessionId: 'child',
    rootSessionId: 'root',
    parentSessionId: 'root',
    sourceId: 'child-source',
    product: 'codex',
    nativeSessionId: 'native-child',
    processId: null,
    agentId: null
  });
  for (const sourceId of ['root-source', 'child-source']) {
    expect(() => projectCandidateObservation(mapped, sourceId, response(), recordedAt, compatibility())).toThrow('candidate_scope_mismatch');
  }
});

test.each([
  { id: 'different-root' },
  { session_id: 'different-root' },
  { parent_thread_id: 'parent' },
  {
    source: {
      subagent: {
        thread_spawn: { parent_thread_id: 'parent', depth: 1 }
      }
    }
  }
])('window projection checks native header identity %j', changed => {
  const input = response();
  expect(() => project({ ...input, sessionMeta: { ...input.sessionMeta, ...changed } })).toThrow('candidate_scope_mismatch');
});

test.each(['thread_id', 'session_id', 'turn_id', 'root_turn_id'])('window projection checks response %s against the root and turn scope', field => {
  const input = response();
  expect(() =>
    project({
      ...input,
      record: { ...input.record, [field]: 'foreign' }
    })
  ).toThrow('candidate_scope_mismatch');
});

test.each([
  { forked_from_id: 'other-root' },
  { forked_from_ordinal_exclusive: 0 },
  {
    history_base: {
      thread_id: 'other-root',
      end_ordinal_exclusive: 1,
      end_byte_offset: 1
    }
  },
  { subagent_history_start_ordinal: 1 }
])('window root projection never accepts inherited history %j', changed => {
  const input = response();
  expect(
    project({
      ...input,
      sessionMeta: { ...input.sessionMeta, ...changed }
    })
  ).toEqual({ kind: 'unattributed', reason: 'unsupported_history' });
});

test.each([{ input_tokens: 25 }, { reasoning_output_tokens: 24 }, { total_tokens: 107 }, { cached_input_tokens: -1 }, { cache_write_input_tokens: null }])(
  'window projection rejects invalid own counters %j',
  changed => {
    const input = response();
    expect(() =>
      project({
        ...input,
        record: {
          ...input.record,
          usage: { ...input.record.usage, ...changed }
        }
      })
    ).toThrow('candidate_invalid_metadata');
  }
);

test('window projection keeps observed zero distinct from missing usage', () => {
  const input = response();
  const zero = {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0
  };
  const result = project({
    ...input,
    record: { ...input.record, usage: zero }
  });
  expect(result.kind === 'usage' && result.event.payload.input_total).toEqual({ status: 'observed', value: 0, reason: null });
  expect(project({ ...input, record: { ...input.record, usage: null } })).toEqual({ kind: 'unattributed', reason: 'missing_usage' });
});

test('window compatibility cannot authorize or ingest through generic candidate writes', () => {
  const store = new Store(':memory:');
  let reads = 0;
  try {
    expect(() => authorizeCandidateScope(store, scope(), compatibility())).toThrow('candidate_scope_mismatch');
    expect(() =>
      ingestCandidateObservation(
        store,
        scope(),
        'root-source',
        () => {
          reads++;
          return response();
        },
        recordedAt,
        compatibility()
      )
    ).toThrow('candidate_scope_mismatch');
    expect(reads).toBe(0);
    expect(store.eventCount()).toBe(0);
    expect(store.all('SELECT * FROM runtime_evidence')).toEqual([]);
  } finally {
    store.close();
  }
});

test('0.166 window selection remains separate from assigned exact authority and the exact base parser', () => {
  for (const version of ['0.163.0', '0.166.0']) {
    const exact = resolveSourceCompatibility('codex', version, 'codex_binding');
    if (!exact) throw new Error('expected_exact');
    expect(exact.profile_id).not.toBe('codex-binding-root-window-v1');
    expect(exact.parser_version).toBe(version);
    const result = project(response(version), scope(), exact);
    expect(result.kind === 'usage' && result.runtime.product_version).toBe(version);
  }
});
