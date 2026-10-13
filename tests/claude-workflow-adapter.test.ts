import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { ClaudeWorkflowExecutionSchema, createClaudeWorkflowAdapter, createSyntheticClaudeWorkflowAdapter, recoverClaudeWorkflow } from '../src/claude-workflow-adapter.js';
import { registerPriceTable } from '../src/pricing.js';
import { makeFlexibleFixture } from './helpers/flexible-fixture.js';
import { readObservedCostReport } from '../src/observed-cost-report.js';
import { runAssignedWorkflow, workflowStatus } from '../src/task-workflow.js';
import { Lifecycle } from '../src/lifecycle.js';
import { codexWorkflowFixture } from './helpers/codex-workflow-fixture.js';
import { compiledWorker } from './helpers/compiled-worker.js';
import { claudeWorkflowChildProfileId, claudeWorkflowProfileId } from '../src/claude-workflow-versions.js';

function fixture(mode='child',version='2.1.296',appVersion=version,nativeProfile?:string) {
  const f=codexWorkflowFixture(nativeProfile,'functional_pilot',nativeProfile?{product:'claude_code',productVersion:version}:undefined);const compiled=compiledWorker(f.root);const binary=join(f.root,'fake-claude');
  writeFileSync(binary,`#!${process.execPath}
if(process.argv.includes('--version')){console.log(${JSON.stringify(version+' (Claude Code)')});process.exit(0);}
const fs=require('node:fs');const cp=require('node:child_process');
(async()=>{const args=process.argv.slice(2);const get=k=>args.includes(k)?args[args.indexOf(k)+1]:undefined;const settings=JSON.parse(fs.readFileSync(get('--settings'),'utf8'));const env=settings.env;const resumed=args.includes('--resume');const native=get('--session-id')??get('--resume');
fs.appendFileSync(${JSON.stringify(join(f.root,'session-flags.log'))},JSON.stringify({native,flags:args.filter(a=>['--session-id','--resume','--no-session-persistence'].includes(a)),matcher:settings.hooks.SessionStart[0].matcher})+'\\n');const processId=JSON.parse(env.OTEL_RESOURCE_ATTRIBUTES_JSON??'null');
const resource=env.OTEL_RESOURCE_ATTRIBUTES;const pid=resource.split(',').find(x=>x.startsWith('harness_delta.process_id=')).slice('harness_delta.process_id='.length);
const token=Object.fromEntries(env.OTEL_EXPORTER_OTLP_HEADERS.split(',').map(x=>x.split('=')));
const endpoint=env.OTEL_EXPORTER_OTLP_ENDPOINT;let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
const instructions=fs.readFileSync(get('--append-system-prompt-file'),'utf8');if(!instructions.startsWith('SYNTHETIC_PRIVATE_HARNESS_')||!prompt.startsWith('SYNTHETIC_PRIVATE_TASK'))process.exit(3);
if(args.includes('--agents')&&fs.readFileSync(get('--append-subagent-system-prompt-file'),'utf8')!==instructions)process.exit(4);
const attrs=o=>Object.entries(o).filter(([,v])=>v!==undefined).map(([key,v])=>({key,value:typeof v==='string'?{stringValue:v}:typeof v==='boolean'?{boolValue:v}:{intValue:String(v)}}));
const post=async(route,body)=>{const res=await fetch(endpoint+route,{method:'POST',headers:{...token,'content-type':'application/json'},body:JSON.stringify(body)});if(!res.ok)process.exit(5);};
const hook=(name,extra={})=>{const cmd=settings.hooks[name][0].hooks[0].command;const res=cp.spawnSync('/bin/sh',['-c',cmd],{input:JSON.stringify({hook_event_name:name,session_id:native,cwd:process.cwd(),...extra})});if(res.status!==0||JSON.parse(res.stdout.toString()||'{}').continue===false)process.exit(6);};
const now=()=>new Date().toISOString();const base={'harness_delta.process_id':pid,'session.id':native,'app.version':${JSON.stringify(appVersion)}};
const log=(seq,name,extra={})=>({resourceLogs:[{scopeLogs:[{logRecords:[{attributes:attrs({...base,'event.name':name,'event.sequence':seq,'event.timestamp':now(),...extra})}]}]}]});
const startup=log(0,'managed_settings_resolved',{'managed_settings.trigger':'startup'});startup.resourceLogs[0].scopeLogs[0].logRecords[0].attributes.push({key:'managed_settings.sources',value:{arrayValue:{values:[]}}});
await post('/v1/logs',startup);
if(${JSON.stringify(mode)}==='hook-before-start'){for(let seq=1;seq<=12;seq++)await post('/v1/logs',log(seq,'synthetic-startup-note'));hook('SessionEnd');process.exit(7);}
hook('SessionStart',{source:resumed?'resume':'startup',model:get('--model')??'inherited-model'});
const trace=(id,child=false)=>{const end=BigInt(Date.now())*1000000n;return {name:'claude_code.llm_request',traceId:'1'.repeat(32),spanId:(child?'3':'2').repeat(16),startTimeUnixNano:String(end-1n),endTimeUnixNano:String(end),status:{code:0},attributes:attrs({...base,agent_id:child?'child-agent':undefined,request_id:pid+'-'+id,model:child?'child-model':get('--model')??'inherited-model',effort:child?'low':get('--effort'),input_tokens:30,cache_read_tokens:20,cache_creation_tokens:10,output_tokens:15,success:true,attempt:1})};};
const batch=s=>({resourceSpans:[{scopeSpans:[{spans:s}]}]});const first=batch([trace('root1')]);await post('/v1/traces',first);await post('/v1/traces',first);
const duplicateLog=log(1,'api_request',{request_id:pid+'-root1',input_tokens:99999,output_tokens:99999});await post('/v1/logs',duplicateLog);await post('/v1/logs',duplicateLog);
if(${JSON.stringify(mode)}==='resume-fails'&&resumed)process.exit(7);
if(${JSON.stringify(mode)}==='error'){await post('/v1/logs',log(2,'api_error'));process.exit(7);}
if(${JSON.stringify(mode)}==='incomplete'){const broken=trace('unfinished');broken.endTimeUnixNano='0';await post('/v1/traces',batch([broken]));process.exit(7);}
if(${JSON.stringify(mode)}==='wait'){fs.watch(__filename,()=>{});fs.writeFileSync(${JSON.stringify(join(f.root,'usage-ready'))},'ready');return;}
if(args.includes('--agents')&&${JSON.stringify(mode)}!=='no-agent'){hook('PreToolUse',{tool_name:'Agent',tool_use_id:'agent-use',tool_input:{subagent_type:'workflow-child',model:'child-model'}});hook('SubagentStart',{agent_id:'child-agent',agent_type:'workflow-child'});const child=batch([trace('child1',true)]);await post('/v1/traces',child);await post('/v1/traces',child);hook('SubagentStop',{agent_id:'child-agent',agent_type:'workflow-child'});await post('/v1/traces',batch([trace('root2')]));if(${JSON.stringify(mode)}==='second-child'){hook('PreToolUse',{tool_name:'Agent',tool_use_id:'agent-use-second',tool_input:{subagent_type:'workflow-child',model:'child-model'}});await post('/v1/traces',batch([trace('extra-child',true)]));}}
if(${JSON.stringify(mode)}!=='missing-end')hook('SessionEnd');process.exit(0);
})().catch(()=>process.exit(8));
`);chmodSync(binary,0o700);
  registerPriceTable(f.store,{...makeFlexibleFixture().priceTable,id:'claude-prices',entries:['root-model','child-model','inherited-model'].flatMap(model=>([['ordinary_input','2'],['cache_read','1'],['cache_write','3'],['output','4']] as const).map(([component,price_per_unit])=>({product:'synthetic',model,component,price_per_unit})))});
  const execution={operation:'launch',run_id:'claude-run',binary:{path:binary,version,sha256:createHash('sha256').update(readFileSync(binary)).digest('hex')},workspace:join(f.root,'claude-workspace'),mediator_path:join(compiled,'claude-probe-hook-mediator.js'),prompt_file:f.prompt,timeout_ms:12000,max_turns:3,request_limit:4,...(['child','second-child','no-agent'].includes(mode)?{child_runtime:{model:'child-model',effort:'low'}}:{})};
  const waitForUsage=()=>new Promise<void>((resolve,reject)=>{
    const watcher=watch(f.root,(_event,name)=>{if(name==='usage-ready'){clearTimeout(timeout);watcher.close();resolve();}});
    const timeout=setTimeout(()=>{watcher.close();reject(new Error('usage_ready_timeout'));},12000);
    watcher.once('error',error=>{clearTimeout(timeout);watcher.close();reject(error);});
  });
  return {...f,compiled,execution,waitForUsage};
}

