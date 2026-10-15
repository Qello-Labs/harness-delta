import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {createLocalWebServer} from '../src/local-web-server.js';
import {createLocalWebDomain} from '../src/local-web-domain.js';
import {generateComparison,hashBytes,registerHarness} from '../src/harness-config.js';
import {comparisonVariant} from '../src/comparison.js';
import {Lifecycle} from '../src/lifecycle.js';
import {localWebFixture} from './helpers/local-web-fixture.js';

// Synthetic repositories must not inherit the invoking checkout's hook index.
beforeEach(()=>{vi.stubEnv('GIT_INDEX_FILE',undefined);});
afterEach(()=>{vi.unstubAllEnvs();});

type TaskView={id:string;version:string;application?:{restoration?:string};actions:{code:string;enabled:boolean;reason:string|null}[]};
const origin='http://127.0.0.1:4318';

async function appliedTask() {
 const f=localWebFixture();writeFileSync(join(f.project,'README.md'),'Synthetic prerequisites');
 for(const [index,version] of ['v1','v2'].entries()){writeFileSync(join(f.project,'procedure.md'),readFileSync(f.input.artifacts[index]!.selected_artifacts[0]!.path));registerHarness(f.project,{schema_version:1,harness_id:'synthetic',version,policy_version:comparisonVariant(f.store,f.input.artifacts[index]!.variant_id).policy_version,readme_path:'README.md',artifacts:[{artifact_id:'instruction',role:'instruction',source_path:'procedure.md',target_path:'harness.md'}]});}
 generateComparison(f.project,{schema_version:2,id:'agent',name:'Synthetic restoration',arm_a:'v1',arm_b:'v2',application:'agent_applied'});
 const domain=createLocalWebDomain({store:f.store,metadataFile:f.metadataFile,profiles:[f.profile],picker:()=>Promise.resolve(join(f.project,'harness-config/comparisons/agent.json'))});
 const app=createLocalWebServer({origin,domain,metadataFile:f.metadataFile});
 const preview=await domain.importSetup!() as {token:string};const bound=await domain.bindSetup!({token:preview.token,project_id:'project-1',template_id:f.profile.id}) as {profile_id:string};
 const task=await domain.createTask({name:'Synthetic restoration',project_id:'project-1',setup_id:bound.profile_id}) as {id:string};
 const bootstrap=(await app.inject({url:'/api/bootstrap',headers:{host:'127.0.0.1:4318'}})).json<{csrf:string}>();
 const view=()=>domain.task(task.id) as unknown as TaskView;
 const post=(action:string,payload:unknown)=>app.inject({method:'POST',url:`/api/tasks/${task.id}/${action}`,headers:{host:'127.0.0.1:4318',origin,'x-harness-csrf':bootstrap.csrf,'idempotency-key':randomUUID(),'if-match':view().version,'content-type':'application/json'},payload:JSON.stringify(payload)});
 const get=(endpoint:string)=>app.inject({url:`/api/tasks/${task.id}/${endpoint}`,headers:{host:'127.0.0.1:4318'}});
 const workspace=domain.applicationWorkspace!(task.id,f.project) as {digest:string};
 expect((await post('application-prepare',{workspace:f.project,workspaceDigest:workspace.digest,product:'codex'})).statusCode).toBe(200);
 const attempt=(view().application as {jobId:string}).jobId;
 const context=(await get(`application-context?attempt=${attempt}`)).json<{bundle_hash:string}>();
 writeFileSync(join(f.project,'AGENTS.md'),'SYNTHETIC_PRIVATE_BASELINE');
 const checkpoints=(await post('application-checkpoint',{attempt_id:attempt,paths:['AGENTS.md','created.md']})).json<{path:string;checkpoint_id:string}[]>();
 writeFileSync(join(f.project,'AGENTS.md'),'SYNTHETIC_APPLIED_RULE');writeFileSync(join(f.project,'created.md'),'SYNTHETIC_CREATED_GUIDE');
 const outputs=checkpoints.map(c=>({path:c.path,checkpoint_id:c.checkpoint_id,sha256:hashBytes(c.path==='AGENTS.md'?'SYNTHETIC_APPLIED_RULE':'SYNTHETIC_CREATED_GUIDE')}));
 expect((await post('application-report',{attempt_id:attempt,bundle_hash:context.bundle_hash,outputs,checks:[{check_id:'synthetic_script',outcome:'passed'}]})).statusCode).toBe(200);
 const finish=()=>{const life=new Lifecycle(f.store);life.start(task.id);life.finalize(task.id,'failed',[]);};
 // A connected task needs the user's stop acknowledgement before restoration.
 const connected=()=>{f.store.execute("UPDATE external_preparations SET state='stopped',first_connected_at=? WHERE task_id=?",[new Date().toISOString(),task.id]);expect(preparationState()).toBe('stopped');};
 const preparationState=()=>f.store.get<{state:string}>('SELECT state FROM external_preparations WHERE task_id=?',[task.id])?.state;
 return {f,domain,app,task,view,post,get,finish,connected,preparationState};
}
const restoreAction=(view:TaskView)=>view.actions.find(action=>action.code==='application-restore');
const journal=(file:string)=>{const db=new Database(file);try{return JSON.stringify(db.prepare('SELECT * FROM web_actions').all());}finally{db.close();}};

