import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as collection from '../src/collection.js';
import { createSessionBindingService } from '../src/session-binding-service.js';
import type { BindingUsageRecord, SessionBindingProvider, VerifiedSessionIdentity } from '../src/session-binding-contract.js';
import { createSyntheticCodexWorkflowAdapter } from '../src/codex-workflow-adapter.js';
import { collectExternalTask } from '../src/external-session-service.js';
import Database from 'better-sqlite3';
import { expect, test, vi } from 'vitest';
import { localWebFixture } from './helpers/local-web-fixture.js';
import { createLocalWebDomain } from '../src/local-web-domain.js';
import { registerHarness, generateComparison } from '../src/harness-config.js';
import { comparisonVariant } from '../src/comparison.js';
import { Lifecycle } from '../src/lifecycle.js';
import { Deletion } from '../src/deletion.js';
import { createLocalWebServer } from '../src/local-web-server.js';
import { loadSharedStartup } from '../src/local-web-shared.js';
import { assertSharedTask } from '../src/local-web-shared-guard.js';
function pair(f: ReturnType<typeof localWebFixture>,name='Synthetic pair') {
  writeFileSync(join(f.project,'notes.md'),'Synthetic approved configuration\n');mkdirSync(join(f.project,'scripts'));writeFileSync(join(f.project,'scripts/tool.py'),'# synthetic tool\n');
  for(const [i,version] of ['baseline','v2'].entries()) {
    writeFileSync(join(f.project,'policy.md'),readFileSync(f.input.artifacts[i]!.selected_artifacts[0]!.path));
    const variant=comparisonVariant(f.store,f.input.artifacts[i]!.variant_id);
    registerHarness(f.project,{schema_version:1,harness_id:'search',version,policy_version:variant.policy_version,readme_path:'notes.md',artifacts:[{artifact_id:'instruction',role:'instruction',source_path:'policy.md',target_path:'harness.md'},{artifact_id:'tool',role:'tool',source_path:'scripts/tool.py',target_path:'scripts/tool.py'}]});
  }
  const {descriptor}=generateComparison(f.project,{schema_version:1,id:'baseline-vs-v2',name,arm_a:'baseline',arm_b:'v2'});
  return {path:join(f.project,'harness-config/comparisons/baseline-vs-v2.json'),descriptor};
}
test('shared setup acquires the Store writer lock before private metadata writes', async () => {
  const f = localWebFixture(); const p = pair(f);
  const domain = createLocalWebDomain({store:f.store,metadataFile:f.metadataFile,profiles:[f.profile],picker:()=>Promise.resolve(p.path)});
  const competing = new Database(f.store.filename);
  competing.pragma('busy_timeout = 0');
  const prepare: unknown = Object.getOwnPropertyDescriptor(Database.prototype, 'prepare')?.value;
  if (typeof prepare !== 'function') throw new Error('missing_original_prepare');
  let checked = false;
  const intercept = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database.Database, sql) {
    if (sql.startsWith('INSERT OR IGNORE INTO web_shared_versions')) {
      checked = true;
      expect(() => competing.exec('BEGIN IMMEDIATE')).toThrow('database is locked');
    }
    return Reflect.apply(prepare, this, [sql]) as Database.Statement;
  });
  try {
    const preview = await domain.importSetup!() as { token: string };
    await domain.bindSetup!({token:preview.token,project_id:'project-1',template_id:f.profile.id});
    expect(checked).toBe(true);
    new Deletion(f.store).deleteProject('project-1');
    const metadata = new Database(f.metadataFile);
    try {
      expect(metadata.prepare('SELECT * FROM web_shared_versions').all()).toEqual([]);
      expect(metadata.prepare('SELECT * FROM web_profiles').all()).toEqual([]);
    } finally { metadata.close(); }
  } finally {
    intercept.mockRestore();
    if (competing.inTransaction) competing.exec('ROLLBACK');
    competing.close();
    await domain.close?.(); f.cleanup();
  }
});
test('actual picker previews and binds a portable pair to an explicit reviewed local profile, repeats and survives restart', async()=>{
  const f=localWebFixture();const p=pair(f);let domain=createLocalWebDomain({store:f.store,metadataFile:f.metadataFile,profiles:[f.profile],picker:()=>Promise.resolve(p.path)});
  try {
    const before=JSON.stringify(f.store.all('SELECT * FROM comparison_protocols'));
    const preview=await domain.importSetup!() as {shared:boolean;token:string;projects:unknown[]};expect(preview.shared).toBe(true);expect(f.store.all('SELECT * FROM tasks')).toHaveLength(0);
    const bound=await domain.bindSetup!({token:preview.token,project_id:'project-1',template_id:f.profile.id}) as {profile_id:string;local_setup_path:string;already_connected:boolean};
    expect(bound.already_connected).toBe(false);expect(existsSync(join(f.project,bound.local_setup_path))).toBe(true);expect(JSON.stringify(f.store.all('SELECT * FROM comparison_protocols'))).toBe(before);
    const repeat=await domain.importSetup!() as {token:string};expect(await domain.bindSetup!({token:repeat.token,project_id:'project-1',template_id:f.profile.id})).toMatchObject({already_connected:true,profile_id:bound.profile_id});
    const task=await domain.createTask({name:'Synthetic shared task',project_id:'project-1',setup_id:bound.profile_id}) as {id:string;status:string};expect(task.status).toBe('draft');expect(f.store.all('SELECT * FROM comparison_assignments')).toHaveLength(1);assertSharedTask(f.store,task.id);
    await domain.close?.();domain=createLocalWebDomain({store:f.store,metadataFile:f.metadataFile,profiles:[f.profile]});expect(domain.task(task.id)).toMatchObject({id:task.id});assertSharedTask(f.store,task.id);
  }finally{await domain.close?.();f.cleanup();}
});
test('post-assignment tool mismatch stays visible with one sticky task and retries same IDs after restart',async()=>{
  const f=localWebFixture();const p=pair(f);let domain=createLocalWebDomain({store:f.store,metadataFile:f.metadataFile,profiles:[f.profile],picker:()=>Promise.resolve(p.path)});
  try {const preview=await domain.importSetup!() as {token:string};const bound=await domain.bindSetup!({token:preview.token,project_id:'project-1',template_id:f.profile.id}) as {profile_id:string};writeFileSync(join(f.project,'scripts/tool.py'),'# drift\n');
    const task=await domain.createTask({name:'Synthetic blocked task',project_id:'project-1',setup_id:bound.profile_id}) as {id:string;status:string};expect(task.status).toBe('blocked_configuration');const assigned=f.store.get<{variant_id:string}>('SELECT variant_id FROM comparison_assignments WHERE task_id=?',[task.id])!.variant_id;expect(new Lifecycle(f.store).state(task.id)).toBe('registered');
    await domain.close?.();domain=createLocalWebDomain({store:f.store,metadataFile:f.metadataFile});expect(domain.task(task.id)).toMatchObject({status:'blocked_configuration'});writeFileSync(join(f.project,'scripts/tool.py'),'# synthetic tool\n');await domain.taskAction(task.id,'prepare',{});expect(domain.task(task.id).status).toBe('draft');expect(f.store.all('SELECT * FROM tasks')).toHaveLength(1);expect(f.store.get('SELECT variant_id FROM comparison_assignments WHERE task_id=?',[task.id])).toEqual({variant_id:assigned});
  }finally{await domain.close?.();f.cleanup();}
});
test('active drift is fenced before source use and private setup deletion cannot disable the guard',async()=>{
  const f=localWebFixture();const p=pair(f);const domain=createLocalWebDomain({store:f.store,metadataFile:f.metadataFile,profiles:[f.profile],picker:()=>Promise.resolve(p.path)});
  try {const preview=await domain.importSetup!() as {token:string};const bound=await domain.bindSetup!({token:preview.token,project_id:'project-1',template_id:f.profile.id}) as {profile_id:string;local_setup_path:string};const task=await domain.createTask({name:'Synthetic drift',project_id:'project-1',setup_id:bound.profile_id}) as {id:string};await domain.taskAction(task.id,'apply',{});new Lifecycle(f.store).start(task.id);writeFileSync(join(f.project,'scripts/tool.py'),'# drift\n');expect(()=>assertSharedTask(f.store,task.id)).toThrow('shared_tool_mismatch');expect(new Lifecycle(f.store).state(task.id)).toBe('paused');expect(f.store.eventCount()).toBe(0);writeFileSync(join(f.project,'scripts/tool.py'),'# synthetic tool\n');unlinkSync(join(f.project,bound.local_setup_path));expect(()=>assertSharedTask(f.store,task.id)).toThrow('shared_file_unavailable');
  }finally{await domain.close?.();f.cleanup();}
});

