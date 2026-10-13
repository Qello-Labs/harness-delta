import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { prepareCodexSessionBindingQualification, codexBindingQualificationArgv, executeCodexSessionBindingQualification } from '../src/codex-session-binding-qualification.js';
import { CodexSessionBindingProvider } from '../src/session-binding-codex.js';
import { bindingSourceSupported, createSessionBindingService } from '../src/session-binding-service.js';
import { checkBindingQualificationIdentity, qualificationRecordedRequests, qualificationStopReached, qualificationStopWitness } from '../src/session-binding-qualification-lease.js';
import { Store } from '../src/store.js';
import { protocolRow } from '../src/comparison.js';
import { effectiveSourceCompatibility, sessionCompatibility } from '../src/source-compatibility.js';
import { externalTaskState } from '../src/external-session-service.js';
import { runExternalWorkflow } from '../src/external-session-workflow.js';
import { leaseBindingQualificationFixture, prepareBindingQualificationFixture } from './helpers/codex-binding-qualification-fixture.js';

const cleanups: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

async function prepared(productVersion = '0.162.1') {
  const p = await prepareBindingQualificationFixture(productVersion);
  cleanups.push(p.cleanup);
  return p;
}

async function family() {
  const p = await prepared(); const f = await leaseBindingQualificationFixture(p);
  cleanups.push(() => f.store.close()); return f;
}

test('target preparation freezes actual product version in intent and protocol', async () => {
  const p = await prepared();
  const store = new Store(p.intent.database);
  cleanups.push(() => store.close());
  const protocol = protocolRow(store, 'qualification-protocol');
  expect(JSON.parse(protocol.settings)).toMatchObject({
    source_profiles: [{ product: 'codex', product_version: '0.162.1', profile_id: 'codex-workflow-own-response-v1' }],
  });
  expect(p.intent).toMatchObject({
    product_version: '0.162.1', validation_kind: 'synthetic', product_gate_delta: false,
    root_request_stop: 8, observed_request_stop: 10, child_request_stop: 1, observed_token_stop: 200000,
    helper_network_permission: 'single_command_network_only',
    profile: { setup: { workflow: { product_version: '0.162.1' } }, execution: { timeout_ms: 900000 } },
  });
  const args = codexBindingQualificationArgv(p.intent);
  expect(p.intent).toHaveProperty('post_connect_input',expect.any(String));
  expect(args).toContain('--no-daemon');
  expect(args.slice(args.indexOf('--enable'), args.indexOf('--enable') + 2)).toEqual(['--enable', 'exec_permission_approvals']);
  const configs = args.filter((_arg, index) => args[index - 1] === '-c').filter(arg => arg.startsWith('tui.'));
  const notifications:unknown=JSON.parse(execFileSync(p.intent.python,['-c','import json,sys,tomllib; print(json.dumps(tomllib.loads(sys.argv[1])))',configs.join('\n')],{encoding:'utf8'}));
  expect(notifications).toEqual({tui:{notifications:['approval-requested','agent-turn-complete'],notification_method:'osc9',notification_condition:'always'}});
});

test('target hook records configured version without opening its source body', async () => {
  const p = await prepared();
  const id = randomUUID(); const source = join(p.home, 'sessions', `${id}.jsonl`);
  writeFileSync(source, 'PRIVATE_SYNTHETIC_NON_TRANSCRIPT\n');
  const output = JSON.parse(execFileSync(p.intent.wrapper, [], { encoding: 'utf8', input: JSON.stringify({
    hook_event_name: 'SessionStart', session_id: id, source: 'startup', cwd: p.intent.project, transcript_path: source,
  }) })) as { hookSpecificOutput: { additionalContext: string } };
  const receipt = /[a-f0-9-]{36}/.exec(output.hookSpecificOutput.additionalContext)?.[0];
  expect(receipt).toBeDefined();
  expect(JSON.parse(readFileSync(join(p.intent.receipts, `${receipt}.json`), 'utf8'))).toMatchObject({ productVersion: '0.162.1' });
});