test('ending measurement keeps the harness; the second step previews, restores and reports staged harness files',async()=>{
 const s=await appliedTask();
 try{
  expect(s.view().application?.restoration).toBe('available');
  expect(restoreAction(s.view())).toMatchObject({enabled:false,reason:'application_outcome_required'});
  expect((await s.post('application-restore',{preview_digest:'a'.repeat(64),external_session_stopped:true})).json()).toEqual({error:'application_outcome_required'});
  s.finish();s.connected();
  expect(readFileSync(join(s.f.project,'AGENTS.md'),'utf8')).toBe('SYNTHETIC_APPLIED_RULE');
  expect(restoreAction(s.view())).toMatchObject({enabled:true});

  const previewReply=await s.get('application-restoration');
  expect(previewReply.headers['cache-control']).toBe('no-store');
  const preview=previewReply.json<{digest:string;files:{path:string;action:string}[]}>();
  expect(preview.files).toEqual([{path:'AGENTS.md',action:'restore'},{path:'created.md',action:'delete'}]);
  expect(previewReply.body).not.toContain('SYNTHETIC_');

  expect((await s.post('application-restore',{preview_digest:preview.digest})).statusCode).toBe(400);
  expect((await s.post('application-restore',{preview_digest:'0'.repeat(64),external_session_stopped:true})).json()).toEqual({error:'application_preview_changed'});
  expect(readFileSync(join(s.f.project,'AGENTS.md'),'utf8')).toBe('SYNTHETIC_APPLIED_RULE');
  expect(s.preparationState()).toBe('stopped');

  execFileSync('git',['-C',s.f.project,'add','AGENTS.md']);
  const restored=await s.post('application-restore',{preview_digest:preview.digest,external_session_stopped:true});
  expect(restored.statusCode).toBe(200);
  expect(restored.json()).toMatchObject({application:{restoration:'restored'},restoration:{staged:{clean:false,files:[{path:'AGENTS.md',reason:'application_change_staged'}]}}});
  expect(readFileSync(join(s.f.project,'AGENTS.md'),'utf8')).toBe('SYNTHETIC_PRIVATE_BASELINE');
  expect(existsSync(join(s.f.project,'created.md'))).toBe(false);
  expect(s.preparationState()).toBe('released');
  expect(restoreAction(s.view())).toMatchObject({enabled:false,reason:'application_restored'});
  expect(restored.body).not.toContain('SYNTHETIC_');
  expect(journal(s.f.metadataFile)).not.toContain('SYNTHETIC_');
 }finally{await s.app.close();s.f.cleanup();}
},30000);

test('a file edited after application blocks the whole restoration without changing any file',async()=>{
 const s=await appliedTask();
 try{
  s.finish();s.connected();
  writeFileSync(join(s.f.project,'created.md'),'SYNTHETIC_USER_EDIT');
  const preview=(await s.get('application-restoration')).json<{digest:string;files:{path:string;action:string}[]}>();
  expect(preview.files).toEqual([{path:'AGENTS.md',action:'restore'},{path:'created.md',action:'conflict'}]);
  expect((await s.post('application-restore',{preview_digest:preview.digest,external_session_stopped:true})).json()).toEqual({error:'application_restore_conflict'});
  expect(readFileSync(join(s.f.project,'AGENTS.md'),'utf8')).toBe('SYNTHETIC_APPLIED_RULE');
  expect(readFileSync(join(s.f.project,'created.md'),'utf8')).toBe('SYNTHETIC_USER_EDIT');
  expect(s.view().application?.restoration).toBe('available');
  expect(s.preparationState()).toBe('stopped');
 }finally{await s.app.close();s.f.cleanup();}
},30000);
