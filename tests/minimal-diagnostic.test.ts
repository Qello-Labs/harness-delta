import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diagnosticArguments, makeGuardDiagnostic, runDiagnostic, type DiagnosticDeps } from '../scripts/conformance/minimal-diagnostic.js';
const first = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';
const stdout = (id: string) =>
  [
    { type: 'thread.started', thread_id: id },
    { type: 'turn.started' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'PRIVATE RESPONSE' } },
    { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 5, secret: 'PRIVATE SECRET' } }
  ]
    .map(x => JSON.stringify(x))
    .join('\n');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hd-diagnostic-test-'));
  const ledger = join(root, 'ledger.jsonl');
  const calls: readonly string[][] = [];
  const mutableCalls = calls as string[][];
  const deps: DiagnosticDeps = {
    preflight: () => ({
      versionMatches: true,
      configurationStable: true,
      globalInstructionBytes: 0,
      mcpServerCount: 0,
      otherInstructionOverrides: false,
      hooksConfigured: false,
      codexHomeSet: false
    }),
    createFixture: () => root,
    spawn: args => {
      mutableCalls.push([...args]);
      const id = mutableCalls.length < 4 ? first : second;
      return Promise.resolve({ code: 0, timedOut: false, spawnError: false, stdout: stdout(id) });
    }
  };
  return { root, ledger, calls, deps, clean: () => rmSync(root, { recursive: true, force: true }) };
}
describe('bounded diagnostic only', () => {
  it('records each attempt before spawning, uses the exact two immutable scopes, and refuses a completed rerun', async () => {
    const f = fixture();
    try {
      const spawn = f.deps.spawn;
      f.deps.spawn = (args, cwd) => {
        expect(
          readFileSync(f.ledger, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map(x => JSON.parse(x) as { kind: string })
            .filter(x => x.kind === 'attempt')
        ).toHaveLength(f.calls.length + 1);
        return spawn(args, cwd);
      };
      expect(await runDiagnostic(f.ledger, f.deps)).toBe('observed_semantics_unknown');
      expect(f.calls).toHaveLength(5);
      expect(f.calls[1]).toContain(first);
      expect(f.calls[2]).toContain(first);
      expect(f.calls[4]).toContain(second);
      expect(f.calls[3]).not.toContain('resume');
      expect(await runDiagnostic(f.ledger, f.deps)).toBe('terminal_ledger');
      expect(f.calls).toHaveLength(5);
      const saved = readFileSync(f.ledger, 'utf8');
      expect(saved).not.toContain('PRIVATE');
      expect(saved).not.toContain('Reply with');
      expect(saved).toContain('semantics_unknown');
      expect(saved).not.toContain('amount');
    } finally {
      f.clean();
    }
  });
  it.each(['nonzero', 'timeout', 'support', 'child', 'thread_changed'] as const)('permanently stops on %s without a retry', async failure => {
    const f = fixture();
    let count = 0;
    try {
      f.deps.spawn = () => {
        count++;
        return Promise.resolve({
          code: failure === 'nonzero' ? 1 : 0,
          timedOut: failure === 'timeout',
          spawnError: false,
          stdout:
            failure === 'support'
              ? JSON.stringify({ type: 'error', message: 'PRIVATE access denied' })
              : failure === 'child'
                ? stdout(first) + '\n' + JSON.stringify({ type: 'item.completed', item: { type: 'collab_tool_call' } })
                : stdout(count === 1 ? first : second)
        });
      };
      expect(await runDiagnostic(f.ledger, f.deps)).not.toBe('observed_semantics_unknown');
      expect(count).toBe(failure === 'thread_changed' ? 2 : 1);
      expect(await runDiagnostic(f.ledger, f.deps)).toBe('terminal_ledger');
      expect(count).toBe(failure === 'thread_changed' ? 2 : 1);
    } finally {
      f.clean();
    }
  });
  it('refuses a crash ledger and a ledger already holding five attempts across restart', async () => {
    for (const count of [1, 5]) {
      const f = fixture();
      try {
        writeFileSync(f.ledger, Array.from({ length: count }, (_, i) => JSON.stringify({ kind: 'attempt', ordinal: i + 1 })).join('\n') + '\n');
        expect(await runDiagnostic(f.ledger, f.deps)).toBe('interrupted_ledger');
        expect(f.calls).toHaveLength(0);
      } finally {
        f.clean();
      }
    }
  });
  it('blocks configured MCP before creating a fixture or making any model calls', async () => {
    const f = fixture();
    try {
      f.deps.preflight = () => ({
        versionMatches: true,
        configurationStable: true,
        globalInstructionBytes: 0,
        mcpServerCount: 1,
        otherInstructionOverrides: false,
        hooksConfigured: false,
        codexHomeSet: false
      });
      f.deps.createFixture = () => {
        throw new Error('must not create');
      };
      expect(await runDiagnostic(f.ledger, f.deps)).toBe('isolation_blocked');
      expect(f.calls).toHaveLength(0);
      expect(await runDiagnostic(f.ledger, f.deps)).toBe('terminal_ledger');
    } finally {
      f.clean();
    }
  });
  it('requests only the approved models, efforts, prompts, and read-only permissions', () => {
    expect(diagnosticArguments(0, null)).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '--model',
      'gpt-6-luna',
      '-c',
      'model_reasoning_effort="low"',
      'Reply with exactly one word: ready'
    ]);
    expect(diagnosticArguments(1, first)).toContain('gpt-5.6-luna');
    expect(diagnosticArguments(2, first)).toContain('model_reasoning_effort="medium"');
    expect(() => diagnosticArguments(1, null)).toThrow('scope_required');
    expect(() => diagnosticArguments(5, null)).toThrow('attempt_cap');
  });
  it.each([
    [
      {
        branch: 'item_type',
        reason: 'unexpected_item',
        eventType: 'item.started',
        itemType: 'command_execution',
        payload: 'PRIVATE BODY',
        command: 'PRIVATE COMMAND',
        path: '/PRIVATE',
        session_id: 'PRIVATE ID',
        auth: 'PRIVATE AUTH',
        toJSON: () => 'PRIVATE SERIALIZER'
      },
      { branch: 'item_type', reason: 'unexpected_item', event_type: 'item.started', item_type: 'command_execution' }
    ],
    [
      { branch: 'event_type', reason: 'unexpected_event', eventType: 'PRIVATE sk-synthetic-auth', itemType: 'PRIVATE /synthetic/path' },
      { branch: 'event_type', reason: 'unexpected_event', event_type: 'unknown', item_type: 'unknown' }
    ],
    [
      { branch: 'item_type', reason: 'unexpected_item', eventType: 'x'.repeat(2048), itemType: 'y'.repeat(2048) },
      { branch: 'item_type', reason: 'unexpected_item', event_type: 'unknown', item_type: 'unknown' }
    ],
    [
      { branch: 'json_parse', reason: 'invalid_json', eventType: { type: 'PRIVATE' }, itemType: 42 },
      { branch: 'json_parse', reason: 'invalid_json', event_type: 'unknown', item_type: 'unknown' }
    ],
    [{ branch: 'PRIVATE', reason: 'unexpected_event', eventType: 'error', itemType: 'unknown' }, null],
    [{ branch: 'event_type', reason: 'PRIVATE', eventType: 'error', itemType: 'unknown' }, null],
    [{ branch: 'event_type', reason: 'unexpected_item', eventType: 'error', itemType: 'unknown' }, null],
    [undefined, null]
  ])('projects and validates supplied guard diagnostics before persisting (%j)', async (guardDiagnostic, expected) => {
    const f = fixture();
    let count = 0;
    try {
      f.deps.spawn = () => {
        count++;
        return Promise.resolve({ code: 0, timedOut: false, spawnError: false, streamStopped: true, stdout: '', guardDiagnostic });
      };
      expect(await runDiagnostic(f.ledger, f.deps)).toBe('unexpected_activity');
      expect(count).toBe(1);
      const saved = readFileSync(f.ledger, 'utf8');
      const rows = saved
        .split('\n')
        .filter(Boolean)
        .map(x => JSON.parse(x) as { kind: string; guard_diagnostic: unknown });
      expect(rows.find(x => x.kind === 'process_outcome')?.guard_diagnostic).toEqual(expected);
      expect(saved).not.toContain('PRIVATE');
      expect(saved).not.toContain('x'.repeat(128));
      expect(saved).not.toContain('y'.repeat(128));
      expect(await runDiagnostic(f.ledger, f.deps)).toBe('terminal_ledger');
      expect(count).toBe(1);
    } finally {
      f.clean();
    }
  });
});