for (const product of ['codex','claude_code'] as const) test(`private ${product} binding round trip and explicit runtime revisions`,async()=>{
 const f=localWebFixture();const p=pair(f,'  Synthetic pair  ');f.profile.session_binding=product==='codex'?{product,receipt_directory:join(f.root,'receipts'),source_roots:[f.home],project_root:f.project}:{product,receipt_directory:join(f.root,'receipts'),claude_projects_directory:f.home};
 let domain=createLocalWebDomain({store:f.store,metadataFile:f.metadataFile,profiles:[f.profile],picker:()=>Promise.resolve(p.path)});
 try{const preview=await domain.importSetup!() as {token:string};const first=await domain.bindSetup!({token:preview.token,project_id:'project-1',template_id:f.profile.id}) as {profile_id:string};
  expect(loadSharedStartup(f.store,p.path)[0]!.id).toBe(first.profile_id);
  const secondTemplate={...f.profile,id:'other-reviewed',execution:{...f.profile.execution,poll_ms:15}};
  await domain.close?.();domain=createLocalWebDomain({store:f.store,metadataFile:f.metadataFile,profiles:[secondTemplate],picker:()=>Promise.resolve(p.path)});
  const again=await domain.importSetup!() as {token:string};const second=await domain.bindSetup!({token:again.token,project_id:'project-1',template_id:secondTemplate.id}) as {profile_id:string};expect(second.profile_id).not.toBe(first.profile_id);const snapshot=await domain.bootstrap() as {setups:{id:string;shared?:{revision_id:string;template_id:string}}[]};expect(snapshot.setups.find(row=>row.id===first.profile_id)?.shared).toMatchObject({revision_id:first.profile_id,template_id:f.profile.id});expect(snapshot.setups.find(row=>row.id===second.profile_id)?.shared).toMatchObject({revision_id:second.profile_id,template_id:secondTemplate.id});
  expect(()=>loadSharedStartup(f.store,p.path)).toThrow('shared_binding_selection_required');expect(loadSharedStartup(f.store,p.path,first.profile_id)[0]!.id).toBe(first.profile_id);const other=loadSharedStartup(f.store,p.path,second.profile_id)[0]!;writeFileSync(join(f.project,other.shared_binding!.local_setup_path),'broken');expect(loadSharedStartup(f.store,p.path,first.profile_id)[0]!.id).toBe(first.profile_id);
 }finally{await domain.close?.();f.cleanup();}
});

