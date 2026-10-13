import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { evaluateReadiness, productionSourceEvidence, type ReadinessInput } from '../src/readiness.js';
import { evaluateCostCoverage } from '../src/cost-coverage.js';
import { createCodexWorkflowAdapter, pinnedCodexWorkflowBinarySha } from '../src/codex-workflow-adapter.js';
import { beginAssignedWorkflow, workflowStatus } from '../src/task-workflow.js';
import { registerPriceTable } from '../src/pricing.js';
import { readObservedCostReport } from '../src/observed-cost-report.js';
import { parseCodexCandidateRollout } from '../src/codex-candidate-rollout.js';
import { checkedCandidateScope } from '../src/nested-candidate.js';
import { putUsageWithEvidence } from '../src/runtime-history.js';
import * as collection from '../src/collection.js';
import { makeFlexibleFixture } from './helpers/flexible-fixture.js';
import { codexWorkflowFixture } from './helpers/codex-workflow-fixture.js';
import { codexNativeChildFixture } from './helpers/codex-native-child-fixture.js';
import { compiledWorker } from './helpers/compiled-worker.js';

const childProfile='codex-workflow-direct-child-v1';
const childEvidence='codex-workflow-01600-direct-child-native-v1';
const profile={product:'codex' as const,product_version:'0.160.0',profile_id:childProfile};
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const permissions={sandbox_policy:{type:'read-only'},approval_policy:'on-request',approvals_reviewer:'auto_review',
  permission_profile:{type:'managed',file_system:{type:'restricted',entries:[{path:{type:'special',value:{kind:'root'}},access:'read'}]},network:'restricted'}};

// Admission fixtures model the pinned runtime independently of the test runner.
const nodeVersion=process.versions.node;
beforeEach(()=>{Object.defineProperty(process.versions,'node',{value:'24.21.0'});});
afterEach(()=>{Object.defineProperty(process.versions,'node',{value:nodeVersion});});

test('verified direct-child evidence admits only exact partial source allocation and wired status',()=>{
  const f=makeFlexibleFixture();const input:ReadinessInput={protocol:{...f.protocol,purpose:'real_experiment',source_profiles:[profile]},source_evidence_ids:[childEvidence],
    coverage:[{evidence:f.coverage,decision:evaluateCostCoverage(f.coverage)}],analysis_evidence_id:null,invalidated:false,followup_complete:true};
  expect(evaluateReadiness(input)).toMatchObject({real_allocation:true,complete_cost:false,inference:false});
  expect(productionSourceEvidence.find(r=>r.id===childEvidence)).toEqual({...profile,id:childEvidence,validation_kind:'real_operations',complete_cost:false,
    semantics_digest:'f60bfac70ddc3c4054d0f104386a07d438dab5d2bc4a1ebbfb297a9fbc6a839b'});
  for(const mismatch of [{...profile,product_version:'0.160.1'},{...profile,profile_id:'codex-all-children-v1'},{...profile,product:'claude_code' as const}]){
    expect(evaluateReadiness({...input,protocol:{...input.protocol,source_profiles:[mismatch]}})).toMatchObject({real_allocation:false,complete_cost:false,inference:false});
  }
  const db=codexWorkflowFixture(childProfile);try{
    expect(workflowStatus(db.store,'comparison-1')).toMatchObject({native_execution:true,readiness:{real_allocation:true,complete_cost:false,inference:false}});
    expect(workflowStatus(db.store,'comparison-1').blockers).not.toContain('native_adapter_not_wired');
  }finally{db.cleanup();}
});

