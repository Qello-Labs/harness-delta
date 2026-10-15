import {createHash} from 'node:crypto';
import {openSync,closeSync,unlinkSync,mkdtempSync,realpathSync,mkdirSync,writeFileSync,rmSync,readFileSync,existsSync,statSync} from 'node:fs';
import {spawn,type ChildProcess} from 'node:child_process';
import {join,resolve} from 'node:path';
import {vi} from 'vitest';
import {Store} from '../../src/store.js';
import {Lifecycle} from '../../src/lifecycle.js';
import * as collection from '../../src/collection.js';
import type {CodexQualificationOptions} from '../../src/codex-qualification.js';
const readSyntheticSource=collection.readSource;
export function codexQualificationFixture(mode = 'success') {
  const dir = realpathSync(mkdtempSync('/tmp/hdcq-'));
  const cwd = join(dir, 'fixture'); const ledger = join(dir, 'ledger'); const codexHome = join(dir, 'codex-home'); mkdirSync(codexHome); const sessionsRoot = join(codexHome, 'sessions');
  for (const path of [cwd, ledger, sessionsRoot]) mkdirSync(path);
  const store = new Store(join(ledger, 'measurement.sqlite')); const lifecycle = new Lifecycle(store);
  lifecycle.registerProject('p', cwd);
  lifecycle.createTask('p', 't', { type: 'feature', expected_size: 'small', assignee: 'synthetic-user', product: 'codex', model: 'gpt-6-astra', criterion_ids: ['c'] });
  lifecycle.start('t');
  const script = join(dir, 'fake.mjs'); const executable = join(dir, 'fake-codex'); const hookPreloader=join(dir,'hook-ready.mjs'); const timingPath=join(dir,'synthetic-timing.jsonl');
  writeFileSync(script, `
import {writeFileSync,appendFileSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {spawn,spawnSync} from 'node:child_process';
const trace=${JSON.stringify(timingPath)};
const mark=(phase,extra={})=>appendFileSync(trace,JSON.stringify({phase,at:Date.now(),...extra})+'\\n');mark('node_ready');
const mode=${JSON.stringify(mode)}, dir=${JSON.stringify(sessionsRoot)}, cwd=${JSON.stringify(cwd)};
const hookCommand=values=>values.find(value=>value.startsWith('hooks.SessionStart=')).match(/command="([^"]+)"/)[1];
let args=process.argv.slice(2), primedCommand;let primedHooks=[];
function primeHook(command){return new Promise((resolve,reject)=>{
  const child=spawn(command,[],{stdio:['pipe','ignore','pipe','ipc'],env:{...process.env,NODE_OPTIONS:(process.env.NODE_OPTIONS??'')+' --import='+JSON.stringify(process.env.HD_SYNTHETIC_HOOK_READY_IMPORT)}});
  const failed=error=>{child.off('message',ready);child.off('exit',exited);reject(error);};
  const exited=()=>failed(new Error('synthetic_hook_exited_before_ready'));
  const ready=()=>{child.off('error',failed);child.off('exit',exited);mark('hook_ready',{pid:child.pid});resolve(child);};
  child.once('error',failed);child.once('exit',exited);child.once('message',ready);
});}
if(process.send){
  await new Promise(resolve=>setTimeout(resolve,Number(process.env.HD_SYNTHETIC_SETUP_DELAY_MS??0)));
  const primeArgs=JSON.parse(process.env.HD_SYNTHETIC_PRIME_ARGS);
  primedCommand=hookCommand(primeArgs);primedHooks=await Promise.all([primeHook(primedCommand),primeHook(primedCommand)]);
  const launched=new Promise(resolve=>process.once('message',resolve));process.send({ready:true});const launch=await launched;args=launch.args;
  // Preserve the native fresh-source contract: never create in the launch millisecond.
  while(Date.now()<launch.startedAt+2)await new Promise(resolve=>setTimeout(resolve,1));
}
const command=hookCommand(args);
if(primedCommand!==undefined&&primedCommand!==command)throw new Error('synthetic_hook_command_changed');
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
async function hook(id){const payload={session_id:root,transcript_path:path(id),cwd,hook_event_name:id===root?'SessionStart':'SubagentStart',model:id===root?'gpt-6-astra':mode==='settings'?'wrong':'gpt-6.1-sol',permission_mode:['auto-review','wire-mismatch','permissions-missing','profile-write','profile-disabled','split-write','permission-relaxation'].includes(mode)?'default':'bypassPermissions',...(id===root?{source:'startup'}:{turn_id:'child-turn',agent_id:id,agent_type:'default'})};
if(mode==='wire-unknown')payload.permission_mode='PRIVATE_WIRE_SENTINEL'; if(mode==='wire-missing')delete payload.permission_mode;
if(mode==='source-malformed')write(path(id),'PRIVATE_SOURCE_SENTINEL\\n',true);
if(id!==root){if(mode==='child-id-missing'||mode==='child-id-missing-path')delete payload.agent_id;
if(mode==='child-id-null')payload.agent_id=null;if(mode==='child-id-malformed')payload.agent_id='invalid-child-id';
if(mode==='child-id-missing-path')payload.transcript_path=dir+'/uncreated-child.jsonl';}
mark(id===root?'root_hook_start':'child_hook_start');
let result;
if(primedHooks.length){const child=primedHooks[id===root?0:1];
  const completed=new Promise((resolve,reject)=>{child.once('error',reject);child.stdin.once('error',reject);child.once('close',(status,signal)=>resolve({status,signal}));});
  child.send({activate:true});child.stdin.end(JSON.stringify(payload));result=await completed;
}else result=spawnSync(command,[],{input:JSON.stringify(payload),timeout:15000});
mark(id===root?'root_hook_end':'child_hook_end',{status:result.status,signal:result.signal,error:result.error?.code??null});if(result.status!==0)process.exit(3);}
create(root);
if(mode==='diagnostic-native-error'){await hook(root);process.stderr.write('ERROR: unexpected status 401 Unauthorized PRIVATE_SECRET\\n');process.exit(1);}
else if(mode.startsWith('timing-')){
  await hook(root);
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  function progress(call='spawn-1',target=child){const item={type:'SubAgentActivity',id:call,kind:'started',agent_thread_id:target,agent_path:'/synthetic/child'};
    write(path(root),row('event_msg',mode==='timing-legacy'?{type:'sub_agent_activity',event_id:call,kind:'started',agent_thread_id:target,agent_path:'/synthetic/child',occurred_at_ms:1}:{type:'item_completed',thread_id:root,turn_id:mode==='timing-wrong-turn'?'unapproved-turn':'root-turn',item,completed_at_ms:1}),true);}
  const input=()=>write(path(root),row('event_msg',{type:'item_completed',thread_id:root,turn_id:'root-turn',item:{type:'UserMessage',id:'input',content:'PRIVATE_INPUT_SENTINEL'}}),true);
  if(mode==='timing-no-progress'||mode==='timing-unknown'){input();setInterval(input,150);}
  else if(mode==='timing-disabled'){setTimeout(()=>process.exit(0),3000);}
  else {
    input();await wait(mode==='timing-callback-first'||mode==='timing-extra'||mode==='timing-late-reader'||mode==='timing-conflict'||mode==='timing-wrong-turn'||mode==='timing-permissions'?100:2200);response(root,'root-first');create(child,root);
    if(mode==='timing-permissions'){const relaxed=context(root);relaxed.permission_profile.file_system.entries[0].access='write';write(path(root),row('turn_context',relaxed),true);}
    if(mode==='timing-callback-first'){await hook(child);response(child,'child-own');await wait(1900);progress();await wait(1900);}
    else {progress('spawn-1',mode==='timing-conflict'?'00000000-0000-0000-0000-000000000003':child);await wait(100);if(mode==='timing-missing-child'){setInterval(input,150);}else {await hook(child);response(child,'child-own');}}
    if(mode==='timing-extra')progress('spawn-2','00000000-0000-0000-0000-000000000003');
    if(mode!=='timing-missing-child'){response(root,'root-final');process.exit(0);}
  }
}
else if(mode==='missing'){setTimeout(()=>process.exit(0),2500);}
else {if(mode==='late')response(root,'late'); if(mode==='late-partial')write(path(root),row('token_usage_record',{thread_id:root,response_id:'prior-own'}).slice(0,-1),true); await hook(root); response(root,'root-first');
create(child,root); await hook(child); response(child,'child-own');
if(mode==='permission-relaxation'){const relaxed=context(root);relaxed.permission_profile.file_system.entries[0].access='write';write(path(root),row('turn_context',relaxed),true);}
if(mode==='extra'){const extra='00000000-0000-0000-0000-000000000003';create(extra,root);await hook(extra);}
if(mode==='pause'||mode==='cancel'||mode==='source-error'||mode==='relink')setTimeout(()=>process.exit(0),1000);
else {response(root,'root-final');process.exit(mode==='nonzero'?2:0);}}
`);
  // Activation defers the recorder's own timeout until its real hook invocation.
  writeFileSync(hookPreloader,"import {once} from 'node:events';\nimport 'node:net';\nconst activated=once(process,'message');\nprocess.send({ready:true});\nawait activated;\n");
  writeFileSync(executable, `#!/bin/sh\n: > '${join(dir,'shell-ready')}'\nexec '${process.execPath}' '${script}' "$@"\n`, { mode: 0o700 });
  const sha256 = createHash('sha256').update(readFileSync(executable)).digest('hex');
  const options = { store, projectId: 'p', taskId: 't', cwd, ledgerDirectory: ledger, codexHome, sessionsRoot, executable, executableSha256: sha256,
    nodeExecutable: process.execPath, hookRecorder: resolve('scripts/conformance/candidate-start-recorder.mjs'), rootModel: 'gpt-6-astra', childModel: 'gpt-6.1-sol', rootEffort: 'high', childEffort: 'high', durationMs: 15000, handshakeTimeoutMs: 10000, pollMs: 10 } satisfies CodexQualificationOptions;
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
  async function primeNative(argv:readonly string[],startupDelayMs=0){
    // Interpreter startup is fixture setup; the real runner still owns its
    // reservation, process-group teardown and unchanged handoff/deadline clocks.
    const native=spawn(process.execPath,[script],{detached:true,stdio:['ignore','ignore','pipe','ipc'],env:{...process.env,HD_SYNTHETIC_SETUP_DELAY_MS:String(startupDelayMs),HD_SYNTHETIC_PRIME_ARGS:JSON.stringify(argv),HD_SYNTHETIC_HOOK_READY_IMPORT:hookPreloader}});primedNative=native;
    await new Promise<void>((ok,no)=>{
      const clear=()=>{clearTimeout(timer);native.off('message',ready);native.off('error',failed);native.off('exit',exited);};
      const ready=()=>{clear();ok();};const failed=(error:Error)=>{clear();no(error);};
      const exited=()=>failed(new Error('synthetic_fixture_exited_before_ready'));
      const timer=setTimeout(()=>failed(new Error('synthetic_fixture_startup_timeout')),15000);
      native.once('message',ready);native.once('error',failed);native.once('exit',exited);
    });
    vi.mocked(spawn).mockImplementationOnce((command,args)=>{if(command!==executable)throw new Error('unexpected_fixture_executable');native.send({args,startedAt:Date.now()});return native;});
    return native;
  }
  const timing=()=>({shellReadyAt:existsSync(join(dir,'shell-ready'))?statSync(join(dir,'shell-ready')).birthtimeMs:null,marks:existsSync(timingPath)?readFileSync(timingPath,'utf8').trim().split('\n').map((line):unknown=>JSON.parse(line)):[]});
  return { dir, store, lifecycle, options, sourceReadSpy, timingPath, timing, primeNative, cleanup: () => { if(primedNative?.pid){try{process.kill(-primedNative.pid,'SIGKILL');}catch(error){if(!(error instanceof Error)||!('code' in error)||error.code!=='ESRCH')throw error;}}vi.mocked(spawn).mockReset();sourceReadSpy.mockRestore();clockSpy?.mockRestore();store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
