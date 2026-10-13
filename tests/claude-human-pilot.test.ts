import { bundledPriceCatalog, compilePriceBasis } from '../src/price-catalog.js';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createLocalWebDomain } from '../src/local-web-domain.js';
import { claudeProjectDirName } from '../src/session-binding-claude.js';
import { localWebFixture } from './helpers/local-web-fixture.js';
import { Deletion } from '../src/deletion.js';
import { assignTask } from '../src/allocation.js';
import { beginAssignedWorkflow, workflowStatus } from '../src/task-workflow.js';
import { invalidateCompatibility, resolveSourceCompatibility } from '../src/source-compatibility.js';

// Native-shaped synthetic data only. No Claude binary or user source is accessed.
test.each(['2.1.293', '2.1.294', '2.1.296'])('Claude %s human UI pilot connects once, retains own family usage and resumes an old live binding', async productVersion => {
  const f = localWebFixture('claude-ordinary-human-pilot', { product: 'claude_code', productVersion, priceTable: compilePriceBasis(bundledPriceCatalog()).table });
  const receipts = join(f.root, 'receipts'); const projects = join(f.root, 'claude-projects');
  const sources = join(projects, claudeProjectDirName(f.project));
  mkdirSync(sources, { recursive: true }); mkdirSync(join(receipts, 'connect'), { recursive: true, mode: 0o700 });
  f.profile.session_binding = { product: 'claude_code', receipt_directory: receipts, claude_projects_directory: projects };
  let domain = f.create();
  try {
    const { id } = await domain.createTask({ name: 'Synthetic Claude human pilot', project_id: 'project-1', setup_id: f.profile.id }) as { id: string };
    await domain.close?.();
    const open = (observe: boolean) => createLocalWebDomain({ store: f.store, metadataFile: f.metadataFile, profiles: [f.profile], nativePilot: { taskId: id, observe, untilExplicitStop: true } });
    domain = open(false); await domain.taskAction(id, 'apply', {});
    expect(domain.task(id)).toMatchObject({ binding: { support: 'native_pilot_preparation_only', roots: 0 } });
    await expect(domain.taskAction(id, 'session-connect', { product: 'claude_code', receipt: randomUUID() })).rejects.toThrow('binding_source_unqualified');
    await domain.close?.(); domain = open(true);
    const sid = randomUUID(); const source = join(sources, `${sid}.jsonl`); const receipt = randomUUID();
    const now = () => new Date().toISOString();
    writeFileSync(source, JSON.stringify({ type: 'user', sessionId: sid, version: productVersion, timestamp: now() }) + '\n', { mode: 0o600 });
    const receiptPath = join(receipts, 'connect', `${receipt}.json`);
    const proof = { schema_version: 1, kind: 'connect', receipt_id: receipt, session_id: sid, agent_id: null, agent_type: 'custom-parent', transcript_path: source, agent_transcript_path: null, cwd: f.project, claude_pid: process.pid, uid: process.getuid?.() ?? null, recorded_at: now() };
    writeFileSync(receiptPath, JSON.stringify(proof), { mode: 0o600 });
    await domain.taskAction(id, 'session-connect', { product: 'claude_code', receipt });
    const usage = (path = source, agent?: string) => {
      appendFileSync(path, JSON.stringify({ type: 'assistant', sessionId: sid, version: productVersion, timestamp: now(), requestId: randomUUID(), ...(agent ? { agentId: agent, isSidechain: true } : {}), message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 3, cache_creation_input_tokens: 2, output_tokens: 4 } } }) + '\n');
      appendFileSync(path, JSON.stringify({ type: 'user', sessionId: sid, version: productVersion, timestamp: now(), ...(agent ? { agentId: agent, isSidechain: true } : {}) }) + '\n');
    };
    const children = ['one', 'two'].map(agent => {
      const path = join(sources, sid, 'subagents', `agent-${agent}.jsonl`);
      mkdirSync(join(sources, sid, 'subagents'), { recursive: true });
      writeFileSync(path, JSON.stringify({ type: 'user', sessionId: sid, agentId: agent, isSidechain: true, version: productVersion, timestamp: now() }) + '\n', { mode: 0o600 });
      const dir = join(receipts, 'sessions', sid, 'agents'); mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, `${agent}.subagent_start.json`), JSON.stringify({ ...proof, kind: 'subagent_start', receipt_id: randomUUID(), agent_id: agent, agent_type: `user-${agent}`, recorded_at: now() }), { mode: 0o600 });
      return { path, agent };
    });
    usage(); children.forEach(child => usage(child.path, child.agent));
    await expect.poll(() => ({ count: f.store.eventCount(), reason: domain.task(id).reason }), { timeout: 4000 }).toMatchObject({ count: 3, reason: null });
    expect(domain.task(id)).toMatchObject({ binding: { support: 'native_unverified_pilot', roots: 1, children: 2, requests: 3, complete_cost: null, inference: false, summary: { input_total: { value: 45 }, output_total: { value: 12 } } } });
    // The pinned v1 rates give (10*2 + 3*0.2 + 2*2.5 + 4*10)/1e6 per native request.
    // Candidate events retain visible reference prices, without becoming verified totals.
    expect(f.store.all<{product:string}>("SELECT json_extract(payload,'$.product') AS product FROM events").map(row=>row.product)).toEqual(['claude_code','claude_code','claude_code']);
    expect(domain.task(id)).toMatchObject({price:{partial_amount:null,legacy_unverified_partial_amount:'0.0001968'},binding:{summary:{partial_amount:null,legacy_unverified_partial_amount:'0.0001968',compatibility:{legacy_unverified_events:3}},sessions:expect.arrayContaining([expect.objectContaining({partial_amount:null,legacy_unverified_partial_amount:'0.0000656'})]) as unknown[]}});
    await domain.taskAction(id, 'pause', {}); usage(); expect(f.store.eventCount()).toBe(3);
    writeFileSync(receiptPath, JSON.stringify({ ...proof, recorded_at: new Date(Date.now() - 86400000).toISOString() }));
    await domain.close?.(); domain = open(true);
    await domain.taskAction(id, 'resume-binding', {}); expect(f.store.eventCount()).toBe(3);
    usage(); await expect.poll(() => f.store.eventCount(), { timeout: 4000 }).toBe(4);
    await domain.taskAction(id, 'session-connect', { product: 'claude_code', receipt });
    expect(f.store.eventCount()).toBe(4);
    await domain.taskAction(id, 'finish-success', {}); usage(); expect(f.store.eventCount()).toBe(4);
    expect(domain.task(id)).toMatchObject({ status: 'success', binding: { requests: 4 } });
    await domain.close?.(); domain = open(true);
    expect(domain.task(id)).toMatchObject({ status: 'success', binding: { requests: 4 } });
    const savedEvents = f.store.all('SELECT id,payload FROM events ORDER BY id');
    invalidateCompatibility(f.store, resolveSourceCompatibility('claude_code', productVersion, 'file')!, 'semantic_incompatibility');
    expect(domain.task(id)).toMatchObject({
      price: { partial_amount: null, legacy_unverified_partial_amount: null, compatibility: { invalidated_events: 4 } },
      binding: { summary: { partial_amount: null, legacy_unverified_partial_amount: null, compatibility: { invalidated_events: 4 } },
        sessions: expect.arrayContaining([expect.objectContaining({ partial_amount: null, legacy_unverified_partial_amount: null, compatibility: expect.objectContaining({ invalidated_events: 1 }) as unknown })]) as unknown[] },
    });
    expect(f.store.all('SELECT id,payload FROM events ORDER BY id')).toEqual(savedEvents);
  } finally { await domain.close?.(); f.cleanup(); }
}, 15000);