test('native Claude gate rejects before task assignment, executable access and source reads',async()=>{
  const f=fixture();try{
    await expect(runAssignedWorkflow(f.store,f.input,createClaudeWorkflowAdapter(f.store,f.execution),{model:'root-model',effort:'high'})).rejects.toThrow('workflow_adapter_mismatch');
    expect(f.store.all('SELECT * FROM comparison_assignments')).toHaveLength(0);expect(f.store.all('SELECT * FROM claude_workflow_runs')).toHaveLength(0);expect(f.store.eventCount()).toBe(0);
  }finally{f.cleanup();}
});

for(const mode of ['root','child','error','incomplete','missing-end','hook-before-start'])test(`shared assigned Claude workflow handles ${mode} with a real synthetic process`,async()=>{
  const f=fixture(mode);try{
    const result=await runAssignedWorkflow(f.store,f.input,createSyntheticClaudeWorkflowAdapter(f.store,f.execution),{model:'root-model',effort:'high'});
    const success=['root','child'].includes(mode);const count=mode==='child'?3:mode==='hook-before-start'?0:1;expect(result.adapter_result).toMatchObject({state:success?'completed':mode==='missing-end'?'failed':'stopped',observed_requests:count,harness_application:mode==='hook-before-start'?'unapplied':'invocation_settings_verified'});
    if(mode==='hook-before-start'){expect(f.store.eventCount()).toBe(0);expect(result.complete_cost).toBeNull();return;}
    expect(result.complete_cost).toBeNull();expect(f.store.eventCount()).toBe(mode==='child'?3:1);
    const runtime=f.store.all<{model:string;effort:string}>("SELECT json_extract(payload,'$.model') AS model,json_extract(payload,'$.effort') AS effort FROM runtime_evidence ORDER BY rowid");expect(runtime[0]).toEqual({model:'root-model',effort:'high'});
    if(mode==='child')expect(runtime[1]).toEqual({model:'child-model',effort:'low'});
    expect(f.store.all('SELECT * FROM comparison_assignments')).toHaveLength(1);
    expect(f.store.all('SELECT * FROM comparison_confirmation_sessions')).toHaveLength(mode==='child'?2:1);
    const usage=JSON.parse(f.store.get<{payload:string}>('SELECT payload FROM events ORDER BY rowid LIMIT 1')!.payload) as {input_total:{value:number};product:string};expect(usage.input_total.value).toBe(60);expect(usage.product).toBe('synthetic');
    expect(f.store.all('SELECT * FROM observation_gaps')).not.toHaveLength(0);
    const table='claude-prices';
    const report=readObservedCostReport(f.store,result.task_id,table,new Date(Date.now()+2).toISOString(),'output-only-v1');
    expect(report).toMatchObject({event_count:mode==='child'?3:1,complete_amount:null,partial_amount:mode==='child'?'0.51':'0.17'});
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_PRIVATE');
    expect(()=>f.store.execute("INSERT INTO otel_processes(id,task_id) VALUES ('second-channel',?)",[result.task_id])).toThrow('claude_workflow_source_conflict');
    expect(()=>f.store.execute("INSERT INTO observation_runs(id,task_id) VALUES ('second-channel',?)",[result.task_id])).toThrow('claude_workflow_source_conflict');
    expect(()=>f.store.execute('UPDATE sessions SET source_path=? WHERE task_id=?',['/synthetic-source',result.task_id])).toThrow('claude_workflow_source_conflict');
  }finally{f.cleanup();}
},20000);

