import { createHash } from 'node:crypto';
import { appendFileSync, openSync, closeSync, unlinkSync, mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { Socket } from 'node:net';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { expect, test, vi } from 'vitest';

// Lane budgets below must stay shorter than these timeouts to keep failure reasons visible.
vi.setConfig({ testTimeout: 30000 });
import { Store } from '../src/store.js';
import { Lifecycle } from '../src/lifecycle.js';
import * as collection from '../src/collection.js';
import { checkCandidatePermissions } from '../src/codex-candidate-permissions.js';
import { prepareCodexQualification, type CodexQualificationOptions } from '../src/codex-qualification.js';

vi.mock('node:child_process',async importOriginal=>{
  const actual=await importOriginal<typeof import('node:child_process')>();
  return {...actual,spawn:vi.fn(actual.spawn)};
});
const readSyntheticSource=collection.readSource;
function fixture(mode = 'success') {
  const dir = realpathSync(mkdtempSync('/tmp/hdcq-'));
  const cwd = join(dir, 'fixture'); const ledger = join(dir, 'ledger'); const codexHome = join(dir, 'codex-home'); mkdirSync(codexHome); const sessionsRoot = join(codexHome, 'sessions');
  for (const path of [cwd, ledger, sessionsRoot]) mkdirSync(path);
  const store = new Store(join(ledger, 'measurement.sqlite')); const lifecycle = new Lifecycle(store);
  lifecycle.registerProject('p', cwd);
  lifecycle.createTask('p', 't', { type: 'feature', expected_size: 'small', assignee: 'synthetic-user', product: 'codex', model: 'gpt-6-astra', criterion_ids: ['c'] });
  lifecycle.start('t');
  const script = join(dir, 'fake.mjs'); const executable = join(dir, 'fake-codex');
  writeFileSync(script, `
import {writeFileSync,appendFileSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const trace=${JSON.stringify(join(dir,'synthetic-timing.jsonl'))};
const mark=(phase,extra={})=>appendFileSync(trace,JSON.stringify({phase,at:Date.now(),...extra})+'\\n');mark('node_ready');
const mode=${JSON.stringify(mode)}, dir=${JSON.stringify(sessionsRoot)}, cwd=${JSON.stringify(cwd)};
let args=process.argv.slice(2);
if(process.send){await new Promise(resolve=>setTimeout(resolve,Number(process.env.HD_SYNTHETIC_SETUP_DELAY_MS??0)));process.send({ready:true});const launch=await new Promise(resolve=>process.once('message',resolve));args=launch.args;
// Preserve the native fresh-source contract: never create in the launch millisecond.
while(Date.now()<launch.startedAt+2)await new Promise(resolve=>setTimeout(resolve,1));}
const setting=args.find(s=>s.startsWith('hooks.SessionStart='));
const command=setting.match(/command="([^"]+)"/)[1];
const root='00000000-0000-0000-0000-000000000001', child='00000000-0000-0000-0000-000000000002';
const path=id=>dir+'/'+id+'.jsonl'; const at=()=>new Date().toISOString();
const row=(type,payload)=>JSON.stringify({timestamp:at(),type,payload})+'\\n';
// Synthetic cooperation only: actual native concurrent mutation still stops.
const lock=dir+'/synthetic-source.lock';
function write(path,data,append=false){let fd;const deadline=Date.now()+3000;while(fd===undefined){try{fd=openSync(lock,'wx');}catch(error){if(error.code!=='EEXIST'||Date.now()>deadline)throw error;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1);}}
try{(append?appendFileSync:writeFileSync)(path,data);}finally{closeSync(fd);unlinkSync(lock);}}
const basePermissions={approval_policy:'never',approvals_reviewer:'user',sandbox_policy:{type:'read-only'},permission_profile:{type:'managed',file_system:{type:'restricted',entries:[{path:{type:'special',value:{kind:'root'}},access:'read'}]},network:'restricted'}};
function permissions(){const p=JSON.parse(JSON.stringify(basePermissions));
if(['auto-review','permissions-missing','profile-write','profile-disabled','split-write','permission-relaxation'].includes(mode)){p.approval_policy='on-request';p.approvals_reviewer='auto_review';}
if(mode==='permissions-missing')delete p.permission_profile;
if(mode==='profile-write')p.permission_profile.file_system.entries[0].access='write';
if(mode==='profile-disabled')p.permission_profile={type:'disabled'};
if(mode==='split-write')p.file_system_sandbox_policy={kind:'restricted',entries:[{path:{type:'special',value:{kind:'root'}},access:'write'}]};
return p;}
function context(id){return {turn_id:id===root?'root-turn':'child-turn',root_turn_id:id===root?null:'root-turn',cwd,model:id===root?'gpt-6-astra':mode==='settings'?'wrong':'gpt-6.1-sol',effort:'high',multi_agent_version:mode==='timing-disabled'?'disabled':mode==='timing-unknown'?'PRIVATE_VERSION_SENTINEL':'v2',...permissions()};}
function create(id,parent=null){write(path(id),row('session_meta',{id,session_id:root,parent_thread_id:parent,cli_version:'0.160.0',cwd,source:parent?{subagent:{thread_spawn:{parent_thread_id:parent,depth:1}}}:'exec'}));
write(path(id),row('turn_context',context(id)),true);}
function response(id,name){write(path(id),row('token_usage_record',{thread_id:id,session_id:root,turn_id:id===root?'root-turn':'child-turn',root_turn_id:'root-turn',response_id:name,usage:{input_tokens:10,cached_input_tokens:2,output_tokens:3,reasoning_output_tokens:1,total_tokens:13}}),true);}
function hook(id){const payload={session_id:root,transcript_path:path(id),cwd,hook_event_name:id===root?'SessionStart':'SubagentStart',model:id===root?'gpt-6-astra':mode==='settings'?'wrong':'gpt-6.1-sol',permission_mode:['auto-review','wire-mismatch','permissions-missing','profile-write','profile-disabled','split-write','permission-relaxation'].includes(mode)?'default':'bypassPermissions',...(id===root?{source:'startup'}:{turn_id:'child-turn',agent_id:id,agent_type:'default'})};
if(mode==='wire-unknown')payload.permission_mode='PRIVATE_WIRE_SENTINEL'; if(mode==='wire-missing')delete payload.permission_mode;
if(mode==='source-malformed')write(path(id),'PRIVATE_SOURCE_SENTINEL\\n',true);
if(id!==root){if(mode==='child-id-missing'||mode==='child-id-missing-path')delete payload.agent_id;
if(mode==='child-id-null')payload.agent_id=null;if(mode==='child-id-malformed')payload.agent_id='invalid-child-id';
if(mode==='child-id-missing-path')payload.transcript_path=dir+'/uncreated-child.jsonl';}
mark(id===root?'root_hook_start':'child_hook_start');
const result=spawnSync(command,[],{input:JSON.stringify(payload),timeout:15000});mark(id===root?'root_hook_end':'child_hook_end',{status:result.status,signal:result.signal,error:result.error?.code??null}); if(result.status!==0)process.exit(3);}
create(root);
if(mode==='diagnostic-native-error'){hook(root);process.stderr.write('ERROR: unexpected status 401 Unauthorized PRIVATE_SECRET\\n');process.exit(1);}
else if(mode.startsWith('timing-')){
  hook(root);
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  function progress(call='spawn-1',target=child){const item={type:'SubAgentActivity',id:call,kind:'started',agent_thread_id:target,agent_path:'/synthetic/child'};
    write(path(root),row('event_msg',mode==='timing-legacy'?{type:'sub_agent_activity',event_id:call,kind:'started',agent_thread_id:target,agent_path:'/synthetic/child',occurred_at_ms:1}:{type:'item_completed',thread_id:root,turn_id:mode==='timing-wrong-turn'?'unapproved-turn':'root-turn',item,completed_at_ms:1}),true);}
  const input=()=>write(path(root),row('event_msg',{type:'item_completed',thread_id:root,turn_id:'root-turn',item:{type:'UserMessage',id:'input',content:'PRIVATE_INPUT_SENTINEL'}}),true);
  if(mode==='timing-no-progress'||mode==='timing-unknown'){input();setInterval(input,150);}
  else if(mode==='timing-disabled'){setTimeout(()=>process.exit(0),3000);}
  else {
    input();await wait(mode==='timing-callback-first'||mode==='timing-extra'||mode==='timing-late-reader'||mode==='timing-conflict'||mode==='timing-wrong-turn'||mode==='timing-permissions'?100:2200);response(root,'root-first');create(child,root);
    if(mode==='timing-permissions'){const relaxed=context(root);relaxed.permission_profile.file_system.entries[0].access='write';write(path(root),row('turn_context',relaxed),true);}
    if(mode==='timing-callback-first'){hook(child);response(child,'child-own');await wait(1900);progress();await wait(1900);}
    else {progress('spawn-1',mode==='timing-conflict'?'00000000-0000-0000-0000-000000000003':child);await wait(100);if(mode==='timing-missing-child'){setInterval(input,150);}else {hook(child);response(child,'child-own');}}
    if(mode==='timing-extra')progress('spawn-2','00000000-0000-0000-0000-000000000003');
    if(mode!=='timing-missing-child'){response(root,'root-final');process.exit(0);}
  }
}
else if(mode==='missing'){setTimeout(()=>process.exit(0),2500);}
else {if(mode==='late')response(root,'late'); if(mode==='late-partial')write(path(root),row('token_usage_record',{thread_id:root,response_id:'prior-own'}).slice(0,-1),true); hook(root); response(root,'root-first');
create(child,root); hook(child); response(child,'child-own');
if(mode==='permission-relaxation'){const relaxed=context(root);relaxed.permission_profile.file_system.entries[0].access='write';write(path(root),row('turn_context',relaxed),true);}
if(mode==='extra'){const extra='00000000-0000-0000-0000-000000000003';create(extra,root);hook(extra);}
if(mode==='pause'||mode==='cancel'||mode==='source-error'||mode==='relink')setTimeout(()=>process.exit(0),1000);
else {response(root,'root-final');process.exit(mode==='nonzero'?2:0);}}
`);
  writeFileSync(executable, `#!/bin/sh\n: > '${join(dir,'shell-ready')}'\nexec '${process.execPath}' '${script}' "$@"\n`, { mode: 0o700 });
  const sha256 = createHash('sha256').update(readFileSync(executable)).digest('hex');
  const options: CodexQualificationOptions = { store, projectId: 'p', taskId: 't', cwd, ledgerDirectory: ledger, codexHome, sessionsRoot, executable, executableSha256: sha256,
    nodeExecutable: process.execPath, hookRecorder: resolve('scripts/conformance/candidate-start-recorder.mjs'), rootModel: 'gpt-6-astra', childModel: 'gpt-6.1-sol', rootEffort: 'high', childEffort: 'high', durationMs: 15000, handshakeTimeoutMs: 10000, pollMs: 10 };
  // Guard/identity tests need both fake Node launches to reach their assertion;
  // the default budgets leave room for slow CI runners and stay below the test
  // timeouts, so a stuck lane reports its own reason. Explicit
  // deadline/missing-handshake cases retain their original budgets.
  if(mode==='missing'){options.handshakeTimeoutMs=2000;options.durationMs=4500;}
  if(mode.startsWith('timing-')){options.handshakeTimeoutMs=1800;options.durationMs=mode==='timing-no-progress'||mode==='timing-unknown'?4300:9500;}
  // Keep real bounded reader/permission guards; serialize only the fake writer.
  const realNow=Date.now;let clockJump=0;
  const clockSpy=mode==='timing-late-reader'?vi.spyOn(Date,'now').mockImplementation(()=>realNow()+clockJump):null;
  const sourceReadSpy=vi.spyOn(collection,'readSource').mockImplementation(path=>{
    const lock=join(sessionsRoot,'synthetic-source.lock');let fd:number|undefined;const deadline=Date.now()+3000;
    while(fd===undefined){try{fd=openSync(lock,'wx');}catch(error){if(!(error instanceof Error)||!('code' in error)||error.code!=='EEXIST'||Date.now()>deadline)throw error;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1);}}
    try{if(mode==='timing-late-reader'&&path===join(sessionsRoot,'00000000-0000-0000-0000-000000000002.jsonl'))clockJump=2000;return readSyntheticSource(path);}finally{closeSync(fd);unlinkSync(lock);}
  });
  let primedNative:ChildProcess|undefined;
  async function primeNative(startupDelayMs=0){
    // Interpreter startup is fixture setup; the real runner still owns its
    // reservation, process-group teardown and unchanged handoff/deadline clocks.
    const native=spawn(process.execPath,[script],{detached:true,stdio:['ignore','ignore','pipe','ipc'],env:{...process.env,HD_SYNTHETIC_SETUP_DELAY_MS:String(startupDelayMs)}});primedNative=native;
    await new Promise<void>((ok,no)=>{const timer=setTimeout(()=>no(new Error('synthetic_fixture_startup_timeout')),15000);native.once('message',()=>{clearTimeout(timer);ok();});native.once('error',no);});
    vi.mocked(spawn).mockImplementationOnce((command,args)=>{if(command!==executable)throw new Error('unexpected_fixture_executable');native.send({args,startedAt:Date.now()});return native;});
    return native;
  }
  const timing=()=>({shellReadyAt:existsSync(join(dir,'shell-ready'))?statSync(join(dir,'shell-ready')).birthtimeMs:null,marks:existsSync(join(dir,'synthetic-timing.jsonl'))?readFileSync(join(dir,'synthetic-timing.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line) as unknown):[]});
  return { dir, store, lifecycle, options, sourceReadSpy, timing, primeNative, cleanup: () => { if(primedNative?.pid){try{process.kill(-primedNative.pid,'SIGKILL');}catch{/* already reaped */}}vi.mocked(spawn).mockReset();sourceReadSpy.mockRestore();clockSpy?.mockRestore();store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('abandoning a primed fixture cannot substitute a later process launch',async()=>{
  const f=fixture();let cleaned=false;
  try{
    const primed=await f.primeNative();
    const exited=once(primed,'exit',{signal:AbortSignal.timeout(3000)});
    f.cleanup();cleaned=true;await exited;
    const next=spawn(process.execPath,['-e','process.exit(0)'],{stdio:'ignore'});
    const result=await once(next,'exit',{signal:AbortSignal.timeout(3000)});
    expect(result[0]).toBe(0);
  }finally{if(!cleaned)f.cleanup();}
});

test('concrete qualification entry registers real lifecycle sources before callback return and preserves initial contexts, root continuation and replay', async () => {
  const f = fixture(); try {
    const lane = await prepareCodexQualification(f.options);
    expect(f.store.eventCount()).toBe(0); expect(lane.argv).toContain('--skip-git-repo-check'); expect(lane.argv).toContain('model_reasoning_effort="high"');
    const result = await lane.run(); expect(result).toMatchObject({ status: 'completed', reason: null, observedRequests: 3, registeredSessions: 2 });
    expect(f.store.all('SELECT * FROM sessions')).toHaveLength(2);
    const rows = f.store.all<{payload:string}>('SELECT payload FROM runtime_evidence').map(r => JSON.parse(r.payload) as {model:string;effort:string});
    expect(rows.filter(r=>r.model==='gpt-6-astra')).toHaveLength(2); expect(rows.filter(r=>r.model==='gpt-6.1-sol')).toHaveLength(1); expect(rows.every(r=>r.effort==='high')).toBe(true);
    await expect(lane.run()).rejects.toThrow('candidate_root_already_started');
    expect(f.store.eventCount()).toBe(3);
  } finally { f.cleanup(); }
});

test.each(['child-id-missing','child-id-null','child-id-malformed','child-id-missing-path'] as const)('child native identity %s is rejected before source access, reservation or linkage without prior spawn progress', async mode => {
  const f=fixture(mode);try{
    await f.primeNative();
    const lane=await prepareCodexQualification(f.options);const startedAt=Date.now();const result=await lane.run();
    const rootPath=join(f.options.sessionsRoot,'00000000-0000-0000-0000-000000000001.jsonl');
    expect(f.sourceReadSpy.mock.calls.length,JSON.stringify({startedAt,result,timing:f.timing()})).toBeGreaterThan(0);
    expect(f.sourceReadSpy.mock.calls.filter(([path])=>path!==rootPath)).toHaveLength(0);
    expect(existsSync(join(f.options.ledgerDirectory,'codex-candidate','child.reserved'))).toBe(false);
    expect(f.store.all('SELECT id FROM sessions WHERE parent_id IS NOT NULL')).toHaveLength(0);
    expect(f.store.all('SELECT id FROM sessions')).toHaveLength(1);
    expect(result).toMatchObject({status:'stopped',registeredSessions:1,reason:mode==='child-id-null'||mode==='child-id-malformed'?'candidate_handshake_schema_invalid':'candidate_unapproved_handshake'});
    expect(result.diagnostics.some(d=>d.code==='candidate_spawn_progress_observed')).toBe(false);
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({phase:'handshake_schema',field:'hook_schema',code:result.reason})]));
    await expect(lane.run()).rejects.toThrow('candidate_root_already_started');
  }finally{f.cleanup();}
},20000);

test('synthetic interpreter setup longer than handoff timeout does not consume the identity operation budget',async()=>{
  const f=fixture('child-id-missing');f.options.handshakeTimeoutMs=4000;f.options.durationMs=8000;try{
    await f.primeNative(4200);
    const lane=await prepareCodexQualification(f.options);const result=await lane.run();
    expect(result).toMatchObject({status:'stopped',reason:'candidate_unapproved_handshake',registeredSessions:1});
    expect(f.sourceReadSpy.mock.calls.length).toBeGreaterThan(0);
    expect(existsSync(join(f.options.ledgerDirectory,'codex-candidate','child.reserved'))).toBe(false);
    expect(result.elapsedMs).toBeLessThan(f.options.handshakeTimeoutMs);
  }finally{f.cleanup();}
},20000);

test.each(['missing', 'late', 'late-partial', 'extra', 'settings', 'nonzero'] as const)('whole entry stops on %s without retrying', async mode => {
  const f = fixture(mode); try { const lane=await prepareCodexQualification(f.options); const result=await lane.run(); expect(result.status).not.toBe('completed'); expect(result.reason).toBe({missing:'candidate_missing_handshake',late:'candidate_late_handshake','late-partial':'candidate_incomplete_initial_source',extra:'candidate_unapproved_handshake',settings:'candidate_unapproved_handshake',nonzero:'candidate_failed'}[mode]); await expect(lane.run()).rejects.toThrow('candidate_root_already_started'); } finally { f.cleanup(); }
},20000);

test.each(['pause','cancel','source-error','relink'] as const)('observer stops active process on %s', async mode => {
  const f=fixture(mode); try {
    const lane=await prepareCodexQualification(f.options); const controller=new AbortController();
    const timer=setInterval(()=>{if(f.store.all('SELECT * FROM sessions').length===2){clearInterval(timer);if(mode==='pause')f.lifecycle.pause('t');else if(mode==='cancel')controller.abort();else if(mode==='relink')f.store.execute('UPDATE sessions SET source_path=? WHERE parent_id IS NULL',[join(f.options.sessionsRoot,'unapproved-source')]);else rmSync(join(f.options.sessionsRoot,'00000000-0000-0000-0000-000000000001.jsonl'));}},5);
    const result=await lane.run({signal:controller.signal});clearInterval(timer);expect(result.status).toBe('stopped');expect(result.reason).toBe({pause:'candidate_inactive_scope',cancel:'candidate_cancelled','source-error':'candidate_source_error',relink:'candidate_scope_mismatch'}[mode]);
  } finally {f.cleanup();}
});


test('prepared lane rechecks authorization/hash/fresh scope and already-aborted cancellation before any launch', async () => {
  for(const invalidation of ['pause','hash','source-layout','cancel'] as const){
    const f=fixture();try{
      const lane=await prepareCodexQualification(f.options);const controller=new AbortController();
      if(invalidation==='pause')f.lifecycle.pause('t');
      if(invalidation==='hash')writeFileSync(f.options.executable,'changed synthetic executable');
      if(invalidation==='source-layout')writeFileSync(join(f.options.sessionsRoot,'unexpected'),'synthetic');
      if(invalidation==='cancel')controller.abort();
      if(invalidation==='cancel')expect(await lane.run({signal:controller.signal})).toMatchObject({status:'stopped',reason:'candidate_cancelled'});
      else await expect(lane.run()).rejects.toThrow({pause:'candidate_inactive_scope',hash:'candidate_executable_mismatch','source-layout':'candidate_invalid_invocation'}[invalidation]);
      expect(existsSync(join(f.options.ledgerDirectory,'codex-candidate','root.reserved'))).toBe(false);
      expect(f.store.eventCount()).toBe(0);
    }finally{f.cleanup();}
  }
});


test.each(['headless-never','auto-review'])('source-shaped headless %s policy retains declared read-only confinement and unchanged flags', async mode => {
  const f=fixture(mode);try{
    const lane=await prepareCodexQualification(f.options);const result=await lane.run();
    expect(result).toMatchObject({status:'completed',reason:null,observedRequests:3,registeredSessions:2});
    expect(lane.argv).toContain('read-only');expect(lane.argv).toContain('approval_policy="on-request"');
    expect(lane.argv.some(value=>value.includes('dangerously'))).toBe(false);
  }finally{f.cleanup();}
});

test('existing authenticated-home opt-in preserves unrelated prior sources and reads only fresh linked callbacks', async () => {
  const f = fixture(); const prior = join(f.options.sessionsRoot, 'prior-native.jsonl');
  writeFileSync(prior, 'PRIVATE_UNRELATED_PRIOR_SOURCE');
  try {
    expect(() => prepareCodexQualification(f.options)).toThrow('candidate_invalid_invocation');
    const lane = await prepareCodexQualification({ ...f.options, reuseExistingHome: true });
    expect(await lane.run()).toMatchObject({ status: 'completed', observedRequests: 3, registeredSessions: 2 });
    expect(f.sourceReadSpy.mock.calls.some(([path]) => path === prior)).toBe(false);
    expect(readFileSync(prior, 'utf8')).toBe('PRIVATE_UNRELATED_PRIOR_SOURCE');
  } finally { f.cleanup(); }
});

test('reusing a home cannot admit a pre-existing exact callback source before bounded content reads', async () => {
  const f = fixture(); const prior = join(f.options.sessionsRoot, '00000000-0000-0000-0000-000000000001.jsonl');
  writeFileSync(prior, 'PRIVATE_PREEXISTING_ROOT');
  try {
    const lane = await prepareCodexQualification({ ...f.options, reuseExistingHome: true }); const result = await lane.run();
    expect(result.status).not.toBe('completed'); expect(result.observedRequests).toBe(0);
    expect(f.sourceReadSpy.mock.calls.some(([path]) => path === prior)).toBe(false);
    expect(f.store.all('SELECT * FROM sessions')).toHaveLength(0);
  } finally { f.cleanup(); }
});

test.each(['wire-mismatch','permissions-missing','profile-write','profile-disabled','split-write','permission-relaxation'])('declared permissions %s stop before baseline/ack or later collection', async mode => {
  const f=fixture(mode);try{
    const lane=await prepareCodexQualification(f.options);const result=await lane.run();
    expect(result.status).toBe('stopped');expect(result.reason).toMatch(/^candidate_permission/);
    if(mode!=='permission-relaxation')expect(f.store.eventCount()).toBe(0);
  }finally{f.cleanup();}
});


test.each(['wire-unknown','wire-missing','source-malformed'])('result diagnoses %s using only fixed safe fields/enums', async mode => {
  const f=fixture(mode);try{
    const lane=await prepareCodexQualification(f.options);const result=await lane.run();
    const encoded=JSON.stringify(result.diagnostics);
    expect(result.status).toBe('stopped');expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining(
      mode==='source-malformed'?{phase:'source_metadata',code:'candidate_source_metadata_invalid'}:{phase:'handshake_schema',field:'permission_mode',wireMode:mode==='wire-unknown'?'unknown':'missing'})]));
    expect(encoded).not.toContain('PRIVATE_');expect(encoded).not.toContain(f.dir);expect(encoded).not.toContain('00000000-0000');
  }finally{f.cleanup();}
});


test('narrow source declaration rejects enabled network, unrestricted/external/unknown profiles and conflicting split while accepting read/deny entries', () => {
  const context={approval_policy:'never',approvals_reviewer:'user',sandbox_policy:{type:'read-only'},permission_profile:{type:'managed',file_system:{type:'restricted',entries:[{path:{type:'special',value:{kind:'root'}},access:'read'},{path:{type:'path',path:'/synthetic/private'},access:'deny'}]},network:'restricted'}};
  expect(checkCandidatePermissions(context,'bypassPermissions')).toMatchObject({declaration:'managed_read_only_restricted',approvalPolicy:'never',reviewer:'user'});
  const changed:Record<string,unknown>[]=[
    {...context,sandbox_policy:{type:'read-only',network_access:true}},
    {...context,permission_profile:{...context.permission_profile,network:'enabled'}},
    {...context,permission_profile:{...context.permission_profile,file_system:{type:'unrestricted'}}},
    {...context,permission_profile:{type:'external',network:'restricted'}},
    {...context,permission_profile:{...context.permission_profile,file_system:{type:'restricted',entries:[{path:{type:'special',value:{kind:'unknown',path:'PRIVATE_UNKNOWN'}},access:'read'}]}}},
    {...context,file_system_sandbox_policy:{kind:'restricted',entries:[]}},
  ];
  for(const declaration of changed)expect(()=>checkCandidatePermissions(declaration,'bypassPermissions')).toThrow('candidate_permissions_invalid');
});


test('permission relaxation appended between handoff validation and Collector read is rejected on the exact projected bytes', async () => {
  const f=fixture();const realRead=readSyntheticSource;let reads=0;let injected=false;
  const acknowledgments=vi.spyOn(Socket.prototype,'end');
  const spy=vi.spyOn(collection,'readSource').mockImplementation(path=>{
    if(path===join(f.options.sessionsRoot,'00000000-0000-0000-0000-000000000001.jsonl')&&++reads===2){
      const row=JSON.parse(readFileSync(path,'utf8').split('\n')[1]!) as {timestamp:string;payload:{permission_profile:{file_system:{entries:{access:string}[]}}}};
      row.timestamp=new Date().toISOString();row.payload.permission_profile.file_system.entries[0]!.access='write';
      appendFileSync(path,JSON.stringify(row)+'\n');injected=true;
    }
    return realRead(path);
  });
  try{const lane=await prepareCodexQualification(f.options);const result=await lane.run();
    expect(injected).toBe(true);expect(acknowledgments.mock.calls.some(args=>args[0]==='ok\n')).toBe(false);expect(result).toMatchObject({status:'stopped',reason:'candidate_permissions_invalid',observedRequests:0});
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({phase:'permissions',field:'permission_profile',wireMode:'bypassPermissions'})]));
  }finally{spy.mockRestore();acknowledgments.mockRestore();f.cleanup();}
});


