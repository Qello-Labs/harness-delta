import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { codexBindingAdmission } from '../src/codex-binding-admission.js';
import { ExternalTaskSetupSchema, prepareExternalTask } from '../src/external-session-service.js';
import { CodexSessionBindingProvider } from '../src/session-binding-codex.js';
import { createSessionBindingService } from '../src/session-binding-service.js';
import { resolveSourceCompatibility } from '../src/source-compatibility.js';
import { localWebFixture } from './helpers/local-web-fixture.js';
import { localWebSupport } from '../src/local-web-domain.js';
import { beginAssignedWorkflow, workflowStatus } from '../src/task-workflow.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function fixture(version = '0.162.1', profileId: string = codexBindingAdmission.profileId, staleChild = false, initialModel: string | null = 'gpt-6.1-sol') {
  const f = localWebFixture(profileId, { product: 'codex', productVersion: version });
  cleanups.push(f.cleanup);
  const setup = ExternalTaskSetupSchema.parse({
    workflow: { ...f.input, assignment: { ...f.input.assignment,
      metadata: { ...f.input.assignment.metadata, initial_model: initialModel } } },
    runtime: { model: 'gpt-6.1-sol', effort: 'high' },
    preparation: { schema_version: 1, common_artifacts: [], common_manifest_hash: null, allowed_preimage_hashes: [] },
  });
  prepareExternalTask(f.store, setup, true);
  const journal = join(f.root, 'ordinary-receipts');
  mkdirSync(journal, { mode: 0o700 });
  let now = new Date(Date.now() + 1000).toISOString();
  const provider = new CodexSessionBindingProvider({
    receiptDirectory: journal, sourceRoots: [join(f.home, 'sessions')], projectRoot: f.project,
    productVersion: version, ordinaryFamilyAdmission: true, maxDepth: 1, maxFamilyMembers: 3, clock: () => now,
  });
  const service = createSessionBindingService({ store: f.store, providers: [provider], setupFor: () => setup, clock: () => now });
  const earlierChild = staleChild ? f.newRoot() : undefined;
  const root = f.newRoot();
  const turn = randomUUID();
  function member(parent: string | null = null, existing?: ReturnType<typeof f.newRoot>) {
    const source = existing ?? (parent === null ? root : f.newRoot());
    writeFileSync(source.path, JSON.stringify({ type: 'session_meta', payload: {
      id: source.id, session_id: root.id, parent_thread_id: parent, cwd: f.project, cli_version: version,
      source: parent === null ? 'cli' : { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1 } } },
    } }) + '\n');
    const output: unknown = JSON.parse(execFileSync(process.execPath, [resolve('scripts/session-binding-codex-hook.mjs'),
      '--receipt-directory', journal, '--source-root', join(f.home, 'sessions'), '--product-version', version],
    { input: JSON.stringify({ hook_event_name: parent === null ? 'SessionStart' : 'SubagentStart',
      session_id: root.id, ...(parent === null ? { source: 'startup' } : { agent_id: source.id, turn_id: turn }),
      cwd: f.project, transcript_path: source.path }), encoding: 'utf8' }));
    const parsed = z.object({ hookSpecificOutput: z.object({ additionalContext: z.string() }) }).parse(output);
    const receipt = /[a-f0-9-]{36}/.exec(parsed.hookSpecificOutput.additionalContext)?.[0];
    if (!receipt) throw new Error('invalid_fixture_receipt');
    now = new Date(Date.parse(now) + 1).toISOString();
    const path = join(journal, `${receipt}.json`);
    const metadata = z.record(z.string(), z.unknown()).parse(JSON.parse(readFileSync(path, 'utf8')));
    writeFileSync(path, JSON.stringify({ ...metadata, createdAt: now }));
    return { ...source, receipt, parent };
  }
  function usage(source: ReturnType<typeof member>, model = 'gpt-6.1-sol', effort: string | null = 'high', contextAt?: string) {
    now = new Date(Date.parse(now) + 1).toISOString();
    const response = randomUUID();
    const context = { type: 'turn_context', timestamp: contextAt ?? now, payload: {
      cwd: f.project, turn_id: source.parent === null ? turn : source.id,
      root_turn_id: turn, model, effort,
    } };
    const record = { type: 'token_usage_record', timestamp: now, payload: {
      thread_id: source.id, session_id: root.id, turn_id: source.parent === null ? turn : source.id,
      root_turn_id: turn, response_id: response,
      usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 120 },
    } };
    appendFileSync(source.path, JSON.stringify(context) + '\n' + JSON.stringify(record) + '\n');
    return response;
  }
  return { ...f, journal, setup, provider, service, member, usage, earlierChild, refresh: () => { now = new Date(Date.parse(now) + 1).toISOString(); },
    id: setup.workflow.assignment.task_id };
}