test('actual main CLI connects Claude assignment, launch, trace collector and durable stop',async()=>{
  const f=fixture('wait');try{
    const entry=join(f.root,'cli.mjs');writeFileSync(entry,`import {main} from ${JSON.stringify(join(f.compiled,'cli.js'))};import {createSyntheticClaudeWorkflowAdapter} from ${JSON.stringify(join(f.compiled,'claude-workflow-adapter.js'))};process.exitCode=await main(process.argv.slice(2),{claudeAdapter:createSyntheticClaudeWorkflowAdapter});`);
    const config=join(f.root,'config.json');const runtime=join(f.root,'runtime.json');const execution=join(f.root,'execution.json');writeFileSync(config,JSON.stringify(f.input));writeFileSync(runtime,JSON.stringify({model:null,effort:null}));writeFileSync(execution,JSON.stringify(f.execution));
    const call=(args:string[])=>new Promise<{code:number|null;stdout:string;stderr:string}>((ok,no)=>{const child=spawn(process.execPath,[entry,'--db',f.database,'workflow','claude',...args],{stdio:['ignore','pipe','pipe']});let stdout='';let stderr='';child.stdout.on('data',b=>{stdout+=String(b);});child.stderr.on('data',b=>{stderr+=String(b);});child.on('error',no);child.on('exit',code=>ok({code,stdout,stderr}));});
    // The subcommand must match the execution document's operation before anything is assigned.
    const mismatch=await call(['resume','--config',config,'--runtime',runtime,'--execution',execution]);
    expect(mismatch.code).not.toBe(0);expect(mismatch.stderr+mismatch.stdout).toContain('workflow_operation_mismatch');expect(f.store.all('SELECT * FROM comparison_assignments')).toHaveLength(0);
    const ready=f.waitForUsage();const launched=call(['launch','--config',config,'--runtime',runtime,'--execution',execution]);
    await Promise.race([ready,launched]);expect(f.store.eventCount()).toBe(1);
    expect((await call(['stop','claude-run'])).code).toBe(0);const stopped=await launched;expect(stopped.code,stopped.stderr+stopped.stdout).toBe(0);
    expect((JSON.parse(stopped.stdout) as {adapter_result:unknown}).adapter_result).toMatchObject({state:'stopped',reason:'stop_requested',observed_requests:1});
    expect(f.store.all('SELECT * FROM comparison_assignments')).toHaveLength(1);expect(stopped.stdout).not.toContain('SYNTHETIC_PRIVATE');
  }finally{f.cleanup();}
},20000);


test('a Claude workspace failure before launch reports its code and pauses the task it started',async()=>{
  const f=fixture('root');try{
    mkdirSync(f.execution.workspace,{mode:0o755});chmodSync(f.execution.workspace,0o755);
    const result=await runAssignedWorkflow(f.store,f.input,createSyntheticClaudeWorkflowAdapter(f.store,f.execution),{model:null,effort:null});
    expect(result).toMatchObject({state:'paused',activation_reverted:true,adapter_result:{state:'failed',reason:'claude_workflow_private_workspace_required',process_started:false}});
    expect(f.store.all('SELECT id FROM active_intervals WHERE ended_at IS NULL')).toEqual([]);
  }finally{f.cleanup();}
});
test('a recovered Claude run keeps its abandoned state after its live process stops',async()=>{
  const f=fixture('wait');try{
    const ready=f.waitForUsage();const launched=runAssignedWorkflow(f.store,f.input,createSyntheticClaudeWorkflowAdapter(f.store,f.execution),{model:null,effort:null});
    await Promise.race([ready,launched]);expect(f.store.eventCount()).toBe(1);
    expect(recoverClaudeWorkflow(f.store,'claude-run')).toMatchObject({state:'failed',reason:'abandoned'});
    await launched;
    expect(f.store.get('SELECT state,reason FROM claude_workflow_runs WHERE id=?',['claude-run'])).toEqual({state:'failed',reason:'abandoned'});
  }finally{f.cleanup();}
},20000);