test.each(['timing-slow','timing-legacy','timing-callback-first'])('stage timing %s preserves slow root reasoning and accepts callback/progress in either order', async mode=>{
  const f=fixture(mode);try{await f.primeNative();const lane=await prepareCodexQualification(f.options);const result=await lane.run();
    expect(result,JSON.stringify({result,timing:f.timing()})).toMatchObject({status:'completed',reason:null,observedRequests:3,registeredSessions:2});
    expect(lane.argv.at(-1)).toContain('V2: fork_turns="none"');expect(lane.argv.at(-1)).toContain('V1: fork_context=false');
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({phase:'progress',code:'candidate_spawn_progress_observed'})]));
    const exported=JSON.stringify(result)+JSON.stringify(f.store.all('SELECT payload FROM runtime_evidence'));
    expect(exported).not.toContain('PRIVATE_');expect(exported).not.toContain('/synthetic/child');expect(exported).not.toContain('00000000-0000');
  }finally{f.cleanup();}
},12000);

test('stage timing starts the bounded missing-child wait only after independently observed persisted spawn progress',async()=>{
  const f=fixture('timing-missing-child');try{await f.primeNative();const lane=await prepareCodexQualification(f.options);const result=await lane.run();
    expect(result).toMatchObject({status:'stopped',reason:'candidate_missing_child_handshake',registeredSessions:1});
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({phase:'progress',code:'candidate_spawn_progress_observed'})]));
    expect(result.elapsedMs).toBeGreaterThan(4000);expect(result.elapsedMs).toBeLessThan(8000);
    await expect(lane.run()).rejects.toThrow('candidate_root_already_started');
  }finally{f.cleanup();}
},12000);

