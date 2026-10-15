import {execFileSync} from 'node:child_process';
import {chmodSync,existsSync,linkSync,readFileSync,rmdirSync,statSync,symlinkSync,unlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import * as restoration from '../src/harness-application-restoration.js';
import {ApplicationCoordinator} from '../src/harness-application.js';
import {canonicalJson,hashBytes} from '../src/harness-config.js';
import {localWebError} from '../src/local-web-server.js';
import {apply,begin,bytes,fixture,git,restore} from './helpers/harness-application-restoration-fixture.js';

// Synthetic worktrees must not inherit the invoking checkout's hook index.
beforeEach(()=>{vi.stubEnv('GIT_INDEX_FILE',undefined);});
afterEach(()=>{vi.unstubAllEnvs();});

test('restoration preserves original modes for edited and deleted executable files',()=>{
 const f=fixture();try {
  bytes(f.project,'edited.mjs','SYNTHETIC_EXECUTABLE');
  bytes(f.project,'deleted.mjs','SYNTHETIC_DELETED_EXECUTABLE');
  chmodSync(join(f.project,'edited.mjs'),0o755);
  chmodSync(join(f.project,'deleted.mjs'),0o751);
  apply(f,begin(f),{'edited.mjs':'SYNTHETIC_APPLIED','deleted.mjs':null});
  chmodSync(join(f.project,'edited.mjs'),0o600);
  restore(f);
  expect(readFileSync(join(f.project,'edited.mjs'),'utf8')).toBe('SYNTHETIC_EXECUTABLE');
  expect(statSync(join(f.project,'edited.mjs')).mode&0o777).toBe(0o755);
  expect(readFileSync(join(f.project,'deleted.mjs'),'utf8')).toBe('SYNTHETIC_DELETED_EXECUTABLE');
  expect(statSync(join(f.project,'deleted.mjs')).mode&0o777).toBe(0o751);
 }finally{f.cleanup();}
});

test('restoration recreates missing parents for a deleted checkpointed file',()=>{
 const f=fixture();try {
  bytes(f.project,'old/AGENTS.md','SYNTHETIC_EXISTING');
  apply(f,begin(f),{'created.md':'SYNTHETIC_CREATED','old/AGENTS.md':null});
  rmdirSync(join(f.project,'old'));
  expect(f.coordinator.restorationPreview(f.taskId).files.find(file=>file.path==='old/AGENTS.md')?.action).toBe('restore');
  restore(f);
  expect(readFileSync(join(f.project,'old/AGENTS.md'),'utf8')).toBe('SYNTHETIC_EXISTING');
  expect(existsSync(join(f.project,'created.md'))).toBe(false);
  expect(f.coordinator.status(f.taskId).reason).toBe('application_restored');
 }finally{f.cleanup();}
});
test('interrupted restoration retains its fence and lease and retries from completed files',()=>{
 const f=fixture();const original=restoration.restoreApplicationFile;
 const mutation=vi.spyOn(restoration,'restoreApplicationFile').mockImplementation((root,file)=>{
  if(file.path==='z.md')throw new Error('synthetic_interruption');
  original(root,file);
 });
 try {
  bytes(f.project,'a.md','SYNTHETIC_A_BASELINE');bytes(f.project,'z.md','SYNTHETIC_Z_BASELINE');
  apply(f,begin(f),{'a.md':'SYNTHETIC_A_APPLIED','z.md':'SYNTHETIC_Z_APPLIED'});
  expect(()=>restore(f)).toThrow('synthetic_interruption');
  mutation.mockRestore();
  expect(readFileSync(join(f.project,'a.md'),'utf8')).toBe('SYNTHETIC_A_BASELINE');
  expect(readFileSync(join(f.project,'z.md'),'utf8')).toBe('SYNTHETIC_Z_APPLIED');
  expect(f.coordinator.status(f.taskId).reason).toBe('application_restoration_started');
  expect(()=>begin(f)).toThrow('application_restoration_required');
  f.coordinator.cancel(f.taskId);
  expect(f.coordinator.status(f.taskId).reason).toBe('application_restoration_started');
  expect(f.store.get('SELECT 1 FROM external_surface_leases WHERE task_id=?',[f.taskId])).toBeDefined();
  const restarted=new ApplicationCoordinator(f.store,[],false);
  restarted.restore(f.taskId,restarted.restorationPreview(f.taskId).digest);
  expect(readFileSync(join(f.project,'z.md'),'utf8')).toBe('SYNTHETIC_Z_BASELINE');
  expect(restarted.status(f.taskId).reason).toBe('application_restored');
  expect(f.store.get('SELECT 1 FROM external_surface_leases WHERE task_id=?',[f.taskId])).toBeUndefined();
 }finally{mutation.mockRestore();f.cleanup();}
});
test('task activation at the fencing transaction refuses restoration before editing',()=>{
 const f=fixture();try {
  apply(f,begin(f),{'AGENTS.md':'SYNTHETIC_APPLIED'});
  const original=f.store.immediateTransaction.bind(f.store);
  const transaction=vi.spyOn(f.store,'immediateTransaction').mockImplementation(<T>(action:()=>T):T=>{
   f.store.execute("UPDATE tasks SET state='active' WHERE id=?",[f.taskId]);
   return original(action);
  });
  try {
   expect(()=>restore(f)).toThrow('workflow_run_active');
   expect(readFileSync(join(f.project,'AGENTS.md'),'utf8')).toBe('SYNTHETIC_APPLIED');
   expect(f.coordinator.status(f.taskId).state).toBe('applied');
  }finally{transaction.mockRestore();}
 }finally{f.cleanup();}
});
test.each(['symlink','hardlink','directory'] as const)('restore refuses a replaced %s output without editing earlier paths',kind=>{
 const f=fixture();try {
  apply(f,begin(f),{'a.md':'SYNTHETIC_A_APPLIED','z.md':'SYNTHETIC_Z_APPLIED'});
  unlinkSync(join(f.project,'z.md'));
  bytes(f.root,'outside.md','SYNTHETIC_OUTSIDE');
  if(kind==='symlink')symlinkSync(join(f.root,'outside.md'),join(f.project,'z.md'));
  else if(kind==='hardlink')linkSync(join(f.root,'outside.md'),join(f.project,'z.md'));
  else bytes(f.project,'z.md/inside.md','SYNTHETIC_DIRECTORY');
  expect(()=>restore(f)).toThrow('application_path_forbidden');
  expect(readFileSync(join(f.project,'a.md'),'utf8')).toBe('SYNTHETIC_A_APPLIED');
  expect(readFileSync(join(f.root,'outside.md'),'utf8')).toBe('SYNTHETIC_OUTSIDE');
 }finally{f.cleanup();}
});
test('a replaced symlink parent cannot redirect recreation outside the workspace',()=>{
 const f=fixture();try {
  bytes(f.project,'old/AGENTS.md','SYNTHETIC_BASELINE');
  apply(f,begin(f),{'old/AGENTS.md':null});
  rmdirSync(join(f.project,'old'));
  bytes(f.root,'outside/AGENTS.md','SYNTHETIC_OUTSIDE');
  symlinkSync(join(f.root,'outside'),join(f.project,'old'));
  expect(()=>restore(f)).toThrow('application_path_forbidden');
  expect(readFileSync(join(f.root,'outside/AGENTS.md'),'utf8')).toBe('SYNTHETIC_OUTSIDE');
 }finally{f.cleanup();}
});
test('legacy checkpoints without mode metadata restore bytes with private creation mode',()=>{
 const f=fixture();try {
  bytes(f.project,'old.mjs','SYNTHETIC_LEGACY');
  const attempt=begin(f);apply(f,attempt,{'old.mjs':null});
  const checkpoint=f.store.get<{id:string}>('SELECT id FROM harness_application_checkpoints WHERE attempt_id=?',[attempt.attempt_id]);
  if(!checkpoint)throw new Error('synthetic_checkpoint_missing');
  const record=Buffer.from(canonicalJson({path:'old.mjs',before_hash:hashBytes('SYNTHETIC_LEGACY'),before_file:`checkpoints/${checkpoint.id}.bytes`}));
  writeFileSync(join(f.project,`.harness-delta/applications/${f.taskId}/${attempt.attempt_id}/checkpoints/${checkpoint.id}.json`),record);
  f.store.execute('UPDATE harness_application_checkpoints SET record_hash=? WHERE id=?',[hashBytes(record),checkpoint.id]);
  restore(f);
  expect(readFileSync(join(f.project,'old.mjs'),'utf8')).toBe('SYNTHETIC_LEGACY');
  expect(statSync(join(f.project,'old.mjs')).mode&0o777).toBe(0o600);
 }finally{f.cleanup();}
});
test('another worktree cannot inherit unresolved application outputs',()=>{
 const f=fixture();try {
  const linked=join(f.root,'linked');
  git(f.project,['worktree','add','-q','-b','synthetic-linked',linked]);
  apply(f,begin(f),{'AGENTS.md':'SYNTHETIC_ORIGIN'});
  f.coordinator.cancel(f.taskId);
  expect(()=>begin(f,linked)).toThrow('application_restoration_required');
  restore(f);
  const next=begin(f,linked);
  expect(next.prior_outputs).toEqual([]);
  apply(f,next,{'AGENTS.md':'SYNTHETIC_LINKED'});
  restore(f);
  expect(existsSync(join(linked,'AGENTS.md'))).toBe(false);
  expect(existsSync(join(f.project,'AGENTS.md'))).toBe(false);
 }finally{f.cleanup();}
});
test.each([false,true])('checkpoint-free failed attempts may switch worktrees after restart (removed=%s)',removed=>{
 const f=fixture();try {
  const linked=join(f.root,'empty-linked');
  git(f.project,['worktree','add','-q','-b','synthetic-empty-linked',linked]);
  const first=begin(f,linked);
  new ApplicationCoordinator(f.store);
  if(removed)git(f.project,['worktree','remove',linked]);
  const next=begin(f);
  expect(next.attempt_id).not.toBe(first.attempt_id);
  expect(next.workspace.root).toBe(f.project);
  expect(next.prior_outputs).toEqual([]);
 }finally{f.cleanup();}
});
test('the web error boundary preserves the restoration-required machine code',()=>{
 expect(localWebError(new Error('application_restoration_required'))).toBe('application_restoration_required');
});
test('historical cross-worktree inherited metadata is not mistaken for a local checkpoint',()=>{
 const f=fixture();try {
  const linked=join(f.root,'linked');
  git(f.project,['worktree','add','-q','-b','synthetic-linked',linked]);
  apply(f,begin(f),{'inherited.md':'SYNTHETIC_ORIGIN'});
  f.coordinator.cancel(f.taskId);
  const next=begin(f);
  const {digest,...workspace}=f.coordinator.workspace(f.taskId,linked);
  expect(digest).toHaveLength(64);
  const legacy={...next,workspace},record=Buffer.from(canonicalJson(legacy));
  writeFileSync(join(f.project,`.harness-delta/applications/${f.taskId}/${next.attempt_id}/context.json`),record);
  f.store.execute('UPDATE harness_application_attempts SET context_hash=? WHERE id=?',[hashBytes(record),next.attempt_id]);
  f.store.execute('DELETE FROM external_surface_leases WHERE task_id=?',[f.taskId]);
  f.store.execute('INSERT INTO external_surface_leases(surface_key,task_id) VALUES(?,?)',[hashBytes(linked),f.taskId]);
  bytes(linked,'inherited.md','SYNTHETIC_ORIGIN');
  apply(f,legacy,{'local.md':'SYNTHETIC_LOCAL'});
  expect(f.coordinator.restorationPreview(f.taskId).files.map(file=>file.path)).toEqual(['local.md']);
  restore(f);
  expect(readFileSync(join(linked,'inherited.md'),'utf8')).toBe('SYNTHETIC_ORIGIN');
  expect(readFileSync(join(f.project,'inherited.md'),'utf8')).toBe('SYNTHETIC_ORIGIN');
  expect(existsSync(join(linked,'local.md'))).toBe(false);
 }finally{f.cleanup();}
},20000); // Two application cycles and linked-worktree setup share this budget.
test('index checking ignores working-tree aliases and flags staged symlink entries',()=>{
 const f=fixture();try {
  bytes(f.project,'AGENTS.md','SYNTHETIC_BASELINE');
  git(f.project,['add','AGENTS.md']);
  apply(f,begin(f),{'AGENTS.md':'SYNTHETIC_APPLIED'});
  unlinkSync(join(f.project,'AGENTS.md'));
  bytes(f.root,'outside.md','SYNTHETIC_OUTSIDE');
  symlinkSync(join(f.root,'outside.md'),join(f.project,'AGENTS.md'));
  expect(f.coordinator.checkStaged(f.taskId)).toEqual({clean:true,files:[]});
  git(f.project,['add','AGENTS.md']);
  expect(f.coordinator.checkStaged(f.taskId)).toEqual({clean:false,files:[{path:'AGENTS.md',reason:'application_index_invalid'}]});
 }finally{f.cleanup();}
});
test('Git clean line-ending conversion accepts the staged dirty checkpoint baseline',()=>{
 const f=fixture();try {
  bytes(f.project,'.gitattributes','*.md text eol=lf\n');
  bytes(f.project,'AGENTS.md','SYNTHETIC_BASELINE\r\n');
  git(f.project,['add','AGENTS.md']);
  apply(f,begin(f),{'AGENTS.md':'SYNTHETIC_APPLIED\r\n'});
  expect(f.coordinator.checkStaged(f.taskId)).toEqual({clean:true,files:[]});
  git(f.project,['add','AGENTS.md']);
  expect(f.coordinator.checkStaged(f.taskId)).toEqual({clean:false,files:[{path:'AGENTS.md',reason:'application_change_staged'}]});
 }finally{f.cleanup();}
});
test('case-folded index paths cannot bypass a checkpointed application guard',()=>{
 const f=fixture();try {
  apply(f,begin(f),{'AGENTS.md':'SYNTHETIC_APPLIED'});
  const oid=git(f.project,['hash-object','-w','AGENTS.md']).trim();
  git(f.project,['update-index','--add','--cacheinfo',`100644,${oid},agents.md`]);
  expect(f.coordinator.checkStaged(f.taskId)).toEqual({clean:false,files:[{path:'AGENTS.md',reason:'application_change_staged'}]});
 }finally{f.cleanup();}
});
test('unrelated case-colliding index paths do not block application checking',()=>{
 const f=fixture();try {
  apply(f,begin(f),{'AGENTS.md':'SYNTHETIC_APPLIED'});
  bytes(f.project,'unrelated.txt','SYNTHETIC_UNRELATED');
  const oid=git(f.project,['hash-object','-w','unrelated.txt']).trim();
  git(f.project,['update-index','--add','--cacheinfo',`100644,${oid},unrelated.txt`]);
  git(f.project,['update-index','--add','--cacheinfo',`100644,${oid},UNRELATED.txt`]);
  expect(f.coordinator.checkStaged(f.taskId)).toEqual({clean:true,files:[]});
 }finally{f.cleanup();}
});
test('unmerged index stages are refused instead of comparing an arbitrary stage blob',()=>{
 const f=fixture();try {
  apply(f,begin(f),{'AGENTS.md':'SYNTHETIC_APPLIED'});
  const oid=git(f.project,['hash-object','-w','AGENTS.md']).trim();
  execFileSync('git',['-C',f.project,'update-index','--index-info'],{input:`100644 ${oid} 1\tAGENTS.md\n100644 ${oid} 2\tAGENTS.md\n100644 ${oid} 3\tAGENTS.md\n`,env:Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')))});
  expect(f.coordinator.checkStaged(f.taskId)).toEqual({clean:false,files:[{path:'AGENTS.md',reason:'application_index_invalid'}]});
 }finally{f.cleanup();}
});
test('a staged deletion of a modified original is refused until the baseline is restaged',()=>{
 const f=fixture();try {
  bytes(f.project,'AGENTS.md','SYNTHETIC_BASELINE');
  git(f.project,['add','AGENTS.md']);
  git(f.project,['-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','-qm','Synthetic tracked baseline']);
  apply(f,begin(f),{'AGENTS.md':'SYNTHETIC_APPLIED'});
  git(f.project,['rm','--cached','AGENTS.md']);
  expect(f.coordinator.checkStaged(f.taskId)).toEqual({clean:false,files:[{path:'AGENTS.md',reason:'application_change_staged'}]});
  restore(f);git(f.project,['add','AGENTS.md']);
  expect(f.coordinator.checkStaged(f.taskId)).toEqual({clean:true,files:[]});
 }finally{f.cleanup();}
});