test('the native Claude adapter admits a read-only direct child and reports its selected profile',()=>{
  const f=fixture('child');try{
    const adapter=createClaudeWorkflowAdapter(f.store,f.execution);
    expect(adapter.profileId).toBe(claudeWorkflowChildProfileId);
    expect(()=>adapter.preflight?.({model:null,effort:null})).not.toThrow();
    expect(()=>createClaudeWorkflowAdapter(f.store,{...f.execution,child_runtime:undefined}).preflight?.({model:null,effort:null})).not.toThrow();
    expect(f.store.all('SELECT * FROM comparison_assignments')).toHaveLength(0);
    expect(f.store.all('SELECT * FROM claude_workflow_runs')).toHaveLength(0);
  }finally{f.cleanup();}
});

test('native child preflight rejects workspace-edit without assignment or run rows',async()=>{
  const f=fixture('child','2.1.296','2.1.296',claudeWorkflowChildProfileId);try{
    const adapter=createClaudeWorkflowAdapter(f.store,{...f.execution,permissions:'workspace-edit'});
    expect(()=>adapter.preflight?.({model:'root-model',effort:'high'})).toThrow(/^claude_workflow_child_read_only_required$/);
    await expect(runAssignedWorkflow(f.store,f.input,adapter,{model:'root-model',effort:'high'}))
      .rejects.toThrow(/^claude_workflow_child_read_only_required$/);
    expect(f.store.all('SELECT * FROM comparison_assignments')).toHaveLength(0);
    expect(f.store.all('SELECT * FROM claude_workflow_runs')).toHaveLength(0);
  }finally{f.cleanup();}
});

test('a conditional functional pilot cannot preflight an unadmitted child',()=>{
  const f=fixture('child','2.1.297','2.1.297',claudeWorkflowProfileId);try{
    const adapter=createClaudeWorkflowAdapter(f.store,f.execution);
    expect(()=>adapter.preflight?.({model:'root-model',effort:'high'})).toThrow(/^claude_workflow_child_unadmitted$/);
    expect(f.store.all('SELECT * FROM comparison_assignments')).toHaveLength(0);
    expect(f.store.all('SELECT * FROM claude_workflow_runs')).toHaveLength(0);
  }finally{f.cleanup();}
});

test.each([[claudeWorkflowProfileId,'child'],[claudeWorkflowChildProfileId,'root']] as const)(
  'a %s protocol rejects the mismatched %s execution profile before assignment',async(profile,mode)=>{
    const f=fixture(mode,'2.1.296','2.1.296',profile);try{
      await expect(runAssignedWorkflow(f.store,f.input,createClaudeWorkflowAdapter(f.store,f.execution),{model:'root-model',effort:'high'}))
        .rejects.toThrow(/^workflow_adapter_mismatch$/);
      expect(f.store.all('SELECT * FROM comparison_assignments')).toHaveLength(0);
      expect(f.store.all('SELECT * FROM claude_workflow_runs')).toHaveLength(0);
    }finally{f.cleanup();}
  });

