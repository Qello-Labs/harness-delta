import { expect, test, vi } from 'vitest';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createCodexWorkflowAdapter, createSyntheticCodexWorkflowAdapter } from '../src/codex-workflow-adapter.js';
import { runAssignedWorkflow } from '../src/task-workflow.js';
import { stopCodexWorkflow, codexWorkflowCostFacts, recoverCodexWorkflow } from '../src/codex-workflow-journal.js';
import { Lifecycle } from '../src/lifecycle.js';
import * as collection from '../src/collection.js';
import { SourceFailure } from '../src/source-errors.js';
import { codexWorkflowFixture } from './helpers/codex-workflow-fixture.js';
import type { RuntimeEvidence } from '../src/flexible-contracts.js';

const runtime = { model: 'user-chosen-model', effort: 'user-chosen-effort' };
test('selected assigned harness actually reaches a fake process; resume changes runtime under the same task and accumulates own usage once', async () => {
  const f = codexWorkflowFixture(); try {
    const first = await runAssignedWorkflow(f.store, f.input, createSyntheticCodexWorkflowAdapter(f.store, f.execution('run-1'), f.script), runtime);
    expect(first.adapter_result).toMatchObject({ state: 'completed', observed_requests: 1, harness_application: 'invocation_settings_verified' });
    const session = first.adapter_result!.session_id!;
    expect(f.store.eventCount()).toBe(1);
    const second = await runAssignedWorkflow(f.store, { ...f.input, confirmation_id: 'confirmation-2', assignment: { ...f.input.assignment, task_id: 'another-id', alias_ids: ['issue-1'] } },
      createSyntheticCodexWorkflowAdapter(f.store, f.execution('run-2', 'resume', session), f.script), {model:'another-user-model',effort:null});
    expect(second).toMatchObject({ task_id: 'task-1', reused: true, assigned_variant_id: first.assigned_variant_id });
    expect(second.adapter_result).toMatchObject({ state:'completed',session_id:session,observed_requests:1 });
    expect(f.store.eventCount()).toBe(2); expect(f.store.all('SELECT id FROM sessions')).toHaveLength(1);
    const payloads = f.store.all<{payload:string}>('SELECT payload FROM runtime_evidence').map(r=>JSON.parse(r.payload) as RuntimeEvidence);
    expect(payloads.map(p=>p.model)).toEqual(['user-chosen-model','another-user-model']);
    expect(payloads[1]!.effort).toBe('native-default-effort');
    const retained = JSON.stringify(f.store.all('SELECT * FROM events'))+JSON.stringify(f.store.all('SELECT * FROM codex_workflow_runs'))+JSON.stringify(f.store.all('SELECT payload FROM comparison_confirmations'));
    expect(retained).not.toContain('SYNTHETIC_PRIVATE');
    expect(new Lifecycle(f.store).state('task-1')).toBe('active');
    expect(codexWorkflowCostFacts(f.store,'task-1').facts).toMatchObject({scope_before_access:'verified',immutable_identity:'verified',request_universe:'unknown',terminal_accounting:'unknown',continuous_observation:'unknown'});
  } finally { f.cleanup(); }
});
test('explicit new root link and foreground collect add future usage under the original task without backfill',async()=>{
  const f=codexWorkflowFixture();try{
    await runAssignedWorkflow(f.store,f.input,createSyntheticCodexWorkflowAdapter(f.store,f.execution('first'),f.script),runtime);
    const root=f.newRoot();f.appendUsage(root);
    const linked=await runAssignedWorkflow(f.store,{...f.input,confirmation_id:'link-confirmation'},createSyntheticCodexWorkflowAdapter(f.store,f.execution('link','link',root.id,root.path),f.script),runtime);
    expect(linked.adapter_result).toMatchObject({state:'completed',observed_requests:0,harness_application:'external_unverified'});
    const execute=f.store.execute.bind(f.store);let appended=false;let stopped=false;let futureRequest:string|null=null;
    const subscription=vi.spyOn(f.store,'execute').mockImplementation((sql,params)=>{
      execute(sql,params);
      const run=f.store.get<{scope_verified:number}>('SELECT scope_verified FROM codex_workflow_runs WHERE id=?',['collect']);
      if(!appended&&run?.scope_verified===1){appended=true;queueMicrotask(()=>{futureRequest=f.appendUsage(root);});}
      if(!stopped&&f.store.eventCount()===2){stopped=true;queueMicrotask(()=>stopCodexWorkflow(f.store,'collect'));}
    });
    try{
      const pending=runAssignedWorkflow(f.store,{...f.input,confirmation_id:'collect-confirmation'},createSyntheticCodexWorkflowAdapter(f.store,f.execution('collect','collect',root.id),f.script),runtime);
      expect((await pending).adapter_result).toMatchObject({state:'stopped',observed_requests:1});
    }finally{subscription.mockRestore();}
    expect(f.store.all('SELECT id FROM sessions')).toHaveLength(2);expect(f.store.all('SELECT task_id FROM comparison_assignments')).toHaveLength(1);
    expect(f.store.eventCount()).toBe(2);
    expect(f.store.all("SELECT json_extract(r.payload,'$.request_id') AS request_id FROM events e JOIN runtime_evidence r ON r.id=json_extract(e.payload,'$.runtime_evidence_id') WHERE e.session_id=?",[root.id])).toEqual([{request_id:futureRequest}]);
  }finally{f.cleanup();}
});
test.each(['replace','child','runtime','pause','delete','confirmation'] as const)('collector fails closed on %s before retaining additional usage',async(mode)=>{
  const f=codexWorkflowFixture();try{
    const root=f.newRoot();await runAssignedWorkflow(f.store,f.input,createSyntheticCodexWorkflowAdapter(f.store,f.execution('link','link',root.id,root.path),f.script),runtime);
    const pending=runAssignedWorkflow(f.store,{...f.input,confirmation_id:'collect-confirmation'},createSyntheticCodexWorkflowAdapter(f.store,f.execution('collect','collect',root.id),f.script),runtime);
    const edit=setTimeout(()=>{
      if(mode==='replace'){renameSync(root.path,root.path+'.old');writeFileSync(root.path,readFileSync(root.path+'.old'));f.appendUsage(root);}
      else if(mode==='child')f.appendUsage(root,'external-user-model',{root_turn_id:'another-root'});
      else if(mode==='runtime')f.appendUsage(root,'external-user-model',{cwd:'/outside'});
      else if(mode==='pause')new Lifecycle(f.store).pause('task-1');
      else if(mode==='delete')f.store.execute("INSERT INTO tombstones(kind,id,deleted_at) VALUES ('task','task-1',?)",[new Date().toISOString()]);
      else f.store.execute("INSERT INTO comparison_confirmations(id,task_id,occurred_at,recorded_at,payload) SELECT 'replacement-confirmation',task_id,occurred_at,recorded_at,payload FROM comparison_confirmations WHERE id='collect-confirmation'",[]);
    },30);
    try{if(['pause','delete','confirmation'].includes(mode))await expect(pending).rejects.toThrow('workflow_scope_revoked');else expect((await pending).adapter_result?.state).toBe('failed');}finally{clearTimeout(edit);}
    expect(f.store.eventCount()).toBe(0);expect(f.store.get<{state:string}>('SELECT state FROM codex_workflow_runs WHERE id=?',['collect'])?.state).toBe('failed');
  }finally{f.cleanup();}
});
test('offline usage between invocations is excluded by the new resume baseline',async()=>{
  const f=codexWorkflowFixture();try{
    const first=await runAssignedWorkflow(f.store,f.input,createSyntheticCodexWorkflowAdapter(f.store,f.execution('launch'),f.script),runtime);
    const id=first.adapter_result!.session_id!;const path=f.store.get<{source_path:string}>('SELECT source_path FROM codex_workflow_runs WHERE id=?',['launch'])!.source_path;
    f.appendUsage({id,path});await new Promise(ok=>setTimeout(ok,10));
    const second=await runAssignedWorkflow(f.store,{...f.input,confirmation_id:'resume-confirmation'},createSyntheticCodexWorkflowAdapter(f.store,f.execution('resume','resume',id),f.script),runtime);
    expect(second.adapter_result).toMatchObject({state:'completed',observed_requests:1});expect(f.store.eventCount()).toBe(2);
  }finally{f.cleanup();}
},20000); // Two bounded five-second invocations plus fixture setup.
test.each(['replace','rewrite'] as const)('a separate resume preserves the durable source identity and prefix across %s',async(mode)=>{
  const f=codexWorkflowFixture();try{
    const first=await runAssignedWorkflow(f.store,f.input,createSyntheticCodexWorkflowAdapter(f.store,f.execution('launch'),f.script),runtime);
    const id=first.adapter_result!.session_id!;const path=f.store.get<{source_path:string}>('SELECT source_path FROM codex_workflow_runs WHERE id=?',['launch'])!.source_path;
    const text=readFileSync(path,'utf8');
    if(mode==='replace'){renameSync(path,path+'.old');writeFileSync(path,text);}else writeFileSync(path,text.replace('30','31'));
    const resumed=await runAssignedWorkflow(f.store,{...f.input,confirmation_id:'resume-confirmation'},createSyntheticCodexWorkflowAdapter(f.store,f.execution('resume','resume',id),f.script),runtime);
    expect(resumed.adapter_result).toMatchObject({state:'failed',reason:'source_changed',harness_application:'unapplied'});expect(f.store.eventCount()).toBe(1);
  }finally{f.cleanup();}
});
test('binary mismatch reports unapplied and a forked source never yields usage',async()=>{
  const f=codexWorkflowFixture();try{
    const wrong={...f.execution('wrong-binary'),binary:{path:process.execPath,sha256:'0'.repeat(64)}};
    // Preflight rejects before assignment, task start or a run journal row.
    await expect(runAssignedWorkflow(f.store,f.input,createSyntheticCodexWorkflowAdapter(f.store,wrong,f.script),runtime)).rejects.toThrow(/^binary_mismatch$/);
    expect(f.store.all('SELECT id FROM comparison_assignments')).toEqual([]);expect(f.store.all('SELECT id FROM codex_workflow_runs')).toEqual([]);
    // A binary changing after preflight is still caught before spawn; this invocation's activation is paused.
    const raced=createSyntheticCodexWorkflowAdapter(f.store,wrong,f.script);delete raced.preflight;
    const failed=await runAssignedWorkflow(f.store,f.input,raced,runtime);
    expect(failed).toMatchObject({state:'paused',activation_reverted:true});
    expect(failed.adapter_result).toMatchObject({state:'failed',reason:'binary_mismatch',harness_application:'unapplied',process_started:false});
    expect(f.store.all('SELECT id FROM active_intervals WHERE ended_at IS NULL')).toEqual([]);
    const root=f.newRoot();const header=JSON.parse(readFileSync(root.path,'utf8')) as {payload:Record<string,unknown>};header.payload.forked_from_id='another-root';writeFileSync(root.path,JSON.stringify(header)+'\n');
    const linked=await runAssignedWorkflow(f.store,{...f.input,confirmation_id:'fork-confirmation'},createSyntheticCodexWorkflowAdapter(f.store,f.execution('fork','link',root.id,root.path),f.script),runtime);
    expect(linked.adapter_result).toMatchObject({state:'failed',reason:'unsupported_session'});expect(f.store.eventCount()).toBe(0);
  }finally{f.cleanup();}
});
test('a binary expectation changed after preflight is re-hashed and rejected before spawn',async()=>{
  const f=codexWorkflowFixture();try{
    const input=f.execution('changed-after-preflight');const adapter=createSyntheticCodexWorkflowAdapter(f.store,input,f.script);
    const preflight=adapter.preflight!.bind(adapter);
    adapter.preflight=async runtimeInput=>{await preflight(runtimeInput);input.binary={...input.binary,sha256:'0'.repeat(64)};};
    const result=await runAssignedWorkflow(f.store,f.input,adapter,runtime);
    expect(result).toMatchObject({state:'paused',activation_reverted:true,adapter_result:{state:'failed',reason:'binary_mismatch',process_started:false}});
    expect(f.store.eventCount()).toBe(0);
  }finally{f.cleanup();}
});
test('a resume failing before spawn pauses the task it resumed',async()=>{
  const f=codexWorkflowFixture();try{
    const first=await runAssignedWorkflow(f.store,f.input,createSyntheticCodexWorkflowAdapter(f.store,f.execution('run-1'),f.script),runtime);
    new Lifecycle(f.store).pause(first.task_id);
    const raced=createSyntheticCodexWorkflowAdapter(f.store,{...f.execution('run-2','resume',first.adapter_result!.session_id!),binary:{path:process.execPath,sha256:'0'.repeat(64)}},f.script);delete raced.preflight;
    const result=await runAssignedWorkflow(f.store,{...f.input,confirmation_id:'resume-confirmation'},raced,runtime);
    expect(result).toMatchObject({state:'paused',activation_reverted:true,adapter_result:{state:'failed',reason:'binary_mismatch',process_started:false}});
    expect(f.store.all('SELECT id FROM active_intervals WHERE ended_at IS NULL')).toEqual([]);
  }finally{f.cleanup();}
});
test('a live collector stops after its run is recovered and keeps the abandoned state',async()=>{
  const f=codexWorkflowFixture();try{
    writeFileSync(f.prompt,'SYNTHETIC_PRIVATE_TASK WAIT');
    const launched=runAssignedWorkflow(f.store,f.input,createSyntheticCodexWorkflowAdapter(f.store,{...f.execution('live'),timeout_ms:20000},f.script),runtime);
    const deadline=Date.now()+10000;while(!f.store.get("SELECT 1 FROM codex_workflow_runs WHERE id='live' AND identity_verified=1")&&Date.now()<deadline)await new Promise(ok=>setTimeout(ok,20));
    expect(recoverCodexWorkflow(f.store,'live')).toMatchObject({state:'failed',reason:'abandoned'});
    await launched.catch(()=>undefined);
    expect(f.store.get('SELECT state,reason FROM codex_workflow_runs WHERE id=?',['live'])).toEqual({state:'failed',reason:'abandoned'});
  }finally{f.cleanup();}
},20000);
/** A read that races a native append sees the file change underneath it. */
function racingReads(times:number){
  const original=collection.readSource;let left=times;
  const spy=vi.spyOn(collection,'readSource').mockImplementation(path=>{if(left>0){left--;throw new SourceFailure('unstable_read');}return original(path);});
  return Object.assign(spy,{race:(next:number)=>{left=next;}});
}
test('reads that race a native append are retried and the usage is counted once',async()=>{
  const f=codexWorkflowFixture();const read=racingReads(3);try{
    const result=await runAssignedWorkflow(f.store,f.input,createSyntheticCodexWorkflowAdapter(f.store,f.execution('raced-launch'),f.script),runtime);
    expect(result.adapter_result,JSON.stringify(result.adapter_result)).toMatchObject({state:'completed',observed_requests:1});
    expect(f.store.eventCount()).toBe(1);expect(read.mock.calls.length).toBeGreaterThan(3);
    // An existing session's baseline read can race too; earlier usage stays excluded.
    const root=f.newRoot();f.appendUsage(root);read.mockClear();read.race(1);
    const linked=await runAssignedWorkflow(f.store,{...f.input,confirmation_id:'raced-link'},createSyntheticCodexWorkflowAdapter(f.store,f.execution('raced-link-run','link',root.id,root.path),f.script),runtime);
    expect(linked.adapter_result,JSON.stringify(linked.adapter_result)).toMatchObject({state:'completed',observed_requests:0});
    expect(f.store.eventCount()).toBe(1);expect(read.mock.calls.length).toBeGreaterThan(1);
  }finally{read.mockRestore();f.cleanup();}
});
test('an unstable read at exit is reread before completion so the final usage is kept',async()=>{
  // Fail every read that already contains the usage for a while, so the process
  // exits while the latest poll is still unstable; completion must wait for a stable read.
  const original=collection.readSource;let racing=15;
  const read=vi.spyOn(collection,'readSource').mockImplementation(path=>{const bytes=original(path);
    if(racing>0&&bytes.text.includes('token_usage_record')){racing--;throw new SourceFailure('unstable_read');}return bytes;});
  const f=codexWorkflowFixture();try{
    const result=await runAssignedWorkflow(f.store,f.input,createSyntheticCodexWorkflowAdapter(f.store,f.execution('exit-race'),f.script),runtime);
    expect(result.adapter_result,JSON.stringify(result.adapter_result)).toMatchObject({state:'completed',observed_requests:1});
    expect(f.store.eventCount()).toBe(1);
  }finally{read.mockRestore();f.cleanup();}
});
test('a stop request ends a link whose baseline read keeps racing',async()=>{
  const f=codexWorkflowFixture();
  // The stop arrives from outside the read transaction, as from another process.
  let requested=false;
  const read=vi.spyOn(collection,'readSource').mockImplementation(()=>{if(!requested){requested=true;setTimeout(()=>stopCodexWorkflow(f.store,'stop-baseline'),0);}throw new SourceFailure('unstable_read');});
  try{
    const root=f.newRoot();
    const linked=await runAssignedWorkflow(f.store,f.input,createSyntheticCodexWorkflowAdapter(f.store,f.execution('stop-baseline','link',root.id,root.path),f.script),runtime);
    expect(linked.adapter_result,JSON.stringify(linked.adapter_result)).toMatchObject({state:'stopped',reason:'stop_requested'});
    expect(read.mock.calls.length).toBeLessThan(5);
  }finally{read.mockRestore();f.cleanup();}
});
test('a source that never yields a stable read still fails with its own reason',async()=>{
  const f=codexWorkflowFixture();const read=racingReads(Number.MAX_SAFE_INTEGER);try{
    const result=await runAssignedWorkflow(f.store,f.input,createSyntheticCodexWorkflowAdapter(f.store,f.execution('never-stable'),f.script),runtime);
    expect(result.adapter_result).toMatchObject({state:'failed',reason:'collection_failed',diagnostic:{stage:'source_read',code:'unstable_read'}});
    expect(f.store.eventCount()).toBe(0);
  }finally{read.mockRestore();f.cleanup();}
},20000);
test('a response ID already owned by another session fails instead of being counted again',async()=>{
  const f=codexWorkflowFixture();try{
    const launched=await runAssignedWorkflow(f.store,f.input,createSyntheticCodexWorkflowAdapter(f.store,f.execution('launch'),f.script),runtime);
    expect(launched.adapter_result,JSON.stringify(launched.adapter_result)).toMatchObject({state:'completed'});
    const request=(JSON.parse(f.store.get<{payload:string}>('SELECT payload FROM runtime_evidence LIMIT 1')!.payload) as RuntimeEvidence).request_id!;
    const root=f.newRoot();await runAssignedWorkflow(f.store,{...f.input,confirmation_id:'link-confirmation'},createSyntheticCodexWorkflowAdapter(f.store,f.execution('link','link',root.id,root.path),f.script),runtime);
    const pending=runAssignedWorkflow(f.store,{...f.input,confirmation_id:'collect-confirmation'},createSyntheticCodexWorkflowAdapter(f.store,f.execution('collect','collect',root.id),f.script),runtime);
    const edit=setTimeout(()=>{const response=f.appendUsage(root);writeFileSync(root.path,readFileSync(root.path,'utf8').replace(response,request));},30);
    try{expect((await pending).adapter_result?.state).toBe('failed');}finally{clearTimeout(edit);}
    expect(f.store.eventCount()).toBe(1);expect(f.store.all('SELECT * FROM runtime_evidence')).toHaveLength(1);
  }finally{f.cleanup();}
});
test('admitted native adapter rejects an unpinned binary before prompt/source/native launch', async () => {
  const f = codexWorkflowFixture(); try {
    const adapter = createCodexWorkflowAdapter(f.store,{...f.execution('native-blocked'),prompt_file:'/absent/private-prompt'});
    await expect(adapter.run({projectId:'project-1',projectRoot:f.project,taskId:'task-1',generation:1,assignedVariantId:'variant-a',confirmationId:'confirmation-1',instructionManifestHash:'a'.repeat(64),runtime,instructions:[],assertActive:()=>{}})).rejects.toThrow('binary_mismatch');
    expect(f.store.all('SELECT * FROM codex_workflow_runs')).toEqual([]);
  } finally { f.cleanup(); }
});
test('artifact drift fails before adapter launch and used run IDs cannot automatically retry', async () => {
  const f = codexWorkflowFixture(); try {
    await runAssignedWorkflow(f.store,f.input,createSyntheticCodexWorkflowAdapter(f.store,f.execution('once'),f.script),runtime);
    await expect(runAssignedWorkflow(f.store,{...f.input,confirmation_id:'retry-confirmation'},createSyntheticCodexWorkflowAdapter(f.store,f.execution('once'),f.script),runtime)).rejects.toThrow('workflow_adapter_failed');
    for(const row of f.input.artifacts)writeFileSync(row.selected_artifacts[0]!.path,'changed');
    await expect(runAssignedWorkflow(f.store,{...f.input,confirmation_id:'drift-confirmation'},createSyntheticCodexWorkflowAdapter(f.store,f.execution('drift'),f.script),runtime)).rejects.toThrow('workflow_manifest_mismatch');
    expect(f.store.all('SELECT id FROM codex_workflow_runs')).toHaveLength(1);
  } finally { f.cleanup(); }
});
test('durable stop terminates an active fake process and leaves the human task active', async () => {
  const f=codexWorkflowFixture();try{
    writeFileSync(f.prompt,'SYNTHETIC_PRIVATE_TASK WAIT');
    const running=runAssignedWorkflow(f.store,f.input,createSyntheticCodexWorkflowAdapter(f.store,f.execution('stop-me'),f.script),runtime);
    const timer=setInterval(()=>{if(f.store.eventCount()===1){clearInterval(timer);stopCodexWorkflow(f.store,'stop-me');}},10);
    try{const result=await running;expect(result.adapter_result).toMatchObject({state:'stopped',reason:'stop_requested'});}finally{clearInterval(timer);}
    expect(new Lifecycle(f.store).state('task-1')).toBe('active');expect(f.store.eventCount()).toBe(1);
    expect(readFileSync(f.prompt,'utf8')).toContain('WAIT');
  }finally{f.cleanup();}
});
test('a concurrent invocation cannot overwrite the active confirmation or launch another process',async()=>{
  const f=codexWorkflowFixture();try{
    writeFileSync(f.prompt,'SYNTHETIC_PRIVATE_TASK WAIT');
    const running=runAssignedWorkflow(f.store,f.input,createSyntheticCodexWorkflowAdapter(f.store,f.execution('first'),f.script),runtime);
    const deadline=Date.now()+3000;while(f.store.eventCount()<1&&Date.now()<deadline)await new Promise(ok=>setTimeout(ok,10));
    expect(f.store.eventCount()).toBe(1);
    await expect(runAssignedWorkflow(f.store,{...f.input,confirmation_id:'second-confirmation'},createSyntheticCodexWorkflowAdapter(f.store,f.execution('second'),f.script),runtime)).rejects.toThrow('workflow_run_active');
    expect(f.store.get("SELECT 1 FROM comparison_confirmations WHERE id='second-confirmation'")).toBeUndefined();
    stopCodexWorkflow(f.store,'first');expect((await running).adapter_result?.state).toBe('stopped');
    expect(f.store.all('SELECT * FROM codex_workflow_runs')).toHaveLength(1);
  }finally{f.cleanup();}
});