// Exact pinned messages are synthetic; no real product/session records are opened.
const authMessage = 'Your access token could not be refreshed. Please log out and sign in again.';
const contextMessage = "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.";
const errorGuard = (message: unknown) => makeGuardDiagnostic('item_type', 'item.completed', 'error', message);
describe('safe error cause evidence', () => {
  it.each([
    [authMessage, 'authentication', 'refresh_token'],
    [contextMessage, 'invalid_request', 'context_window'],
    ['request timed out', 'transport', 'request_timeout'],
    ['rate limit exceeded: ', 'rate_limit', 'rate_limit_empty']
  ])('classifies the exact pinned template %s without manufacturing code/status', (message, cause, template) => {
    expect(errorGuard(message).errorDiagnostic).toEqual({
      source: 'item_message',
      cause,
      evidenceKind: 'trusted_message',
      template,
      messageState: 'present',
      codeState: 'absent',
      statusState: 'absent',
      limitation: 'none'
    });
  });
  it.each([
    [{ code: 'model_not_supported' }, 'model_unsupported'],
    [{ code: 'model_not_supported', status: 400 }, 'model_unsupported'],
    [{ code: 'rate_limit_exceeded', status: 429 }, 'rate_limit'],
    [{ code: 'slow_down' }, 'rate_limit'],
    [{ code: 'invalid_prompt', status: 400 }, 'invalid_request'],
    [{ code: 'context_length_exceeded' }, 'invalid_request'],
    [{ status: 401 }, 'authentication'],
    [{ status: 403 }, 'authorization'],
    [{ status: 408 }, 'transport']
  ])('classifies only observed allowlisted wrapped fields %j', (fields, cause) => {
    expect(errorGuard(JSON.stringify({ error: fields })).errorDiagnostic).toEqual({
      source: 'item_message',
      cause,
      evidenceKind: 'structured_message',
      messageState: 'present',
      codeState: 'code' in fields ? 'present' : 'absent',
      statusState: 'status' in fields ? 'present' : 'absent',
      limitation: 'none',
      ...fields
    });
  });
  it.each([
    ['model not supported', 'unrecognized_message', 'present'],
    ['model rerouted: synthetic -> other (Other)', 'unrecognized_message', 'present'],
    [authMessage + ' (PRIVATE sk-synthetic)', 'unrecognized_message', 'present'],
    ['PRIVATE ' + authMessage, 'unrecognized_message', 'present'],
    ['request timed out\nPRIVATE /synthetic/path', 'unrecognized_message', 'present'],
    ['x'.repeat(2049), 'oversized_message', 'oversized'],
    ['é'.repeat(1025), 'oversized_message', 'oversized'],
    [undefined, 'missing_message', 'absent'],
    [42, 'invalid_message', 'invalid'],
    ['{"error":', 'invalid_structure', 'present'],
    [JSON.stringify({ error: { code: 'PRIVATE', status: 429 } }), 'invalid_structure', 'present'],
    [JSON.stringify({ error: { code: 'rate_limit_exceeded', status: 401 } }), 'ambiguous_evidence', 'present'],
    [JSON.stringify({ error: { status: '429' } }), 'invalid_structure', 'present']
  ])('keeps unsupported, ambiguous and unsafe message evidence unknown (%j)', (message, limitation, messageState) => {
    const diagnostic = errorGuard(message).errorDiagnostic;
    expect(diagnostic).toMatchObject({ cause: 'unknown', evidenceKind: 'none', limitation, messageState });
    expect(JSON.stringify(diagnostic)).not.toContain('PRIVATE');
    expect(diagnostic).not.toHaveProperty('code');
    expect(diagnostic).not.toHaveProperty('status');
  });
  it.each([
    {
      cause: 'authentication',
      evidenceKind: 'trusted_message',
      template: 'request_timeout',
      messageState: 'present',
      codeState: 'absent',
      statusState: 'absent',
      limitation: 'none'
    },
    {
      cause: 'rate_limit',
      evidenceKind: 'structured_message',
      messageState: 'present',
      codeState: 'present',
      statusState: 'present',
      code: 'rate_limit_exceeded',
      status: 401,
      limitation: 'none'
    },
    {
      cause: 'rate_limit',
      evidenceKind: 'structured_message',
      messageState: 'present',
      codeState: 'absent',
      statusState: 'present',
      code: 'PRIVATE',
      status: 429,
      limitation: 'none'
    },
    {
      cause: 'rate_limit',
      evidenceKind: 'structured_message',
      messageState: 'present',
      codeState: 'present',
      statusState: 'present',
      code: undefined,
      status: 429,
      limitation: 'none'
    },
    {
      cause: 'rate_limit',
      evidenceKind: 'structured_message',
      messageState: 'present',
      codeState: 'present',
      statusState: 'present',
      code: 'rate_limit_exceeded',
      status: undefined,
      limitation: 'none'
    },
    { cause: 'unknown', evidenceKind: 'PRIVATE', messageState: 'present', codeState: 'absent', statusState: 'absent', limitation: 'none' }
  ])('rejects mismatched supplied evidence before ledger persistence (%j)', async fields => {
    const f = fixture();
    try {
      f.deps.spawn = () =>
        Promise.resolve({
          code: 0,
          timedOut: false,
          spawnError: false,
          streamStopped: true,
          stdout: '',
          guardDiagnostic: {
            branch: 'item_type',
            reason: 'unexpected_item',
            eventType: 'item.completed',
            itemType: 'error',
            errorDiagnostic: { source: 'item_message', ...fields, payload: 'PRIVATE' }
          }
        });
      expect(await runDiagnostic(f.ledger, f.deps)).toBe('unexpected_activity');
      const saved = readFileSync(f.ledger, 'utf8');
      const outcome = saved
        .split('\n')
        .filter(Boolean)
        .map(x => JSON.parse(x) as { kind: string; guard_diagnostic?: { error_diagnostic: unknown } })
        .find(x => x.kind === 'process_outcome');
      expect(outcome?.guard_diagnostic?.error_diagnostic).toBeNull();
      expect(saved).not.toContain('PRIVATE');
      expect(saved).not.toContain('rate_limit_exceeded');
    } finally {
      f.clean();
    }
  });
});