test('a journaled task interrupted before Store creation remains visible and retries the reserved identity after restart',async()=>{
 const f=localWebFixture();const p=pair(f);let domain=createLocalWebDomain({store:f.store,metadataFile:f.metadataFile,profiles:[f.profile],picker:()=>Promise.resolve(p.path)});
 try{const preview=await domain.importSetup!() as {token:string};const bound=await domain.bindSetup!({token:preview.token,project_id:'project-1',template_id:f.profile.id}) as {profile_id:string};
  const execute=f.store.execute.bind(f.store);const crash=vi.spyOn(f.store,'execute').mockImplementation((sql,params)=>{if(sql.startsWith('INSERT INTO tasks'))throw new Error('synthetic_interruption');execute(sql,params);});
  let task:{id:string;status:string};try{task=await domain.createTask({name:'Synthetic interruption',project_id:'project-1',setup_id:bound.profile_id}) as typeof task;}finally{crash.mockRestore();}
  expect(task.status).toBe('blocked_configuration');expect(f.store.all('SELECT * FROM tasks')).toHaveLength(0);
  const db=new Database(f.metadataFile);const reserved=db.prepare('SELECT setup FROM web_tasks WHERE id=?').get(task.id) as {setup:string};db.close();
  await domain.close?.();domain=createLocalWebDomain({store:f.store,metadataFile:f.metadataFile});expect(await domain.bootstrap()).toMatchObject({tasks:[{id:task.id,status:'blocked_configuration'}]});
  await domain.taskAction(task.id,'prepare',{});expect(f.store.all('SELECT id FROM tasks')).toEqual([{id:task.id}]);expect(f.store.all('SELECT * FROM comparison_assignments')).toHaveLength(1);
  const saved=new Database(f.metadataFile);expect(saved.prepare('SELECT setup FROM web_tasks WHERE id=?').get(task.id)).toEqual(reserved);saved.close();
 }finally{await domain.close?.();f.cleanup();}
});