test.each(['timing-no-progress','timing-unknown'])('stage timing %s stays unknown and cannot reset or extend the absolute root deadline',async mode=>{
  const f=fixture(mode);try{
    // Interpreter startup is setup; keep the handoff and absolute runner deadlines unchanged.
    await f.primeNative();const lane=await prepareCodexQualification(f.options);const result=await lane.run();
    expect(result,JSON.stringify({result,timing:f.timing()})).toMatchObject({reason:'candidate_timed_out',registeredSessions:1,observedRequests:0});expect(result.elapsedMs).toBeGreaterThanOrEqual(4300);expect(result.elapsedMs).toBeLessThan(6500);
    expect(result.diagnostics.some(d=>d.code==='candidate_spawn_progress_observed')).toBe(false);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_');await expect(lane.run()).rejects.toThrow('candidate_root_already_started');
  }finally{f.cleanup();}
},12000);

test('stage timing explicitly disabled multi-agent declaration stops distinctly without treating root acknowledgment as tool/auth readiness',async()=>{
  const f=fixture('timing-disabled');try{await f.primeNative();const lane=await prepareCodexQualification(f.options);const result=await lane.run();
    expect(result).toMatchObject({status:'stopped',reason:'candidate_multi_agent_disabled',observedRequests:0});
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({phase:'capability',field:'multi_agent_version',code:'candidate_multi_agent_disabled'})]));
  }finally{f.cleanup();}
},12000);

