import { familyRejection, takeFamilyDiagnostic } from '../../src/binding/binding-family-diagnostics.js';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { codexWorkflowFixture } from '../helpers/codex-workflow-fixture.js';
import { CodexSessionBindingProvider } from '../../src/session-binding-codex.js';
import {
  issueCodexHumanPilotScope,
  assertCodexHumanPilotScope,
  checkCodexHumanPilotIdentity,
  codexHumanPilotProfileId
} from '../../src/binding/session-binding-human-pilot.js';
import { ExternalTaskSetupSchema, prepareExternalTask } from '../../src/workflow/external-session-service.js';
import { bindingSourceSupported, createSessionBindingService } from '../../src/session-binding-service.js';
import type { VerifiedSessionIdentity } from '../../src/session-binding-contract.js';
import { localWebFixture } from '../helpers/local-web-fixture.js';
import { createLocalWebDomain } from '../../src/web/local-web-domain.js';
import { beginAssignedWorkflow, workflowStatus } from '../../src/workflow/task-workflow.js';
import { assignTask } from '../../src/comparison/allocation.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function fixture() {
  const f = codexWorkflowFixture(codexHumanPilotProfileId, 'functional_pilot');
  cleanups.push(f.cleanup);
  const setup = ExternalTaskSetupSchema.parse({
    workflow: f.input,
    runtime: { model: null, effort: null },
    preparation: { schema_version: 1, common_artifacts: [], common_manifest_hash: null, allowed_preimage_hashes: [] }
  });
  prepareExternalTask(f.store, setup, true);
  const journal = join(f.root, 'pilot-receipts');
  mkdirSync(journal, { mode: 0o700 });
  const provider = new CodexSessionBindingProvider({
    receiptDirectory: journal,
    sourceRoots: [join(f.home, 'sessions')],
    projectRoot: f.project,
    maxDepth: 1,
    maxFamilyMembers: 3
  });
  const id = f.input.assignment.task_id;
  const scope = issueCodexHumanPilotScope(f.store, id, provider);
  const identity = (parentSessionId: string | null = null): VerifiedSessionIdentity => ({
    product: 'codex',
    productVersion: '0.160.0',
    sessionId: randomUUID(),
    sourceRef: f.newRoot().path,
    sourceIdentity: randomUUID(),
    cwd: f.project,
    identityEvidenceId: randomUUID(),
    parentSessionId,
    createdAt: new Date(Date.now() + 1).toISOString()
  });
  return { ...f, setup, journal, provider, id, scope, identity };
}
test('pilot authority is exact task/store/provider and does not admit production', () => {
  const f = fixture();
  expect(bindingSourceSupported(f.store, f.id)).toBe(false);
  expect(() => assertCodexHumanPilotScope(f.scope, f.store, f.id, f.provider)).not.toThrow();
  expect(() => assertCodexHumanPilotScope({ ...f.scope }, f.store, f.id, f.provider)).toThrow('binding_pilot_scope_invalid');
  expect(() => assertCodexHumanPilotScope(f.scope, f.store, 'other', f.provider)).toThrow('binding_pilot_scope_invalid');
  f.store.execute("UPDATE tasks SET metadata=json_set(metadata,'$.initial_model','changed-model') WHERE id=?", [f.id]);
  expect(() => assertCodexHumanPilotScope(f.scope, f.store, f.id, f.provider)).toThrow('binding_pilot_scope_invalid');
});
test('pilot rejects old roots and a second parent before reading usage', async () => {
  const f = fixture();
  const root = f.identity();
  const service = createSessionBindingService({ store: f.store, providers: [f.provider], setupFor: () => f.setup, humanPilot: f.scope });
  const resolve = vi.spyOn(f.provider, 'resolveCurrent').mockResolvedValue(root);
  vi.spyOn(f.provider, 'assertRootReceipt').mockImplementation(() => {});
  vi.spyOn(f.provider, 'discoverChildren').mockResolvedValue({ children: [], gaps: [] });
  const read = vi.spyOn(f.provider, 'readUsage').mockResolvedValue({ records: [], cursor: '0', gaps: [] });
  await service.connect(f.id, 'codex', { receipt: randomUUID() });
  expect(read).toHaveBeenCalledTimes(1);
  resolve.mockResolvedValue(f.identity());
  await expect(service.connect(f.id, 'codex', { receipt: randomUUID() })).rejects.toThrow('binding_pilot_family_scope');
  expect(read).toHaveBeenCalledTimes(1);
  const old = { ...root, sessionId: randomUUID(), createdAt: '2000-01-01T00:00:00.000Z' };
  expect(() => checkCodexHumanPilotIdentity(f.scope, f.store, f.id, old)).toThrow('binding_pilot_family_scope');
});
test('third and nested children stop before their usage bodies are read', async () => {
  const f = fixture();
  const root = f.identity();
  const children = [f.identity(root.sessionId), f.identity(root.sessionId)];
  vi.spyOn(f.provider, 'resolveCurrent').mockResolvedValue(root);
  vi.spyOn(f.provider, 'assertRootReceipt').mockImplementation(() => {});
  const read = vi.spyOn(f.provider, 'readUsage').mockResolvedValue({ records: [], cursor: '0', gaps: [] });
  const discover = vi.spyOn(f.provider, 'discoverChildren').mockImplementation(parent =>
    Promise.resolve({
      children:
        parent.sessionId === root.sessionId ? children.map(identity => ({ identity, parentSessionId: root.sessionId, relationEvidenceId: randomUUID() })) : [],
      gaps: []
    })
  );
  const service = createSessionBindingService({ store: f.store, providers: [f.provider], setupFor: () => f.setup, humanPilot: f.scope });
  await service.connect(f.id, 'codex', { receipt: randomUUID() });
  await service.tick(f.id);
  const count = read.mock.calls.length;
  const extra = f.identity(root.sessionId);
  children.push(extra);
  await expect(service.tick(f.id)).rejects.toThrow('binding_pilot_family_scope');
  expect(read.mock.calls.length).toBe(count);
  children.pop();
  const nested = f.identity(children[0]!.sessionId);
  discover.mockImplementation(parent =>
    Promise.resolve({
      children: parent.sessionId === children[0]!.sessionId ? [{ identity: nested, parentSessionId: parent.sessionId, relationEvidenceId: randomUUID() }] : [],
      gaps: []
    })
  );
  await expect(service.tick(f.id)).rejects.toThrow('binding_pilot_family_scope');
  expect(read.mock.calls.length).toBe(count);
});
test('source-free scope issuance reads no source files and synthetic or real-experiment tasks cannot issue it', () => {
  const f = fixture();
  writeFileSync(join(f.journal, 'unrelated.json'), 'private content must not be read');
  expect(() => issueCodexHumanPilotScope(f.store, f.id, f.provider)).not.toThrow();
  const synthetic = codexWorkflowFixture();
  cleanups.push(synthetic.cleanup);
  expect(() => issueCodexHumanPilotScope(synthetic.store, synthetic.input.assignment.task_id, f.provider)).toThrow();
  const real = codexWorkflowFixture(codexHumanPilotProfileId, 'real_experiment');
  cleanups.push(real.cleanup);
  expect(() => issueCodexHumanPilotScope(real.store, real.input.assignment.task_id, f.provider)).toThrow();
});
test('pilot preparation does not enable ordinary allocation, activation or native execution', () => {
  const f = codexWorkflowFixture(codexHumanPilotProfileId, 'functional_pilot');
  cleanups.push(f.cleanup);
  expect(() => assignTask(f.store, f.input.assignment)).toThrow('real_experiment_disabled');
  expect(() => beginAssignedWorkflow(f.store, f.input, { model: null, effort: null })).toThrow('real_experiment_disabled');
  expect(workflowStatus(f.store, f.input.assignment.protocol_id)).toMatchObject({ native_execution: false, readiness: { real_allocation: false } });
});
test.each([
  ['initial', 'nested'],
  ['tick', 'nested'],
  ['resume', 'nested'],
  ['initial', 'excess'],
  ['tick', 'excess']
])('native provider %s %s discovery stops before usage bodies', async (stage, kind) => {
  const f = fixture();
  const service = createSessionBindingService({ store: f.store, providers: [f.provider], setupFor: () => f.setup, humanPilot: f.scope });
  const root = f.newRoot();
  const receipt = (session: { id: string; path: string }, parent?: string, depth = 1) => {
    if (parent)
      writeFileSync(
        session.path,
        JSON.stringify({
          type: 'session_meta',
          payload: {
            id: session.id,
            session_id: root.id,
            parent_thread_id: parent,
            cli_version: '0.160.0',
            cwd: f.project,
            source: { subagent: { thread_spawn: { parent_thread_id: parent, depth } } }
          }
        }) + '\n'
      );
    const output = JSON.parse(
      execFileSync(
        process.execPath,
        [resolve('scripts/session-binding-codex-hook.mjs'), '--receipt-directory', f.journal, '--source-root', join(f.home, 'sessions')],
        {
          input: JSON.stringify({
            hook_event_name: parent ? 'SubagentStart' : 'SessionStart',
            session_id: root.id,
            agent_id: parent ? session.id : undefined,
            turn_id: parent ? 'root-turn' : undefined,
            source: parent ? undefined : 'startup',
            cwd: f.project,
            transcript_path: session.path
          }),
          encoding: 'utf8'
        }
      )
    ) as { hookSpecificOutput: { additionalContext: string } };
    return /[a-f0-9-]{36}/.exec(output.hookSpecificOutput.additionalContext)![0];
  };
  const rootReceipt = receipt(root);
  if (stage !== 'initial') await service.connect(f.id, 'codex', { receipt: rootReceipt });
  const child = f.newRoot();
  receipt(child, root.id);
  if (stage !== 'initial') await service.tick(f.id);
  if (stage === 'resume') service.pause(f.id);
  if (kind === 'nested') receipt(f.newRoot(), child.id, 2);
  else {
    receipt(f.newRoot(), root.id);
    receipt(f.newRoot(), root.id);
  }
  f.appendUsage(root);
  const read = vi.spyOn(f.provider, 'readUsage');
  const action =
    stage === 'initial' ? service.connect(f.id, 'codex', { receipt: rootReceipt }) : stage === 'resume' ? service.resume(f.id) : service.tick(f.id);
  await expect(action).rejects.toThrow(stage === 'initial' && kind === 'excess' ? 'binding_family_limit' : 'binding_pilot_family_scope');
  expect(read).not.toHaveBeenCalled();
  expect(f.store.eventCount()).toBe(0);
});
test('native-shaped pilot family collects native provenance, excludes pause, resumes after restart and finishes without owner', async () => {
  const f = localWebFixture(codexHumanPilotProfileId);
  const journal = join(f.root, 'receipts');
  mkdirSync(journal, { mode: 0o700 });
  f.profile.session_binding = { product: 'codex', receipt_directory: journal, source_roots: [join(f.home, 'sessions')], project_root: f.project };
  let domain = f.create();
  try {
    const created = (await domain.createTask({ name: 'Synthetic native-shaped pilot', project_id: 'project-1', setup_id: f.profile.id })) as { id: string };
    const id = created.id;
    await domain.close?.();
    const open = (observe: boolean) =>
      createLocalWebDomain({ store: f.store, metadataFile: f.metadataFile, profiles: [f.profile], nativePilot: { taskId: id, observe } });
    domain = open(false);
    expect(domain.task(id)).toMatchObject({ binding: { support: 'native_pilot_preparation_only', roots: 0 } });
    await domain.taskAction(id, 'apply', {});
    await expect(domain.taskAction(id, 'session-connect', { product: 'codex', receipt: randomUUID() })).rejects.toThrow('binding_source_unqualified');
    await expect(domain.taskAction(id, 'ticket', {})).rejects.toThrow('binding_pilot_control_only');
    await domain.close?.();
    domain = open(false);
    expect(f.store.eventCount()).toBe(0);
    expect(domain.task(id)).toMatchObject({ preparation: { configuration_evidence: 'verified_at_preparation' } });
    await domain.close?.();
    domain = open(true);
    const root = f.newRoot();
    const receipt = (session: { id: string; path: string }, parent?: string) => {
      const output = JSON.parse(
        execFileSync(
          process.execPath,
          [resolve('scripts/session-binding-codex-hook.mjs'), '--receipt-directory', journal, '--source-root', join(f.home, 'sessions')],
          {
            input: JSON.stringify({
              hook_event_name: parent ? 'SubagentStart' : 'SessionStart',
              session_id: parent ?? session.id,
              agent_id: parent ? session.id : undefined,
              turn_id: parent ? 'root-turn' : undefined,
              source: parent ? undefined : 'startup',
              cwd: f.project,
              transcript_path: session.path
            }),
            encoding: 'utf8'
          }
        )
      ) as { hookSpecificOutput: { additionalContext: string } };
      return /[a-f0-9-]{36}/.exec(output.hookSpecificOutput.additionalContext)![0];
    };
    await domain.taskAction(id, 'session-connect', { product: 'codex', receipt: receipt(root) });
    const children = Array.from({ length: 2 }, () => {
      const child = f.newRoot();
      writeFileSync(
        child.path,
        JSON.stringify({
          type: 'session_meta',
          payload: {
            id: child.id,
            session_id: root.id,
            parent_thread_id: root.id,
            cli_version: '0.160.0',
            cwd: f.project,
            source: { subagent: { thread_spawn: { parent_thread_id: root.id, depth: 1 } } }
          }
        }) + '\n'
      );
      receipt(child, root.id);
      return child;
    });
    const usage = () => {
      f.appendUsage(root);
      for (const child of children) {
        const at = new Date().toISOString();
        const turn = randomUUID();
        appendFileSync(
          child.path,
          JSON.stringify({
            type: 'turn_context',
            timestamp: at,
            payload: { cwd: f.project, turn_id: turn, root_turn_id: 'root-turn', model: 'synthetic-pilot-model', effort: 'high' }
          }) +
            '\n' +
            JSON.stringify({
              type: 'token_usage_record',
              timestamp: at,
              payload: {
                thread_id: child.id,
                session_id: root.id,
                turn_id: turn,
                root_turn_id: 'root-turn',
                response_id: randomUUID(),
                usage: { input_tokens: 10, cached_input_tokens: 2, cache_write_input_tokens: 0, output_tokens: 3, reasoning_output_tokens: 1, total_tokens: 13 }
              }
            }) +
            '\n'
        );
      }
    };
    usage();
    await expect.poll(() => f.store.eventCount(), { timeout: 3000 }).toBe(3);
    expect(domain.task(id)).toMatchObject({
      binding: { support: 'native_unverified_pilot', roots: 1, children: 2, requests: 3, complete_cost: null, inference: false }
    });
    expect(f.store.all<{ product: string }>("SELECT json_extract(payload,'$.product') AS product FROM events").map(r => r.product)).toEqual([
      'codex',
      'codex',
      'codex'
    ]);
    await domain.taskAction(id, 'pause', {});
    usage();
    expect(f.store.eventCount()).toBe(3);
    await domain.close?.();
    domain = open(true);
    await domain.taskAction(id, 'resume-binding', {});
    expect(f.store.eventCount()).toBe(3);
    usage();
    await expect.poll(() => f.store.eventCount(), { timeout: 3000 }).toBe(6);
    expect(domain.task(id).actions).toEqual(expect.arrayContaining([{ code: 'finish-success', enabled: true, reason: null }]));
    await domain.taskAction(id, 'finish-success', {});
    usage();
    expect(f.store.eventCount()).toBe(6);
    expect(domain.task(id)).toMatchObject({ status: 'success', binding: { requests: 6 } });
  } finally {
    await domain.close?.();
    f.cleanup();
  }
}, 10000);

