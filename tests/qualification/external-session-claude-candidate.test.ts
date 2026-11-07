import { expect, test, vi } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as supervisor from '../../src/qualification/claude-probe-supervisor.js';
import { randomUUID } from 'node:crypto';
import { Store } from '../../src/store.js';
import {
  createManualClaudeReceiver,
  prepareManualClaudeCandidate,
  manualClaudeHandoff,
  pinnedManualClaudeBinarySha,
  readManualClaudeProcess,
  verifyManualClaudeProcess,
  type ManualClaudeInvocation,
  type ManualClaudeProcessObservation
} from '../../src/qualification/external-session-claude-candidate.js';
import { attrs, span, startedAt, receivedAt, traces, traceScope, seedTraceScope } from '../helpers/claude-trace-fixture.js';

function fixture() {
  const store = new Store(':memory:');
  store.execute("INSERT INTO comparison_workspace_scope(singleton,purpose) VALUES (1,'synthetic_validation')", []);
  store.execute("INSERT INTO projects(id) VALUES ('project-1')", []);
  store.execute("INSERT INTO tasks(id,project_id,state,metadata) VALUES ('task-1','project-1','active',?)", [JSON.stringify({ product: 'synthetic' })]);
  store.execute("INSERT INTO sessions(id,project_id,task_id,product,product_version) VALUES ('root','project-1','task-1','synthetic','1.0.0')", []);
  const native = randomUUID();
  const invocation: ManualClaudeInvocation = {
    ticket_id: randomUUID(),
    issued_at: startedAt,
    native_session_id: native,
    binary: { path: '/synthetic/claude-2.1.288', version: '2.1.288', sha256: pinnedManualClaudeBinarySha },
    settings_path: '/synthetic/settings.json',
    settings_hash: '1'.repeat(64),
    instructions_path: '/synthetic/instructions.md',
    instructions_hash: '2'.repeat(64),
    empty_mcp_path: '/synthetic/mcp.json',
    model: 'claude-sonnet-5-5',
    effort: 'high'
  };
  const scope = { ...traceScope, sessions: [{ ...traceScope.sessions[0]!, nativeSessionId: native }] };
  const handoff = manualClaudeHandoff(invocation);
  let now = startedAt,
    reads = 0;
  let observed: ManualClaudeProcessObservation | null = {
    pid: 1234,
    started_at: startedAt,
    binary_path: invocation.binary.path,
    binary_hash: invocation.binary.sha256,
    argv: handoff.argv,
    settings_hash: invocation.settings_hash,
    instructions_hash: invocation.instructions_hash
  };
  const connections: unknown[] = [];
  const candidate = createManualClaudeReceiver(store, {
    scope,
    generation: 0,
    invocation,
    clock: () => now,
    durationMs: 10000,
    readProcess: () => {
      reads++;
      return observed;
    },
    onVerifiedConnection: evidence => {
      connections.push(evidence);
    }
  });
  const token = candidate.receiver.exporterHeaders()['x-harness-delta-token']!;
  const hook = (patch: Record<string, unknown> = {}) =>
    candidate.receiver.acceptHook(token, () => ({ hook_event_name: 'SessionStart', session_id: native, source: 'startup', ...patch }));
  const startup = {
    resourceLogs: [
      {
        resource: { attributes: attrs({ 'harness_delta.process_id': 'process-1' }) },
        scopeLogs: [
          {
            logRecords: [
              {
                attributes: [
                  ...attrs({
                    'event.name': 'managed_settings_resolved',
                    'event.sequence': 0,
                    'event.timestamp': startedAt,
                    'session.id': native,
                    'app.version': '2.1.288',
                    'managed_settings.trigger': 'startup'
                  }),
                  { key: 'managed_settings.sources', value: { arrayValue: { values: [] } } }
                ]
              }
            ]
          }
        ]
      }
    ]
  };
  const ready = () => {
    hook();
    candidate.receiver.ingestLogs(token, () => startup);
    now = receivedAt;
  };
  const usage = () => traces([span(false, { 'session.id': native, model: invocation.model, effort: invocation.effort })]);
  return {
    store,
    scope,
    candidate,
    token,
    invocation,
    handoff,
    hook,
    startup,
    ready,
    usage,
    reads: () => reads,
    connections,
    setObserved: (patch: Partial<ManualClaudeProcessObservation>) => {
      observed = { ...observed!, ...patch };
    },
    clearProcess: () => {
      observed = null;
    },
    setNow: (at: string) => {
      now = at;
    }
  };
}