test('historical target retains its ordinary arguments', async () => {
  const p = await prepared('0.160.0');
  expect(p.intent.product_version).toBe('0.160.0');
  expect(p.intent).toMatchObject({ root_request_stop: 4, observed_request_stop: 6, observed_token_stop: 100000, post_connect_input:null, helper_network_permission: 'none', profile: { execution: { timeout_ms: 120000 } } });
  expect(codexBindingQualificationArgv(p.intent)).not.toContain('--no-daemon');
  expect(codexBindingQualificationArgv(p.intent)).not.toContain('--enable');
  expect(codexBindingQualificationArgv(p.intent).filter(arg => arg.startsWith('projects='))).toEqual([]);
  expect(codexBindingQualificationArgv(p.intent).filter(arg => arg.startsWith('tui.'))).toEqual([]);
});

test.each([['0.160.0', 120000], ['0.162.1', 900000]] as const)('default %s duration is frozen at %i',async(productVersion,duration)=>{
  const p=await prepared(productVersion);
  const result=await prepareCodexSessionBindingQualification(join(p.root,'default-duration'),{
    binary:realpathSync(process.execPath),codexHome:p.home,productVersion,
  },{script:p.fixture.script});
  expect(result.intent).toMatchObject({duration_ms:duration,profile:{execution:{timeout_ms:duration}}});
});

test.each([300000,900000])('historical execution rejects duration %i before reservation',async duration=>{
  const p=await prepared('0.160.0');
  writeFileSync(p.intentPath,JSON.stringify({...p.intent,duration_ms:duration}));
  await expect(executeCodexSessionBindingQualification(p.intentPath,{
    intent_sha256:p.sha256,approval_reference:'synthetic-only',actual_model_run:true,
    transient_hooks:true,native_source_reads:true,owned_process_termination:true,
  },p.fixture)).rejects.toThrow('binding_qualification_invalid_intent');
  const store=new Store(p.intent.database);cleanups.push(()=>store.close());
  expect(store.get('SELECT reserved FROM binding_qualification')).toEqual({reserved:0});
  expect(()=>readFileSync(join(p.intent.directory,'execution.reserved'))).toThrow();
});

test('target duration above fifteen minutes is refused before reservation',async()=>{
  const p=await prepared();
  writeFileSync(p.intentPath,JSON.stringify({...p.intent,duration_ms:900001}));
  await expect(executeCodexSessionBindingQualification(p.intentPath,{
    intent_sha256:p.sha256,approval_reference:'synthetic-only',actual_model_run:true,
    transient_hooks:true,native_source_reads:true,owned_process_termination:true,network_command_permission:true,
  },p.fixture)).rejects.toMatchObject({issues:[{code:'too_big',maximum:900000,path:['duration_ms']}]});
  const store=new Store(p.intent.database);cleanups.push(()=>store.close());
  expect(store.get('SELECT reserved FROM binding_qualification')).toEqual({reserved:0});
  expect(()=>readFileSync(join(p.intent.directory,'execution.reserved'))).toThrow();
});

test.each([120000,300000])('target rejects stale profile duration %i before reservation',async duration=>{
  const p=await prepared();
  writeFileSync(p.intentPath,JSON.stringify({...p.intent,profile:{...p.intent.profile,execution:{...p.intent.profile.execution,timeout_ms:duration}}}));
  await expect(executeCodexSessionBindingQualification(p.intentPath,{
    intent_sha256:p.sha256,approval_reference:'synthetic-only',actual_model_run:true,
    transient_hooks:true,native_source_reads:true,owned_process_termination:true,network_command_permission:true,
  },p.fixture)).rejects.toThrow('binding_qualification_invalid_intent');
  const store=new Store(p.intent.database);cleanups.push(()=>store.close());
  expect(store.get('SELECT reserved FROM binding_qualification')).toEqual({reserved:0});
  expect(()=>readFileSync(join(p.intent.directory,'execution.reserved'))).toThrow();
});