test.each(['child','second-child','no-agent'])('native direct-child assigned workflow handles %s with verified session and usage pins',async mode=>{
  const f=fixture(mode,'2.1.296','2.1.296',claudeWorkflowChildProfileId);try{
    expect(workflowStatus(f.store,f.input.assignment.protocol_id)).toMatchObject({native_execution:true,readiness:{complete_cost:false,inference:false}});
    const result=await runAssignedWorkflow(f.store,f.input,createClaudeWorkflowAdapter(f.store,f.execution),{model:'root-model',effort:'high'});
    const count=mode==='no-agent'?1:3;
    expect(result.adapter_result).toMatchObject({state:mode==='second-child'?'stopped':'completed',observed_requests:count});
    if(mode==='second-child')expect(result.adapter_result).toMatchObject({reason:'claude_probe_observation_stopped'});
    const sessions=f.store.all<{id:string;parent_id:string|null;product_version:string;profile:string;state:string}>(
      "SELECT s.id,s.parent_id,s.product_version,json_extract(c.payload,'$.profile_id') AS profile,json_extract(c.payload,'$.state') AS state FROM sessions s JOIN session_source_compatibility c ON c.session_id=s.id ORDER BY s.rowid");
    expect(sessions).toHaveLength(mode==='no-agent'?1:2);
    expect(sessions[0]).toMatchObject({parent_id:null,product_version:'2.1.296',profile:claudeWorkflowChildProfileId,state:'verified'});
    if(mode!=='no-agent')expect(sessions[1]).toMatchObject({parent_id:sessions[0]!.id,product_version:'2.1.296',profile:claudeWorkflowChildProfileId,state:'verified'});
    const usage=f.store.all<{session_id:string;product_version:string;profile:string;state:string;runtime_session:string;runtime_version:string;model:string;effort:string}>(
      "SELECT e.session_id,json_extract(e.payload,'$.product_version') AS product_version,json_extract(e.payload,'$.source_compatibility.profile_id') AS profile,json_extract(e.payload,'$.source_compatibility.state') AS state,r.session_id AS runtime_session,json_extract(r.payload,'$.product_version') AS runtime_version,json_extract(r.payload,'$.model') AS model,json_extract(r.payload,'$.effort') AS effort FROM events e JOIN runtime_evidence r ON r.id=json_extract(e.payload,'$.runtime_evidence_id') ORDER BY e.rowid");
    expect(f.store.eventCount()).toBe(count);expect(usage).toHaveLength(count);
    for(const row of usage){
      expect(row).toMatchObject({product_version:'2.1.296',runtime_version:'2.1.296',profile:claudeWorkflowChildProfileId,state:'verified',runtime_session:row.session_id});
    }
    expect(usage.filter(row=>row.session_id===sessions[0]!.id)).toHaveLength(mode==='no-agent'?1:2);
    expect(usage[0]).toMatchObject({model:'root-model',effort:'high'});
    if(mode!=='no-agent'){
      expect(usage.filter(row=>row.session_id===sessions[1]!.id)).toHaveLength(1);
      expect(usage[1]).toMatchObject({model:'child-model',effort:'low'});
    }
    expect(f.store.all('SELECT * FROM comparison_assignments')).toHaveLength(1);
    expect(f.store.all('SELECT * FROM comparison_confirmation_sessions')).toHaveLength(sessions.length);
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_PRIVATE');
  }finally{f.cleanup();}
},20000);
test('Claude execution limits follow the one-hour workflow bound and default to read-only',()=>{
  const f=fixture('root');try{
    const parsed=ClaudeWorkflowExecutionSchema.parse({...f.execution,timeout_ms:3600000,max_turns:1024,request_limit:1024});
    expect(parsed).toMatchObject({permissions:'read-only'});expect(parsed.max_budget_usd).toBeUndefined();
    for(const bad of [{timeout_ms:3600001},{request_limit:1025},{max_turns:1025},{permissions:'bash'},{max_budget_usd:0},{max_budget_usd:0.001}])
      expect(ClaudeWorkflowExecutionSchema.safeParse({...f.execution,...bad}).success).toBe(false);
  }finally{f.cleanup();}
});
test('pausing the task during a Claude run ends that run instead of leaving it running',async()=>{
  const f=fixture('wait');try{
    const ready=f.waitForUsage();const launched=runAssignedWorkflow(f.store,f.input,createSyntheticClaudeWorkflowAdapter(f.store,f.execution),{model:null,effort:null});
    await Promise.race([ready,launched]);expect(f.store.eventCount()).toBe(1);
    const taskId=f.store.get<{task_id:string}>('SELECT task_id FROM claude_workflow_runs WHERE id=?',['claude-run'])!.task_id;
    new Lifecycle(f.store).pause(taskId);
    // Pausing revokes the measurement scope; the shared orchestrator reports that, not an adapter failure.
    await expect(launched).rejects.toThrow(/^workflow_scope_revoked$/);
    // Either scope-loss detector (supervisor poll or gateway authorization) may end it first.
    const run=f.store.get<{state:string;reason:string}>('SELECT state,reason FROM claude_workflow_runs WHERE id=?',['claude-run'])!;
    expect(run.state).toBe('stopped');expect(['workflow_scope_revoked','claude_probe_observation_stopped']).toContain(run.reason);
    expect(f.store.eventCount()).toBe(1);
    // The in-flight interval after the last stored usage is marked at the pause itself.
    const usageAt=f.store.get<{at:string}>('SELECT max(occurred_at) AS at FROM events')!.at;
    const gaps=f.store.all<{reason:string;started_at:string}>("SELECT reason,started_at FROM observation_gaps WHERE reason='incomplete'");
    expect(gaps).toHaveLength(1);expect(Date.parse(gaps[0]!.started_at)).toBeGreaterThan(Date.parse(usageAt));
  }finally{f.cleanup();}
},20000);
test('a second Claude launch on the same task can reuse the workspace directory',async()=>{
  const f=fixture('root');try{
    const first=await runAssignedWorkflow(f.store,f.input,createSyntheticClaudeWorkflowAdapter(f.store,f.execution),{model:null,effort:null});
    expect(first.adapter_result).toMatchObject({state:'completed'});
    const second=await runAssignedWorkflow(f.store,{...f.input,confirmation_id:'confirmation-2'},createSyntheticClaudeWorkflowAdapter(f.store,{...f.execution,run_id:'claude-run-2'}),{model:null,effort:'low'});
    expect(second).toMatchObject({task_id:first.task_id,assigned_variant_id:first.assigned_variant_id,adapter_result:{state:'completed'}});
    expect(f.store.all('SELECT id FROM claude_workflow_runs')).toHaveLength(2);
  }finally{f.cleanup();}
},20000);

test('an already owned collection channel prevents Claude trace ownership before process launch',async()=>{
  const f=fixture('root');try{
    const native=createSyntheticClaudeWorkflowAdapter(f.store,f.execution);
    // A synthetic store rejects file sources outright, so a managed run is the other owner.
    await expect(runAssignedWorkflow(f.store,f.input,{...native,run:async c=>{
      const at=new Date().toISOString();
      f.store.execute("INSERT INTO sessions(id,task_id,project_id,product,product_version) VALUES ('managed-session',?,?,'synthetic','1.0.0')",[c.taskId,c.projectId]);
      f.store.execute("INSERT INTO observation_runs(id,project_id,task_id,session_id,generation,profile_id,state,started_at,updated_at,input_facts,output_facts) VALUES ('managed-run',?,?,'managed-session',?,'synthetic-managed-v1','running',?,?,'{}','{}')",[c.projectId,c.taskId,c.generation,at,at]);
      return native.run(c);
    }},{model:'root-model',effort:'high'})).rejects.toThrow(/^candidate_mixed_sources$/);
    expect(f.store.all('SELECT * FROM claude_workflow_runs')).toHaveLength(0);expect(f.store.eventCount()).toBe(0);
  }finally{f.cleanup();}
});
test('a 2.1.296 binary runs the shared workflow when its telemetry reports 2.1.296 and stops on another version',async()=>{
  const ok=fixture('root','2.1.296');try{
    const result=await runAssignedWorkflow(ok.store,ok.input,createSyntheticClaudeWorkflowAdapter(ok.store,ok.execution),{model:'root-model',effort:'high'});
    expect(result.adapter_result).toMatchObject({state:'completed',observed_requests:1});expect(ok.store.eventCount()).toBe(1);
  }finally{ok.cleanup();}
  const drift=fixture('root','2.1.296','2.1.288');try{
    const result=await runAssignedWorkflow(drift.store,drift.input,createSyntheticClaudeWorkflowAdapter(drift.store,drift.execution),{model:'root-model',effort:'high'});
    expect(result.adapter_result).toMatchObject({state:'stopped',observed_requests:0});expect(drift.store.eventCount()).toBe(0);
  }finally{drift.cleanup();}
},20000);

