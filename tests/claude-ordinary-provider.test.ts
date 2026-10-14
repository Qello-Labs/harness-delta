import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeBindingAdmission } from '../src/claude-binding-admission.js';
import { claudeProjectDirName, ClaudeSessionBindingProvider } from '../src/session-binding-claude.js';
import type { CandidateScope } from '../src/nested-candidate.js';
import type { ClaudeBindingOptions } from '../src/session-binding-claude.js';
import { Store } from '../src/store.js';
import { Lifecycle } from '../src/lifecycle.js';
import { createOrdinaryTask, saveOrdinaryProjectSettings } from '../src/ordinary-observation.js';
import { createOrdinarySessionBindingService } from '../src/ordinary-session-binding.js';

describe('ordinary Claude provider boundary', () => {
  let root: string, project: string, projects: string, receipts: string, native: string, source: string, receipt: string;
  let now: number;
  let reads: string[];
  const jsonLine = (input: unknown) => JSON.stringify(input) + '\n';
  const assistant = (requestId: string, extra: Record<string, unknown> = {}) => ({
    type: 'assistant', sessionId: native, version: '2.1.296', requestId,
    timestamp: new Date(now - 1000).toISOString(),
    message: { model: 'claude-opus-5-5', content: 'SYNTHETIC-PRIVATE-CONTENT',
      usage: { input_tokens: 11, cache_read_input_tokens: 7, cache_creation_input_tokens: 3, output_tokens: 5 } },
    ...extra,
  });
  const makeProvider = (options: Partial<ClaudeBindingOptions> = {}) => new ClaudeSessionBindingProvider({
    projectRoot: project, claudeProjectsDir: projects, receiptDir: receipts,
    ordinaryAdmission: true, now: () => now, quiescenceMs: 0,
    readProcessIdentity: () => 'synthetic-process-start',
    readProcessBinary: () => ({
      productVersion: claudeBindingAdmission.productVersion, sha256: claudeBindingAdmission.binarySha256,
    }),
    authorizeSource: metadata => { reads.push(metadata.sourceRef); },
    ...options,
  });
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-ordinary-provider-')));
    project = join(root, 'project'); projects = join(root, 'projects'); receipts = join(root, 'receipts');
    now = Date.now(); reads = []; native = randomUUID(); receipt = randomUUID();
    for (const path of [project, projects, receipts, join(receipts, 'connect')])
      mkdirSync(path, { recursive: true, mode: 0o700 });
    const directory = join(projects, claudeProjectDirName(project));
    mkdirSync(directory, { mode: 0o700 }); source = join(directory, `${native}.jsonl`);
    writeFileSync(source, jsonLine({
      type: 'user', sessionId: native, version: '2.1.296',
      timestamp: new Date(now - 2000).toISOString(), message: 'SYNTHETIC-PRIVATE-CONTENT',
    }) + jsonLine(assistant('prior')), { mode: 0o600 });
    writeFileSync(join(receipts, 'connect', `${receipt}.json`), JSON.stringify({
      schema_version: 1, kind: 'connect', receipt_id: receipt, session_id: native,
      agent_id: null, agent_type: null, transcript_path: source, agent_transcript_path: null,
      cwd: project, claude_pid: process.pid, recorded_at: new Date(now).toISOString(),
      uid: process.getuid?.() ?? null,
    }), { mode: 0o600 });
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('inspects current receipt and pinned image metadata without a transcript body read', async () => {
    const proof = await makeProvider().inspectCurrent({ receipt });
    expect(proof).toMatchObject({
      receipt, nativeSessionId: native, agentId: null, cwd: project,
      sourceRef: source, productVersion: '2.1.296',
    });
    expect(reads).toEqual([]);
    expect(JSON.stringify(proof)).not.toContain('SYNTHETIC-PRIVATE-CONTENT');
  });

  it('rejects an unqualified native image before any transcript body read', async () => {
    const provider = makeProvider({ readProcessBinary: () => ({ productVersion: '2.1.294', sha256: 'a'.repeat(64) }) });
    await expect(provider.inspectCurrent({ receipt })).rejects.toThrow('claude_binary_unqualified');
    await expect(provider.resolveCurrent({ receipt })).rejects.toThrow('claude_binary_unqualified');
    expect(reads).toEqual([]);
  });

  it('preserves native identities while using task-scoped measurement mappings for usage', async () => {
    const provider = makeProvider();
    const parent = await provider.resolveCurrent({ receipt });
    const measurementRoot = randomUUID();
    const scope: CandidateScope = {
      taskId: 'ordinary-task', projectId: 'ordinary-project', allowedRootTurnIds: ['binding-observation'],
      sessions: [{ sessionId: measurementRoot, rootSessionId: measurementRoot, parentSessionId: null,
        sourceId: native, product: 'claude_code', nativeSessionId: native,
        agentId: null, processId: parent.nativeMapping?.processId ?? null }],
    };
    const excluded = new Set<string>();
    const baselineLedger = { has: (id: string) => excluded.has(id), add: (id: string) => { excluded.add(id); } };
    const baseline = await provider.readUsage(parent, null, scope, { baseline: true, baselineLedger });
    appendFileSync(source, jsonLine(assistant('future')) + jsonLine({
      type: 'user', sessionId: native, timestamp: new Date(now).toISOString(),
    }));
    const batch = await provider.readUsage(parent, baseline.cursor, scope, { baseline: false, baselineLedger });
    expect(batch.records).toHaveLength(1);
    expect(batch.records[0]).toMatchObject({
      sessionId: native, requestId: 'future', payload: { input_total: { value: 21 }, output_total: { value: 5 } },
    });
    expect(excluded.has('prior')).toBe(true);
    expect(JSON.stringify(batch)).not.toContain('SYNTHETIC-PRIVATE-CONTENT');
  });

  it('skips old descendants before their bodies are opened on a new segment', async () => {
    const child = 'old-member';
    const childDirectory = join(projects, claudeProjectDirName(project), native, 'subagents');
    mkdirSync(childDirectory, { recursive: true, mode: 0o700 });
    const childSource = join(childDirectory, `agent-${child}.jsonl`);
    writeFileSync(childSource, jsonLine(assistant('old-child', { agentId: child, isSidechain: true })), { mode: 0o600 });
    const agents = join(receipts, 'sessions', native, 'agents');
    mkdirSync(agents, { recursive: true, mode: 0o700 });
    writeFileSync(join(agents, `${child}.subagent_start.json`), JSON.stringify({
      schema_version: 1, kind: 'subagent_start', receipt_id: randomUUID(), session_id: native,
      agent_id: child, agent_type: 'synthetic', transcript_path: source, agent_transcript_path: null,
      cwd: project, claude_pid: process.pid, recorded_at: new Date(now - 1000).toISOString(),
      uid: process.getuid?.() ?? null,
    }), { mode: 0o600 });
    const provider = makeProvider({ memberEligible: () => false });
    const parent = await provider.resolveCurrent({ receipt });
    reads = [];
    const family = await provider.discoverChildren(parent);
    expect(family.children).toEqual([]);
    expect(family.gaps).toContain('binding_unobserved_context');
    expect(reads).not.toContain(childSource);
  });

  it('retains the default candidate refusal without ordinary authority', async () => {
    const provider = makeProvider({ ordinaryAdmission: false });
    await expect(provider.resolveCurrent({ receipt })).rejects.toThrow('claude_source_version_unsupported');
    expect(provider.capabilities().productionSupported).toBe(false);
  });

  it('authorizes a member file that appears between the metadata pass and its first own-row read', async () => {
    const childDirectory = join(projects, claudeProjectDirName(project), native, 'subagents');
    const agents = join(receipts, 'sessions', native, 'agents');
    mkdirSync(childDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(agents, { recursive: true, mode: 0o700 });
    const lateSource = join(childDirectory, 'agent-a-late.jsonl');
    const writeMember = (agentId: string) => writeFileSync(join(childDirectory, `agent-${agentId}.jsonl`),
      jsonLine(assistant(`request-${agentId}`, { agentId, isSidechain: true })), { mode: 0o600 });
    for (const agentId of ['a-late', 'b-present']) {
      writeFileSync(join(agents, `${agentId}.subagent_start.json`), JSON.stringify({
        schema_version: 1, kind: 'subagent_start', receipt_id: randomUUID(), session_id: native,
        agent_id: agentId, agent_type: 'synthetic', transcript_path: source, agent_transcript_path: null,
        cwd: project, claude_pid: process.pid, recorded_at: new Date(now).toISOString(),
        uid: process.getuid?.() ?? null,
      }), { mode: 0o600 });
    }
    writeMember('b-present');
    const permitted = new Set<string>();
    const provider = makeProvider({
      memberEligible: metadata => {
        permitted.add(metadata.sourceRef);
        if (metadata.agentId === 'b-present' && !permitted.has(lateSource)) writeMember('a-late');
        return true;
      },
      authorizeSource: metadata => {
        if (metadata.agentId !== null && !permitted.has(metadata.sourceRef))
          throw new Error('binding_member_ineligible');
        reads.push(metadata.sourceRef);
      },
    });
    const parent = await provider.resolveCurrent({ receipt });
    const family = await provider.discoverChildren(parent);
    expect(family.children).toHaveLength(2);
    expect(family.gaps).toEqual([]);
    expect(reads).toContain(lateSource);
  });

  it.each(['receipt-less', 'missing-old-start', 'missing-expired-start'] as const)(
    'keeps an already-running root observable with an excluded %s member', async condition => {
    const childDirectory = join(projects, claudeProjectDirName(project), native, 'subagents');
    mkdirSync(childDirectory, { recursive: true, mode: 0o700 });
    const childSource = join(childDirectory, 'agent-pre-connect.jsonl');
    if (condition === 'receipt-less') {
      writeFileSync(childSource, jsonLine(assistant('old-member', {
        agentId: 'pre-connect', isSidechain: true,
      })), { mode: 0o600 });
    } else {
      const agents = join(receipts, 'sessions', native, 'agents');
      mkdirSync(agents, { recursive: true, mode: 0o700 });
      writeFileSync(join(agents, 'pre-connect.subagent_start.json'), JSON.stringify({
        schema_version: 1, kind: 'subagent_start', receipt_id: randomUUID(), session_id: native,
        agent_id: 'pre-connect', agent_type: 'synthetic', transcript_path: source, agent_transcript_path: null,
        cwd: project, claude_pid: process.pid,
        recorded_at: new Date(condition === 'missing-expired-start' ? now + 1100 : now - 400000).toISOString(),
        uid: process.getuid?.() ?? null,
      }), { mode: 0o600 });
    }
    now += 1000;
    const store = new Store(':memory:');
    const clock = () => new Date(now).toISOString();
    new Lifecycle(store, clock).registerProject('ordinary-project', project);
    saveOrdinaryProjectSettings(store, 'ordinary-project', {
      schema_version: 1, product: 'claude_code', product_version: '2.1.296',
      receipt_directory: receipts, claude_projects_directory: projects,
    }, clock);
    const taskId = createOrdinaryTask(store, {
      project_id: 'ordinary-project', criterion_ids: ['accepted'],
    }, clock);
    const provider = makeProvider({
      authorizeSource: metadata => { reads.push(metadata.sourceRef); service.assertSource(taskId, metadata); },
      memberEligible: metadata => service.memberEligible(taskId, metadata),
    });
    const service = createOrdinarySessionBindingService({
      store, clock, providersForTask: () => [provider], syntheticProviderForTask: () => true,
    });
    try {
      await service.connect(taskId, 'claude_code', { receipt });
      reads = [];
      now += condition === 'missing-expired-start' ? 400000 : 100;
      await service.tick(taskId);
      expect(service.status(taskId)).toMatchObject({ state: 'observing', roots: 1, children: 0 });
      expect(service.status(taskId).gaps).toContain('binding_unobserved_context');
      expect(reads).not.toContain(childSource);
      const count = store.all('SELECT * FROM observation_gaps WHERE task_id=?', [taskId]).length;
      for (let index = 0; index < 5; index++) { now += 100; await service.tick(taskId); }
      expect(store.all('SELECT * FROM observation_gaps WHERE task_id=?', [taskId])).toHaveLength(count);
      expect(reads).not.toContain(childSource);
    } finally { await service.close(); store.close(); }
  });
});