// The fake executable below is only a trusted synthetic CLI dependency. The
// public production entry is exercised separately without starting a product.
test('assigned CLI fresh-child launch applies the sticky harness and preserves flexible runtimes',async()=>{
  const f=codexNativeChildFixture('native-start');try{
    const compiled=compiledWorker(f.root);const entry=join(f.root,'synthetic-cli.mjs');
    writeFileSync(entry,`import {main} from ${JSON.stringify(join(compiled,'cli.js'))};import {createSyntheticCodexWorkflowAdapter} from ${JSON.stringify(join(compiled,'codex-workflow-adapter.js'))};process.exitCode=await main(process.argv.slice(2),{codexAdapter:(store,input)=>createSyntheticCodexWorkflowAdapter(store,input,${JSON.stringify(f.script)})});`);
    const config=join(f.root,'workflow.json');const runtime=join(f.root,'runtime.json');const execution=join(f.root,'execution.json');
    writeFileSync(config,JSON.stringify(f.input));writeFileSync(runtime,JSON.stringify({model:'root-user-choice',effort:'medium'}));writeFileSync(execution,JSON.stringify(f.execution));
    const launched=await call(entry,f.database,['workflow','codex','launch','--config',config,'--runtime',runtime,'--execution',execution]);
    expect(launched.code,launched.stderr+launched.stdout).toBe(0);expect(JSON.parse(launched.stdout)).toMatchObject({adapter_result:{state:'completed',observed_requests:3}});
    expect(f.store.all('SELECT id FROM comparison_assignments')).toHaveLength(1);expect(f.store.all('SELECT DISTINCT task_id FROM events')).toEqual([{task_id:'task-1'}]);
    expect(f.store.all<{payload:string}>('SELECT payload FROM runtime_evidence').map(r=>JSON.parse(r.payload) as unknown)).toEqual(expect.arrayContaining([
      expect.objectContaining({model:'root-user-choice',effort:'medium'}),expect.objectContaining({model:'child-user-choice',effort:'low'})]));
    expect(launched.stdout).not.toContain('SYNTHETIC_PRIVATE');
  }finally{f.cleanup();}
},15000);

const call=(entry:string,database:string,args:string[])=>new Promise<{code:number|null;stdout:string;stderr:string}>((ok,no)=>{
  const worker=spawn(process.execPath,[entry,'--db',database,...args],{stdio:['ignore','pipe','pipe']});let stdout='';let stderr='';
  worker.stdout.on('data',chunk=>{stdout+=String(chunk);});worker.stderr.on('data',chunk=>{stderr+=String(chunk);});worker.on('error',no);worker.on('exit',code=>ok({code,stdout,stderr}));
});

