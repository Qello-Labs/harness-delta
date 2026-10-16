import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { localWebFixture } from './helpers/local-web-fixture.js';
import { registerHarness, generateComparison } from '../src/harness-config.js';
import { comparisonVariant } from '../src/comparison.js';
import { createLocalWebDomain } from '../src/local-web-domain.js';
import { createLocalWebServer } from '../src/local-web-server.js';

test('UI HTTP workflow imports a portable pair, explicitly binds it and persists one inactive task',async()=>{
 const f=localWebFixture();writeFileSync(join(f.project,'notes.md'),'Synthetic browser exercise prerequisites\n');
 for(const [i,version] of ['baseline','v2'].entries()){
  writeFileSync(join(f.project,'policy.md'),readFileSync(f.input.artifacts[i]!.selected_artifacts[0]!.path));
  registerHarness(f.project,{schema_version:1,harness_id:'search',version,policy_version:comparisonVariant(f.store,f.input.artifacts[i]!.variant_id).policy_version,readme_path:'notes.md',artifacts:[{artifact_id:'instruction',role:'instruction',source_path:'policy.md',target_path:'harness.md'}]});
 }
 generateComparison(f.project,{schema_version:1,id:'baseline-vs-v2',name:'Synthetic browser pair',arm_a:'baseline',arm_b:'v2'});
 const origin='http://127.0.0.1:4318';
 const domain=createLocalWebDomain({store:f.store,metadataFile:f.metadataFile,profiles:[f.profile],picker:()=>Promise.resolve(join(f.project,'harness-config/comparisons/baseline-vs-v2.json'))});
 let app=createLocalWebServer({origin,domain,metadataFile:f.metadataFile});
 try{
  const bootstrap=await app.inject({url:'/api/bootstrap',headers:{host:'127.0.0.1:4318'}});
  expect(bootstrap.statusCode).toBe(200);
  const {csrf}=bootstrap.json<{csrf:string}>();
  const headers={host:'127.0.0.1:4318',origin,'x-harness-csrf':csrf};
  const preview=await app.inject({method:'POST',url:'/api/setup-picker',headers:{...headers,'idempotency-key':randomUUID()},payload:{}});
  expect(preview.statusCode).toBe(200);
  const imported=preview.json<{shared:boolean;token:string;projects:{project_id:string}[]}>();
  expect(imported.shared).toBe(true);
  expect(imported.projects.map(project=>project.project_id)).toEqual(['project-1']);
  expect(f.store.all('SELECT id FROM tasks')).toHaveLength(0);
  expect(f.store.all('SELECT id FROM comparison_assignments')).toHaveLength(0);
  const db=new Database(f.metadataFile);
  try{expect(db.prepare('SELECT id FROM web_profiles').all()).toHaveLength(1);}finally{db.close();}
  const binding=await app.inject({method:'POST',url:'/api/setup-bind',headers:{...headers,'idempotency-key':randomUUID()},payload:{token:imported.token,project_id:'project-1',template_id:f.profile.id}});
  expect(binding.statusCode).toBe(200);
  const {profile_id}=binding.json<{profile_id:string}>();
  expect(profile_id).not.toBe(f.profile.id);
  const request={method:'POST' as const,url:'/api/tasks',headers:{...headers,'idempotency-key':randomUUID()},payload:{name:'Synthetic HTTP task',project_id:'project-1',setup_id:profile_id}};
  const created=await app.inject(request);
  expect(created.statusCode).toBe(200);
  const task=created.json<{id:string;setup_id:string}>();
  expect(task.setup_id).toBe(profile_id);
  expect((await app.inject(request)).json()).toEqual(created.json());
  expect(f.store.all('SELECT state FROM tasks')).toEqual([{state:'registered'}]);expect(f.store.all('SELECT id FROM comparison_assignments')).toHaveLength(1);expect(f.store.all('SELECT * FROM active_intervals')).toHaveLength(0);expect(f.store.eventCount()).toBe(0);
  await app.close();
  const restored=createLocalWebDomain({store:f.store,metadataFile:f.metadataFile,profiles:[f.profile]});
  app=createLocalWebServer({origin,domain:restored,metadataFile:f.metadataFile});
  const result=await app.inject({url:`/api/tasks/${task.id}`,headers:{host:headers.host}});
  expect(result.statusCode).toBe(200);expect(result.json()).toMatchObject({id:task.id,setup_id:profile_id});
  const saved=new Database(f.metadataFile);
  try{expect(saved.prepare('SELECT id FROM web_profiles').all()).toHaveLength(2);}finally{saved.close();}
 }finally{await app.close();f.cleanup();}
});
