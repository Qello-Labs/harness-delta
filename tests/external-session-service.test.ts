import Database from 'better-sqlite3';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { codexWorkflowFixture } from './helpers/codex-workflow-fixture.js';
import { createSyntheticCodexWorkflowAdapter } from '../src/codex-workflow-adapter.js';
import { stopCodexWorkflow } from '../src/codex-workflow-journal.js';
import {
  ExternalTaskSetupSchema,
  connectExternalTask,
  collectExternalTask,
  createExternalTask,
  externalTaskResult,
  externalTaskState,
  issueExternalStartTicket,
  pauseExternalTask,
  prepareExternalTask,
  recordExternalTaskOutcome,
  verifyExternalNativeBinary
} from '../src/external-session-service.js';
import { externalInstructionFragment, verifyExternalContext } from '../src/external-session-context.js';
import { externalContract } from '../src/external-session-contract.js';
import { sha256 } from '../src/harness-managed-file.js';
import { aggregateFlexibleTaskReport } from '../src/reports/flexible-comparison.js';
import { Deletion } from '../src/deletion.js';
import { Lifecycle } from '../src/lifecycle.js';
import { beginAssignedWorkflow, workflowTaskStatus, finishAssignedWorkflow } from '../src/task-workflow.js';
import { buildExternalTaskSetup } from '../src/external-session-service.js';

function fixture() {
  const f = codexWorkflowFixture();
  // Integration owns Store's registry. Bootstrap019 only if it has not yet been
  // merged; after integration this fixture uses the ordinary Store migration.
  if (!f.store.get("SELECT 1 FROM sqlite_master WHERE name='external_task_contracts'")) {
    const db = new Database(f.database);
    try {
      db.exec(readFileSync(new URL('../src/migrations/019_external_connection_contract.sql', import.meta.url), 'utf8'));
    } finally {
      db.close();
    }
  }
  const setup = ExternalTaskSetupSchema.parse({
    workflow: f.input,
    runtime: { model: null, effort: null },
    preparation: { schema_version: 1, common_artifacts: [], common_manifest_hash: null, allowed_preimage_hashes: [] }
  });
  const sourceFor = (ticket: { ticket_id: string }, options: { stale?: boolean; role?: string; changed?: boolean } = {}) => {
    const source = f.newRoot();
    const at = new Date().toISOString();
    writeFileSync(
      source.path,
      JSON.stringify({
        timestamp: options.stale ? '2000-01-01T00:00:00.000Z' : at,
        type: 'session_meta',
        payload: { id: source.id, session_id: source.id, cwd: f.project, cli_version: '0.160.0', source: 'cli' }
      }) + '\n'
    );
    const active = readFileSync(f.project + '/.harness-delta-managed/active-instructions.md', 'utf8');
    const fragment = externalInstructionFragment(ticket.ticket_id, options.changed ? active + ' changed' : active);
    appendFileSync(
      source.path,
      JSON.stringify({
        timestamp: at,
        type: 'response_item',
        payload: {
          type: 'message',
          role: options.role ?? 'developer',
          content: [{ type: 'input_text', text: 'SYNTHETIC_NATIVE_POLICY\n' + fragment + '\nSYNTHETIC_NATIVE_SUFFIX' }]
        }
      }) + '\n'
    );
    return source;
  };
  const execution = (run: string, op: 'link' | 'collect', source: { id: string; path: string }) => ({
    ...f.execution(run, op, source.id, source.path),
    timeout_ms: 1000
  });
  const adapter = (e: unknown) => createSyntheticCodexWorkflowAdapter(f.store, e, f.script);
  const connect = (run: string, ticket: { ticket_id: string }, source: { id: string; path: string }) => {
    const e = execution(run, 'link', source);
    return connectExternalTask(f.store, setup, e, ticket.ticket_id, adapter(e));
  };
  return { ...f, setup, sourceFor, execution, adapter, connect };
}