function seededProductionFamily(){
  const f=codexWorkflowFixture(childProfile);const prepared=beginAssignedWorkflow(f.store,f.input,{model:null,effort:null});
  const root=f.newRoot();const kid={id:randomUUID(),path:join(f.home,'sessions','synthetic-child.jsonl')};
  const turn=randomUUID();const childTurn=randomUUID();const started=new Date(Date.now()-1000).toISOString();
  const row=(type:string,payload:unknown,at=new Date().toISOString())=>JSON.stringify({timestamp:at,type,payload})+'\n';
  const usage=(id:string,ownTurn:string,at?:string)=>row('token_usage_record',{session_id:root.id,thread_id:id,turn_id:ownTurn,root_turn_id:turn,response_id:randomUUID(),
    usage:{input_tokens:10,cached_input_tokens:2,cache_write_input_tokens:0,output_tokens:3,reasoning_output_tokens:1,total_tokens:13}},at);
  appendFileSync(root.path,row('event_msg',{type:'task_started',turn_id:turn})+row('turn_context',{cwd:f.project,turn_id:turn,model:'root-choice',effort:'medium',multi_agent_version:'v2',...permissions},started)+
    row('event_msg',{type:'item_completed',thread_id:root.id,turn_id:turn,item:{type:'SubAgentActivity',kind:'started',id:'synthetic-spawn',agent_thread_id:kid.id}})+usage(root.id,turn));
  writeFileSync(kid.path,row('session_meta',{id:kid.id,session_id:root.id,parent_thread_id:root.id,cli_version:'0.160.0',cwd:f.project,source:{subagent:{thread_spawn:{parent_thread_id:root.id,depth:1}}}})+
    row('turn_context',{cwd:f.project,turn_id:childTurn,root_turn_id:turn,model:'child-choice',effort:'low',multi_agent_version:'v2',...permissions},started)+usage(kid.id,childTurn));
  for(const s of [{...root,parent:null},{...kid,parent:root.id}])f.store.execute('INSERT INTO sessions(id,project_id,task_id,parent_id,source_path,product,product_version) VALUES (?,?,?,?,?,?,?)',[s.id,'project-1','task-1',s.parent,s.path,'codex','0.160.0']);
  const scope=checkedCandidateScope({projectId:'project-1',taskId:'task-1',allowedRootTurnIds:[turn],sessions:[{sessionId:root.id,rootSessionId:root.id,parentSessionId:null,sourceId:root.id,product:'codex',nativeSessionId:root.id,processId:null,agentId:null},
    {sessionId:kid.id,rootSessionId:root.id,parentSessionId:root.id,sourceId:kid.id,product:'codex',nativeSessionId:kid.id,processId:null,agentId:null}]});
  for(const s of [root,kid])for(const r of parseCodexCandidateRollout(readFileSync(s.path,'utf8'),scope,s.id,f.project,new Date().toISOString()).records)putUsageWithEvidence(f.store,r.projection.event,r.projection.runtime);
  const checkpoint=(path:string)=>{const bytes=readFileSync(path);const stat=lstatSync(path);return [`${stat.dev}:${stat.ino}`,bytes.length,hash(bytes.toString('utf8'))];};
  f.store.execute("INSERT INTO codex_workflow_runs(id,task_id,project_id,session_id,source_path,source_identity,source_size,source_prefix_hash,confirmation_id,purpose,generation,operation,state,instruction_manifest_hash,application,started_at,ended_at,scope_verified,identity_verified,observed_requests) VALUES ('seed-launch','task-1','project-1',?,?,?,?,?,?,'development',1,'launch','completed',?,'invocation_settings_verified',?,?,1,1,2)",
    [root.id,root.path,...checkpoint(root.path),f.input.confirmation_id,prepared.receipt.instruction_manifest_hash,started,new Date().toISOString()]);
  f.store.execute("INSERT INTO codex_workflow_children(run_id,session_id,task_id,project_id,source_path,source_identity,source_size,source_prefix_hash) VALUES ('seed-launch',?,'task-1','project-1',?,?,?,?)",[kid.id,kid.path,...checkpoint(kid.path)]);
  const execution=(id:string)=>({...f.execution(id,'collect',root.id),sandbox:'read-only' as const,binary:{path:realpathSync(process.execPath),sha256:pinnedCodexWorkflowBinarySha}});
  return {...f,rootSession:root,kid,turn,childTurn,execution,append:()=>{appendFileSync(root.path,usage(root.id,turn));appendFileSync(kid.path,usage(kid.id,childTurn));},appendChild:()=>{appendFileSync(kid.path,usage(kid.id,childTurn));},appendExcluded:()=>{appendFileSync(root.path,usage(root.id,turn,started));appendFileSync(kid.path,usage(kid.id,childTurn,started));}};
}