test.each(['root','wait'])('conditional native Claude pilot handles %s with pinned unverified usage and executable integrity',async mode=>{
  const f=fixture(mode,'2.1.298');try{
    const {registerProtocol,freezeProtocol}=await import('../src/comparison.js');
    const {FlexibleProtocolSchema}=await import('../src/flexible-contracts.js');
    const saved=FlexibleProtocolSchema.parse(JSON.parse(f.store.get<{settings:string}>('SELECT settings FROM comparison_protocols WHERE id=?',['comparison-1'])!.settings));
    const protocol={...saved,id:'claude-forward-pilot',purpose:'functional_pilot' as const,source_profiles:[{product:'claude_code' as const,product_version:'2.1.298',profile_id:'claude-workflow-own-trace-v1'}]};
    delete protocol.minimum_effect;delete protocol.quality_margin;delete protocol.confidence_level;
    registerProtocol(f.store,protocol);freezeProtocol(f.store,protocol.id,new Date(Date.now()-120000).toISOString());
    const input={...f.input,product_version:'2.1.298',assignment:{...f.input.assignment,protocol_id:protocol.id,metadata:{...f.input.assignment.metadata,product:'claude_code'}}};
    const ready=mode==='wait'?f.waitForUsage():undefined;
    const running=runAssignedWorkflow(f.store,input,createClaudeWorkflowAdapter(f.store,f.execution),{model:'root-model',effort:'high'});
    if(mode==='wait'){await Promise.race([ready,running]);expect(f.store.eventCount()).toBe(1);writeFileSync(f.execution.binary.path,'#!/bin/sh\nexit 0\n');}
    const result=await running;
    expect(result.adapter_result).toMatchObject({state:mode==='root'?'completed':'stopped',observed_requests:1});
    if(mode==='wait')expect(result.adapter_result).toMatchObject({reason:'claude_probe_executable_mismatch'});
    expect(f.store.get("SELECT json_extract(payload,'$.product_version') AS version,json_extract(payload,'$.source_compatibility.state') AS state FROM events")).toEqual({version:'2.1.298',state:'compatibility_unverified'});
  }finally{f.cleanup();}
},20000);