test('legacy human-pilot children accept optional display metadata while changed source proof stays rejected', async () => {
  const f = fixture();
  const root = f.identity();
  const child = f.identity(root.sessionId);
  vi.spyOn(f.provider, 'resolveCurrent').mockResolvedValue(root);
  vi.spyOn(f.provider, 'assertRootReceipt').mockImplementation(() => {});
  vi.spyOn(f.provider, 'readUsage').mockResolvedValue({ records: [], cursor: '0', gaps: [] });
  vi.spyOn(f.provider, 'discoverChildren').mockImplementation(parent =>
    Promise.resolve({
      children: parent.sessionId === root.sessionId ? [{ identity: child, parentSessionId: root.sessionId, relationEvidenceId: child.identityEvidenceId }] : [],
      gaps: []
    })
  );
  const service = createSessionBindingService({ store: f.store, providers: [f.provider], setupFor: () => f.setup, humanPilot: f.scope });
  await service.connect(f.id, 'codex', { receipt: randomUUID() });
  await service.tick(f.id);
  child.agentMetadata = { source: 'codex_session_meta', nickname: 'Cedar', role: 'reviewer' };
  await expect(service.tick(f.id)).resolves.toMatchObject({ roots: 1, children: 1 });
  expect(service.status(f.id).sessions.find(s => s.session_id === child.sessionId)?.agent_metadata).toBeNull();
  child.sourceIdentity = randomUUID();
  await expect(service.tick(f.id)).rejects.toThrow('binding_identity_mismatch');
});