test.each(['project', 'project.with.dots', 'project with "quotes" and \\slash'])(
  'target trust override addresses only the disposable project %s',
  async name => {
    const p = await prepared(); const project = join(p.root, name);
    const args = codexBindingQualificationArgv({ ...p.intent, project });
    const configs = args.filter((_arg, index) => args[index - 1] === '-c');
    const trust = configs.filter(arg => arg.startsWith('projects='));
    expect(trust).toHaveLength(1);
    const parsed: unknown = JSON.parse(execFileSync(p.intent.python, [
      '-c', 'import json,sys,tomllib; print(json.dumps(tomllib.loads(sys.argv[1])))', trust[0] ?? '',
    ], { encoding: 'utf8' }));
    expect(parsed).toEqual({ projects: { [project]: { trust_level: 'trusted' } } });
    expect(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2)).toEqual(['--sandbox', 'read-only']);
    expect(configs).toContain('approval_policy="on-request"');
  },
);

test('target execution requires separate command network consent before reservation', async () => {
  const p = await prepared();
  await expect(executeCodexSessionBindingQualification(p.intentPath, {
    intent_sha256: p.sha256, approval_reference: 'synthetic-only', actual_model_run: true,
    transient_hooks: true, native_source_reads: true, owned_process_termination: true,
  }, p.fixture)).rejects.toThrow('binding_qualification_consent_required');
  const store = new Store(p.intent.database); cleanups.push(() => store.close());
  expect(store.get('SELECT reserved FROM binding_qualification')).toEqual({ reserved: 0 });
  expect(() => readFileSync(join(p.intent.directory, 'execution.reserved'))).toThrow();
});

test('target manual startup is rejected before preparing a permission-enabled workspace', async () => {
  const p = await prepared(); const directory = join(p.root, 'manual-target');
  await expect(prepareCodexSessionBindingQualification(directory, {
    binary: realpathSync(process.execPath), codexHome: p.home, productVersion: '0.162.1', startMode: 'manual',
  }, p.fixture)).rejects.toThrow('binding_qualification_invalid_intent');
  expect(() => readFileSync(join(directory, 'execution-intent.json'))).toThrow();
});

test('changing the frozen connector refuses execution before reservation', async () => {
  const p = await prepared();
  if (p.intent.connector === null) throw new Error('synthetic_connector_missing');
  appendFileSync(p.intent.connector, '\n');
  await expect(executeCodexSessionBindingQualification(p.intentPath, {
    intent_sha256: p.sha256, approval_reference: 'synthetic-only', actual_model_run: true,
    transient_hooks: true, native_source_reads: true, owned_process_termination: true, network_command_permission: true,
  }, p.fixture)).rejects.toThrow('binding_qualification_drift');
  const store = new Store(p.intent.database); cleanups.push(() => store.close());
  expect(store.get('SELECT reserved FROM binding_qualification')).toEqual({ reserved: 0 });
});

test('preexisting attention metadata refuses execution without consuming the reservation',async()=>{
 const p=await prepared();
 writeFileSync(join(p.intent.directory,'native-attention.json'),'synthetic-existing-attention');
 await expect(executeCodexSessionBindingQualification(p.intentPath,{
  intent_sha256:p.sha256,approval_reference:'synthetic-only',actual_model_run:true,
  transient_hooks:true,native_source_reads:true,owned_process_termination:true,network_command_permission:true,
 },p.fixture)).rejects.toThrow('binding_qualification_attention_exists');
 const store=new Store(p.intent.database);cleanups.push(()=>store.close());
 expect(store.get('SELECT reserved FROM binding_qualification')).toEqual({reserved:0});
 expect(()=>readFileSync(join(p.intent.directory,'execution.reserved'))).toThrow();
});