describe('structured error payload compatibility', () => {
  it.each([
    [{ error: { code: 'model_not_supported', message: 'PRIVATE', path: '/PRIVATE', auth: 'PRIVATE' } }, 'model_unsupported', 'absent'],
    [
      { type: 'error', status: 400, error: { code: 'model_not_supported', message: 'PRIVATE', payload: { body: 'PRIVATE' } }, auth: 'PRIVATE' },
      'model_unsupported',
      'present'
    ]
  ] as const)('projects observed code/status while discarding unrelated structured fields (%j)', async (wrapper, cause, statusState) => {
    const f = fixture();
    try {
      const guard = errorGuard(JSON.stringify(wrapper));
      expect(guard.errorDiagnostic).toMatchObject({
        cause,
        evidenceKind: 'structured_message',
        code: 'model_not_supported',
        codeState: 'present',
        statusState
      });
      f.deps.spawn = () =>
        Promise.resolve({
          code: 0,
          timedOut: false,
          spawnError: false,
          streamStopped: true,
          stdout: '',
          guardDiagnostic: { ...guard, payload: 'PRIVATE', errorDiagnostic: { ...guard.errorDiagnostic, auth: 'PRIVATE', toJSON: () => 'PRIVATE' } }
        });
      expect(await runDiagnostic(f.ledger, f.deps)).toBe('unexpected_activity');
      const saved = readFileSync(f.ledger, 'utf8');
      expect(saved).toContain('model_unsupported');
      expect(saved).toContain('model_not_supported');
      expect(saved).not.toContain('PRIVATE');
      expect(saved).not.toContain('payload');
      expect(saved).not.toContain('toJSON');
      const rows = saved
        .split('\n')
        .filter(Boolean)
        .map(x => JSON.parse(x) as { kind: string; guard_diagnostic?: { error_diagnostic?: Record<string, unknown> } });
      const evidence = rows.find(x => x.kind === 'process_outcome')?.guard_diagnostic?.error_diagnostic;
      expect(evidence).toMatchObject({ cause, evidence_kind: 'structured_message', code: 'model_not_supported', status_state: statusState });
      if (statusState === 'absent') expect(evidence).not.toHaveProperty('status');
      else expect(evidence?.status).toBe(400);
    } finally {
      f.clean();
    }
  });
  it('rejects conflicting explicit status locations', () => {
    expect(errorGuard(JSON.stringify({ status: 401, error: { code: 'rate_limit_exceeded', status: 429 } })).errorDiagnostic).toMatchObject({
      cause: 'unknown',
      limitation: 'ambiguous_evidence'
    });
  });
});