test('family observer fences mid-read original-tool drift, discards the uncertain batch and requires explicit reconnect',async()=>{
 const f=localWebFixture();const p=pair(f);const domain=createLocalWebDomain({store:f.store,metadataFile:f.metadataFile,profiles:[f.profile],picker:()=>Promise.resolve(p.path)});
 try{const preview=await domain.importSetup!() as {token:string};const bound=await domain.bindSetup!({token:preview.token,project_id:'project-1',template_id:f.profile.id}) as {profile_id:string};const task=await domain.createTask({name:'Synthetic family boundary',project_id:'project-1',setup_id:bound.profile_id}) as {id:string};await domain.taskAction(task.id,'apply',{});
  const db=new Database(f.metadataFile);const row=db.prepare('SELECT setup FROM web_tasks WHERE id=?').get(task.id) as {setup:string};db.close();const setup=JSON.parse(row.setup) as typeof f.profile.setup;
  let now=new Date().toISOString();const identity:VerifiedSessionIdentity={product:'codex',productVersion:'0.160.0',sessionId:randomUUID(),sourceRef:f.newRoot().path,sourceIdentity:randomUUID(),cwd:f.project,identityEvidenceId:randomUUID(),parentSessionId:null,createdAt:now};
  let reads=0;let drift=false;const records:BindingUsageRecord[]=[];
  const provider:SessionBindingProvider={product:'codex',capabilities:()=>({currentIdentity:'native_hook',ancestry:'verified_relations',usage:'own_requests',productionSupported:false,maxDepth:8,reasons:['qualification_required']}),resolveCurrent:()=>Promise.resolve(identity),discoverChildren:()=>Promise.resolve({children:[],gaps:[]}),readUsage:(_identity,cursor)=>{reads++;if(drift)writeFileSync(join(f.project,'scripts/tool.py'),'# drift during read\n');return Promise.resolve({records:records.slice(Number(cursor??0)),cursor:String(records.length),gaps:[]});}};
  const service=createSessionBindingService({store:f.store,providers:[provider],setupFor:()=>setup,clock:()=>now});await service.connect(task.id,'codex',{receipt:randomUUID()});
  const observed=(value:number)=>({status:'observed' as const,value,reason:null});const add=()=>{now=new Date().toISOString();records.push({requestId:randomUUID(),sessionId:identity.sessionId,occurredAt:now,turnId:'turn',effort:null,payload:{schema_version:2,kind:'usage',product:'codex',product_version:'0.160.0',model:'model-a',epoch:'epoch',attribution:'verified',input_total:observed(10),cached_input:observed(0),output_total:observed(3),reasoning_output:observed(0),billing_components:[{kind:'ordinary_input',reading:observed(10)},{kind:'output',reading:observed(3)}]}});};
  add();await service.tick(task.id);expect(f.store.eventCount()).toBe(1);const before=domain.task(task.id).price;add();drift=true;await expect(service.tick(task.id)).rejects.toThrow('shared_tool_mismatch');expect(f.store.eventCount()).toBe(1);expect(new Lifecycle(f.store).state(task.id)).toBe('paused');expect(domain.task(task.id).price).toEqual(before);expect(f.store.all("SELECT * FROM observation_gaps WHERE reason='source_error'")).toHaveLength(1);
  const stoppedReads=reads;await service.tick(task.id);expect(reads).toBe(stoppedReads);drift=false;writeFileSync(join(f.project,'scripts/tool.py'),'# synthetic tool\n');await service.tick(task.id);expect(reads).toBe(stoppedReads);await domain.taskAction(task.id,'prepare',{});now=new Date().toISOString();await service.connect(task.id,'codex',{receipt:randomUUID()});expect(f.store.eventCount()).toBe(1);
 }finally{await domain.close?.();f.cleanup();}
});
test('external root collector discards an in-flight source read after shared snapshot drift and retains historical results',async()=>{
 const f=localWebFixture();const p=pair(f);let picked=p.path;let domain=createLocalWebDomain({store:f.store,metadataFile:f.metadataFile,profiles:[f.profile],picker:()=>Promise.resolve(picked),adapterFactory:(store,execution)=>createSyntheticCodexWorkflowAdapter(store,execution,f.script)});
 try{const preview=await domain.importSetup!() as {token:string};const bound=await domain.bindSetup!({token:preview.token,project_id:'project-1',template_id:f.profile.id}) as {profile_id:string;local_setup_path:string};const task=await domain.createTask({name:'Synthetic root boundary',project_id:'project-1',setup_id:bound.profile_id}) as {id:string};await domain.taskAction(task.id,'apply',{});await domain.taskAction(task.id,'ticket',{});const ticket=domain.task(task.id).startup as {ticket_id:string};const source=f.sourceFor(ticket.ticket_id);picked=source.path;const selection=await domain.chooseSession(task.id) as {handle:string};await domain.taskAction(task.id,'connect',{source_handle:selection.handle});
  const db=new Database(f.metadataFile);const row=db.prepare('SELECT setup FROM web_tasks WHERE id=?').get(task.id) as {setup:string};db.close();const setup=JSON.parse(row.setup) as typeof f.profile.setup;
  const original=collection.readSource;let sourceReads=0;const spy=vi.spyOn(collection,'readSource').mockImplementation(path=>{const bytes=original(path);if(path===source.path){sourceReads++;writeFileSync(join(f.project,'scripts/tool.py'),'# drift during native read\n');}return bytes;});
  const execution={...f.execution(randomUUID(),'collect',source.id,source.path),timeout_ms:1000};f.appendUsage(source);try{await expect(collectExternalTask(f.store,setup,execution,createSyntheticCodexWorkflowAdapter(f.store,execution,f.script))).rejects.toThrow();}finally{spy.mockRestore();}
  expect(sourceReads).toBe(1);expect(f.store.eventCount()).toBe(0);expect(new Lifecycle(f.store).state(task.id)).toBe('paused');const window=(domain.task(task.id).measurement as {window:unknown}).window;
  writeFileSync(join(f.project,'scripts/tool.py'),'# synthetic tool\n');await domain.taskAction(task.id,'finish-failed',{});const result=domain.task(task.id);await domain.close?.();unlinkSync(join(f.project,bound.local_setup_path));domain=createLocalWebDomain({store:f.store,metadataFile:f.metadataFile});expect(domain.task(task.id)).toMatchObject({status:'failed',outcome:result.outcome,price:result.price,attempt:result.attempt,measurement:{window}});
 }finally{await domain.close?.();f.cleanup();}
});