test.each([0, 1])('the frozen connector gates connect on successful inspect exit %i', async inspectExit => {
  const p = await prepared();
  const connector = p.intent.connector;
  if (connector === null) throw new Error('synthetic_connector_missing');
  const trace = join(p.root, 'connector-operations.jsonl');
  const helper = join(p.intent.project, '.agents/skills/harness-connect/scripts/connect.mjs');
  writeFileSync(helper, `import{appendFileSync}from'node:fs';appendFileSync(${JSON.stringify(trace)},JSON.stringify(process.argv.slice(2))+'\\n');if(process.argv[2]==='inspect')process.exit(${inspectExit});\n`);
  const receipt = randomUUID();
  const invoke = () => execFileSync(p.intent.node, [connector, '--receipt', receipt], { encoding: 'utf8' });
  if (inspectExit) expect(invoke).toThrow(); else invoke();
  const operations = readFileSync(trace, 'utf8').trim().split('\n').map(line => z.array(z.string()).parse(JSON.parse(line)));
  expect(operations.map(args => args[0])).toEqual(inspectExit ? ['inspect'] : ['inspect', 'connect']);
  for (const args of operations) {
    expect(args.slice(1, 9)).toEqual(['--origin', 'http://127.0.0.1:4319', '--product', 'codex', '--project', p.intent.project_id, '--task', p.intent.task_id]);
  }
  if (!inspectExit) expect(operations[1]?.slice(9)).toEqual(['--receipt', receipt]);
});

test.each([
  { root_request_stop: 4 },
  { root_request_stop: 5 },
  { observed_request_stop: 6 },
  { observed_request_stop: 7 },
  { observed_token_stop: 100000 },
  { helper_network_permission: 'none' },
  { post_connect_input: null },
  { post_connect_input: 'synthetic-substitution' },
])('target execution rejects policy substitution before reservation %j', async change => {
  const p = await prepared();
  writeFileSync(p.intentPath, JSON.stringify({ ...p.intent, ...change }));
  await expect(executeCodexSessionBindingQualification(p.intentPath, {
    intent_sha256: p.sha256, approval_reference: 'synthetic-only', actual_model_run: true,
    transient_hooks: true, native_source_reads: true, owned_process_termination: true,
    network_command_permission: true,
  }, p.fixture)).rejects.toThrow('binding_qualification_invalid_intent');
  const store = new Store(p.intent.database); cleanups.push(() => store.close());
  expect(store.get('SELECT reserved FROM binding_qualification')).toEqual({ reserved: 0 });
});

test('target six-request planned family stays below its separate stop envelope', async () => {
  const f = await family();
  for (let n = 0; n < 3; n++) appendFileSync(f.source(f.rootId), f.row('token_usage_record', {
    thread_id: f.rootId, session_id: f.rootId, turn_id: `${f.rootId}-turn`, root_turn_id: `${f.rootId}-turn`,
    response_id: randomUUID(),
    usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 120 },
  }));
  await f.service.tick(f.intent.task_id);
  await f.service.tick(f.intent.task_id);
  expect(f.service.status(f.intent.task_id)).toMatchObject({ roots: 1, children: 2, requests: 6 });
  expect(qualificationStopReached(f.lease)).toBe(false);
});

test('historical execution rejects the raised token policy before reservation', async () => {
  const p = await prepared('0.160.0');
  writeFileSync(p.intentPath, JSON.stringify({ ...p.intent, observed_token_stop: 200000 }));

  await expect(executeCodexSessionBindingQualification(p.intentPath, {
    intent_sha256: p.sha256, approval_reference: 'synthetic-only', actual_model_run: true,
    transient_hooks: true, native_source_reads: true, owned_process_termination: true,
  }, p.fixture)).rejects.toThrow('binding_qualification_invalid_intent');
  const store = new Store(p.intent.database); cleanups.push(() => store.close());
  expect(store.get('SELECT reserved FROM binding_qualification')).toEqual({ reserved: 0 });
  expect(() => readFileSync(join(p.intent.directory, 'execution.reserved'))).toThrow();
});

