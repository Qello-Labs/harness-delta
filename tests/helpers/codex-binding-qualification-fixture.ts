import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { prepareCodexSessionBindingQualification } from '../../src/codex-session-binding-qualification.js';
import { OwnedCliInvocation } from '../../src/owned-cli-invocation.js';
import { CodexSessionBindingProvider } from '../../src/session-binding-codex.js';
import { createSessionBindingService } from '../../src/session-binding-service.js';
import { issueCodexBindingLease } from '../../src/session-binding-qualification-lease.js';
import { Store } from '../../src/store.js';

export async function prepareBindingQualificationFixture(productVersion = '0.162.1', route: 'qualification' | 'ordinary_admission' = 'qualification') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'binding-version-synthetic-')));
  const home = join(root, 'home'); mkdirSync(home); mkdirSync(join(home, 'sessions'));
  const script = join(root, 'fixture.mjs'); writeFileSync(script, 'process.exit(0);\n');
  const fixture = { script, durationMs: 5000 };
  const result = await prepareCodexSessionBindingQualification(join(root, 'attempt'), {
    binary: realpathSync(process.execPath), codexHome: home, productVersion, route,
  }, fixture);
  return { ...result, root, home, fixture, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export async function leaseBindingQualificationFixture(p: Awaited<ReturnType<typeof prepareBindingQualificationFixture>>) {
  const store = new Store(p.intent.database);
  const realNow = Date.now.bind(Date);
  let now = realNow();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const deadline = now + 120000;
  store.execute('UPDATE binding_qualification SET reserved=1,deadline=?', [deadline]);
  const owner = new OwnedCliInvocation({
    command: realpathSync(process.execPath), args: [], cwd: p.root, durationMs: 120000, stdio: 'ignore',
  });
  vi.spyOn(owner, 'hasSpawned').mockReturnValue(true);
  vi.spyOn(owner, 'isAlive').mockReturnValue(true);
  const lease = issueCodexBindingLease(store, p.intent.task_id, owner, deadline);
  const root = randomUUID(); const children = [randomUUID(), randomUUID()] as const;
  const source = (id: string) => join(p.home, 'sessions', `${id}.jsonl`);
  const row = (type: string, payload: unknown) => JSON.stringify({ timestamp: new Date(now).toISOString(), type, payload }) + '\n';
  const member = (id: string, parent: string | null) => {
    writeFileSync(source(id), row('session_meta', {
      id, session_id: root, cwd: p.intent.project, cli_version: '0.162.1', parent_thread_id: parent,
      source: parent ? { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1 } } } : 'cli',
    }));
    const output = JSON.parse(execFileSync(p.intent.wrapper, [], { encoding: 'utf8', input: JSON.stringify({
      hook_event_name: parent ? 'SubagentStart' : 'SessionStart', session_id: root, agent_id: parent ? id : undefined,
      turn_id: parent ? `${id}-turn` : undefined, source: parent ? undefined : 'startup', cwd: p.intent.project, transcript_path: source(id),
    }) })) as { hookSpecificOutput: { additionalContext: string } };
    const receipt = /[a-f0-9-]{36}/.exec(output.hookSpecificOutput.additionalContext)?.[0];
    if (!receipt) throw new Error('synthetic_receipt_missing');
    return receipt;
  };
  const receipt = member(root, null);
  const provider = new CodexSessionBindingProvider({
    receiptDirectory: p.intent.receipts, sourceRoots: [join(p.home, 'sessions')], projectRoot: p.intent.project,
    productVersion: '0.162.1', ordinaryFamilyQualification: true, maxDepth: 1, maxFamilyMembers: 3,
    clock: () => new Date(now).toISOString(),
  });
  const identity = await provider.resolveCurrent({ receipt });
  const service = createSessionBindingService({
    store, providers: [provider], setupFor: () => p.intent.profile.setup, qualificationLease: lease,
    clock: () => new Date(now).toISOString(),
  });
  await service.connect(p.intent.task_id, 'codex', { receipt });
  for (const child of children) member(child, root);
  now = Math.max(now + 1, realNow());
  const requestIds = new Map<string, string>([root, ...children].map(id => [id, randomUUID()]));
  const usage = (id: string) => row('token_usage_record', {
    thread_id: id, session_id: root, turn_id: `${id}-turn`, root_turn_id: `${root}-turn`, response_id: requestIds.get(id),
    usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 120 },
  });
  for (const id of [root, ...children]) {
    appendFileSync(source(id), row('turn_context', {
      cwd: p.intent.project, turn_id: `${id}-turn`, root_turn_id: `${root}-turn`, model: 'gpt-6.1-sol', effort: 'high',
    }) + usage(id) + row('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 999999 } } }));
    if (id !== root) appendFileSync(source(id), usage(root));
  }
  return { ...p, store, provider, service, lease, identity, rootId: root, children, source, row, usage };
}
