import {execFileSync} from 'node:child_process';
import {mkdirSync,unlinkSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {prepareExternalTask} from '../../src/external-session-service.js';
import {ApplicationCoordinator,requireApplication} from '../../src/harness-application.js';
import {hashBytes,registerHarness} from '../../src/harness-config.js';
import {localWebFixture} from './local-web-fixture.js';

export function git(root:string,args:string[],extra:NodeJS.ProcessEnv={}) {
 return execFileSync('git',['-C',root,...args],{encoding:'utf8',env:{...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_'))),...extra}});
}
export function fixture() {
 const f=localWebFixture();prepareExternalTask(f.store,f.profile.setup);
 writeFileSync(join(f.project,'procedure.md'),'Synthetic procedure');
 writeFileSync(join(f.project,'README.md'),'Synthetic readme');
 const bundle=registerHarness(f.project,{schema_version:1,harness_id:'synthetic',version:'v2',policy_version:'synthetic',readme_path:'README.md',artifacts:[{artifact_id:'rules',role:'instruction',source_path:'procedure.md',target_path:'harness.md'}]}).manifest;
 const taskId=f.input.assignment.task_id;
 requireApplication(f.store,taskId,{origin:f.project,bundlePath:'harness-config/v2/manifest.json',bundleHash:bundle.bundle_hash});
 return {...f,taskId,bundle,coordinator:new ApplicationCoordinator(f.store,[],false)};
}
export type Fixture=ReturnType<typeof fixture>;
export function begin(f:Fixture,workspace=f.project) {
 return f.coordinator.prepareHandoff(f.taskId,{workspace,workspaceDigest:f.coordinator.workspace(f.taskId,workspace).digest,product:'codex'});
}
export function bytes(root:string,path:string,content:string|null) {
 const file=join(root,path);
 if(content===null)unlinkSync(file);
 else {mkdirSync(dirname(file),{recursive:true});writeFileSync(file,content);}
}
export function apply(f:Fixture,attempt:ReturnType<typeof begin>,changes:Record<string,string|null>) {
 const checkpoints=f.coordinator.checkpoint(f.taskId,{attempt_id:attempt.attempt_id,paths:Object.keys(changes)});
 const outputs=Object.entries(changes).map(([path,content])=>{
  const checkpoint=checkpoints.find(value=>value.path===path);
  if(!checkpoint)throw new Error('synthetic_checkpoint_missing');
  bytes(attempt.workspace.root,path,content);
  return {path,checkpoint_id:checkpoint.checkpoint_id,sha256:content===null?null:hashBytes(content)};
 });
 return f.coordinator.report(f.taskId,{attempt_id:attempt.attempt_id,bundle_hash:f.bundle.bundle_hash,outputs,checks:[{check_id:'synthetic_script',outcome:'passed'}]});
}
export function restore(f:Fixture) {return f.coordinator.restore(f.taskId,f.coordinator.restorationPreview(f.taskId).digest);}