test('ordinary native provider collects one root and two fresh direct children without pilot or lease', async () => {
  const f = fixture();
  const root = f.member();
  f.refresh();
  expect(await f.service.connect(f.id, 'codex', { receipt: root.receipt })).toMatchObject({ status: 'connected', roots: 1 });
  const a = f.member(root.id);
  const b = f.member(root.id);
  f.usage(root); f.usage(a); f.usage(b); f.refresh();

  await f.service.tick(f.id);
  await f.service.tick(f.id);

  expect(f.service.status(f.id)).toMatchObject({ roots: 1, children: 2, requests: 3, complete_cost: null, inference: false });
  const events = f.store.all<{ payload: string }>('SELECT payload FROM events WHERE task_id=?', [f.id]);
  expect(events).toHaveLength(3);
  expect(events.every(event => z.object({ source_compatibility: z.object({
    state: z.literal('verified'), source: z.literal('codex_binding'), product_version: z.literal('0.162.1'),
  }) }).safeParse(JSON.parse(event.payload)).success)).toBe(true);
});

test.each([['another-model', 'high'], ['claude-opus-5-5', 'high'], ['not-gpt-6.1-sol', 'low']])(
  'ordinary profile refuses unsupported runtime %s/%s before storing its request', async (model, effort) => {
    const f = fixture(); const root = f.member(); f.refresh();
    await f.service.connect(f.id, 'codex', { receipt: root.receipt });
    f.usage(root, model, effort); f.refresh();

    await expect(f.service.tick(f.id)).rejects.toThrow('binding_runtime_unsupported');
    expect(f.store.eventCount()).toBe(0);
  });

test.each([null, 'gpt-5.4', 'GPT-4o', 'gpt-oss-120b'] as const)(
  'ordinary connection accepts declared model %s without replacing task metadata', async initialModel => {
    const f = fixture('0.162.1', codexBindingAdmission.profileId, false, initialModel);
    const root = f.member(); f.refresh();
    const before = f.store.get('SELECT metadata FROM tasks WHERE id=?', [f.id]);

    expect(f.service.sourceSupported(f.id, 'codex')).toBe(true);
    await expect(f.service.connect(f.id, 'codex', { receipt: root.receipt })).resolves.toMatchObject({ status: 'connected', roots: 1 });

    expect(f.store.get('SELECT metadata FROM tasks WHERE id=?', [f.id])).toEqual(before);
  });

test.each([
  ['gpt-6.1-sol', 'low'],
  ['gpt-5.4', 'medium'],
  ['gpt-6-astra', 'xhigh'],
  ['gpt-4o', null],
  ['gpt-oss-120b', 'minimal'],
  ['gpt-future-synthetic', 'high'],
] as const)('ordinary usage stores GPT model %s and effort %s as observed', async (model, effort) => {
  const f = fixture(); const root = f.member(); f.refresh();
  await f.service.connect(f.id, 'codex', { receipt: root.receipt });
  f.usage(root, model, effort); f.refresh();

  await f.service.tick(f.id);

  const events = f.store.all<{ payload: string }>('SELECT payload FROM events WHERE task_id=?', [f.id]);
  expect(events).toHaveLength(1);
  expect(JSON.parse(events[0]?.payload ?? 'null') as unknown).toMatchObject({
    model, source_compatibility: { state: 'verified', source: 'codex_binding' },
  });
  const runtime = f.store.get<{ payload: string }>('SELECT payload FROM runtime_evidence WHERE task_id=?', [f.id]);
  expect(JSON.parse(runtime?.payload ?? 'null') as unknown).toMatchObject({ model, effort });
  expect(f.service.status(f.id)).toMatchObject({ requests: 1, cost_coverage: 'partial', complete_cost: null });
  if (model === 'gpt-future-synthetic') expect(f.service.status(f.id).summary.unpriced_events).toBeGreaterThan(0);
});