const sessionFlags=(root:string)=>readFileSync(join(root,'session-flags.log'),'utf8').trim().split('\n').map(line=>JSON.parse(line) as {native:string;flags:string[];matcher:string});
test('a resumable launch is continued on the same session row and each run counts only its own requests',async()=>{
  const f=fixture('root','2.1.296','2.1.296',claudeWorkflowProfileId);try{
    const first=await runAssignedWorkflow(f.store,f.input,createClaudeWorkflowAdapter(f.store,{...f.execution,resumable:true}),{model:'root-model',effort:'high'});
    expect(first.adapter_result).toMatchObject({state:'completed',observed_requests:1});
    const second=await runAssignedWorkflow(f.store,{...f.input,confirmation_id:'confirmation-2'},
      createClaudeWorkflowAdapter(f.store,{...f.execution,operation:'resume',run_id:'claude-run-2',resume_run_id:'claude-run'}),{model:'root-model',effort:'medium'});
    expect(second.adapter_result).toMatchObject({state:'completed',observed_requests:1,session_id:first.adapter_result!.session_id});
    const previousEnd=f.store.get<{ended_at:string}>("SELECT ended_at FROM claude_workflow_runs WHERE id='claude-run-2'")!.ended_at;
    // Naming an older run still uses the newest run's end as the no-backfill boundary.
    const third=await runAssignedWorkflow(f.store,{...f.input,confirmation_id:'confirmation-3'},
      createClaudeWorkflowAdapter(f.store,{...f.execution,operation:'resume',run_id:'claude-run-3',resume_run_id:'claude-run'}),{model:'root-model',effort:'high'});
    expect(third.adapter_result).toMatchObject({state:'completed',observed_requests:1,session_id:first.adapter_result!.session_id});
    const flags=sessionFlags(f.root);
    expect(flags.map(row=>[row.flags,row.matcher])).toEqual([[['--session-id'],'startup'],[['--resume'],'resume'],[['--resume'],'resume']]);
    expect(new Set(flags.map(row=>row.native)).size).toBe(1);
    expect(f.store.all('SELECT id FROM sessions')).toHaveLength(1);expect(f.store.eventCount()).toBe(3);
    expect(f.store.all('SELECT DISTINCT session_id FROM claude_workflow_runs')).toHaveLength(1);
    expect(f.store.all("SELECT json_extract(payload,'$.effort') AS effort FROM runtime_evidence ORDER BY rowid")).toEqual([{effort:'high'},{effort:'medium'},{effort:'high'}]);
    expect(f.store.all("SELECT DISTINCT json_extract(payload,'$.source_compatibility.profile_id') AS profile,json_extract(payload,'$.source_compatibility.state') AS state FROM events"))
      .toEqual([{profile:claudeWorkflowProfileId,state:'verified'}]);
    // The interval between two runs of the kept session is recorded as unobserved, never backfilled.
    expect(f.store.all("SELECT id FROM observation_gaps WHERE reason='offline'")).toHaveLength(2);
    expect(f.store.get<{started_at:string}>("SELECT started_at FROM observation_gaps WHERE reason='offline' ORDER BY rowid DESC LIMIT 1")!.started_at).toBe(previousEnd);
    expect(f.store.all('SELECT * FROM comparison_confirmation_sessions')).toHaveLength(3);
  }finally{f.cleanup();}
},30000);
test('resume refuses a run that was not kept, an unknown run and a conditional version without starting anything',async()=>{
  const f=fixture('root','2.1.296','2.1.296',claudeWorkflowProfileId);try{
    const first=await runAssignedWorkflow(f.store,f.input,createClaudeWorkflowAdapter(f.store,f.execution),{model:'root-model',effort:'high'});
    expect(first.adapter_result).toMatchObject({state:'completed'});
    expect(sessionFlags(f.root)[0]!.flags).toEqual(['--session-id','--no-session-persistence']);
    for(const resume_run_id of ['claude-run','unknown-run'])
      await expect(runAssignedWorkflow(f.store,{...f.input,confirmation_id:'confirmation-2'},
        createClaudeWorkflowAdapter(f.store,{...f.execution,operation:'resume',run_id:'claude-run-2',resume_run_id}),{model:'root-model',effort:'high'}))
        .rejects.toThrow(/^claude_workflow_resume_source_invalid$/);
    expect(f.store.all('SELECT id FROM claude_workflow_runs')).toHaveLength(1);expect(f.store.eventCount()).toBe(1);
    expect(sessionFlags(f.root)).toHaveLength(1);
  }finally{f.cleanup();}
  const conditional=fixture('root','2.1.297','2.1.297',claudeWorkflowProfileId);try{
    for(const patch of [{resumable:true},{operation:'resume',run_id:'claude-run-2',resume_run_id:'claude-run'}])
      expect(()=>createClaudeWorkflowAdapter(conditional.store,{...conditional.execution,...patch}).preflight?.({model:'root-model',effort:'high'})).toThrow(/^claude_workflow_resume_unadmitted$/);
  }finally{conditional.cleanup();}
},30000);
test('the execution schema keeps resume parent-only and separate from launch options',()=>{
  const f=fixture('root');try{
    const resume={...f.execution,operation:'resume',run_id:'claude-run-2',resume_run_id:'claude-run'};
    expect(ClaudeWorkflowExecutionSchema.safeParse(resume).success).toBe(true);
    expect(ClaudeWorkflowExecutionSchema.safeParse({...f.execution,resumable:true}).success).toBe(true);
    const child={model:'child-model',effort:'low'};
    for(const bad of [{...resume,resume_run_id:undefined},{...resume,resume_run_id:'claude-run-2'},{...resume,child_runtime:child},{...resume,resumable:true},
      {...f.execution,resume_run_id:'claude-run-0'},{...f.execution,resumable:true,child_runtime:child},{...f.execution,operation:'collect'}])
      expect(ClaudeWorkflowExecutionSchema.safeParse(bad).success).toBe(false);
  }finally{f.cleanup();}
});