test.each([{root_request_stop:8},{observed_request_stop:10},{post_connect_input:'synthetic-substitution'}])('historical execution rejects staged policy substitution %j',async change=>{
  const p=await prepared('0.160.0');
  writeFileSync(p.intentPath,JSON.stringify({...p.intent,...change}));
  await expect(executeCodexSessionBindingQualification(p.intentPath,{
    intent_sha256:p.sha256,approval_reference:'synthetic-only',actual_model_run:true,
    transient_hooks:true,native_source_reads:true,owned_process_termination:true,
  },p.fixture)).rejects.toThrow('binding_qualification_invalid_intent');
  const store=new Store(p.intent.database);cleanups.push(()=>store.close());
  expect(store.get('SELECT reserved FROM binding_qualification')).toEqual({reserved:0});
  expect(()=>readFileSync(join(p.intent.directory,'execution.reserved'))).toThrow();
});

test.each([108256, 199999, 200000, 200001])('target collector enforces the raised token boundary at %i', async tokens => {
  const f = await family();
  appendFileSync(f.source(f.rootId), f.row('token_usage_record', {
    thread_id: f.rootId, session_id: f.rootId, turn_id: `${f.rootId}-turn`, root_turn_id: `${f.rootId}-turn`,
    response_id: randomUUID(),
    usage: { input_tokens: tokens - 380, cached_input_tokens: 10, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: tokens - 360 },
  }));

  if (tokens > 200000) {
    await expect(f.service.tick(f.intent.task_id)).rejects.toThrow('binding_qualification_token_limit');
    expect(qualificationStopWitness(f.lease, 'collector_limit').attempted).toMatchObject({
      input_output_tokens: tokens, reached: ['token_limit'],
    });
  } else {
    await f.service.tick(f.intent.task_id);
    expect(f.service.status(f.intent.task_id)).toMatchObject({ roots: 1, children: 2, requests: 4 });
    expect(qualificationStopWitness(f.lease, 'safety_limit').safety).toMatchObject({
      input_output_tokens: tokens, reached: tokens === 200000 ? ['token_limit'] : [],
    });
    expect(qualificationStopReached(f.lease)).toBe(tokens === 200000);
  }
});

test('target eighth root request reaches both stops and a ninth cannot enter the ledger', async () => {
  const f = await family();
  for (let n = 0; n < 7; n++) appendFileSync(f.source(f.rootId), f.row('token_usage_record', {
    thread_id: f.rootId, session_id: f.rootId, turn_id: `${f.rootId}-turn`, root_turn_id: `${f.rootId}-turn`,
    response_id: randomUUID(),
    usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 120 },
  }));
  await f.service.tick(f.intent.task_id);
  expect(qualificationStopWitness(f.lease, 'safety_limit').safety).toMatchObject({
    root_requests: 8, total_requests: 10, reached: ['root_request_limit', 'total_request_limit'],
  });
  expect(qualificationStopReached(f.lease)).toBe(true);
  appendFileSync(f.source(f.rootId), f.row('token_usage_record', {
    thread_id: f.rootId, session_id: f.rootId, turn_id: `${f.rootId}-turn`, root_turn_id: `${f.rootId}-turn`,
    response_id: randomUUID(),
    usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 120 },
  }));
  await expect(f.service.tick(f.intent.task_id)).rejects.toThrow('binding_qualification_request_limit');
  expect(qualificationRecordedRequests(f.lease).size).toBe(10);
  expect(qualificationStopWitness(f.lease, 'collector_limit').attempted).toMatchObject({
    own_requests: 9, total_requests: 11, reached: ['root_request_limit', 'total_request_limit'],
  });
});