test('ordinary profile rejects a third child before reading usage bodies', async () => {
  const f = fixture(); const root = f.member(); f.refresh();
  await f.service.connect(f.id, 'codex', { receipt: root.receipt });
  f.member(root.id); f.member(root.id); f.member(root.id); f.refresh();
  const read = vi.spyOn(f.provider, 'readUsage');

  await expect(f.service.tick(f.id)).rejects.toThrow('binding_pilot_family_scope');
  expect(read).not.toHaveBeenCalled();
});

test('ordinary profile cannot add a second root to its task', async () => {
  const f = fixture(); const root = f.member(); f.refresh();
  await f.service.connect(f.id, 'codex', { receipt: root.receipt });
  const other = f.newRoot();
  writeFileSync(other.path, JSON.stringify({ type: 'session_meta', payload: {
    id: other.id, session_id: other.id, cli_version: '0.162.1', cwd: f.project, source: 'cli',
  } }) + '\n');
  const receipt = randomUUID();
  const stat = statSync(other.path);
  writeFileSync(join(f.journal, `${receipt}.json`), JSON.stringify({
    schemaVersion: 1, receipt, productVersion: '0.162.1', event: 'SessionStart', sessionId: other.id,
    parentSessionId: null, turnId: null, sourceRef: other.path, sourceIdentity: `${stat.dev}:${stat.ino}`,
    cwd: f.project, createdAt: new Date().toISOString(),
  }), { mode: 0o600 });
  f.refresh();

  await expect(f.service.connect(f.id, 'codex', { receipt })).rejects.toThrow('binding_qualification_live_root_required');
  expect(f.service.status(f.id).roots).toBe(1);
});

test('new exact ordinary admission leaves file and launch estimates unverified', () => {
  expect(resolveSourceCompatibility('codex', '0.162.1', 'codex_binding')).toMatchObject({ state: 'verified' });
  expect(resolveSourceCompatibility('codex', '0.162.0', 'codex_binding')).toBeNull();
  expect(resolveSourceCompatibility('codex', '0.162.2', 'codex_binding')).toBeNull();
  expect(resolveSourceCompatibility('codex', '0.162.1', 'file')).toMatchObject({ state: 'compatibility_unverified' });
  expect(resolveSourceCompatibility('codex', '0.162.1', 'codex_workflow')).toMatchObject({ state: 'compatibility_unverified' });
});

test('ordinary admission preserves excluded old contexts instead of backfilling their late responses', async () => {
  const f = fixture(); const root = f.member(); f.refresh();
  await f.service.connect(f.id, 'codex', { receipt: root.receipt });
  f.usage(root, 'gpt-6.1-sol', 'high', '2000-01-01T00:00:00.000Z'); f.refresh();

  await f.service.tick(f.id);

  expect(f.store.eventCount()).toBe(0);
  expect(f.service.status(f.id).gaps).toContain('binding_unobserved_context');
});

test('ordinary root receipt before task registration is refused before usage reads', async () => {
  const f = fixture(); const root = f.member();
  const task = z.object({registered_at:z.string()}).parse(f.store.get('SELECT registered_at FROM tasks WHERE id=?',[f.id]));
  const path = join(f.journal, `${root.receipt}.json`);
  const receipt = z.record(z.string(),z.unknown()).parse(JSON.parse(readFileSync(path,'utf8')));
  writeFileSync(path,JSON.stringify({...receipt,createdAt:new Date(Date.parse(task.registered_at)-1).toISOString()}));
  const read = vi.spyOn(f.provider,'readUsage'); f.refresh();

  await expect(f.service.connect(f.id,'codex',{receipt:root.receipt})).rejects.toThrow('binding_admission_family_scope');

  expect(read).not.toHaveBeenCalled();
  expect(f.service.status(f.id).roots).toBe(0);
});

test('ordinary root source born before registration is refused even with a new receipt', async () => {
  const f = fixture(); const root = f.member();
  f.store.execute('UPDATE tasks SET registered_at=? WHERE id=?',[new Date(statSync(root.path).birthtimeMs+1).toISOString(),f.id]);
  const read = vi.spyOn(f.provider,'readUsage'); f.refresh();

  await expect(f.service.connect(f.id,'codex',{receipt:root.receipt})).rejects.toThrow('binding_admission_family_scope');

  expect(read).not.toHaveBeenCalled();
  expect(f.service.status(f.id).roots).toBe(0);
});

