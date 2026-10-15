import {spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {main} from '../src/cli.js';
import {apply,begin,bytes,fixture,git,restore} from './helpers/harness-application-restoration-fixture.js';

// Synthetic worktrees must not inherit the invoking checkout's hook index.
beforeEach(()=>{vi.stubEnv('GIT_INDEX_FILE',undefined);});
afterEach(()=>{vi.unstubAllEnvs();});

test('real main CLI returns success and dirty failure codes without leaking baseline bytes',async()=>{
 const f=fixture();let stdout='',stderr='';
 const out=vi.spyOn(process.stdout,'write').mockImplementation(value=>{stdout+=String(value);return true;});
 const err=vi.spyOn(process.stderr,'write').mockImplementation(value=>{stderr+=String(value);return true;});
 try {
  bytes(f.project,'AGENTS.md','SYNTHETIC_PRIVATE_BASELINE_BYTES');
  apply(f,begin(f),{'AGENTS.md':'SYNTHETIC_APPLIED_BYTES'});
  const call=(args:string[])=>main(['--db',f.database,'application',...args]);
  expect(await call(['preview',f.taskId])).toBe(0);
  const preview=f.coordinator.restorationPreview(f.taskId);
  expect(JSON.parse(stdout)).toEqual(preview);
  expect(await call(['check-staged',f.taskId])).toBe(0);
  git(f.project,['add','AGENTS.md']);
  expect(await call(['check-staged',f.taskId])).toBe(2);
  expect(stderr.split('\n')[0]).toBe('application_changes_staged');
  stderr='';
  expect(await call(['restore',f.taskId,'--preview','0'.repeat(64)])).toBe(2);
  expect(stderr.split('\n')[0]).toBe('application_preview_changed');
  expect(readFileSync(join(f.project,'AGENTS.md'),'utf8')).toBe('SYNTHETIC_APPLIED_BYTES');
  expect(await call(['restore',f.taskId,'--preview',preview.digest])).toBe(0);
  expect(await call(['check-staged',f.taskId])).toBe(2);
  git(f.project,['add','AGENTS.md']);
  expect(await call(['check-staged',f.taskId])).toBe(0);
  expect(stdout+stderr).not.toContain('SYNTHETIC_PRIVATE_BASELINE_BYTES');
  expect(stdout+stderr).not.toContain('SYNTHETIC_APPLIED_BYTES');
  expect(readFileSync(join(f.project,'AGENTS.md'),'utf8')).toBe('SYNTHETIC_PRIVATE_BASELINE_BYTES');
 }finally{out.mockRestore();err.mockRestore();f.cleanup();}
});
test('real main CLI rejects conflicting restore without changing any file or exposing bytes',async()=>{
 const f=fixture();let output='';
 const out=vi.spyOn(process.stdout,'write').mockImplementation(value=>{output+=String(value);return true;});
 const err=vi.spyOn(process.stderr,'write').mockImplementation(value=>{output+=String(value);return true;});
 try {
  bytes(f.project,'a/AGENTS.md','SYNTHETIC_PRIVATE_BASELINE');
  apply(f,begin(f),{'a/AGENTS.md':'SYNTHETIC_APPLIED','z/AGENTS.md':'SYNTHETIC_CREATED'});
  bytes(f.project,'z/AGENTS.md','SYNTHETIC_PRIVATE_USER_EDIT');
  const preview=f.coordinator.restorationPreview(f.taskId);
  expect(await main(['--db',f.database,'application','restore',f.taskId,'--preview',preview.digest])).toBe(2);
  expect(output.split('\n')[0]).toBe('application_restore_conflict');
  expect(readFileSync(join(f.project,'a/AGENTS.md'),'utf8')).toBe('SYNTHETIC_APPLIED');
  expect(readFileSync(join(f.project,'z/AGENTS.md'),'utf8')).toBe('SYNTHETIC_PRIVATE_USER_EDIT');
  expect(output).not.toContain('SYNTHETIC_PRIVATE_BASELINE');
  expect(output).not.toContain('SYNTHETIC_PRIVATE_USER_EDIT');
 }finally{out.mockRestore();err.mockRestore();f.cleanup();}
});
test('built CLI subprocess previews restores and checks the real index with observable exit codes',()=>{
 const f=fixture();try {
  bytes(f.project,'AGENTS.md','SYNTHETIC_SUBPROCESS_PRIVATE_BASELINE');
  apply(f,begin(f),{'AGENTS.md':'SYNTHETIC_SUBPROCESS_APPLIED'});
  const run=(args:string[])=>spawnSync(process.execPath,[join(process.cwd(),'dist/cli.js'),'--db',f.database,'application',...args],{encoding:'utf8',timeout:10000,env:Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')))});
  const preview=f.coordinator.restorationPreview(f.taskId);
  const viewed=run(['preview',f.taskId]);
  expect(viewed.error).toBeUndefined();
  expect(viewed.status).toBe(0);
  expect(JSON.parse(viewed.stdout)).toEqual(preview);
  expect(run(['check-staged',f.taskId]).status).toBe(0);
  git(f.project,['add','AGENTS.md']);
  const dirty=run(['check-staged',f.taskId]);
  expect(dirty.status).toBe(2);
  expect(dirty.stderr.split('\n')[0]).toBe('application_changes_staged');
  expect(JSON.parse(dirty.stdout)).toEqual({clean:false,files:[{path:'AGENTS.md',reason:'application_change_staged'}]});
  const stale=run(['restore',f.taskId,'--preview','0'.repeat(64)]);
  expect(stale.status).toBe(2);
  expect(stale.stderr.split('\n')[0]).toBe('application_preview_changed');
  const restored=run(['restore',f.taskId,'--preview',preview.digest]);
  expect(restored.status).toBe(0);
  expect(JSON.parse(restored.stdout)).toEqual(f.coordinator.restorationPreview(f.taskId));
  expect(readFileSync(join(f.project,'AGENTS.md'),'utf8')).toBe('SYNTHETIC_SUBPROCESS_PRIVATE_BASELINE');
  expect(run(['check-staged',f.taskId]).status).toBe(2);
  git(f.project,['add','AGENTS.md']);
  expect(run(['check-staged',f.taskId]).status).toBe(0);
  for(const result of [viewed,dirty,stale,restored]) {
   expect(result.stdout+result.stderr).not.toContain('SYNTHETIC_SUBPROCESS_PRIVATE_BASELINE');
   expect(result.stdout+result.stderr).not.toContain('SYNTHETIC_SUBPROCESS_APPLIED');
  }
 }finally{f.cleanup();}
});
test('index guard retains staged restored-cycle paths after a fresh explicit application',()=>{
 const f=fixture();try {
  apply(f,begin(f),{'old/AGENTS.md':'SYNTHETIC_OLD_APPLIED'});
  git(f.project,['add','old/AGENTS.md']);
  f.coordinator.restore(f.taskId,f.coordinator.restorationPreview(f.taskId).digest);
  const next=begin(f);
  apply(f,next,{'new/AGENTS.md':'SYNTHETIC_NEW_APPLIED'});
  expect(f.coordinator.restorationPreview(f.taskId).files.map(file=>file.path)).toEqual(['new/AGENTS.md']);
  expect(f.coordinator.checkStaged(f.taskId)).toEqual({clean:false,files:[{path:'old/AGENTS.md',reason:'application_change_staged'}]});
  expect(git(f.project,['show',':old/AGENTS.md'])).toBe('SYNTHETIC_OLD_APPLIED');
  git(f.project,['add','-u','old/AGENTS.md']);
  expect(f.coordinator.checkStaged(f.taskId)).toEqual({clean:true,files:[]});
 }finally{f.cleanup();}
});
test('index guard honors an alternate hook index while sanitizing unrelated GIT_DIR',()=>{
 const f=fixture();try {
  apply(f,begin(f),{'AGENTS.md':'SYNTHETIC_APPLIED'});
  const alternate=join(f.root,'alternate-index');
  git(f.project,['read-tree','HEAD'],{GIT_INDEX_FILE:alternate});
  git(f.project,['add','AGENTS.md'],{GIT_INDEX_FILE:alternate});
  const foreign=join(f.root,'foreign');mkdirSync(foreign);
  git(foreign,['init','-q']);
  expect(f.coordinator.checkStaged(f.taskId)).toEqual({clean:true,files:[]});
  vi.stubEnv('GIT_INDEX_FILE',alternate);vi.stubEnv('GIT_DIR',join(foreign,'.git'));
  expect(f.coordinator.checkStaged(f.taskId)).toEqual({clean:false,files:[{path:'AGENTS.md',reason:'application_change_staged'}]});
  expect(git(f.project,['ls-files'])).toBe('');
 }finally{vi.unstubAllEnvs();f.cleanup();}
});
test('restoration and index guards are isolated to the selected linked worktree',()=>{
 const f=fixture();try {
  const linked=join(f.root,'linked');
  git(f.project,['worktree','add','-q','-b','synthetic-linked',linked]);
  bytes(f.project,'AGENTS.md','SYNTHETIC_ORIGIN');
  git(f.project,['add','AGENTS.md']);
  bytes(linked,'AGENTS.md','SYNTHETIC_LINKED_BASELINE');
  apply(f,begin(f,linked),{'AGENTS.md':'SYNTHETIC_LINKED_APPLIED'});
  expect(f.coordinator.checkStaged(f.taskId)).toEqual({clean:true,files:[]});
  git(linked,['add','AGENTS.md']);
  expect(f.coordinator.checkStaged(f.taskId).clean).toBe(false);
  restore(f);
  expect(readFileSync(join(linked,'AGENTS.md'),'utf8')).toBe('SYNTHETIC_LINKED_BASELINE');
  expect(readFileSync(join(f.project,'AGENTS.md'),'utf8')).toBe('SYNTHETIC_ORIGIN');
  expect(git(f.project,['show',':AGENTS.md'])).toBe('SYNTHETIC_ORIGIN');
  expect(git(linked,['show',':AGENTS.md'])).toBe('SYNTHETIC_LINKED_APPLIED');
 }finally{f.cleanup();}
});