test('copying the same shared files to another checkout uses its explicit local template and private paths',async()=>{
 const a=localWebFixture(),b=localWebFixture();const p=pair(a);pair(b);cpSync(join(a.project,'harness-config'),join(b.project,'harness-config'),{recursive:true});b.profile.id='another-reviewed-template';b.profile.execution.poll_ms=15;
 const domains=[createLocalWebDomain({store:a.store,metadataFile:a.metadataFile,profiles:[a.profile],picker:()=>Promise.resolve(p.path)}),createLocalWebDomain({store:b.store,metadataFile:b.metadataFile,profiles:[b.profile],picker:()=>Promise.resolve(join(b.project,'harness-config/comparisons/baseline-vs-v2.json'))})];
 try{const ids:string[]=[];for(const [index,f] of [a,b].entries()){const domain=domains[index]!;const preview=await domain.importSetup!() as {token:string};const bound=await domain.bindSetup!({token:preview.token,project_id:'project-1',template_id:f.profile.id}) as {profile_id:string};ids.push(bound.profile_id);const startup=loadSharedStartup(f.store,join(f.project,'harness-config/comparisons/baseline-vs-v2.json'))[0]!;expect(startup.shared_binding!.settings_hash).toBe(p.descriptor.settings_hash);expect(startup.shared_binding!.project_root).toBe(f.project);expect(startup.execution.poll_ms).toBe(f.profile.execution.poll_ms);expect(f.store.all('SELECT * FROM tasks')).toHaveLength(0);expect(f.store.all('SELECT * FROM codex_workflow_runs')).toHaveLength(0);}expect(ids[0]).not.toBe(ids[1]);
 }finally{for(const domain of domains)await domain.close?.();a.cleanup();b.cleanup();}
});
test('immutable variant-to-bundle mapping survives use of a different UI metadata DB',async()=>{
 const f=localWebFixture();const p=pair(f);let domain=createLocalWebDomain({store:f.store,metadataFile:f.metadataFile,profiles:[f.profile],picker:()=>Promise.resolve(p.path)});
 try{const preview=await domain.importSetup!() as {token:string};await domain.bindSetup!({token:preview.token,project_id:'project-1',template_id:f.profile.id});await domain.close?.();
  for(const [i,version] of ['baseline-next','v2-next'].entries()){writeFileSync(join(f.project,'policy.md'),readFileSync(f.input.artifacts[i]!.selected_artifacts[0]!.path));registerHarness(f.project,{schema_version:1,harness_id:'search',version,policy_version:comparisonVariant(f.store,f.input.artifacts[i]!.variant_id).policy_version,readme_path:'notes.md',artifacts:[{artifact_id:'instruction',role:'instruction',source_path:'policy.md',target_path:'harness.md'}]});}generateComparison(f.project,{schema_version:1,id:'next-pair',name:'Next pair',arm_a:'baseline-next',arm_b:'v2-next'});
  domain=createLocalWebDomain({store:f.store,metadataFile:join(f.root,'another-ui.sqlite'),profiles:[f.profile],picker:()=>Promise.resolve(join(f.project,'harness-config/comparisons/next-pair.json'))});const next=await domain.importSetup!() as {token:string};expect(()=>domain.bindSetup!({token:next.token,project_id:'project-1',template_id:f.profile.id})).toThrow('shared_registration_mismatch');expect(f.store.all('SELECT * FROM tasks')).toHaveLength(0);
 }finally{await domain.close?.();f.cleanup();}
});