// Original rejection and pause fences must survive both unknown cause and a failed diagnostic sink.
test.each(['sink', 'eligibility'] as const)('baseline diagnostic %s failure preserves rejection and pause without extra reads', async fault => {
  const f = fixture();
  const root = f.identity();
  const diagnostics: unknown[] = [];
  vi.spyOn(f.provider, 'resolveCurrent').mockResolvedValue(root);
  vi.spyOn(f.provider, 'assertRootReceipt').mockImplementation(() => {});
  const discover = vi.spyOn(f.provider, 'discoverChildren').mockRejectedValue(new Error('SYNTHETIC-PRIVATE-FAILURE'));
  const read = vi.spyOn(f.provider, 'readUsage');
  const get = f.store.get.bind(f.store);
  if (fault === 'eligibility')
    vi.spyOn(f.store, 'get').mockImplementation((sql, params) => {
      if (sql === 'SELECT t.state,t.generation,t.project_id,p.local_root FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=?')
        throw new Error('SYNTHETIC-ELIGIBILITY-FAILURE');
      return get(sql, params);
    });
  const service = createSessionBindingService({
    store: f.store,
    providers: [f.provider],
    setupFor: () => f.setup,
    humanPilot: f.scope,
    onFamilyRejection: diagnostic => {
      diagnostics.push(diagnostic);
      throw new Error('SYNTHETIC-SINK-FAILURE');
    }
  });
  await expect(service.connect(f.id, 'codex', { receipt: randomUUID() })).rejects.toThrow('SYNTHETIC-PRIVATE-FAILURE');
  expect(diagnostics).toEqual(fault === 'sink' ? [{ schema_version: 1, phase: 'baseline_discovery', reason_codes: [] }] : []);
  expect(f.store.get<{ state: string }>('SELECT state FROM tasks WHERE id=?', [f.id])?.state).toBe('paused');
  expect(f.store.all<{ state: string }>('SELECT state FROM session_bindings WHERE task_id=?', [f.id]).map(row => row.state)).toEqual(['stopped']);
  expect(discover).toHaveBeenCalledTimes(1);
  expect(read).not.toHaveBeenCalled();
  expect(f.store.eventCount()).toBe(0);
  await service.tick(f.id);
  expect(diagnostics).toHaveLength(fault === 'sink' ? 1 : 0);
  expect(discover).toHaveBeenCalledTimes(1);
});