test('production CLI recollects only its durable child, stops and reopens without duplicate usage or complete-cost claims',async()=>{
  const f=seededProductionFamily();try{
    const compiled=compiledWorker(f.root);const entry=join(f.root,'pinned-runtime-cli.mjs');const config=join(f.root,'workflow.json');const runtime=join(f.root,'runtime.json');const execution=join(f.root,'execution.json');
    writeFileSync(entry,`Object.defineProperty(process.versions,'node',{value:'24.21.0'});const {main}=await import(${JSON.stringify(join(compiled,'cli.js'))});process.exitCode=await main(process.argv.slice(2));`);
    writeFileSync(runtime,JSON.stringify({model:null,effort:null}));
    const args=(id:string)=>{writeFileSync(config,JSON.stringify({...f.input,confirmation_id:id+'-confirmation'}));writeFileSync(execution,JSON.stringify(f.execution(id)));return ['workflow','codex','collect','--config',config,'--runtime',runtime,'--execution',execution];};
    const waitBound=async(id:string)=>{await vi.waitFor(()=>expect(f.store.get('SELECT identity_verified FROM codex_workflow_runs WHERE id=?',[id])).toEqual({identity_verified:1}),{timeout:4000});};
    const collecting=call(entry,f.database,args('public-child-collect'));await waitBound('public-child-collect');f.appendExcluded();
    const excludedSize=lstatSync(f.kid.path).size;await vi.waitFor(()=>expect(f.store.get('SELECT source_size FROM codex_workflow_children WHERE run_id=?',['public-child-collect'])).toEqual({source_size:excludedSize}));expect(f.store.eventCount()).toBe(2);f.append();await vi.waitFor(()=>expect(f.store.eventCount()).toBe(4));
    expect((await call(entry,f.database,['workflow','codex','stop','public-child-collect'])).code).toBe(0);const collected=await collecting;
    expect(collected.code,collected.stderr+collected.stdout).toBe(0);expect(JSON.parse(collected.stdout)).toMatchObject({reused:true,adapter_result:{state:'stopped',reason:'stop_requested',observed_requests:2}});
    const replaying=call(entry,f.database,args('public-child-replay'));await waitBound('public-child-replay');expect((await call(entry,f.database,['workflow','codex','stop','public-child-replay'])).code).toBe(0);
    const replayed=await replaying;expect(replayed.code,replayed.stderr+replayed.stdout).toBe(0);expect(JSON.parse(replayed.stdout)).toMatchObject({adapter_result:{state:'stopped',observed_requests:0}});
    expect(f.store.eventCount()).toBe(4);expect(f.store.all('SELECT id FROM runtime_evidence')).toHaveLength(4);expect(f.store.all('SELECT id FROM comparison_assignments')).toHaveLength(1);
    expect(f.store.all('SELECT DISTINCT task_id FROM events')).toEqual([{task_id:'task-1'}]);expect(f.store.all('SELECT session_id FROM comparison_confirmation_sessions WHERE confirmation_id=?',['public-child-replay-confirmation'])).toHaveLength(2);
    registerPriceTable(f.store,{id:'child-rates',version:'v1',currency:'USD',source_id:'synthetic-offline-only',as_of:'2026-01-01T00:00:00Z',unit_tokens:100,display_decimals:6,rounding:'half_even',entries:['root-choice','child-choice'].flatMap(model=>[
      {product:'codex' as const,model,component:'ordinary_input' as const,price_per_unit:'1'}, {product:'codex' as const,model,component:'cache_read' as const,price_per_unit:'2'}, {product:'codex' as const,model,component:'output' as const,price_per_unit:'4'}, {product:'codex' as const,model,component:'cache_write' as const,price_per_unit:'3'}])});
    const cost=readObservedCostReport(f.store,'task-1','child-rates',new Date(Date.now()+1000).toISOString(),'output-only-v1');
    expect(cost).toMatchObject({event_count:4,session_count:2,partial_amount:'0.48',legacy_unverified_partial_amount:'0.48',complete_amount:null,compatibility:{verified_events:2,legacy_unverified_events:2},coverage:{observed_components_priced:true}});
    expect(collected.stdout+replayed.stdout+JSON.stringify(cost)).not.toContain('SYNTHETIC_PRIVATE');
  }finally{f.cleanup();}
},15000);

test.each(['25.0.0','26.10.0','27.0.0'])('unqualified Node %s rejects production child collection before source access',version=>{
  const f=seededProductionFamily();const read=vi.spyOn(collection,'readSource');
  try{
    Object.defineProperty(process.versions,'node',{value:version});
    const adapter=createCodexWorkflowAdapter(f.store,f.execution('unqualified-runtime'));
    expect(()=>adapter.preflight?.({model:null,effort:null})).toThrow('codex_workflow_child_operation_unsupported');
    expect(read).not.toHaveBeenCalled();expect(f.store.eventCount()).toBe(2);
    expect(f.store.all('SELECT id FROM codex_workflow_runs')).toEqual([{id:'seed-launch'}]);
  }finally{read.mockRestore();f.cleanup();}
});