test('ordinary child receipt before its root is refused before child usage reads', async () => {
  const f = fixture(); const root = f.member(); f.refresh();
  await f.service.connect(f.id,'codex',{receipt:root.receipt});
  const child = f.member(root.id);
  const rootReceipt = z.object({createdAt:z.string()}).parse(JSON.parse(readFileSync(join(f.journal,`${root.receipt}.json`),'utf8')));
  const path = join(f.journal,`${child.receipt}.json`);
  const receipt = z.record(z.string(),z.unknown()).parse(JSON.parse(readFileSync(path,'utf8')));
  writeFileSync(path,JSON.stringify({...receipt,createdAt:new Date(Date.parse(rootReceipt.createdAt)-1).toISOString()}));
  const read = vi.spyOn(f.provider,'readUsage'); f.refresh();

  await expect(f.service.tick(f.id)).rejects.toThrow('binding_admission_family_scope');

  expect(read).not.toHaveBeenCalled();
  expect(f.service.status(f.id).children).toBe(0);
});

test('ordinary child source born before its root is refused despite a fresh child receipt', async () => {
  const f = fixture('0.162.1',codexBindingAdmission.profileId,true); const root = f.member(); f.refresh();
  await f.service.connect(f.id,'codex',{receipt:root.receipt});
  if(!f.earlierChild)throw new Error('missing_child_fixture');
  f.member(root.id,f.earlierChild);
  const read = vi.spyOn(f.provider,'readUsage'); f.refresh();

  await expect(f.service.tick(f.id)).rejects.toThrow('binding_admission_family_scope');

  expect(read).not.toHaveBeenCalled();
  expect(f.service.status(f.id).children).toBe(0);
});

test('ordinary binding evidence cannot start or qualify a tool-owned launch', () => {
  const f = localWebFixture(codexBindingAdmission.profileId,{product:'codex',productVersion:'0.162.1'});
  cleanups.push(f.cleanup);

  expect(()=>beginAssignedWorkflow(f.store,f.input,{model:'gpt-6.1-sol',effort:'high'})).toThrow('native_source_unqualified');
  expect(workflowStatus(f.store,f.input.assignment.protocol_id)).toMatchObject({native_execution:false});
  expect(f.store.all('SELECT * FROM comparison_assignments')).toHaveLength(0);
});

test('unsupported ordinary root source rejects the session without invalidating the version cohort', async () => {
  const f = fixture(); const root = f.member(); f.refresh();
  const header = z.object({type:z.string(),payload:z.record(z.string(),z.unknown())}).parse(JSON.parse(readFileSync(root.path,'utf8')));
  writeFileSync(root.path,JSON.stringify({...header,payload:{...header.payload,source:'exec'}})+'\n');
  const read = vi.spyOn(f.provider,'readUsage');

  await expect(f.service.connect(f.id,'codex',{receipt:root.receipt})).rejects.toThrow('binding_scope_mismatch');

  expect(read).not.toHaveBeenCalled();
  expect(f.store.all('SELECT * FROM source_compatibility_blocks')).toHaveLength(0);
});

test('ordinary source contract failure invalidates only binding provenance and blocks another body read', async () => {
  const f = fixture(); const root = f.member(); f.refresh();
  await f.service.connect(f.id, 'codex', { receipt: root.receipt });
  f.usage(root); f.refresh();
  await f.service.tick(f.id);
  appendFileSync(root.path, JSON.stringify({ timestamp: '2000-01-01T00:00:00.000Z',
    type: 'token_usage_record', payload: {} }) + '\n');
  f.refresh();
  await expect(f.service.tick(f.id)).rejects.toThrow('candidate_invalid_metadata');
  const read = vi.spyOn(f.provider, 'readUsage');

  await expect(f.service.tick(f.id)).rejects.toThrow('compatibility_invalidated');

  expect(read).not.toHaveBeenCalled();
  expect(f.store.all('SELECT product,product_version,source FROM source_compatibility_blocks')).toEqual([
    { product: 'codex', product_version: '0.162.1', source: 'codex_binding' },
  ]);
  expect(f.store.eventCount()).toBe(1);
  expect(()=>f.service.sourceSupported(f.id,'codex')).toThrow('compatibility_invalidated');
  expect(localWebSupport(f.store,{...f.profile,setup:f.setup})).toMatchObject({
    family:'qualification_required',family_parser_compatibility:{state:'invalidated'},
  });
});