// Diagnostic eligibility is separate from a previously authorized observer attempt.
test.each([
  'once',
  'foreign_task',
  'unlinked',
  'task_state',
  'binding_state',
  'task_generation',
  'binding_generation',
  'identity',
  'root',
  'project_root'
] as const)('sealed diagnostic rejects changed %s eligibility or consumes it exactly once', async fault => {
  const f = fixture();
  const root = f.identity();
  vi.spyOn(f.provider, 'resolveCurrent').mockResolvedValue(root);
  vi.spyOn(f.provider, 'assertRootReceipt').mockImplementation(() => {});
  vi.spyOn(f.provider, 'discoverChildren').mockResolvedValue({ children: [], gaps: [] });
  vi.spyOn(f.provider, 'readUsage').mockResolvedValue({ records: [], cursor: '0', gaps: [] });
  const service = createSessionBindingService({ store: f.store, providers: [f.provider], setupFor: () => f.setup, humanPilot: f.scope });
  await service.connect(f.id, 'codex', { receipt: randomUUID() });
  const task = f.store.get<{ generation: number; project_id: string }>('SELECT generation,project_id FROM tasks WHERE id=?', [f.id])!;
  const binding = f.store.get<{ identity: string; root_id: string }>('SELECT identity,root_id FROM session_bindings WHERE session_id=?', [root.sessionId])!;
  const error = new Error('SYNTHETIC-RAW-ERROR');
  familyRejection(
    error,
    'tick_discovery',
    {
      taskId: f.id,
      projectId: task.project_id,
      projectRoot: f.project,
      rootId: binding.root_id,
      sessionId: root.sessionId,
      generation: task.generation,
      identity: binding.identity
    },
    undefined,
    ['ownership_unverified', 'SYNTHETIC-SECRET']
  );
  if (fault === 'unlinked') f.store.execute('DELETE FROM session_bindings WHERE session_id=?', [root.sessionId]);
  if (fault === 'task_state') f.store.execute("UPDATE tasks SET state='paused' WHERE id=?", [f.id]);
  if (fault === 'binding_state') f.store.execute("UPDATE session_bindings SET state='stopped' WHERE session_id=?", [root.sessionId]);
  if (fault === 'task_generation') f.store.execute('UPDATE tasks SET generation=generation+1 WHERE id=?', [f.id]);
  if (fault === 'binding_generation') f.store.execute('UPDATE session_bindings SET generation=generation+1 WHERE session_id=?', [root.sessionId]);
  if (fault === 'identity') f.store.execute("UPDATE session_bindings SET identity='{}' WHERE session_id=?", [root.sessionId]);
  if (fault === 'root') {
    const other = randomUUID();
    f.store.execute('INSERT INTO sessions(id,project_id,task_id,product) VALUES (?,?,?,?)', [other, task.project_id, f.id, 'codex']);
    f.store.execute('UPDATE session_bindings SET root_id=? WHERE session_id=?', [other, root.sessionId]);
  }
  if (fault === 'project_root') f.store.execute('UPDATE projects SET local_root=? WHERE id=?', [f.root, task.project_id]);
  const result = takeFamilyDiagnostic(error, fault === 'foreign_task' ? 'another-task' : f.id, f.store);
  expect(result).toEqual(fault === 'once' ? { schema_version: 1, phase: 'tick_discovery', reason_codes: ['ownership_unverified'] } : null);
  expect(takeFamilyDiagnostic(error, f.id, f.store)).toBeNull();
});