test('manual Claude handoff is a fixed native command with no launcher, file/hook writes or loading claim', () => {
  const f = fixture();
  try {
    expect(f.handoff).toMatchObject({
      automatic_launch: false,
      profile_status: 'candidate_unadmitted',
      native_loading: 'unverified',
      hard_billing_bound: null
    });
    expect(f.handoff.argv).toContain('--append-system-prompt-file');
    expect(f.handoff.argv).toContain('--session-id');
    expect(f.handoff.argv).not.toContain('--dangerously-skip-permissions');
    expect(f.candidate.state()).toMatchObject({ first_verified_at: null, native_context_evidence: 'unverified' });
    expect(f.reads()).toBe(0);
    expect(f.store.eventCount()).toBe(0);
  } finally {
    f.store.close();
  }
});

test('authenticated scoped startup/log and native process proof precede trace decoding; one connection and replay-safe usage', () => {
  const f = fixture();
  let decoded = 0;
  try {
    expect(() =>
      f.candidate.receiver.ingestTraces('foreign', () => {
        decoded++;
        return f.usage();
      })
    ).toThrow('claude_probe_unauthorized');
    expect(() =>
      f.candidate.receiver.ingestTraces(f.token, () => {
        decoded++;
        return f.usage();
      })
    ).toThrow('claude_probe_not_ready');
    expect(f.reads()).toBe(0);
    expect(decoded).toBe(0);
    f.ready();
    expect(f.connections).toHaveLength(1);
    expect(f.candidate.state()).toMatchObject({
      invocation_evidence: 'native_process_flags_and_files_observed',
      native_context_evidence: 'unverified',
      tool_use_evidence: 'unavailable'
    });
    expect(f.candidate.receiver.ingestTraces(f.token, () => f.usage())).toMatchObject({ inserted: 1 });
    expect(f.candidate.receiver.ingestTraces(f.token, () => f.usage())).toMatchObject({ inserted: 0 });
    f.hook();
    expect(f.connections).toHaveLength(1);
    expect(f.store.eventCount()).toBe(1);
    const saved = JSON.stringify(f.store.all('SELECT * FROM events')) + JSON.stringify(f.connections);
    expect(saved).not.toContain('/synthetic');
    expect(saved).not.toContain('x-harness-delta-token');
  } finally {
    f.store.close();
  }
});

test.each(['old_process', 'wrong_argv', 'changed_instructions', 'wrong_binary'] as const)('manual Claude %s proof refuses connection/usage', kind => {
  const f = fixture();
  try {
    if (kind === 'old_process') f.setObserved({ started_at: '2000-01-01T00:00:00.000Z' });
    if (kind === 'wrong_argv') f.setObserved({ argv: [...f.handoff.argv, '--resume', 'old'] });
    if (kind === 'changed_instructions') f.setObserved({ instructions_hash: '3'.repeat(64) });
    if (kind === 'wrong_binary') f.setObserved({ binary_hash: '4'.repeat(64) });
    expect(() => f.ready()).toThrow('manual_claude_provenance_mismatch');
    expect(f.candidate.state()).toMatchObject({ first_verified_at: null, revoked: true });
    expect(f.store.eventCount()).toBe(0);
  } finally {
    f.store.close();
  }
});