test('candidate metadata preparation does not admit ordinary external collection', async () => {
  const p = await prepared();
  const store = new Store(p.intent.database); cleanups.push(() => store.close());
  expect(externalTaskState(store, p.intent.task_id).state).toBe('configuration_verified');
  expect(bindingSourceSupported(store, p.intent.task_id)).toBe(false);
  await expect(runExternalWorkflow(store, p.intent.profile.setup.workflow, {
    ...p.intent.profile.execution, product_version: '0.162.1', run_id: 'unadmitted-collect',
    operation: 'collect', session_id: randomUUID(),
  }, p.intent.profile.setup.runtime, p.intent.profile.setup.preparation)).rejects.toThrow('external_source_unsupported');
  expect(store.all('SELECT id FROM sessions')).toEqual([]);
  expect(store.eventCount()).toBe(0);
});

test('native preparation rejects an unpinned executable before creating an intent', async () => {
  const p = await prepared(); const destination = join(p.root, 'invalid-native');
  await expect(prepareCodexSessionBindingQualification(destination, {
    binary: realpathSync(process.execPath), codexHome: p.home, productVersion: '0.162.1',
  // Native preparation stays Node 24 only, so the Node gate precedes the binary pin on Node 26.
  })).rejects.toThrow(process.versions.node.startsWith('24.') ? 'binding_qualification_binary_mismatch' : 'node24_required');
  expect(() => readFileSync(join(destination, 'execution-intent.json'))).toThrow();
});

test('unfrozen project configuration blocks transient trust before reservation', async () => {
  const p = await prepared();
  mkdirSync(join(p.intent.project, '.codex'));
  writeFileSync(join(p.intent.project, '.codex', 'config.toml'), 'PRIVATE_SYNTHETIC_PROJECT_CONFIGURATION\n');
  await expect(executeCodexSessionBindingQualification(p.intentPath, {
    intent_sha256: p.sha256, approval_reference: 'synthetic-only', actual_model_run: true,
    transient_hooks: true, native_source_reads: true, owned_process_termination: true,
  }, p.fixture)).rejects.toThrow('binding_qualification_drift');
  const store = new Store(p.intent.database); cleanups.push(() => store.close());
  expect(store.get('SELECT reserved FROM binding_qualification')).toEqual({ reserved: 0 });
});

test('target substitution cannot reuse its frozen consent or reserve execution', async () => {
  const p = await prepared();
  writeFileSync(p.intentPath, JSON.stringify({ ...p.intent, product_version: '0.160.0' }));
  await expect(executeCodexSessionBindingQualification(p.intentPath, {
    intent_sha256: p.sha256, approval_reference: 'synthetic-only', actual_model_run: true,
    transient_hooks: true, native_source_reads: true, owned_process_termination: true,
  }, p.fixture)).rejects.toThrow('binding_qualification_invalid_intent');
  const store = new Store(p.intent.database); cleanups.push(() => store.close());
  expect(store.get('SELECT reserved FROM binding_qualification')).toEqual({ reserved: 0 });
});

test('candidate provider configuration cannot authorize ordinary source access', async () => {
  const p = await prepared();
  const store = new Store(p.intent.database); cleanups.push(() => store.close());
  const provider = new CodexSessionBindingProvider({
    receiptDirectory: p.intent.receipts, sourceRoots: [join(p.home, 'sessions')], projectRoot: p.intent.project,
    productVersion: '0.162.1', ordinaryFamilyQualification: true, maxDepth: 1, maxFamilyMembers: 3,
  });
  const resolve = vi.spyOn(provider, 'resolveCurrent');
  const service = createSessionBindingService({ store, providers: [provider], setupFor: () => p.intent.profile.setup });
  await expect(service.connect(p.intent.task_id, 'codex', { receipt: randomUUID() })).rejects.toThrow('binding_source_unqualified');
  expect(resolve).not.toHaveBeenCalled();
});