test.each(['resume','external-link','foreign-child','foreign-source','wrong-task','generation','orphan-binding','rewrite','deleted','new-turn','permissions','second-child','compaction','fork'])('production family rejects %s before measurement or unsafe source access',async mode=>{
  const f=seededProductionFamily();const read=vi.spyOn(collection,'readSource');try{
    let e:Record<string,unknown>=f.execution('reject-'+mode);
    if(mode==='resume')e={...e,operation:'resume',prompt_file:f.prompt};
    if(mode==='external-link')e={...e,operation:'link',source_path:f.rootSession.path,direct_child:{session_id:f.kid.id,source_path:f.kid.path}};
    if(mode==='foreign-child')e={...e,direct_child:{session_id:randomUUID(),source_path:f.kid.path}};
    if(mode==='foreign-source')e={...e,direct_child:{session_id:f.kid.id,source_path:f.rootSession.path}};
    if(mode==='orphan-binding')f.store.execute("DELETE FROM codex_workflow_children WHERE run_id='seed-launch'",[]);
    if(mode==='second-child')appendFileSync(f.rootSession.path,JSON.stringify({type:'event_msg',payload:{type:'item_completed',thread_id:f.rootSession.id,turn_id:f.turn,item:{type:'SubAgentActivity',kind:'started',id:'foreign-spawn',agent_thread_id:randomUUID()}}})+'\n');
    if(mode==='compaction')appendFileSync(f.kid.path,JSON.stringify({type:'compacted',payload:{}})+'\n');
    if(mode==='fork')appendFileSync(f.kid.path,JSON.stringify({type:'session_meta',payload:{forked_from_id:f.rootSession.id}})+'\n');
    if(mode==='rewrite')writeFileSync(f.kid.path,readFileSync(f.kid.path,'utf8').replace('child-choice','foreign-choice'));
    if(mode==='deleted')f.store.execute("INSERT INTO tombstones(kind,id,deleted_at) VALUES ('session',?,?)",[f.kid.id,new Date().toISOString()]);
    if(mode==='new-turn'||mode==='permissions')appendFileSync(f.kid.path,JSON.stringify({type:'turn_context',payload:{cwd:f.project,turn_id:mode==='new-turn'?randomUUID():f.childTurn,root_turn_id:f.turn,model:'child-choice',effort:'low',multi_agent_version:'v2',...permissions,...(mode==='permissions'?{sandbox_policy:{type:'workspace-write'}}:{})}})+'\n');
    const adapter=createCodexWorkflowAdapter(f.store,e);
    const context={taskId:mode==='wrong-task'?'foreign-task':'task-1',projectId:'project-1',projectRoot:f.project,generation:mode==='generation'?2:1,assignedVariantId:'variant-a',confirmationId:f.input.confirmation_id,instructionManifestHash:f.store.get<{instruction_manifest_hash:string}>("SELECT instruction_manifest_hash FROM codex_workflow_runs WHERE id='seed-launch'")!.instruction_manifest_hash,runtime:{model:null,effort:null},instructions:[],assertActive:()=>{}};
    if(['resume','external-link','foreign-child','foreign-source','wrong-task','generation','orphan-binding'].includes(mode)){
      await expect(adapter.run(context)).rejects.toThrow();expect(read).not.toHaveBeenCalled();expect(f.store.all('SELECT id FROM codex_workflow_runs')).toHaveLength(1);
    }else{expect(await adapter.run(context)).toMatchObject({state:'failed'});if(mode==='deleted')expect(read).not.toHaveBeenCalled();}
    expect(f.store.eventCount()).toBe(2);expect(f.store.all('SELECT id FROM runtime_evidence')).toHaveLength(2);
  }finally{read.mockRestore();f.cleanup();}
});

