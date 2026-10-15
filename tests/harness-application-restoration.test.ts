import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {assertAppliedHarness} from '../src/harness-application.js';
import {hashBytes} from '../src/harness-config.js';
import {releaseExternalWorkflow} from '../src/external-session-workflow.js';
import {Lifecycle} from '../src/lifecycle.js';
import {apply,begin,bytes,fixture,git,restore} from './helpers/harness-application-restoration-fixture.js';

// Keep subprocess deadlines observable while complete application fixtures run.
vi.setConfig({testTimeout:30000});

// Synthetic worktrees must not inherit the invoking checkout's hook index.
beforeEach(()=>{vi.stubEnv('GIT_INDEX_FILE',undefined);});
afterEach(()=>{vi.unstubAllEnvs();});

test('restoration uses dirty checkpoint bytes rather than HEAD and fences application',()=>{
 const f=fixture();try {
  bytes(f.project,'AGENTS.md','SYNTHETIC_HEAD');
  git(f.project,['add','AGENTS.md']);
  git(f.project,['-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','-qm','Synthetic tracked baseline']);
  bytes(f.project,'AGENTS.md','SYNTHETIC_DIRTY_BASELINE');
  const attempt=begin(f);apply(f,attempt,{'AGENTS.md':'SYNTHETIC_APPLIED_LONGER'});
  const preview=f.coordinator.restorationPreview(f.taskId);
  expect(preview).toMatchObject({task_id:f.taskId,attempt_id:attempt.attempt_id,workspace:f.project,files:[{path:'AGENTS.md',before_hash:hashBytes('SYNTHETIC_DIRTY_BASELINE'),applied_hash:hashBytes('SYNTHETIC_APPLIED_LONGER'),current_hash:hashBytes('SYNTHETIC_APPLIED_LONGER'),action:'restore'}]});
  const restored=f.coordinator.restore(f.taskId,preview.digest);
  expect(readFileSync(join(f.project,'AGENTS.md'),'utf8')).toBe('SYNTHETIC_DIRTY_BASELINE');
  expect(git(f.project,['show','HEAD:AGENTS.md'])).toBe('SYNTHETIC_HEAD');
  expect(restored.files).toEqual([{...preview.files[0],current_hash:hashBytes('SYNTHETIC_DIRTY_BASELINE'),action:'unchanged'}]);
  expect(restored).toEqual(f.coordinator.restorationPreview(f.taskId));
  expect(restored.digest).not.toBe(preview.digest);
  expect(f.coordinator.status(f.taskId)).toMatchObject({state:'abandoned',reason:'application_restored'});
  expect(()=>assertAppliedHarness(f.store,f.taskId)).toThrow('application_required');
 }finally{f.cleanup();}
});
test('restoration deletes created outputs and recreates deleted existing outputs',()=>{
 const f=fixture();try {
  bytes(f.project,'old/AGENTS.md','SYNTHETIC_EXISTING');
  const attempt=begin(f);apply(f,attempt,{'new/AGENTS.md':'SYNTHETIC_CREATED','old/AGENTS.md':null});
  expect(f.coordinator.restorationPreview(f.taskId).files).toEqual(expect.arrayContaining([
   {path:'new/AGENTS.md',before_hash:null,applied_hash:hashBytes('SYNTHETIC_CREATED'),current_hash:hashBytes('SYNTHETIC_CREATED'),action:'delete'},
   {path:'old/AGENTS.md',before_hash:hashBytes('SYNTHETIC_EXISTING'),applied_hash:null,current_hash:null,action:'restore'}
  ]));
  restore(f);
  expect(existsSync(join(f.project,'new/AGENTS.md'))).toBe(false);
  expect(readFileSync(join(f.project,'old/AGENTS.md'),'utf8')).toBe('SYNTHETIC_EXISTING');
 }finally{f.cleanup();}
});
test('one diverged output prevents every restoration and preserves application state',()=>{
 const f=fixture();try {
  bytes(f.project,'a/AGENTS.md','SYNTHETIC_A_BASELINE');
  const attempt=begin(f);apply(f,attempt,{'a/AGENTS.md':'SYNTHETIC_A_APPLIED','z/AGENTS.md':'SYNTHETIC_Z_APPLIED'});
  bytes(f.project,'z/AGENTS.md','SYNTHETIC_USER_EDIT');
  const before=f.store.all('SELECT * FROM harness_application_attempts');
  const preview=f.coordinator.restorationPreview(f.taskId);
  expect(preview.files).toEqual(expect.arrayContaining([expect.objectContaining({path:'a/AGENTS.md',action:'restore'}),expect.objectContaining({path:'z/AGENTS.md',action:'conflict'})]));
  expect(()=>f.coordinator.restore(f.taskId,preview.digest)).toThrow('application_restore_conflict');
  expect(readFileSync(join(f.project,'a/AGENTS.md'),'utf8')).toBe('SYNTHETIC_A_APPLIED');
  expect(readFileSync(join(f.project,'z/AGENTS.md'),'utf8')).toBe('SYNTHETIC_USER_EDIT');
  expect(f.store.all('SELECT * FROM harness_application_attempts')).toEqual(before);
 }finally{f.cleanup();}
});
test('stale preview digest cannot restore even when files independently return to baseline',()=>{
 const f=fixture();try {
  bytes(f.project,'AGENTS.md','SYNTHETIC_BASELINE');
  apply(f,begin(f),{'AGENTS.md':'SYNTHETIC_APPLIED'});
  const preview=f.coordinator.restorationPreview(f.taskId);
  bytes(f.project,'AGENTS.md','SYNTHETIC_BASELINE');
  expect(()=>f.coordinator.restore(f.taskId,preview.digest)).toThrow('application_preview_changed');
  expect(f.coordinator.restorationPreview(f.taskId).files[0]?.action).toBe('unchanged');
  expect(f.store.get<{state:string}>('SELECT state FROM harness_application_attempts WHERE id=?',[preview.attempt_id])?.state).toBe('applied');
 }finally{f.cleanup();}
});
test('preview and staged checking never roll back files or change attempts and index',()=>{
 const f=fixture();try {
  const attempt=begin(f);apply(f,attempt,{'AGENTS.md':'SYNTHETIC_APPLIED'});
  git(f.project,['add','AGENTS.md']);
  const attempts=f.store.all('SELECT * FROM harness_application_attempts');
  const index=git(f.project,['ls-files','--stage']);
  const first=f.coordinator.restorationPreview(f.taskId);
  expect(f.coordinator.restorationPreview(f.taskId)).toEqual(first);
  expect(f.coordinator.checkStaged(f.taskId).clean).toBe(false);
  expect(readFileSync(join(f.project,'AGENTS.md'),'utf8')).toBe('SYNTHETIC_APPLIED');
  expect(git(f.project,['ls-files','--stage'])).toBe(index);
  expect(f.store.all('SELECT * FROM harness_application_attempts')).toEqual(attempts);
 }finally{f.cleanup();}
});
test('restoration refuses an active measurement without modifying outputs',()=>{
 const f=fixture();try {
  apply(f,begin(f),{'AGENTS.md':'SYNTHETIC_APPLIED'});
  f.store.execute("UPDATE tasks SET state='active' WHERE id=?",[f.taskId]);
  expect(()=>restore(f)).toThrow('workflow_run_active');
  expect(readFileSync(join(f.project,'AGENTS.md'),'utf8')).toBe('SYNTHETIC_APPLIED');
 }finally{f.cleanup();}
});
test('restoration permits finalized tasks after observation has stopped',()=>{
 const f=fixture();try {
  apply(f,begin(f),{'AGENTS.md':'SYNTHETIC_APPLIED'});
  f.store.execute("UPDATE tasks SET state='finalized',finalized_at='2026-01-01T00:00:00.000Z' WHERE id=?",[f.taskId]);
  restore(f);
  expect(existsSync(join(f.project,'AGENTS.md'))).toBe(false);
  expect(f.coordinator.status(f.taskId).reason).toBe('application_restored');
 }finally{f.cleanup();}
});
test('restoration requires explicit stop acknowledgement for previously connected measurement',()=>{
 const f=fixture();try {
  apply(f,begin(f),{'AGENTS.md':'SYNTHETIC_APPLIED'});
  f.store.execute("UPDATE external_preparations SET first_connected_at='2026-01-01T00:00:00.000Z',state='connected' WHERE task_id=?",[f.taskId]);
  expect(()=>restore(f)).toThrow('external_stop_acknowledgement_required');
  expect(readFileSync(join(f.project,'AGENTS.md'),'utf8')).toBe('SYNTHETIC_APPLIED');
  releaseExternalWorkflow(f.store,f.taskId,true);
  expect(f.store.get('SELECT 1 FROM external_surface_leases WHERE task_id=?',[f.taskId])).toBeUndefined();
  restore(f);
  expect(existsSync(join(f.project,'AGENTS.md'))).toBe(false);
  expect(f.store.get('SELECT 1 FROM external_surface_leases WHERE task_id=?',[f.taskId])).toBeUndefined();
 }finally{f.cleanup();}
});
test('restoration refuses another task surface owner without overwriting its lease',()=>{
 const f=fixture();try {
  apply(f,begin(f),{'AGENTS.md':'SYNTHETIC_APPLIED'});
  releaseExternalWorkflow(f.store,f.taskId,true);
  new Lifecycle(f.store).createTask(f.input.assignment.project_id,'synthetic-owner',f.input.assignment.metadata);
  f.store.execute("INSERT INTO external_preparations(task_id,project_id,revision,configuration_digest,active_digest,state,prepared_at) SELECT 'synthetic-owner',project_id,revision,configuration_digest,active_digest,'assigned',prepared_at FROM external_preparations WHERE task_id=?",[f.taskId]);
  f.store.execute('INSERT INTO external_surface_leases(surface_key,task_id) VALUES(?,?)',[hashBytes(f.project),'synthetic-owner']);
  expect(()=>restore(f)).toThrow('external_surface_busy');
  expect(readFileSync(join(f.project,'AGENTS.md'),'utf8')).toBe('SYNTHETIC_APPLIED');
  expect(f.store.get<{task_id:string}>('SELECT task_id FROM external_surface_leases WHERE surface_key=?',[hashBytes(f.project)])?.task_id).toBe('synthetic-owner');
 }finally{f.cleanup();}
});
test('restoration is idempotent with a fresh digest and does not advance the epoch twice',()=>{
 const f=fixture();try {
  apply(f,begin(f),{'AGENTS.md':'SYNTHETIC_APPLIED'});
  const restored=restore(f);
  const marker=f.store.get('SELECT * FROM harness_application_tasks WHERE task_id=?',[f.taskId]);
  expect(f.coordinator.restore(f.taskId,restored.digest)).toEqual(restored);
  expect(f.store.get('SELECT * FROM harness_application_tasks WHERE task_id=?',[f.taskId])).toEqual(marker);
  expect(existsSync(join(f.project,'AGENTS.md'))).toBe(false);
 }finally{f.cleanup();}
});
test('explicit reapplication after restoration starts fresh without inherited restored outputs',()=>{
 const f=fixture();try {
  const first=begin(f);apply(f,first,{'old/AGENTS.md':'SYNTHETIC_OLD'});
  restore(f);
  const next=begin(f);
  expect(next.attempt_id).not.toBe(first.attempt_id);
  expect(next.epoch).toBeGreaterThan(first.epoch);
  expect(next.prior_outputs).toEqual([]);
  apply(f,next,{'new/AGENTS.md':'SYNTHETIC_NEW'});
  assertAppliedHarness(f.store,f.taskId);
  expect(f.coordinator.restorationPreview(f.taskId).files.map(file=>file.path)).toEqual(['new/AGENTS.md']);
  restore(f);
  expect(existsSync(join(f.project,'new/AGENTS.md'))).toBe(false);
 }finally{f.cleanup();}
});
test('multiple attempts restore earliest baselines including inherited checkpoint outputs',()=>{
 const f=fixture();try {
  bytes(f.project,'a/AGENTS.md','SYNTHETIC_EARLIEST_A');
  bytes(f.project,'b/AGENTS.md','SYNTHETIC_EARLIEST_B');
  const first=begin(f);apply(f,first,{'a/AGENTS.md':'SYNTHETIC_A_ONE','b/AGENTS.md':'SYNTHETIC_B_ONE'});
  f.coordinator.cancel(f.taskId);
  const second=begin(f);apply(f,second,{'a/AGENTS.md':'SYNTHETIC_A_TWO'});
  expect(second.prior_outputs).toEqual(expect.arrayContaining([{path:'b/AGENTS.md',sha256:hashBytes('SYNTHETIC_B_ONE')}]));
  const preview=f.coordinator.restorationPreview(f.taskId);
  expect(preview.files).toEqual(expect.arrayContaining([
   expect.objectContaining({path:'a/AGENTS.md',before_hash:hashBytes('SYNTHETIC_EARLIEST_A'),applied_hash:hashBytes('SYNTHETIC_A_TWO'),action:'restore'}),
   expect.objectContaining({path:'b/AGENTS.md',before_hash:hashBytes('SYNTHETIC_EARLIEST_B'),applied_hash:hashBytes('SYNTHETIC_B_ONE'),action:'restore'})
  ]));
  restore(f);
  expect(readFileSync(join(f.project,'a/AGENTS.md'),'utf8')).toBe('SYNTHETIC_EARLIEST_A');
  expect(readFileSync(join(f.project,'b/AGENTS.md'),'utf8')).toBe('SYNTHETIC_EARLIEST_B');
 }finally{f.cleanup();}
});
test('unreported attempts sharing an epoch still require restoration before changing worktrees',()=>{
 const f=fixture();try {
  const linked=join(f.root,'linked');git(f.project,['worktree','add','-q','-b','synthetic-linked',linked]);
  const first=begin(f);f.coordinator.checkpoint(f.taskId,{attempt_id:first.attempt_id,paths:['old.md']});
  restore(f);
  const next=begin(f);expect(next.epoch).toBe(first.epoch);
  f.coordinator.checkpoint(f.taskId,{attempt_id:next.attempt_id,paths:['new.md']});
  bytes(f.project,'new.md','SYNTHETIC_UNREPORTED');f.coordinator.cancel(f.taskId);
  expect(()=>begin(f,linked)).toThrow('application_restoration_required');
  expect(readFileSync(join(f.project,'new.md'),'utf8')).toBe('SYNTHETIC_UNREPORTED');
 }finally{f.cleanup();}
});
test('unreported checkpoint edits fail closed alongside otherwise restorable reported files',()=>{
 const f=fixture();try {
  bytes(f.project,'unreported/AGENTS.md','SYNTHETIC_UNREPORTED_BASELINE');
  const first=begin(f);
  f.coordinator.checkpoint(f.taskId,{attempt_id:first.attempt_id,paths:['unreported/AGENTS.md']});
  bytes(f.project,'unreported/AGENTS.md','SYNTHETIC_UNREPORTED_EDIT');
  f.coordinator.cancel(f.taskId);
  apply(f,begin(f),{'reported/AGENTS.md':'SYNTHETIC_REPORTED'});
  const preview=f.coordinator.restorationPreview(f.taskId);
  expect(preview.files).toEqual(expect.arrayContaining([expect.objectContaining({path:'unreported/AGENTS.md',action:'conflict'})]));
  expect(()=>f.coordinator.restore(f.taskId,preview.digest)).toThrow('application_restore_conflict');
  expect(readFileSync(join(f.project,'unreported/AGENTS.md'),'utf8')).toBe('SYNTHETIC_UNREPORTED_EDIT');
  expect(readFileSync(join(f.project,'reported/AGENTS.md'),'utf8')).toBe('SYNTHETIC_REPORTED');
 }finally{f.cleanup();}
});
test('unmodified unreported checkpoints do not block restoration of reported outputs',()=>{
 const f=fixture();try {
  bytes(f.project,'untouched/AGENTS.md','SYNTHETIC_UNTOUCHED');
  const attempt=begin(f);
  f.coordinator.checkpoint(f.taskId,{attempt_id:attempt.attempt_id,paths:['untouched/AGENTS.md']});
  apply(f,attempt,{'reported/AGENTS.md':'SYNTHETIC_REPORTED'});
  expect(f.coordinator.restorationPreview(f.taskId).files).toEqual(expect.arrayContaining([expect.objectContaining({path:'untouched/AGENTS.md',action:'unchanged'})]));
  restore(f);
  expect(readFileSync(join(f.project,'untouched/AGENTS.md'),'utf8')).toBe('SYNTHETIC_UNTOUCHED');
  expect(existsSync(join(f.project,'reported/AGENTS.md'))).toBe(false);
 }finally{f.cleanup();}
});
test('staged application bytes remain dirty after working tree restoration until restaged',()=>{
 const f=fixture();try {
  bytes(f.project,'AGENTS.md','SYNTHETIC_BASELINE');
  apply(f,begin(f),{'AGENTS.md':'SYNTHETIC_APPLIED'});
  git(f.project,['add','AGENTS.md']);
  restore(f);
  expect(readFileSync(join(f.project,'AGENTS.md'),'utf8')).toBe('SYNTHETIC_BASELINE');
  expect(git(f.project,['show',':AGENTS.md'])).toBe('SYNTHETIC_APPLIED');
  expect(f.coordinator.checkStaged(f.taskId)).toEqual({clean:false,files:[{path:'AGENTS.md',reason:'application_change_staged'}]});
  git(f.project,['add','AGENTS.md']);
  expect(f.coordinator.checkStaged(f.taskId)).toEqual({clean:true,files:[]});
 }finally{f.cleanup();}
});
test.each(['.harness-delta/private.json','.harness-delta-managed/private.md'])('forced staged private path %s is blocked while unrelated code is allowed',path=>{
 const f=fixture();try {
  apply(f,begin(f),{'AGENTS.md':'SYNTHETIC_APPLIED'});
  bytes(f.project,'source.ts','export const synthetic = 1;');
  git(f.project,['add','source.ts']);
  expect(f.coordinator.checkStaged(f.taskId)).toEqual({clean:true,files:[]});
  bytes(f.project,path,'SYNTHETIC_PRIVATE_RECORD');
  git(f.project,['add','-f',path]);
  expect(f.coordinator.checkStaged(f.taskId).files).toEqual(expect.arrayContaining([{path,reason:'private_record_staged'}]));
 }finally{f.cleanup();}
});
test('index guard accepts dirty baseline equality and skips unchanged harness outputs',()=>{
 const f=fixture();try {
  bytes(f.project,'baseline/AGENTS.md','SYNTHETIC_DIRTY_BASELINE');
  bytes(f.project,'noop/AGENTS.md','SYNTHETIC_NOOP');
  git(f.project,['add','baseline/AGENTS.md']);
  apply(f,begin(f),{'baseline/AGENTS.md':'SYNTHETIC_APPLIED','noop/AGENTS.md':'SYNTHETIC_NOOP'});
  git(f.project,['add','noop/AGENTS.md']);
  expect(f.coordinator.checkStaged(f.taskId)).toEqual({clean:true,files:[]});
  expect(git(f.project,['show',':baseline/AGENTS.md'])).toBe('SYNTHETIC_DIRTY_BASELINE');
 }finally{f.cleanup();}
});
test('index guard flags diverged managed paths without guessing mixed user changes',()=>{
 const f=fixture();try {
  bytes(f.project,'AGENTS.md','SYNTHETIC_BASELINE');
  apply(f,begin(f),{'AGENTS.md':'SYNTHETIC_APPLIED'});
  bytes(f.project,'AGENTS.md','SYNTHETIC_APPLIED\nSYNTHETIC_USER_EDIT');
  git(f.project,['add','AGENTS.md']);
  expect(f.coordinator.checkStaged(f.taskId)).toEqual({clean:false,files:[{path:'AGENTS.md',reason:'application_change_staged'}]});
  expect(readFileSync(join(f.project,'AGENTS.md'),'utf8')).toBe('SYNTHETIC_APPLIED\nSYNTHETIC_USER_EDIT');
 }finally{f.cleanup();}
});
