import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { createLocalWebDomain } from '../src/web/local-web-domain.js';
import { ClaudeSessionBindingProvider, claudeProjectDirName } from '../src/session-binding-claude.js';
import { localWebFixture } from './helpers/local-web-fixture.js';

// Synthetic files and the test runner's process metadata only; no native CLI or user records.
// Losing provider causes before shared mapping makes these distinct cases indistinguishable.
test.each([
  ['missing_source', ['child_source_missing'], 'ready'],
  ['mismatched_receipt', ['child_receipt_mismatch', 'child_relation_unverified'], 'ready'],
  ['unowned_rows', ['ownership_unverified'], 'ready'],
  ['unreceipted_file', ['child_relation_unverified'], 'ready'],
  ['predates_root', ['pilot_member_predates_root'], 'ready'],
  ['missing_source', ['child_source_missing'], 'unsafe_file'],
  ['missing_source', ['child_source_missing'], 'full_sink'],
  ['missing_source', ['child_source_missing'], 'locked']
] as const)('retains %s rejection with %s and %s sink without admitting a child', async (fault, reason, sinkMode) => {
  const f = localWebFixture('claude-ordinary-human-pilot', { product: 'claude_code', productVersion: '2.1.294' });
  const receipts = join(f.root, 'receipts');
  const projects = join(f.root, 'claude-projects');
  const sources = join(projects, claudeProjectDirName(f.project));
  mkdirSync(sources, { recursive: true });
  mkdirSync(join(receipts, 'connect'), { recursive: true, mode: 0o700 });
  f.profile.session_binding = { product: 'claude_code', receipt_directory: receipts, claude_projects_directory: projects };
  let domain = f.create();
  const usage = vi.spyOn(ClaudeSessionBindingProvider.prototype, 'readUsage');
  const discover = vi.spyOn(ClaudeSessionBindingProvider.prototype, 'discoverChildren');
  try {
    const { id } = (await domain.createTask({ name: 'Synthetic fixed rejection', project_id: 'project-1', setup_id: f.profile.id })) as { id: string };
    await domain.close?.();
    domain = createLocalWebDomain({
      store: f.store,
      metadataFile: f.metadataFile,
      profiles: [f.profile],
      nativePilot: { taskId: id, observe: true, untilExplicitStop: true }
    });
    await domain.taskAction(id, 'apply', {});
    const audit = f.metadataFile + '.family-diagnostics.jsonl';
    expect(existsSync(audit)).toBe(false); // Registered, unlinked preparation is not a diagnostic attempt.
    const sid = randomUUID();
    const source = join(sources, sid + '.jsonl');
    const receipt = randomUUID();
    const at = new Date().toISOString();
    writeFileSync(
      source,
      JSON.stringify({
        type: 'user',
        sessionId: sid,
        version: '2.1.294',
        timestamp: fault === 'predates_root' ? new Date(Date.now() + 2000).toISOString() : at
      }) + '\n',
      { mode: 0o600 }
    );
    const proof = {
      schema_version: 1,
      kind: 'connect',
      receipt_id: receipt,
      session_id: sid,
      agent_id: null,
      agent_type: null,
      transcript_path: source,
      agent_transcript_path: null,
      cwd: f.project,
      claude_pid: process.pid,
      uid: process.getuid?.() ?? null,
      recorded_at: at
    };
    writeFileSync(join(receipts, 'connect', receipt + '.json'), JSON.stringify(proof), { mode: 0o600 });
    await domain.taskAction(id, 'session-connect', { product: 'claude_code', receipt });
    expect(domain.task(id).state).toBe('active');
    expect(existsSync(audit)).toBe(false);
    const usageBefore = usage.mock.calls.length;
    const discoveriesBefore = discover.mock.calls.length;
    let sinkBefore: string | undefined;
    if (sinkMode === 'unsafe_file') {
      sinkBefore = '';
      writeFileSync(audit, sinkBefore, { mode: 0o600 });
      chmodSync(audit, 0o644);
    }
    if (sinkMode === 'full_sink') {
      sinkBefore = Array.from({ length: 64 }, () => JSON.stringify({ schema_version: 1, phase: 'tick_discovery', reason_codes: [] })).join('\n') + '\n';
      writeFileSync(audit, sinkBefore, { mode: 0o600 });
    }
    if (sinkMode === 'locked') writeFileSync(audit + '.lock', '', { mode: 0o600 });
    const agent = 'synthetic-member';
    const agents = join(receipts, 'sessions', sid, 'agents');
    mkdirSync(agents, { recursive: true, mode: 0o700 });
    const childDir = join(sources, sid, 'subagents');
    mkdirSync(childDir, { recursive: true });
    const childPath = join(childDir, 'agent-' + agent + '.jsonl');
    if (fault !== 'missing_source')
      writeFileSync(
        childPath,
        JSON.stringify({
          type: 'user',
          sessionId: fault === 'unowned_rows' ? randomUUID() : sid,
          agentId: agent,
          isSidechain: true,
          version: '2.1.294',
          timestamp: at,
          message: { content: 'SYNTHETIC-CONTENT-MUST-NOT-LEAK' }
        }) + '\n',
        { mode: 0o600 }
      );
    if (fault !== 'unreceipted_file')
      writeFileSync(
        join(agents, agent + '.subagent_stop.json'),
        JSON.stringify({
          ...proof,
          kind: 'subagent_stop',
          receipt_id: randomUUID(),
          agent_id: agent,
          agent_transcript_path: childPath,
          transcript_path: fault === 'mismatched_receipt' ? source + '.wrong' : source
        }),
        { mode: 0o600 }
      );
    await expect.poll(() => domain.task(id).state, { timeout: 4000 }).toBe('paused');
    expect(domain.task(id).reason).toBe('binding_pilot_family_scope');
    expect(f.store.eventCount()).toBe(0);
    expect(f.store.get<{ count: number }>('SELECT count(*) AS count FROM session_bindings WHERE task_id=?', [id])?.count).toBe(1);
    expect(usage.mock.calls.length).toBe(usageBefore);
    expect(discover.mock.calls.length).toBe(discoveriesBefore + 1);
    if (sinkMode === 'locked') {
      expect(existsSync(audit)).toBe(false);
      return;
    }
    if (sinkBefore !== undefined) {
      expect(readFileSync(audit, 'utf8')).toBe(sinkBefore);
      return;
    }
    expect(existsSync(audit)).toBe(true);
    const text = readFileSync(audit, 'utf8');
    expect(
      text
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as unknown)
    ).toEqual([{ schema_version: 1, phase: 'tick_discovery', reason_codes: reason }]);
    for (const secret of [source, sid, f.project, 'SYNTHETIC-CONTENT-MUST-NOT-LEAK']) expect(text).not.toContain(secret);
    for (const code of reason) expect(JSON.stringify(domain.task(id))).not.toContain(code);
  } finally {
    await domain.close?.();
    usage.mockRestore();
    discover.mockRestore();
    f.cleanup();
  }
});