test('manual Claude drift/pause/restart/child cases revoke before another source decoder', () => {
  const f = fixture();
  let decoded = 0;
  try {
    f.ready();
    f.setObserved({ pid: 1235 });
    expect(() =>
      f.candidate.receiver.ingestTraces(f.token, () => {
        decoded++;
        return f.usage();
      })
    ).toThrow('manual_claude_provenance_mismatch');
    expect(decoded).toBe(0);
    expect(f.store.eventCount()).toBe(0);
  } finally {
    f.store.close();
  }
  const paused = fixture();
  try {
    paused.ready();
    paused.store.execute("UPDATE tasks SET state='paused',generation=1 WHERE id='task-1'", []);
    expect(() =>
      paused.candidate.receiver.ingestTraces(paused.token, () => {
        decoded++;
        return paused.usage();
      })
    ).toThrow('claude_trace_scope_revoked');
    expect(decoded).toBe(0);
  } finally {
    paused.store.close();
  }
  const resumed = fixture();
  try {
    expect(() => resumed.hook({ source: 'resume' })).toThrow('claude_probe_configuration_changed');
  } finally {
    resumed.store.close();
  }
  const child = fixture();
  try {
    child.ready();
    expect(() =>
      child.candidate.receiver.acceptHook(child.token, () => ({
        hook_event_name: 'PreToolUse',
        session_id: child.invocation.native_session_id,
        tool_name: 'Agent',
        tool_use_id: 'unexpected',
        tool_input: { subagent_type: 'manual-child-forbidden' }
      }))
    ).toThrow('claude_probe_child_scope');
  } finally {
    child.store.close();
  }
});

test('candidate production guard does not relabel existing admitted tool-owned Claude sessions', () => {
  const f = fixture();
  const production = new Store(':memory:');
  try {
    seedTraceScope(production);
    expect(() =>
      createManualClaudeReceiver(production, {
        scope: { ...traceScope, sessions: [{ ...traceScope.sessions[0]!, nativeSessionId: f.invocation.native_session_id }] },
        generation: 0,
        invocation: f.invocation,
        clock: () => startedAt,
        durationMs: 1000,
        readProcess: () => {
          throw new Error('must_not_read');
        }
      })
    ).toThrow('manual_claude_candidate_only');
  } finally {
    f.store.close();
    production.close();
  }
});

test('manual candidate loopback transport checks credentials/startup/provenance before accepting metadata-only usage', async () => {
  const f = fixture();
  const gateway = await f.candidate.openGateway();
  try {
    const post = (path: string, body: unknown, token = f.token) =>
      fetch(gateway.endpoint + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-harness-delta-token': token },
        body: JSON.stringify(body)
      });
    expect((await post('/v1/traces', f.usage(), 'foreign')).status).toBe(401);
    expect((await post('/v1/traces', f.usage())).status).toBe(503);
    expect(f.reads()).toBe(0);
    expect((await post('/v1/hooks', { hook_event_name: 'SessionStart', session_id: f.invocation.native_session_id, source: 'startup' })).status).toBe(200);
    expect((await post('/v1/logs', f.startup)).status).toBe(200);
    expect(f.connections).toHaveLength(1);
    f.setNow(receivedAt);
    expect((await post('/v1/traces', f.usage())).status).toBe(200);
    expect((await post('/v1/traces', f.usage())).status).toBe(200);
    expect(f.store.eventCount()).toBe(1);
    expect(f.candidate.state().profile_status).toBe('candidate_unadmitted');
  } finally {
    await gateway.close();
    f.store.close();
  }
});

test('identified-process metadata reader requires exact known argv/executable/files and no PID replacement; unknown arguments never escape', () => {
  const f = fixture();
  try {
    const snapshot = {
      started_at: startedAt,
      command: [f.invocation.binary.path, ...f.handoff.argv].join(' '),
      mapped_executable_paths: [f.invocation.binary.path]
    };
    const hash = (path: string) =>
      path === f.invocation.binary.path
        ? pinnedManualClaudeBinarySha
        : path === f.invocation.settings_path
          ? f.invocation.settings_hash
          : f.invocation.instructions_hash;
    const observed = readManualClaudeProcess(1234, f.invocation, () => snapshot, hash);
    expect(verifyManualClaudeProcess(f.invocation, observed, receivedAt)).toMatchObject({ native_context_evidence: 'unverified' });
    expect(() => readManualClaudeProcess(1234, f.invocation, () => ({ ...snapshot, command: snapshot.command + ' PRIVATE_PROMPT' }), hash)).toThrow(
      /^manual_claude_provenance_mismatch$/
    );
    let count = 0;
    expect(() => readManualClaudeProcess(1234, f.invocation, () => ({ ...snapshot, started_at: count++ ? receivedAt : startedAt }), hash)).toThrow(
      'manual_claude_provenance_mismatch'
    );
  } finally {
    f.store.close();
  }
});