test.each(['source', 'process', 'revoked', 'deleted', 'expired-new'] as const)('Claude pilot rejects %s without collecting source usage', async fault => {
  const f = localWebFixture('claude-ordinary-human-pilot', { product: 'claude_code', productVersion: '2.1.293' });
  const receipts = join(f.root, 'receipts'); const projects = join(f.root, 'claude-projects');
  const sources = join(projects, claudeProjectDirName(f.project));
  mkdirSync(sources, { recursive: true }); mkdirSync(join(receipts, 'connect'), { recursive: true, mode: 0o700 });
  f.profile.session_binding = { product: 'claude_code', receipt_directory: receipts, claude_projects_directory: projects };
  let domain = f.create();
  try {
    const { id } = await domain.createTask({ name: 'Synthetic rejection', project_id: 'project-1', setup_id: f.profile.id }) as { id: string };
    await domain.close?.();
    domain = createLocalWebDomain({ store: f.store, metadataFile: f.metadataFile, profiles: [f.profile], nativePilot: { taskId: id, observe: true, untilExplicitStop: true } });
    await domain.taskAction(id, 'apply', {});
    const sid = randomUUID(); const source = join(sources, `${sid}.jsonl`); const receipt = randomUUID();
    const row = JSON.stringify({ type: 'user', sessionId: sid, version: '2.1.293', timestamp: new Date().toISOString() }) + '\n';
    writeFileSync(source, row, { mode: 0o600 });
    const path = join(receipts, 'connect', `${receipt}.json`);
    const proof = { schema_version: 1, kind: 'connect', receipt_id: receipt, session_id: sid, agent_id: null, agent_type: null, transcript_path: source, agent_transcript_path: null, cwd: f.project, claude_pid: process.pid, uid: process.getuid?.() ?? null, recorded_at: new Date(fault === 'expired-new' ? Date.now() - 86400000 : Date.now()).toISOString() };
    writeFileSync(path, JSON.stringify(proof), { mode: 0o600 });
    if (fault === 'expired-new') {
      await expect(domain.taskAction(id, 'session-connect', { product: 'claude_code', receipt })).rejects.toThrow('claude_receipt_expired');
    } else {
      await domain.taskAction(id, 'session-connect', { product: 'claude_code', receipt });
      await domain.taskAction(id, 'pause', {});
      if (fault === 'source') { renameSync(source, source + '.original'); writeFileSync(source, row, { mode: 0o600 }); }
      if (fault === 'process') writeFileSync(path, JSON.stringify({ ...proof, claude_pid: process.pid + 1000000 }));
      if (fault === 'revoked') await domain.taskAction(id, 'revoke-collection', {});
      if (fault === 'deleted') new Deletion(f.store).deleteTask(id);
      await expect(domain.taskAction(id, 'resume-binding', {})).rejects.toThrow();
    }
    expect(f.store.eventCount()).toBe(0);
  } finally { await domain.close?.(); f.cleanup(); }
});