test('recovered pending Apply cannot write managed instructions before assigned-tool verification',async()=>{
 const f=localWebFixture();const p=pair(f);const domain=createLocalWebDomain({store:f.store,metadataFile:f.metadataFile,profiles:[f.profile],picker:()=>Promise.resolve(p.path)});
 try{const preview=await domain.importSetup!() as {token:string};const bound=await domain.bindSetup!({token:preview.token,project_id:'project-1',template_id:f.profile.id}) as {profile_id:string};const execute=f.store.execute.bind(f.store);const crash=vi.spyOn(f.store,'execute').mockImplementation((sql,params)=>{if(sql.startsWith('INSERT INTO tasks'))throw new Error('synthetic_interruption');execute(sql,params);});let task:{id:string};try{task=await domain.createTask({name:'Synthetic pending apply',project_id:'project-1',setup_id:bound.profile_id}) as typeof task;}finally{crash.mockRestore();}
  writeFileSync(join(f.project,'scripts/tool.py'),'# mismatched original\n');await expect(domain.taskAction(task.id,'apply',{})).rejects.toThrow('shared_tool_mismatch');expect(existsSync(join(f.project,'.harness-delta-managed/active-instructions.md'))).toBe(false);expect(f.store.all('SELECT id FROM comparison_assignments')).toHaveLength(1);
 }finally{await domain.close?.();f.cleanup();}
});
test('Connect refuses a valid descriptor that changed since preview',async()=>{
 const f=localWebFixture();const p=pair(f);const domain=createLocalWebDomain({store:f.store,metadataFile:f.metadataFile,profiles:[f.profile],picker:()=>Promise.resolve(p.path)});
 try{const preview=await domain.importSetup!() as {token:string};unlinkSync(p.path);generateComparison(f.project,{schema_version:1,id:'baseline-vs-v2',name:'Changed after preview',arm_a:'baseline',arm_b:'v2'});expect(()=>domain.bindSetup!({token:preview.token,project_id:'project-1',template_id:f.profile.id})).toThrow('shared_preview_changed');expect(await domain.bootstrap()).toMatchObject({setups:[{id:f.profile.id}],tasks:[]});expect(f.store.all('SELECT task_id FROM shared_configuration_tasks')).toHaveLength(0);
 }finally{await domain.close?.();f.cleanup();}
});
test('persisted comparison ID conflicts cannot bypass a fresh UI DB',async()=>{
 const f=localWebFixture();const p=pair(f);let domain=createLocalWebDomain({store:f.store,metadataFile:f.metadataFile,profiles:[f.profile],picker:()=>Promise.resolve(p.path)});
 try{const preview=await domain.importSetup!() as {token:string};await domain.bindSetup!({token:preview.token,project_id:'project-1',template_id:f.profile.id});await domain.close?.();unlinkSync(p.path);generateComparison(f.project,{schema_version:1,id:'baseline-vs-v2',name:'Conflicting name',arm_a:'baseline',arm_b:'v2'});domain=createLocalWebDomain({store:f.store,metadataFile:join(f.root,'fresh-ui.sqlite'),profiles:[f.profile],picker:()=>Promise.resolve(p.path)});const next=await domain.importSetup!() as {token:string};expect(()=>domain.bindSetup!({token:next.token,project_id:'project-1',template_id:f.profile.id})).toThrow('shared_settings_conflict');
 }finally{await domain.close?.();f.cleanup();}
});
test('deleted-project binding is excluded after re-registering the same directory',async()=>{
 const f=localWebFixture();const p=pair(f);const domain=createLocalWebDomain({store:f.store,metadataFile:f.metadataFile,profiles:[f.profile],picker:()=>Promise.resolve(p.path)});
 try{const preview=await domain.importSetup!() as {token:string};const bound=await domain.bindSetup!({token:preview.token,project_id:'project-1',template_id:f.profile.id}) as {profile_id:string};new Deletion(f.store).deleteProject('project-1');new Lifecycle(f.store).registerProject('project-2',f.project);expect(()=>loadSharedStartup(f.store,p.path,bound.profile_id)).toThrow('shared_binding_required');expect(()=>loadSharedStartup(f.store,p.path)).toThrow('shared_binding_required');
 }finally{await domain.close?.();f.cleanup();}
});
test('setup-bind transport enforces CSRF, replays exact writes and cancellation creates no setup',async()=>{
 const f=localWebFixture();const p=pair(f);let picked:string|null=null;const domain=createLocalWebDomain({store:f.store,metadataFile:f.metadataFile,profiles:[f.profile],picker:()=>Promise.resolve(picked)});const origin='http://127.0.0.1:4318';const app=createLocalWebServer({origin,domain,metadataFile:f.metadataFile});
 try{const csrf=(await app.inject({url:'/api/bootstrap',headers:{host:'127.0.0.1:4318'}})).json<{csrf:string}>().csrf;const headers={host:'127.0.0.1:4318',origin,'content-type':'application/json','x-harness-csrf':csrf,'idempotency-key':randomUUID()};
  expect((await app.inject({method:'POST',url:'/api/setup-picker',payload:'{}',headers})).json()).toEqual({cancelled:true});picked=p.path;const preview=(await app.inject({method:'POST',url:'/api/setup-picker',payload:'{}',headers:{...headers,'idempotency-key':randomUUID()}})).json<{token:string}>();const payload=JSON.stringify({token:preview.token,project_id:'project-1',template_id:f.profile.id});expect((await app.inject({method:'POST',url:'/api/setup-bind',payload,headers:{host:'127.0.0.1:4318',origin}})).statusCode).toBe(403);
  const bindHeaders={...headers,'idempotency-key':randomUUID()};const first=await app.inject({method:'POST',url:'/api/setup-bind',payload,headers:bindHeaders});expect(first.statusCode).toBe(200);expect((await app.inject({method:'POST',url:'/api/setup-bind',payload,headers:bindHeaders})).body).toBe(first.body);expect(f.store.all('SELECT * FROM tasks')).toHaveLength(0);
 }finally{await app.close();f.cleanup();}
});