test('new preparation has no operative clock, private ticket never claims actual native use, simple task facade makes opaque IDs', () => {
  const f = fixture();
  try {
    const state = prepareExternalTask(f.store, f.setup, true);
    expect(state).toMatchObject({ window: { started_at: null, ends_at: null }, native_context_evidence: 'unverified', tool_use_evidence: 'unavailable' });
    expect(state).not.toHaveProperty('comparison_followup_ends_at');
    expect(f.store.all('SELECT * FROM active_intervals')).toHaveLength(0);
    const ticket = issueExternalStartTicket(f.store, f.setup);
    expect(ticket).toMatchObject({ automatic_launch: false, native_loading: 'unverified' });
    expect(ticket.start_command).toContain('developer_instructions=');
    expect(JSON.stringify(f.store.all('SELECT * FROM external_start_tickets'))).not.toContain('SYNTHETIC_PRIVATE_HARNESS');
    expect(() => createExternalTask(f.store, f.setup)).toThrow('external_surface_busy');
  } finally {
    f.cleanup();
  }
});

test('verified native fragment starts one connection window; old usage is baseline, reconnect/rework keep arm and totals', async () => {
  const f = fixture();
  try {
    prepareExternalTask(f.store, f.setup, true);
    const assignment = f.store.get('SELECT * FROM comparison_assignments WHERE task_id=?', ['task-1']);
    const first = issueExternalStartTicket(f.store, f.setup);
    const source = f.sourceFor(first);
    f.appendUsage(source);
    await f.connect('ticket-link', first, source);
    const initial = externalContract(f.store, 'task-1');
    expect(initial?.started_at).not.toBeNull();
    expect(f.store.eventCount()).toBe(0);
    expect(externalTaskState(f.store, 'task-1')).toMatchObject({
      native_context_evidence: 'native_developer_context_observed',
      freshness_evidence: 'fresh_root_after_ticket',
      tool_use_evidence: 'unavailable'
    });
    await expect(f.connect('ticket-reuse', first, source)).rejects.toThrow('external_ticket_used');
    const e = f.execution('ticket-collect', 'collect', source);
    const collecting = collectExternalTask(f.store, f.setup, e, f.adapter(e));
    const timer = setInterval(() => {
      if (f.store.get<{ source_identity: string | null }>('SELECT source_identity FROM codex_workflow_runs WHERE id=?', [e.run_id])?.source_identity) {
        clearInterval(timer);
        f.appendUsage(source);
        setTimeout(() => stopCodexWorkflow(f.store, e.run_id), 100);
      }
    }, 10);
    try {
      await collecting;
    } finally {
      clearInterval(timer);
    }
    expect(f.store.eventCount()).toBe(1);
    expect(new Lifecycle(f.store).state('task-1')).toBe('paused');
    recordExternalTaskOutcome(f.store, 'task-1', 'rework', []);
    const second = issueExternalStartTicket(f.store, f.setup);
    const next = f.sourceFor(second);
    f.appendUsage(next);
    await f.connect('ticket-next', second, next);
    expect(externalContract(f.store, 'task-1')).toEqual(initial);
    expect(f.store.get('SELECT * FROM comparison_assignments WHERE task_id=?', ['task-1'])).toEqual(assignment);
    expect(f.store.eventCount()).toBe(1);
    const observed = f.store.get<{
      id: string;
      project_id: string;
      task_id: string;
      session_id: string;
      source_key: string;
      occurred_at: string;
      payload: string;
    }>('SELECT * FROM events WHERE task_id=?', ['task-1'])!;
    f.store.execute('INSERT INTO events(id,project_id,task_id,session_id,source_key,occurred_at,payload) VALUES (?,?,?,?,?,?,?)', [
      'synthetic-prior-event',
      observed.project_id,
      observed.task_id,
      observed.session_id,
      'synthetic-prior-source',
      new Date(Date.parse(initial!.started_at!) - 1).toISOString(),
      observed.payload
    ]);
    const report = externalTaskResult(f.store, 'task-1');
    expect(report).toMatchObject({
      report_contract: 'external-observation-v1',
      window: { started_at: initial?.started_at, ends_at: initial?.ends_at },
      time: { rework_count: 1 },
      coverage: 'partial',
      complete_cost: null,
      inference: false
    });
    expect(report.cost?.event_count).toBe(1);
    expect(report.cost?.window_start).toBe(initial!.started_at);
    const originalStart = new Lifecycle(f.store).task('task-1').started_at;
    f.store.execute('UPDATE tasks SET started_at=? WHERE id=?', ['2000-01-01T00:00:00.000Z', 'task-1']);
    expect(() => externalTaskResult(f.store, 'task-1')).toThrow('external_window_mismatch');
    f.store.execute('UPDATE tasks SET started_at=? WHERE id=?', [originalStart, 'task-1']);
    expect(() => aggregateFlexibleTaskReport(f.store, 'task-1', new Date().toISOString())).toThrow('timing_contract_mismatch');
    expect(() => f.store.execute("UPDATE external_task_contracts SET started_at='2000-01-01T00:00:00Z' WHERE task_id=?", ['task-1'])).toThrow(
      'immutable_external_window'
    );
    pauseExternalTask(f.store, 'task-1');
    const criteria = (JSON.parse(new Lifecycle(f.store).task('task-1').metadata) as { criterion_ids: string[] }).criterion_ids;
    expect(() => recordExternalTaskOutcome(f.store, 'task-1', 'success', [])).toThrow('invalid_criteria');
    const success = recordExternalTaskOutcome(f.store, 'task-1', 'success', criteria);
    expect(success.state).toMatchObject({ outcome: 'success', post_success_action: 'success_is_final_for_this_task_create_followup_task_for_additional_work' });
    expect(() => recordExternalTaskOutcome(f.store, 'task-1', 'rework', [])).toThrow('invalid_transition');
    new Deletion(f.store).deleteTask('task-1');
    expect(f.store.all('SELECT * FROM external_start_tickets')).toHaveLength(0);
    expect(f.store.all('SELECT * FROM external_task_contracts')).toHaveLength(0);
  } finally {
    f.cleanup();
  }
}, 10000);

