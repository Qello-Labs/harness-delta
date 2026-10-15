import {Deletion} from '../src/deletion.js';
import {writeFileSync,readFileSync,mkdirSync,symlinkSync,unlinkSync,existsSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {expect,test} from 'vitest';
import {localWebFixture} from './helpers/local-web-fixture.js';
import {prepareExternalTask} from '../src/external-session-service.js';
import {registerHarness,hashBytes} from '../src/harness-config.js';
import {ApplicationCoordinator,requireApplication,assertAppliedHarness,assertApplicationWorkingIdentity} from '../src/harness-application.js';
test('an already matching harness completes only after its unchanged outputs and checks are reported',()=>{
 const f=fixture();try{
  const path=join(f.project,'AGENTS.md'),content='Synthetic already applied rules';
  writeFileSync(path,content);
  const context=f.coordinator.prepareHandoff(f.taskId,f.selection);
  expect(f.coordinator.status(f.taskId).state).toBe('awaiting_session');
  expect(()=>assertAppliedHarness(f.store,f.taskId)).toThrow('application_required');
  const [checkpoint]=f.coordinator.checkpoint(f.taskId,{attempt_id:context.attempt_id,paths:['AGENTS.md']});
  if(!checkpoint)throw new Error('Missing synthetic checkpoint');
  report(f,context.attempt_id,checkpoint.checkpoint_id,'AGENTS.md',content);
  expect(f.coordinator.status(f.taskId).state).toBe('applied');
  assertAppliedHarness(f.store,f.taskId);
  expect(f.coordinator.review(f.taskId).changes[0]).toMatchObject({path:'AGENTS.md',verified:true,
   before_hash:hashBytes(content),actual_hash:hashBytes(content)});
  expect(readFileSync(path,'utf8')).toBe(content);
  expect(f.coordinator.prepareHandoff(f.taskId,f.selection)).toEqual(context);
 }finally{f.cleanup();}
});

test('application review compares output hashes rather than decoded text to identify unchanged files',()=>{
 const f=fixture();try{
  const path=join(f.project,'AGENTS.md');writeFileSync(path,Buffer.from([0xff]));
  const context=f.coordinator.prepareHandoff(f.taskId,f.selection);
  const [checkpoint]=f.coordinator.checkpoint(f.taskId,{attempt_id:context.attempt_id,paths:['AGENTS.md']});
  if(!checkpoint)throw new Error('Missing synthetic checkpoint');
  const after=Buffer.from([0xfe]);writeFileSync(path,after);
  f.coordinator.report(f.taskId,{attempt_id:context.attempt_id,bundle_hash:f.bundle.bundle_hash,
   outputs:[{path:'AGENTS.md',checkpoint_id:checkpoint.checkpoint_id,sha256:hashBytes(after)}],
   checks:[{check_id:'synthetic_script',outcome:'passed'}]});
  expect(f.coordinator.review(f.taskId).changes[0]).toMatchObject({verified:true,
   before_hash:hashBytes(Buffer.from([0xff])),actual_hash:hashBytes(after)});
 }finally{f.cleanup();}
});
function fixture(...native:Parameters<typeof localWebFixture>){const f=localWebFixture(...native);prepareExternalTask(f.store,f.profile.setup);writeFileSync(join(f.project,'procedure.md'),'Synthetic adapt both domains');writeFileSync(join(f.project,'README.md'),'Synthetic readme');writeFileSync(join(f.project,'tool.mjs'),'// Synthetic tool');const bundle=registerHarness(f.project,{schema_version:1,harness_id:'synthetic',version:'v2',policy_version:'synthetic',readme_path:'README.md',artifacts:[{artifact_id:'rules',role:'instruction',source_path:'procedure.md',target_path:'harness.md'},{artifact_id:'tool',role:'tool',source_path:'tool.mjs',target_path:'tool.mjs'}]}).manifest;const taskId=f.input.assignment.task_id;requireApplication(f.store,taskId,{origin:f.project,bundlePath:'harness-config/v2/manifest.json',bundleHash:bundle.bundle_hash});const coordinator=new ApplicationCoordinator(f.store);const selection={workspace:f.project,workspaceDigest:coordinator.workspace(taskId,f.project).digest,product:'codex' as const};return {...f,coordinator,selection,taskId,bundle};}
function report(f:ReturnType<typeof fixture>,attemptId:string,checkpointId:string,path:string,content:string|null){return f.coordinator.report(f.taskId,{attempt_id:attemptId,bundle_hash:f.bundle.bundle_hash,outputs:[{path,checkpoint_id:checkpointId,sha256:content===null?null:hashBytes(content)}],checks:[{check_id:'synthetic_script',outcome:'passed'}]});}
test('external attempts preserve pins on repeat, reject stale selection and retire managed execution',()=>{const f=fixture();try{const before=f.store.get('SELECT * FROM comparison_assignments WHERE task_id=?',[f.taskId]);const context=f.coordinator.prepareHandoff(f.taskId,f.selection);expect(f.coordinator.prepareHandoff(f.taskId,f.selection)).toEqual(context);expect(()=>f.coordinator.prepareHandoff(f.taskId,{...f.selection,workspaceDigest:'0'.repeat(64)})).toThrow('application_preview_changed');expect(f.store.get('SELECT * FROM comparison_assignments WHERE task_id=?',[f.taskId])).toEqual(before);expect(f.coordinator.status(f.taskId).state).toBe('awaiting_session');}finally{f.cleanup();}});
test('dirty preimages and newly discovered nested outputs are verified after direct edits',()=>{const f=fixture();try{writeFileSync(join(f.project,'AGENTS.md'),'Synthetic dirty user rule');const c=f.coordinator.prepareHandoff(f.taskId,f.selection);const [a]=f.coordinator.checkpoint(f.taskId,{attempt_id:c.attempt_id,paths:['AGENTS.md']});writeFileSync(join(f.project,'AGENTS.md'),'Synthetic adapted rule');report(f,c.attempt_id,a!.checkpoint_id,'AGENTS.md','Synthetic adapted rule');assertAppliedHarness(f.store,f.taskId);const review=f.coordinator.review(f.taskId);expect(review.changes[0]).toMatchObject({before:'Synthetic dirty user rule',after:'Synthetic adapted rule'});expect(review.checks[0]?.evidence).toBe('agent_reported');writeFileSync(join(f.project,'AGENTS.md'),'Synthetic drift');expect(()=>assertAppliedHarness(f.store,f.taskId)).toThrow('application_output_changed');expect(readFileSync(join(f.project,'AGENTS.md'),'utf8')).toBe('Synthetic drift');}finally{f.cleanup();}});
test('late discovery permits absent nested file and direct deletion without publishing',()=>{const f=fixture();try{const c=f.coordinator.prepareHandoff(f.taskId,f.selection);const [a]=f.coordinator.checkpoint(f.taskId,{attempt_id:c.attempt_id,paths:['domain/AGENTS.md']});mkdirSync(join(f.project,'domain'));writeFileSync(join(f.project,'domain/AGENTS.md'),'Synthetic nested');report(f,c.attempt_id,a!.checkpoint_id,'domain/AGENTS.md','Synthetic nested');expect(f.coordinator.review(f.taskId).changes[0]?.before).toBeNull();}finally{f.cleanup();}});
test('wrong hashes, bundle, missing checkpoints, aliases and stale reports fail closed',()=>{const f=fixture();try{const c=f.coordinator.prepareHandoff(f.taskId,f.selection);const [a]=f.coordinator.checkpoint(f.taskId,{attempt_id:c.attempt_id,paths:['AGENTS.md']});writeFileSync(join(f.project,'AGENTS.md'),'Synthetic actual');expect(()=>report(f,c.attempt_id,a!.checkpoint_id,'AGENTS.md','Synthetic claimed')).toThrow('application_output_changed');expect(()=>report(f,c.attempt_id,'00000000-0000-0000-0000-000000000000','AGENTS.md','Synthetic actual')).toThrow('application_checkpoint_invalid');symlinkSync(f.root,join(f.project,'alias'));expect(()=>f.coordinator.checkpoint(f.taskId,{attempt_id:c.attempt_id,paths:['alias/out.md']})).toThrow('application_path_forbidden');f.coordinator.cancel(f.taskId);expect(()=>report(f,c.attempt_id,a!.checkpoint_id,'AGENTS.md','Synthetic actual')).toThrow('application_attempt_stale');expect(readFileSync(join(f.project,'AGENTS.md'),'utf8')).toBe('Synthetic actual');}finally{f.cleanup();}});
test('restart invalidates unfinished attempts without rolling back user edits',()=>{const f=fixture();try{const c=f.coordinator.prepareHandoff(f.taskId,f.selection);const [a]=f.coordinator.checkpoint(f.taskId,{attempt_id:c.attempt_id,paths:['AGENTS.md']});writeFileSync(join(f.project,'AGENTS.md'),'Synthetic retained');const next=new ApplicationCoordinator(f.store);expect(next.status(f.taskId).state).toBe('failed');expect(()=>report({...f,coordinator:next},c.attempt_id,a!.checkpoint_id,'AGENTS.md','Synthetic retained')).toThrow('application_attempt_stale');expect(readFileSync(join(f.project,'AGENTS.md'),'utf8')).toBe('Synthetic retained');}finally{f.cleanup();}});
test('reported success without passed checks stays incomplete and no session content is collected',()=>{const f=fixture();try{const c=f.coordinator.prepareHandoff(f.taskId,f.selection);const [a]=f.coordinator.checkpoint(f.taskId,{attempt_id:c.attempt_id,paths:['AGENTS.md']});writeFileSync(join(f.project,'AGENTS.md'),'Synthetic rule');f.coordinator.report(f.taskId,{attempt_id:c.attempt_id,bundle_hash:f.bundle.bundle_hash,outputs:[{path:'AGENTS.md',checkpoint_id:a!.checkpoint_id,sha256:hashBytes('Synthetic rule')}],checks:[]});expect(()=>assertAppliedHarness(f.store,f.taskId)).toThrow('application_checks_incomplete');expect(f.store.eventCount()).toBe(0);}finally{f.cleanup();}});
test('applied output survives restart and unregistered identity prevents working connection',()=>{const f=fixture();try{const c=f.coordinator.prepareHandoff(f.taskId,f.selection);const [a]=f.coordinator.checkpoint(f.taskId,{attempt_id:c.attempt_id,paths:['AGENTS.md']});writeFileSync(join(f.project,'AGENTS.md'),'Synthetic rule');report(f,c.attempt_id,a!.checkpoint_id,'AGENTS.md','Synthetic rule');new ApplicationCoordinator(f.store);assertAppliedHarness(f.store,f.taskId);expect(()=>assertApplicationWorkingIdentity(f.store,f.taskId,{product:'codex',sessionId:'synthetic',parentSessionId:null,createdAt:new Date(Date.now()+1000).toISOString()})).toThrow('application_identity_unavailable');}finally{f.cleanup();}});
test('verified setup root and direct family cannot connect even under a different task',()=>{const f=fixture();try{const context=f.coordinator.prepareHandoff(f.taskId,f.selection);const identity={product:'codex' as const,productVersion:'0.160.0',sessionId:'synthetic-setup',sourceRef:'/tmp/synthetic',sourceIdentity:'synthetic-source',cwd:f.project,identityEvidenceId:'synthetic-proof',parentSessionId:null,createdAt:'2000-01-01T00:00:00.000Z'};f.coordinator.registerIdentity(f.taskId,context.attempt_id,identity);expect(()=>assertApplicationWorkingIdentity(f.store,'different-task',{...identity,sessionId:'synthetic-child',parentSessionId:identity.sessionId})).toThrow('application_setup_session_excluded');}finally{f.cleanup();}});
test('deleted output and duplicate reports verify actual absence and remain metadata-only',()=>{const f=fixture();try{writeFileSync(join(f.project,'AGENTS.md'),'Synthetic remove me');const context=f.coordinator.prepareHandoff(f.taskId,f.selection);const [checkpoint]=f.coordinator.checkpoint(f.taskId,{attempt_id:context.attempt_id,paths:['AGENTS.md']});expect(f.coordinator.checkpoint(f.taskId,{attempt_id:context.attempt_id,paths:['AGENTS.md']})).toEqual([checkpoint]);unlinkSync(join(f.project,'AGENTS.md'));const first=report(f,context.attempt_id,checkpoint!.checkpoint_id,'AGENTS.md',null);expect(report(f,context.attempt_id,checkpoint!.checkpoint_id,'AGENTS.md',null)).toEqual(first);expect(f.coordinator.review(f.taskId).changes[0]?.after).toBeNull();expect(JSON.stringify(f.store.all('SELECT * FROM harness_application_checkpoints'))).not.toContain('Synthetic remove me');}finally{f.cleanup();}});
test('deletion retains opaque applying-session exclusions and removes only product review artifacts',()=>{const f=fixture();try{const context=f.coordinator.prepareHandoff(f.taskId,f.selection);const identity={product:'codex' as const,productVersion:'0.160.0',sessionId:'synthetic-deleted-setup',sourceRef:'/tmp/synthetic',sourceIdentity:'synthetic-source',cwd:f.project,identityEvidenceId:'synthetic-proof',parentSessionId:null,createdAt:'2000-01-01T00:00:00.000Z'};f.coordinator.registerIdentity(f.taskId,context.attempt_id,identity);writeFileSync(join(f.project,'AGENTS.md'),'SYNTHETIC_PRIVATE_PREIMAGE');f.coordinator.checkpoint(f.taskId,{attempt_id:context.attempt_id,paths:['AGENTS.md']});writeFileSync(join(f.project,'AGENTS.md'),'Synthetic direct edit remains');new Deletion(f.store).deleteTask(f.taskId);expect(()=>assertApplicationWorkingIdentity(f.store,'another-task',identity)).toThrow('application_setup_session_excluded');expect(()=>assertApplicationWorkingIdentity(f.store,'another-task',{...identity,sessionId:'synthetic-child',parentSessionId:identity.sessionId})).toThrow('application_setup_session_excluded');expect(existsSync(join(f.project,`.harness-delta/applications/${f.taskId}`))).toBe(false);expect(readFileSync(join(f.project,'AGENTS.md'),'utf8')).toBe('Synthetic direct edit remains');expect(f.store.all('SELECT * FROM harness_application_attempts')).toHaveLength(0);}finally{f.cleanup();}});
test('deleting a checkpoint-only attempt removes private bytes and preserves native edits',()=>{const f=fixture();try{const context=f.coordinator.prepareHandoff(f.taskId,f.selection);writeFileSync(join(f.project,'AGENTS.md'),'SYNTHETIC_PRIVATE_BASELINE');f.coordinator.checkpoint(f.taskId,{attempt_id:context.attempt_id,paths:['AGENTS.md']});writeFileSync(join(f.project,'AGENTS.md'),'Synthetic keep native edit');new Deletion(f.store).deleteTask(f.taskId);expect(existsSync(join(f.project,`.harness-delta/applications/${f.taskId}`))).toBe(false);expect(readFileSync(join(f.project,'AGENTS.md'),'utf8')).toBe('Synthetic keep native edit');}finally{f.cleanup();}});
test('unsafe private deletion paths stay pending, never follow aliases, and retry cannot resurrect records',()=>{const f=fixture();try{const context=f.coordinator.prepareHandoff(f.taskId,f.selection);writeFileSync(join(f.project,'AGENTS.md'),'Synthetic dirty');f.coordinator.checkpoint(f.taskId,{attempt_id:context.attempt_id,paths:['AGENTS.md']});const product=join(f.project,`.harness-delta/applications/${f.taskId}`);renameSync(product,product+'-saved');const outside=join(f.root,'outside-private');mkdirSync(outside);writeFileSync(join(outside,'sentinel'),'Synthetic unrelated');symlinkSync(outside,product);const deletion=new Deletion(f.store);expect(()=>deletion.deleteTask(f.taskId)).toThrow('application_cleanup_pending');expect(readFileSync(join(outside,'sentinel'),'utf8')).toBe('Synthetic unrelated');expect(f.store.get('SELECT 1 FROM tasks WHERE id=?',[f.taskId])).toBeUndefined();expect(f.store.all('SELECT * FROM harness_application_cleanup')).toHaveLength(1);unlinkSync(product);renameSync(product+'-saved',product);deletion.deleteTask(f.taskId);expect(existsSync(product)).toBe(false);expect(f.store.all('SELECT * FROM harness_application_cleanup')).toHaveLength(0);expect(f.store.all('SELECT * FROM harness_application_attempts')).toHaveLength(0);}finally{f.cleanup();}});
test('project deletion purges product review artifacts while retaining workspace edits',()=>{const f=fixture();try{const context=f.coordinator.prepareHandoff(f.taskId,f.selection);writeFileSync(join(f.project,'AGENTS.md'),'Synthetic dirty');f.coordinator.checkpoint(f.taskId,{attempt_id:context.attempt_id,paths:['AGENTS.md']});writeFileSync(join(f.project,'AGENTS.md'),'Synthetic keep');new Deletion(f.store).deleteProject(f.input.assignment.project_id);expect(existsSync(join(f.project,`.harness-delta/applications/${f.taskId}`))).toBe(false);expect(readFileSync(join(f.project,'AGENTS.md'),'utf8')).toBe('Synthetic keep');expect(f.store.all('SELECT * FROM harness_application_cleanup')).toHaveLength(0);}finally{f.cleanup();}});

test('applying launch context is retired on abandonment and still permits private file review',()=>{
 const f=fixture();try{
  const c=f.coordinator.prepareHandoff(f.taskId,f.selection);
  expect(f.coordinator.launchContext(f.taskId,'http://127.0.0.1:4318').attemptId).toBe(c.attempt_id);
  const [cp]=f.coordinator.checkpoint(f.taskId,{attempt_id:c.attempt_id,paths:['AGENTS.md']});
  writeFileSync(join(f.project,'AGENTS.md'),'Synthetic adapted output');
  report(f,c.attempt_id,cp!.checkpoint_id,'AGENTS.md','Synthetic adapted output');
  f.coordinator.cancel(f.taskId);
  expect(()=>f.coordinator.launchContext(f.taskId,'http://127.0.0.1:4318')).toThrow('application_attempt_stale');
  expect(f.coordinator.review(f.taskId).changes[0]?.after).toBe('Synthetic adapted output');
 }finally{f.cleanup();}
});
test('completed and interrupted attempts do not offer an applying launch context',()=>{
 const f=fixture();try{
  const c=f.coordinator.prepareHandoff(f.taskId,f.selection);
  const [cp]=f.coordinator.checkpoint(f.taskId,{attempt_id:c.attempt_id,paths:['AGENTS.md']});
  writeFileSync(join(f.project,'AGENTS.md'),'Synthetic complete');
  report(f,c.attempt_id,cp!.checkpoint_id,'AGENTS.md','Synthetic complete');
  expect(()=>f.coordinator.launchContext(f.taskId,'http://127.0.0.1:4318')).toThrow('application_attempt_stale');
  f.coordinator.cancel(f.taskId);
  const next=f.coordinator.prepareHandoff(f.taskId,f.selection);
  expect(next.attempt_id).not.toBe(c.attempt_id);
  const restarted=new ApplicationCoordinator(f.store);
  expect(()=>restarted.launchContext(f.taskId,'http://127.0.0.1:4318')).toThrow('application_attempt_stale');
 }finally{f.cleanup();}
});
test('any installed agent may apply while connection guidance keeps the task agent',()=>{const f=fixture('codex-01620-ordinary-root-human-pilot',{product:'codex',productVersion:'0.162.1'});try{
 expect((JSON.parse(f.store.get<{metadata:string}>('SELECT metadata FROM tasks WHERE id=?',[f.taskId])!.metadata) as {product:string}).product).toBe('codex');
 const context=f.coordinator.prepareHandoff(f.taskId,{...f.selection,product:'claude_code'});
 expect(context.product).toBe('claude_code');
 expect(f.coordinator.launchContext(f.taskId,'http://127.0.0.1:4318').product).toBe('claude_code');
 expect(f.coordinator.handoff(f.taskId,'http://127.0.0.1:4318').connect_context).toEqual({origin:'http://127.0.0.1:4318',task_id:f.taskId,product:'codex'});
 }finally{f.cleanup();}
});
test('a different applying agent needs no application identity while a fresh working session is still required',()=>{const f=fixture('codex-01620-ordinary-root-human-pilot',{product:'codex',productVersion:'0.162.1'});try{
 const context=f.coordinator.prepareHandoff(f.taskId,{...f.selection,product:'claude_code'});
 const [checkpoint]=f.coordinator.checkpoint(f.taskId,{attempt_id:context.attempt_id,paths:['AGENTS.md']});writeFileSync(join(f.project,'AGENTS.md'),'Synthetic rule');report(f,context.attempt_id,checkpoint!.checkpoint_id,'AGENTS.md','Synthetic rule');
 const completed=f.store.get<{completed_at:string}>('SELECT completed_at FROM harness_application_attempts WHERE id=?',[context.attempt_id])!.completed_at;
 const later=new Date(Date.parse(completed)+1000).toISOString();
 const working=(product:string,createdAt:string)=>()=>assertApplicationWorkingIdentity(f.store,f.taskId,{product,sessionId:'synthetic-working',parentSessionId:null,createdAt});
 expect(working('codex',later)).not.toThrow();
 expect(working('codex',completed)).toThrow('application_fresh_session_required');
 expect(working('claude_code',later)).toThrow('application_identity_unavailable');
 expect(f.coordinator.handoff(f.taskId,'http://127.0.0.1:4318').readiness).toBe('native_loading_and_source_qualification_required');
 }finally{f.cleanup();}
});