test('production direct-child launch reaches the pinned binary check without a product process or new identity',async()=>{
  const f=codexWorkflowFixture(childProfile);try{
    const e={...f.execution('production-guard'),sandbox:'read-only' as const,child_runtime:{model:'user-child-model',effort:'low'},binary:{path:realpathSync(process.execPath),sha256:pinnedCodexWorkflowBinarySha}};
    const {runAssignedWorkflow}=await import('../src/task-workflow.js');
    if(process.platform!=='darwin'||process.arch!=='arm64'){
      await expect(runAssignedWorkflow(f.store,f.input,createCodexWorkflowAdapter(f.store,e),{model:null,effort:null})).rejects.toThrow(/^codex_workflow_child_operation_unsupported$/);expect(f.store.all('SELECT id FROM codex_workflow_runs')).toHaveLength(0);return;
    }
    await expect(runAssignedWorkflow(f.store,f.input,createCodexWorkflowAdapter(f.store,e),{model:null,effort:null})).rejects.toThrow(/^binary_mismatch$/);
    expect(f.store.all('SELECT id FROM sessions')).toHaveLength(0);expect(f.store.eventCount()).toBe(0);expect(f.store.all('SELECT id FROM comparison_assignments')).toHaveLength(0);
    expect(f.store.all('SELECT id FROM codex_workflow_runs')).toHaveLength(0);
  }finally{f.cleanup();}
});


test('coordinator rechecks the selected profile if input mutates after admission',async()=>{
  const f=codexWorkflowFixture('codex-workflow-own-response-v1');try{
    const input:Record<string,unknown>={...f.execution('mutated-after-admission'),binary:{path:realpathSync(process.execPath),sha256:pinnedCodexWorkflowBinarySha},sandbox:'read-only'};
    let calls=0;const clock=()=>{if(++calls===2)input.child_runtime={model:'foreign-child-choice',effort:'high'};return new Date().toISOString();};
    const {runAssignedWorkflow}=await import('../src/task-workflow.js');
    // Skip only the local file preflight; the profile getter must stay live.
    const adapter=createCodexWorkflowAdapter(f.store,input);delete adapter.preflight;
    await expect(runAssignedWorkflow(f.store,f.input,adapter,{model:null,effort:null},clock)).rejects.toThrow('workflow_scope_revoked');
    expect(f.store.all('SELECT id FROM codex_workflow_runs')).toHaveLength(0);expect(f.store.all('SELECT id FROM sessions')).toHaveLength(0);
  }finally{f.cleanup();}
});


test('family snapshot samples its observation time after the child bounded read',async()=>{
  const f=seededProductionFamily();const original=collection.readSource;const now=Date.now();let appended=false;
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(now);
  const read=vi.spyOn(collection,'readSource').mockImplementation(path=>{
    if(path===f.kid.path&&!appended){appended=true;vi.setSystemTime(now+20);f.appendChild();}
    return original(path);
  });try{
    const adapter=createCodexWorkflowAdapter(f.store,f.execution('read-clock'));
    const result=adapter.run({taskId:'task-1',projectId:'project-1',projectRoot:f.project,generation:1,assignedVariantId:'variant-a',confirmationId:f.input.confirmation_id,
      instructionManifestHash:f.store.get<{instruction_manifest_hash:string}>("SELECT instruction_manifest_hash FROM codex_workflow_runs WHERE id='seed-launch'")!.instruction_manifest_hash,runtime:{model:null,effort:null},instructions:[],assertActive:()=>{}});
    const {stopCodexWorkflow}=await import('../src/codex-workflow-journal.js');stopCodexWorkflow(f.store,'read-clock');
    expect(await result).toMatchObject({state:'stopped',reason:'stop_requested',observed_requests:0});
    expect(f.store.eventCount()).toBe(2);
  }finally{read.mockRestore();vi.useRealTimers();f.cleanup();}
});