describe('resume warning postprocessing', () => {
  const warning = {
    type: 'item.completed',
    item: {
      id: 'item_0',
      type: 'error',
      message:
        'This session was recorded with model `gpt-6-luna` but is resuming with `gpt-5.6-luna`. Consider switching back to `gpt-6-luna` as it may affect Codex performance.'
    }
  };
  it('continues after the exact expected resumed warning and persists only its fixed count', async () => {
    const f = fixture();
    const spawn = f.deps.spawn;
    let context: unknown;
    try {
      f.deps.spawn = async (args, cwd, resumeWarningContext) => {
        if (args.includes('gpt-5.6-luna')) context = resumeWarningContext;
        const result = await spawn(args, cwd, resumeWarningContext);
        return args.includes('gpt-5.6-luna')
          ? {
              ...result,
              stdout: result.stdout.replace(JSON.stringify({ type: 'turn.started' }), JSON.stringify(warning) + '\n' + JSON.stringify({ type: 'turn.started' }))
            }
          : result;
      };
      expect(await runDiagnostic(f.ledger, f.deps)).toBe('observed_semantics_unknown');
      expect(context).toEqual({ sessionId: first, previousModel: 'gpt-6-luna', currentModel: 'gpt-5.6-luna' });
      expect(f.calls).toHaveLength(5);
      const saved = readFileSync(f.ledger, 'utf8');
      const rows = saved
        .split('\n')
        .filter(Boolean)
        .map(x => JSON.parse(x) as { kind: string; ordinal: number; warning_counts: unknown });
      expect(rows.find(x => x.kind === 'process_outcome' && x.ordinal === 2)?.warning_counts).toEqual({ resume_model_changed: 1 });
      expect(saved).not.toContain('This session');
      expect(saved).not.toContain('PRIVATE');
      expect(saved).not.toContain('item_0');
    } finally {
      f.clean();
    }
  });
  it.each(['initial', 'duplicate', 'suffix', 'tool', 'error'] as const)('still stops postprocessing for %s', async mode => {
    const f = fixture();
    const spawn = f.deps.spawn;
    try {
      f.deps.spawn = async (args, cwd, context) => {
        const result = await spawn(args, cwd, context);
        if (mode !== 'initial' && !args.includes('gpt-5.6-luna')) return result;
        const event =
          mode === 'suffix'
            ? { ...warning, item: { ...warning.item, message: warning.item.message + ' PRIVATE' } }
            : mode === 'tool'
              ? { type: 'item.completed', item: { type: 'command_execution', command: 'PRIVATE' } }
              : mode === 'error'
                ? { ...warning, item: { ...warning.item, message: 'request timed out' } }
                : warning;
        return {
          ...result,
          stdout: result.stdout.replace(
            JSON.stringify({ type: 'turn.started' }),
            JSON.stringify(event) + '\n' + (mode === 'duplicate' ? JSON.stringify(warning) + '\n' : '') + JSON.stringify({ type: 'turn.started' })
          )
        };
      };
      expect(await runDiagnostic(f.ledger, f.deps)).toBe('unexpected_activity');
      expect(f.calls).toHaveLength(mode === 'initial' ? 1 : 2);
      expect(readFileSync(f.ledger, 'utf8')).not.toContain('PRIVATE');
    } finally {
      f.clean();
    }
  });
});