test.each(['timing-extra','timing-late-reader','timing-conflict','timing-wrong-turn','timing-permissions'])('stage timing %s preserves scope/permission checks before trusting progress',async mode=>{
  const f=fixture(mode);try{await f.primeNative();const lane=await prepareCodexQualification(f.options);const result=await lane.run();
    expect(result.reason).toBe({'timing-extra':'candidate_unapproved_spawn','timing-late-reader':'candidate_missing_child_handshake','timing-conflict':'candidate_unapproved_handshake','timing-wrong-turn':'candidate_scope_mismatch','timing-permissions':'candidate_permissions_invalid'}[mode]);
    if(mode==='timing-conflict')expect(result.registeredSessions).toBe(1);
    if(mode==='timing-late-reader')expect(result.observedRequests).toBe(1);
    if(mode==='timing-permissions')expect(result.diagnostics.some(d=>d.code==='candidate_spawn_progress_observed')).toBe(false);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_');
  }finally{f.cleanup();}
},12000);

test('stage timing elapsed absolute deadline before invocation skips launch and durable reservation',async()=>{
  const f=fixture();f.options.durationMs=4500;f.options.handshakeTimeoutMs=4000;const realNow=Date.now;let reads=0;const clock=vi.spyOn(Date,'now').mockImplementation(()=>realNow()+(reads++===0?0:5000));
  try{const lane=await prepareCodexQualification(f.options);const result=await lane.run();
    expect(result.reason).toBe('candidate_timed_out');expect(result.registeredSessions).toBe(0);
    expect(existsSync(join(f.options.ledgerDirectory,'codex-candidate','root.reserved'))).toBe(false);
    expect(f.store.eventCount()).toBe(0);
  }finally{clock.mockRestore();f.cleanup();}
});


test('whole qualification preserves sanitized native failure signals without changing failed status or retrying', async () => {
  const f=fixture('diagnostic-native-error');try {
    const lane=await prepareCodexQualification(f.options);const result=await lane.run();
    expect(result).toMatchObject({status:'failed',reason:'candidate_failed',registeredSessions:1,observedRequests:0,nativeFailureDiagnostics:{channel:'stderr',signals:[{category:'auth_failed',code:'http_401'}],unknownErrorObserved:false,truncated:false}});
    expect(JSON.stringify(result)).not.toContain('PRIVATE');expect(f.store.eventCount()).toBe(0);
    await expect(lane.run()).rejects.toThrow('candidate_root_already_started');
  }finally{f.cleanup();}
});