type ResumeFixture=ReturnType<typeof fixture>;
const keptManifest=(f:ResumeFixture)=>join(f.execution.workspace,'claude-run','claude-probe-manifest.json');
const rewriteManifest=(f:ResumeFixture,change:(manifest:Record<string,unknown>)=>void)=>{const manifest=JSON.parse(readFileSync(keptManifest(f),'utf8')) as Record<string,unknown>;change(manifest);writeFileSync(keptManifest(f),JSON.stringify(manifest));};
const resumeOf=(f:ResumeFixture)=>({...f.execution,operation:'resume',run_id:'claude-run-2',resume_run_id:'claude-run'});
test.each<[string,(f:ResumeFixture)=>void]>([
  ['a manifest of another binary version',f=>rewriteManifest(f,manifest=>{manifest.binary={version:'2.1.295'};})],
  ['a manifest without the kept-session marker',f=>rewriteManifest(f,manifest=>{delete manifest.sessionPersistence;})],
  ['a symlinked manifest',f=>{const copy=join(f.root,'manifest-copy.json');writeFileSync(copy,readFileSync(keptManifest(f)));rmSync(keptManifest(f));symlinkSync(copy,keptManifest(f));}],
  ['a run directory open to other users',f=>chmodSync(join(f.execution.workspace,'claude-run'),0o755)],
  ['a kept session that already had a child',f=>{const s=f.store.get<{id:string;task_id:string;project_id:string}>('SELECT id,task_id,project_id FROM sessions')!;
    f.store.execute("INSERT INTO sessions(id,project_id,task_id,parent_id,product,product_version) VALUES ('synthetic-child',?,?,?,'claude_code','2.1.296')",[s.project_id,s.task_id,s.id]);}],
  ['a kept session whose run is still marked running',f=>f.store.execute("UPDATE claude_workflow_runs SET state='running',ended_at=NULL WHERE id='claude-run'",[])],
])('resume refuses %s before anything is assigned or started',async(_name,tamper)=>{
  const f=fixture('root','2.1.296','2.1.296',claudeWorkflowProfileId);try{
    const first=await runAssignedWorkflow(f.store,f.input,createClaudeWorkflowAdapter(f.store,{...f.execution,resumable:true}),{model:'root-model',effort:'high'});
    expect(first.adapter_result).toMatchObject({state:'completed',observed_requests:1});
    tamper(f);
    await expect(runAssignedWorkflow(f.store,{...f.input,confirmation_id:'confirmation-2'},createClaudeWorkflowAdapter(f.store,resumeOf(f)),{model:'root-model',effort:'high'}))
      .rejects.toThrow(/^claude_workflow_resume_source_invalid$/);
    expect(f.store.all('SELECT id FROM claude_workflow_runs')).toHaveLength(1);expect(f.store.eventCount()).toBe(1);
    expect(f.store.all('SELECT id FROM comparison_confirmations')).toHaveLength(1);expect(sessionFlags(f.root)).toHaveLength(1);
  }finally{f.cleanup();}
},30000);
test('resume is bound to the task and project of the kept session before assignment',async()=>{
  const f=fixture('root','2.1.296','2.1.296',claudeWorkflowProfileId);try{
    await runAssignedWorkflow(f.store,f.input,createClaudeWorkflowAdapter(f.store,{...f.execution,resumable:true}),{model:'root-model',effort:'high'});
    const run=f.store.get<{task_id:string;project_id:string}>('SELECT task_id,project_id FROM claude_workflow_runs')!;
    const adapter=createClaudeWorkflowAdapter(f.store,resumeOf(f));const runtime={model:'root-model',effort:'high'};
    expect(()=>adapter.preflight?.(runtime,{projectRoot:null,taskId:run.task_id,projectId:run.project_id})).not.toThrow();
    for(const scope of [{taskId:'another-task',projectId:run.project_id},{taskId:run.task_id,projectId:'another-project'}])
      expect(()=>adapter.preflight?.(runtime,{projectRoot:null,...scope})).toThrow(/^claude_workflow_resume_source_invalid$/);
    const other={...f.input,confirmation_id:'confirmation-other',assignment:{...f.input.assignment,task_id:'another-task',logical_task_id:'another-logical-task'}};
    await expect(runAssignedWorkflow(f.store,other,adapter,runtime)).rejects.toThrow(/^claude_workflow_resume_source_invalid$/);
    expect(f.store.all('SELECT * FROM comparison_assignments')).toHaveLength(1);
    expect(f.store.all('SELECT * FROM claude_workflow_runs')).toHaveLength(1);
  }finally{f.cleanup();}
},30000);
test('a kept session that never produced observed usage cannot be resumed',async()=>{
  const f=fixture('hook-before-start','2.1.296','2.1.296',claudeWorkflowProfileId);try{
    const first=await runAssignedWorkflow(f.store,f.input,createClaudeWorkflowAdapter(f.store,{...f.execution,resumable:true}),{model:'root-model',effort:'high'});
    expect(first.adapter_result).toMatchObject({observed_requests:0});expect(f.store.eventCount()).toBe(0);
    await expect(runAssignedWorkflow(f.store,{...f.input,confirmation_id:'confirmation-2'},createClaudeWorkflowAdapter(f.store,resumeOf(f)),{model:'root-model',effort:'high'}))
      .rejects.toThrow(/^claude_workflow_resume_source_invalid$/);
    expect(f.store.all("SELECT id FROM observation_gaps WHERE reason='offline'")).toHaveLength(0);
  }finally{f.cleanup();}
},30000);
test('a resume that fails keeps its own usage and marks only its own unfinished interval',async()=>{
  const f=fixture('resume-fails','2.1.296','2.1.296',claudeWorkflowProfileId);try{
    await runAssignedWorkflow(f.store,f.input,createClaudeWorkflowAdapter(f.store,{...f.execution,resumable:true}),{model:'root-model',effort:'high'});
    const failed=await runAssignedWorkflow(f.store,{...f.input,confirmation_id:'confirmation-2'},createClaudeWorkflowAdapter(f.store,resumeOf(f)),{model:'root-model',effort:'high'});
    expect(failed.adapter_result).toMatchObject({state:'failed',observed_requests:1});expect(f.store.eventCount()).toBe(2);
    const resumed=f.store.get<{started_at:string}>("SELECT started_at FROM claude_workflow_runs WHERE id='claude-run-2'")!;
    const gaps=f.store.all<{reason:string;started_at:string}>("SELECT reason,started_at FROM observation_gaps WHERE reason IN ('offline','incomplete') ORDER BY reason");
    expect(gaps.map(gap=>gap.reason)).toEqual(['incomplete','offline']);
    // The unfinished interval starts after this run's own last usage, never at the earlier run's usage.
    expect(Date.parse(gaps[0]!.started_at)).toBeGreaterThanOrEqual(Date.parse(resumed.started_at));
    expect(Date.parse(gaps[1]!.started_at)).toBeLessThanOrEqual(Date.parse(resumed.started_at));
  }finally{f.cleanup();}
},30000);