test.each([
  { productVersion: '0.160.0', maxDepth: 1, maxFamilyMembers: 3 },
  { productVersion: '0.162.1', maxDepth: 2, maxFamilyMembers: 3 },
  { productVersion: '0.162.1', maxDepth: 1, maxFamilyMembers: 4 },
  { productVersion: '0.162.1', maxDepth: 1, maxFamilyMembers: 3, ordinaryRootPilot: true },
])('qualification reader rejects scope expansion %j', async options => {
  const p = await prepared();
  expect(() => new CodexSessionBindingProvider({
    receiptDirectory: p.intent.receipts, sourceRoots: [join(p.home, 'sessions')], projectRoot: p.intent.project,
    ordinaryFamilyQualification: true, ...options,
  })).toThrow('binding_configuration_invalid');
});

test('leased target rejects another version without replacing its root identity', async () => {
  const f = await family();
  expect(() => checkBindingQualificationIdentity(f.lease, f.store, f.intent.task_id, { ...f.identity, productVersion: '0.160.0' }, false))
    .toThrow('binding_qualification_identity_invalid');
  expect(f.service.status(f.intent.task_id)).toMatchObject({ roots: 1, children: 0, requests: 0 });
});

test('leased target family collects own responses without ancestor or cumulative double counting', async () => {
  const f = await family();
  await f.service.tick(f.intent.task_id); await f.service.tick(f.intent.task_id);
  expect(f.service.status(f.intent.task_id)).toMatchObject({ roots: 1, children: 2, requests: 3 });
  const payloads = f.store.all<{ payload: string }>('SELECT payload FROM events').map(r => JSON.parse(r.payload) as unknown);
  expect(payloads).toHaveLength(3);
  for (const payload of payloads) expect(payload).toMatchObject({
    product_version: '0.162.1', input_total: { value: 100 }, output_total: { value: 20 },
    billing_components: [
      { kind: 'ordinary_input', reading: { value: 90 } }, { kind: 'cache_read', reading: { value: 10 } },
      { kind: 'cache_write', reading: { status: 'observed', value: 0 } }, { kind: 'output', reading: { value: 20 } },
    ],
    source_compatibility: { state: 'compatibility_unverified', product_version: '0.162.1', parser_version: '0.160.0' },
  });
  for (const id of [f.rootId, ...f.children]) expect(sessionCompatibility(f.store, id)).toMatchObject({
    state: 'compatibility_unverified', product_version: '0.162.1', parser_version: '0.160.0',
  });
});

test('a sibling-thread copy in a child source fails closed instead of becoming own usage', async () => {
  const f = await family();
  appendFileSync(f.source(f.children[0]), f.usage(f.children[1]));
  appendFileSync(f.source(f.children[1]), f.usage(f.children[0]));
  await expect(f.service.tick(f.intent.task_id)).rejects.toThrow('candidate_scope_mismatch');
  expect(f.store.all('SELECT session_id FROM events')).toEqual([{ session_id: f.rootId }]);
});

test('a leased counter contract failure invalidates the tuple and prevents further body reads', async () => {
  const f = await family();
  appendFileSync(f.source(f.rootId), f.row('token_usage_record', {
    thread_id: f.rootId, session_id: f.rootId, turn_id: `${f.rootId}-turn`, root_turn_id: `${f.rootId}-turn`, response_id: randomUUID(),
    usage: { input_tokens: 100, cached_input_tokens: 101, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 120 },
  }));
  await expect(f.service.tick(f.intent.task_id)).rejects.toThrow('candidate_invalid_metadata');
  const compatibility = sessionCompatibility(f.store, f.rootId);
  if (!compatibility) throw new Error('synthetic_compatibility_missing');
  expect(effectiveSourceCompatibility(f.store, compatibility).state).toBe('invalidated');
  const read = vi.spyOn(f.provider, 'readUsage');
  await expect(f.service.tick(f.intent.task_id)).rejects.toThrow('compatibility_invalidated');
  expect(read).not.toHaveBeenCalled();
  expect(f.store.eventCount()).toBe(0);
});