test.each([{ stale: true }, { role: 'user' }, { changed: true }])(
  'unverified/stale/mismatched context never starts the operative clock (%j)',
  async options => {
    const f = fixture();
    try {
      prepareExternalTask(f.store, f.setup, true);
      const ticket = issueExternalStartTicket(f.store, f.setup);
      const source = f.sourceFor(ticket, options);
      f.appendUsage(source);
      await expect(f.connect('rejected-link', ticket, source)).rejects.toThrow('external_connection_unverified');
      expect(externalContract(f.store, 'task-1')).toMatchObject({ started_at: null, ends_at: null });
      expect(externalTaskState(f.store, 'task-1')).toMatchObject({ native_context_evidence: 'unverified' });
      expect(f.store.eventCount()).toBe(0);
    } finally {
      f.cleanup();
    }
  },
  5000
);

test('developer-only projection rejects duplicate markers and ignores assistant attestation', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const fragment = externalInstructionFragment(id, 'SYNTHETIC_INSTRUCTIONS');
  const at = '2026-10-06T00:00:00.000Z';
  const header = { type: 'session_meta', timestamp: at, payload: {} };
  const message = (text: string, role = 'developer') => ({
    type: 'response_item',
    timestamp: at,
    payload: { type: 'message', role, content: [{ type: 'input_text', text }] }
  });
  const expected = { ticketId: id, issuedAt: at, fragmentHash: sha256(fragment) };
  expect(() => verifyExternalContext([header, message(fragment, 'assistant')], expected, at)).toThrow('external_context_unverified');
  expect(() => verifyExternalContext([header, message(fragment), message(fragment)], expected, at)).toThrow('external_context_mismatch');
  expect(verifyExternalContext([header, message(fragment)], expected, at)).toEqual({ nativeCreatedAt: at, fragmentHash: sha256(fragment) });
});