test.each(['baseline_relation', 'baseline_descendants', 'tick_relation'] as const)(
  'records %s at the rejecting service boundary before child usage',
  async phase => {
    const f = fixture();
    const root = f.identity();
    const child = f.identity(root.sessionId);
    const diagnostics: unknown[] = [];
    vi.spyOn(f.provider, 'resolveCurrent').mockResolvedValue(root);
    vi.spyOn(f.provider, 'assertRootReceipt').mockImplementation(() => {});
    const read = vi.spyOn(f.provider, 'readUsage').mockResolvedValue({ records: [], cursor: '0', gaps: [] });
    const discover = vi.spyOn(f.provider, 'discoverChildren').mockResolvedValue({ children: [], gaps: [] });
    const service = createSessionBindingService({
      store: f.store,
      providers: [f.provider],
      setupFor: () => f.setup,
      humanPilot: f.scope,
      onFamilyRejection: value => {
        expect(f.store.get<{ state: string }>('SELECT state FROM tasks WHERE id=?', [f.id])?.state).toBe('paused');
        diagnostics.push(value);
      }
    });
    if (phase === 'tick_relation') await service.connect(f.id, 'codex', { receipt: randomUUID() });
    discover.mockImplementation(parent =>
      Promise.resolve({
        children:
          parent.sessionId === root.sessionId
            ? [
                {
                  identity: child,
                  parentSessionId: phase === 'baseline_descendants' ? root.sessionId : 'other-parent',
                  relationEvidenceId: child.identityEvidenceId
                }
              ]
            : phase === 'baseline_descendants'
              ? [{ identity: f.identity(child.sessionId), parentSessionId: child.sessionId, relationEvidenceId: randomUUID() }]
              : [],
        gaps: []
      })
    );
    if (phase === 'tick_relation') {
      let failure: unknown;
      try {
        await service.tick(f.id);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe('binding_relation_invalid');
      const value = takeFamilyDiagnostic(failure, f.id, f.store);
      service.pause(f.id);
      diagnostics.push(value);
    } else await expect(service.connect(f.id, 'codex', { receipt: randomUUID() })).rejects.toThrow('binding_pilot_family_scope');
    expect(diagnostics).toEqual([{ schema_version: 1, phase, reason_codes: [phase === 'baseline_descendants' ? 'descendants_present' : 'relation_mismatch'] }]);
    expect(read.mock.calls.length).toBe(phase === 'tick_relation' ? 1 : 0);
    expect(f.store.eventCount()).toBe(0);
    expect(f.store.get<{ count: number }>('SELECT count(*) AS count FROM session_bindings WHERE task_id=?', [f.id])?.count).toBe(1);
  }
);