test.each(['completed','replaced'])('conditional Codex native pilot handles %s executable with actual version provenance',async mode=>{
  const f=codexWorkflowFixture();try{
    const {createHash}=await import('node:crypto');const {chmodSync}=await import('node:fs');
    const {registerProtocol,freezeProtocol}=await import('../src/comparison.js');const {FlexibleProtocolSchema}=await import('../src/flexible-contracts.js');
    const saved=FlexibleProtocolSchema.parse(JSON.parse(f.store.get<{settings:string}>('SELECT settings FROM comparison_protocols WHERE id=?',['comparison-1'])!.settings));
    const protocol={...saved,id:'codex-forward-pilot',purpose:'functional_pilot' as const,source_profiles:[{product:'codex' as const,product_version:'0.161.0',profile_id:'codex-workflow-own-response-v1'}]};
    delete protocol.minimum_effect;delete protocol.quality_margin;delete protocol.confidence_level;
    registerProtocol(f.store,protocol);freezeProtocol(f.store,protocol.id,new Date(Date.now()-120000).toISOString());
    const script=readFileSync(f.script,'utf8').replaceAll('0.160.0','0.161.0');
    writeFileSync(f.script,`#!${process.execPath}\nif(process.argv.includes('--version')){console.log('codex-cli 0.161.0');process.exit(0);}\n${script}`);chmodSync(f.script,0o700);
    const execution={...f.execution('forward-native'),product_version:'0.161.0',binary:{path:f.script,sha256:createHash('sha256').update(readFileSync(f.script)).digest('hex')}};
    const input={...f.input,product_version:'0.161.0',assignment:{...f.input.assignment,protocol_id:protocol.id,metadata:{...f.input.assignment.metadata,product:'codex'}}};
    if(mode==='replaced')writeFileSync(f.prompt,'SYNTHETIC_PRIVATE_TASK WAIT');
    const running=runAssignedWorkflow(f.store,input,createCodexWorkflowAdapter(f.store,execution),runtime);
    if(mode==='replaced'){const deadline=Date.now()+4000;while(f.store.eventCount()===0&&Date.now()<deadline)await new Promise(ok=>setTimeout(ok,10));expect(f.store.eventCount()).toBe(1);writeFileSync(f.script,'#!/bin/sh\nexit 0\n');}
    const result=await running;expect(result.adapter_result).toMatchObject({state:mode==='completed'?'completed':'failed',observed_requests:1});
    if(mode==='replaced')expect(result.adapter_result).toMatchObject({reason:'binary_mismatch'});
    expect(f.store.get("SELECT json_extract(payload,'$.product_version') AS version,json_extract(payload,'$.source_compatibility.state') AS state FROM events")).toEqual({version:'0.161.0',state:'compatibility_unverified'});
  }finally{f.cleanup();}
},20000);