test('new contract blocks legacy activation/finalization, keeps its single clock in shared task status and preserves user changes', async () => {
  const f = fixture();
  try {
    prepareExternalTask(f.store, f.setup, true);
    expect(workflowTaskStatus(f.store, 'task-1')).toMatchObject({
      followup_ends_at: null,
      followup: 'pending',
      timing_contract: 'external-first-connection-v1'
    });
    expect(() => beginAssignedWorkflow(f.store, f.input, f.setup.runtime)).toThrow('timing_contract_mismatch');
    const first = issueExternalStartTicket(f.store, f.setup);
    const source = f.sourceFor(first);
    await f.connect('boundary-connect', first, source);
    const frozen = externalContract(f.store, 'task-1')!;
    expect(workflowTaskStatus(f.store, 'task-1').followup_ends_at).toBe(frozen.ends_at);
    expect(() => finishAssignedWorkflow(f.store, 'task-1', 'failed', [])).toThrow('timing_contract_mismatch');
    const expired = () => frozen.ends_at!;
    expect(() => issueExternalStartTicket(f.store, f.setup, expired)).toThrow('external_window_closed');
    await expect(collectExternalTask(f.store, f.setup, f.execution('late-collect', 'collect', source), undefined, expired)).rejects.toThrow(
      'external_window_closed'
    );
    expect(f.store.get('SELECT id FROM codex_workflow_runs WHERE id=?', ['late-collect'])).toBeUndefined();
    expect(externalTaskState(f.store, 'task-1', frozen.ends_at!).window_status).toBe('closed');
    writeFileSync(f.project + '/.harness-delta-managed/active-instructions.md', 'SYNTHETIC_USER_CHANGE');
    expect(() => issueExternalStartTicket(f.store, f.setup)).toThrow('external_configuration_drift');
    expect(readFileSync(f.project + '/.harness-delta-managed/active-instructions.md', 'utf8')).toBe('SYNTHETIC_USER_CHANGE');
    expect(externalContract(f.store, 'task-1')).toEqual(frozen);
  } finally {
    f.cleanup();
  }
});

test('native binary mismatch is a local metadata rejection and cannot start a ticket or a model', () => {
  const f = fixture();
  try {
    expect(() => verifyExternalNativeBinary({ path: f.script, version: '0.160.0', sha256: sha256(readFileSync(f.script)) })).toThrow('binary_mismatch');
    expect(f.store.all('SELECT * FROM external_start_tickets')).toHaveLength(0);
  } finally {
    f.cleanup();
  }
});

test('reviewed template builder chooses only existing project/protocol/criterion IDs and invents no defaults', () => {
  const f = fixture();
  try {
    const criteria = f.setup.workflow.assignment.metadata.criterion_ids;
    const selected = buildExternalTaskSetup(f.store, { id: 'reviewed-setup', setup: f.setup }, { projectId: 'project-1', criterionIds: [criteria[0]!] });
    expect(selected.workflow.assignment.protocol_id).toBe(f.setup.workflow.assignment.protocol_id);
    expect(selected.workflow.assignment.metadata.criterion_ids).toEqual([criteria[0]]);
    expect(() => buildExternalTaskSetup(f.store, { id: 'reviewed-setup', setup: f.setup }, { projectId: 'unknown-project' })).toThrow(
      'workflow_configuration_mismatch'
    );
    expect(() =>
      buildExternalTaskSetup(f.store, { id: 'reviewed-setup', setup: f.setup }, { projectId: 'project-1', criterionIds: ['unreviewed-criterion'] })
    ).toThrow('invalid_criteria');
  } finally {
    f.cleanup();
  }
});

test('configuration drift after validated baseline leaves connection uncommitted and durably pauses speculative time', async () => {
  const f = fixture();
  try {
    prepareExternalTask(f.store, f.setup, true);
    const ticket = issueExternalStartTicket(f.store, f.setup),
      source = f.sourceFor(ticket);
    const execution = f.execution('commit-drift', 'link', source),
      adapter = f.adapter(execution);
    const changed = {
      ...adapter,
      async run(context: Parameters<typeof adapter.run>[0]) {
        const result = await adapter.run(context);
        writeFileSync(f.project + '/.harness-delta-managed/active-instructions.md', 'SYNTHETIC_USER_CHANGE');
        return result;
      }
    };
    await expect(connectExternalTask(f.store, f.setup, execution, ticket.ticket_id, changed)).rejects.toThrow('external_configuration_drift');
    expect(externalContract(f.store, 'task-1')).toMatchObject({ started_at: null, ends_at: null });
    expect(externalTaskState(f.store, 'task-1')).toMatchObject({ state: 'configuration_changed', task_state: 'paused' });
    expect(
      f.store.get<{ verified_at: string | null }>('SELECT verified_at FROM external_start_tickets WHERE id=?', [ticket.ticket_id])?.verified_at
    ).toBeNull();
    expect(f.store.eventCount()).toBe(0);
    expect(readFileSync(f.project + '/.harness-delta-managed/active-instructions.md', 'utf8')).toBe('SYNTHETIC_USER_CHANGE');
  } finally {
    f.cleanup();
  }
});