test('explicit process selection may wait without decoding or revoking; preparation binds once before source startup', () => {
  const f = fixture();
  try {
    f.candidate.bindPreparedInvocation({ ...f.invocation });
    expect(() => f.candidate.bindPreparedInvocation({ ...f.invocation })).toThrow('manual_claude_preparation_locked');
    f.clearProcess();
    f.ready();
    expect(f.candidate.state()).toMatchObject({ first_verified_at: null, revoked: false });
    let decoded = 0;
    expect(() =>
      f.candidate.receiver.ingestTraces(f.token, () => {
        decoded++;
        return f.usage();
      })
    ).toThrow('claude_probe_not_ready');
    expect(decoded).toBe(0);
    expect(f.store.eventCount()).toBe(0);
    expect(() => f.candidate.bindPreparedInvocation({ ...f.invocation })).toThrow('manual_claude_preparation_locked');
  } finally {
    f.store.close();
  }
});

test('late native proof never backfills preconnection Claude spans', () => {
  const f = fixture();
  try {
    f.clearProcess();
    f.ready();
    f.setObserved({
      pid: 1234,
      started_at: startedAt,
      binary_path: f.invocation.binary.path,
      binary_hash: f.invocation.binary.sha256,
      argv: f.handoff.argv,
      settings_hash: f.invocation.settings_hash,
      instructions_hash: f.invocation.instructions_hash
    });
    expect(() => f.candidate.receiver.ingestTraces(f.token, () => f.usage())).toThrow('claude_probe_request_boundary');
    expect(f.candidate.state()).toMatchObject({ first_verified_at: receivedAt, revoked: true });
    expect(f.store.eventCount()).toBe(0);
    expect(f.connections).toHaveLength(1);
  } finally {
    f.store.close();
  }
});

test('manual preparer returns private files and a selectable handoff without native launch or hook activation', async () => {
  const f = fixture(),
    directory = realpathSync(mkdtempSync(join(tmpdir(), 'manual-claude-prepare-')));
  const cwd = join(directory, 'project'),
    workspace = join(directory, 'private');
  mkdirSync(cwd);
  f.store.execute('UPDATE projects SET local_root=? WHERE id=?', [cwd, 'project-1']);
  // Only the read-only pinned executable attestation is replaced with a synthetic
  // fixture. No native executable, model, OS process probe or mediator runs.
  const attestation = vi.spyOn(supervisor, 'verifyClaudeProbeBinary').mockImplementation(() => {});
  let prepared: Awaited<ReturnType<typeof prepareManualClaudeCandidate>> | undefined;
  try {
    prepared = await prepareManualClaudeCandidate(f.store, {
      scope: f.scope,
      generation: 0,
      clock: () => startedAt,
      durationMs: 10000,
      ticket: f.invocation,
      workspace,
      cwd,
      mediatorPath: join(directory, 'synthetic-mediator.js'),
      instructions: 'Synthetic assigned instructions'
    });
    expect(attestation).toHaveBeenCalledOnce();
    expect(prepared.handoff).toMatchObject({ automatic_launch: false, profile_status: 'candidate_unadmitted', native_loading: 'unverified' });
    expect(prepared.state()).toMatchObject({ first_verified_at: null, rootStarted: false });
    expect(readFileSync(prepared.handoff.invocation.instructions_path, 'utf8')).toBe('Synthetic assigned instructions');
    const settings = JSON.parse(readFileSync(prepared.handoff.invocation.settings_path, 'utf8')) as { hooks: unknown };
    expect(settings.hooks).toBeDefined();
    expect(f.store.eventCount()).toBe(0);
    prepared.selectProcess(1234);
    expect(() => prepared!.selectProcess(1234)).toThrow('manual_claude_process_selection_invalid');
    const path = prepared.handoff.invocation.settings_path;
    await prepared.dispose();
    prepared = undefined;
    expect(existsSync(path)).toBe(false);
    expect(existsSync(join(workspace, 'claude-probe-manifest.json'))).toBe(true);
  } finally {
    await prepared?.dispose();
    attestation.mockRestore();
    f.store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