test.each(['2.1.293', '2.1.294', '2.1.296'])('Claude %s pilot preparation does not admit direct native execution or real allocation', productVersion => {
  const f = localWebFixture('claude-ordinary-human-pilot', { product: 'claude_code', productVersion });
  try {
    expect(() => assignTask(f.store, f.input.assignment)).toThrow('real_experiment_disabled');
    expect(() => beginAssignedWorkflow(f.store, f.input, { model: null, effort: null })).toThrow('real_experiment_disabled');
    expect(workflowStatus(f.store, f.input.assignment.protocol_id)).toMatchObject({ native_execution: false, readiness: { real_allocation: false } });
  } finally { f.cleanup(); }
});


test('active Claude pilot stops when its own synthetic process exits', async () => {
  const f = localWebFixture('claude-ordinary-human-pilot', { product: 'claude_code', productVersion: '2.1.293' });
  const receipts = join(f.root, 'receipts'); const projects = join(f.root, 'claude-projects');
  const sources = join(projects, claudeProjectDirName(f.project));
  mkdirSync(sources, { recursive: true }); mkdirSync(join(receipts, 'connect'), { recursive: true, mode: 0o700 });
  f.profile.session_binding = { product: 'claude_code', receipt_directory: receipts, claude_projects_directory: projects };
  const fixtureProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: f.project, stdio: 'ignore' });
  await once(fixtureProcess, 'spawn');
  let domain = f.create();
  try {
    const { id } = await domain.createTask({ name: 'Synthetic active process fence', project_id: 'project-1', setup_id: f.profile.id }) as { id: string };
    await domain.close?.();
    domain = createLocalWebDomain({ store: f.store, metadataFile: f.metadataFile, profiles: [f.profile], nativePilot: { taskId: id, observe: true, untilExplicitStop: true } });
    await domain.taskAction(id, 'apply', {});
    const sid = randomUUID(); const source = join(sources, `${sid}.jsonl`); const receipt = randomUUID();
    const row = { type: 'user', sessionId: sid, version: '2.1.293', timestamp: new Date().toISOString() };
    writeFileSync(source, JSON.stringify(row) + '\n', { mode: 0o600 });
    writeFileSync(join(receipts, 'connect', `${receipt}.json`), JSON.stringify({ schema_version: 1, kind: 'connect', receipt_id: receipt, session_id: sid, agent_id: null, agent_type: null,
      transcript_path: source, agent_transcript_path: null, cwd: f.project, claude_pid: fixtureProcess.pid, uid: process.getuid?.() ?? null, recorded_at: row.timestamp }), { mode: 0o600 });
    await domain.taskAction(id, 'session-connect', { product: 'claude_code', receipt });
    const exited = once(fixtureProcess, 'exit'); fixtureProcess.kill('SIGTERM'); await exited;
    appendFileSync(source, JSON.stringify({ ...row, type: 'assistant', requestId: randomUUID(), message: { model: 'user-choice', usage: { input_tokens: 10, output_tokens: 4 } } }) + '\n' + JSON.stringify(row) + '\n');
    await expect.poll(() => domain.task(id).state, { timeout: 4000 }).toBe('paused');
    expect(domain.task(id).reason).toBe('claude_process_absent'); expect(f.store.eventCount()).toBe(0);
  } finally { if (fixtureProcess.exitCode === null && fixtureProcess.signalCode === null) { const exited = once(fixtureProcess, 'exit'); fixtureProcess.kill('SIGTERM'); await exited; } await domain.close?.(); f.cleanup(); }
});


test.each(['2.1.292', '2.1.295', '2.2.0', '2.1.294-rc.1'])('Claude human UI preparation rejects non-candidate version %s', async productVersion => {
  const f = localWebFixture('claude-ordinary-human-pilot', { product: 'claude_code', productVersion });
  const domain = f.create();
  try {
    expect(() => domain.createTask({ name: 'Synthetic unsupported ordinary version', project_id: 'project-1', setup_id: f.profile.id })).toThrow('external_source_unsupported');
    expect(f.store.eventCount()).toBe(0);
  } finally { await domain.close?.(); f.cleanup(); }
});
