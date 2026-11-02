import { execFileSync } from 'node:child_process';
import { cpSync, lstatSync, mkdtempSync, mkdirSync, renameSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import * as workspace from '../src/harness-application-workspace.js';
vi.mock('node:child_process', { spy: true });
const realExecFileSync = (await vi.importActual<typeof import('node:child_process')>('node:child_process')).execFileSync;
const roots:string[]=[];
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')));
function repository(){const root=realpathSync(mkdtempSync(join(tmpdir(),'application-workspace-')));roots.push(root);execFileSync('git',['init','-q',root],{env});execFileSync('git',['-C',root,'-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','--allow-empty','-qm','Synthetic baseline'],{env});return root;}
afterEach(()=>{vi.mocked(execFileSync).mockImplementation(realExecFileSync);vi.clearAllMocks();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
test('pins a same-repository worktree without restricting branch names or changing Git',()=>{
 const origin=repository();const target=join(origin,'workspace');execFileSync('git',['-C',origin,'worktree','add','-qb','main-test',target],{env});
 const value=workspace.inspectApplicationWorkspace(origin,target);expect(value.root).toBe(target);expect(value.branch).toBe('main-test');expect(value.head).toHaveLength(40);expect(value.common).toBe(join(origin,'.git'));
 workspace.assertApplicationWorkspace(value);writeFileSync(join(target,'AGENTS.md'),'Synthetic uncommitted rule');workspace.assertApplicationWorkspace(value);
 expect(execFileSync('git',['-C',target,'status','--porcelain'],{encoding:'utf8',env})).toContain('AGENTS.md');
 expect(()=>workspace.inspectApplicationWorkspace(origin,repository())).toThrow('application_workspace_mismatch');
});
test('rejects symlink aliases and recreated root/admin identities even at the same path',()=>{
 const origin=repository();const target=join(origin,'workspace');execFileSync('git',['-C',origin,'worktree','add','-qb','work',target],{env});const value=workspace.inspectApplicationWorkspace(origin,target);
 const alias=join(origin,'alias');symlinkSync(target,alias);expect(()=>workspace.inspectApplicationWorkspace(origin,alias)).toThrow('application_workspace_mismatch');
 renameSync(target,target+'-old');mkdirSync(target);writeFileSync(join(target,'.git'),`gitdir: ${value.admin}\n`);expect(()=>workspace.assertApplicationWorkspace(value)).toThrow('application_workspace_changed');
});

test('ignores inherited Git routing variables when inspecting an explicit workspace',()=>{
 const origin=repository(),other=repository();const previous=process.env.GIT_DIR;process.env.GIT_DIR=join(other,'.git');
 try{expect(workspace.inspectApplicationWorkspace(origin,origin).common).toBe(join(origin,'.git'));}finally{if(previous===undefined)delete process.env.GIT_DIR;else process.env.GIT_DIR=previous;}
});

// Intercept only the process boundary; every metadata result still comes from real Git.
function observeGit(after:(args:readonly string[],output:string)=>void){
 vi.mocked(execFileSync).mockImplementation((file,args,options)=>{
  const output=realExecFileSync(file,args,options);
  if(file==='git'&&Array.isArray(args))after(args,output.toString());
  return output;
 });
}
function directoryIdentity(path:string){const stat=lstatSync(path,{bigint:true});return {dev:String(stat.dev),ino:String(stat.ino),birth:String(stat.birthtimeNs)};}

test('same-root inspection preserves every output field with seven real Git processes',()=>{
 const root=repository();const head=realExecFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8',env}).trim();
 const branch=realExecFileSync('git',['-C',root,'branch','--show-current'],{encoding:'utf8',env}).trim();
 const calls:string[][]=[];observeGit(args=>calls.push([...args]));
 expect(workspace.inspectApplicationWorkspace(root,root)).toEqual({root,origin:root,common:join(root,'.git'),admin:join(root,'.git'),root_identity:directoryIdentity(root),admin_identity:directoryIdentity(join(root,'.git')),common_identity:directoryIdentity(join(root,'.git')),head,branch});
 expect(calls).toHaveLength(7);
 expect(calls.filter(args=>args.includes('--show-toplevel'))).toHaveLength(2);
 expect(calls.filter(args=>args.includes('--git-common-dir'))).toHaveLength(2);
 calls.length=0;workspace.inspectApplicationWorkspace(root,root);expect(calls).toHaveLength(7);
});

test('different-origin worktrees retain nine processes and distinct administrative metadata',()=>{
 const origin=repository(),target=join(origin,'linked space');realExecFileSync('git',['-C',origin,'worktree','add','-qb','linked',target],{env});
 const calls:string[][]=[];observeGit(args=>calls.push([...args]));
 const value=workspace.inspectApplicationWorkspace(origin,target);
 expect(value).toMatchObject({root:target,origin,common:join(origin,'.git'),admin:join(origin,'.git/worktrees/linked-space'),branch:'linked'});
 expect(calls).toHaveLength(9);
});

test.each(['space root',"quote' and \\ slash",'internal\nline','internal\rcarriage'])('preserves accepted path shape %# in same-root linked and main inspections',name=>{
 const parent=repository(),root=join(parent,name);mkdirSync(root);realExecFileSync('git',['init','-q',root],{env});realExecFileSync('git',['-C',root,'-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','--allow-empty','-qm','Synthetic baseline'],{env});
 const calls:string[][]=[];observeGit(args=>calls.push([...args]));
 const main=workspace.inspectApplicationWorkspace(root,root);expect(calls).toHaveLength(/[\r\n]/.test(name)?9:7);expect(main).toMatchObject({root,origin:root,common:join(root,'.git'),admin:join(root,'.git')});workspace.assertApplicationWorkspace(main);
 const linked=join(root,'linked');realExecFileSync('git',['-C',root,'worktree','add','-qb','work',linked],{env});
 calls.length=0;expect(workspace.inspectApplicationWorkspace(linked,linked)).toMatchObject({root:linked,origin:linked,common:join(root,'.git'),admin:join(root,'.git/worktrees/linked')});expect(calls).toHaveLength(/[\r\n]/.test(name)?9:7);
});

test.each(['trailing ', 'trailing\n'])('retains rejection of roots with trailing whitespace %#',name=>{
 const parent=repository(),root=join(parent,name);realExecFileSync('git',['init','-q',root],{env});expect(()=>workspace.inspectApplicationWorkspace(root,root)).toThrow('application_workspace_mismatch');
});

test('rejects a changed second top-level observation',()=>{
 const root=repository(),other=repository();let reads=0;
 observeGit(args=>{if(args.includes('--show-toplevel')&&++reads===1)realExecFileSync('git',['-C',root,'config','core.worktree',other],{env});});
 expect(()=>workspace.inspectApplicationWorkspace(root,root)).toThrow('application_workspace_mismatch');expect(reads).toBe(2);
});

test('rejects common-directory rerouting between separated observations',()=>{
 const root=repository(),other=repository();let reads=0;
 observeGit(args=>{if(args.includes('--git-common-dir')&&++reads===1)writeFileSync(join(root,'.git/commondir'),join(other,'.git')+'\n');});
 expect(()=>workspace.inspectApplicationWorkspace(root,root)).toThrow('application_workspace_mismatch');expect(reads).toBe(2);
});

test.each(['root','admin','common'] as const)('rejects replaced %s identity between inspections',part=>{
 const origin=repository(),root=join(origin,'linked');realExecFileSync('git',['-C',origin,'worktree','add','-qb','work',root],{env});const value=workspace.inspectApplicationWorkspace(root,root);
 const path=part==='root'?root:part==='admin'?value.admin:value.common;
 renameSync(path,path+'-old');cpSync(path+'-old',path,{recursive:true});
 expect(()=>workspace.assertApplicationWorkspace(value)).toThrow('application_workspace_changed');
});

test('allows branch and HEAD advancement and a detached HEAD without reusing earlier inspections',()=>{
 const root=repository(),value=workspace.inspectApplicationWorkspace(root,root);realExecFileSync('git',['-C',root,'checkout','-qb','advanced'],{env});realExecFileSync('git',['-C',root,'-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','--allow-empty','-qm','Synthetic advancement'],{env});
 workspace.assertApplicationWorkspace(value);const advanced=workspace.inspectApplicationWorkspace(root,root);expect(advanced.branch).toBe('advanced');expect(advanced.head).not.toBe(value.head);
 realExecFileSync('git',['-C',root,'checkout','--detach','-q'],{env});expect(workspace.inspectApplicationWorkspace(root,root).branch).toBe('');workspace.assertApplicationWorkspace(value);
});

test('rejects submodules, unregistered linked roots, malformed Git metadata and origin symlink aliases',()=>{
 const origin=repository(),source=repository();realExecFileSync('git',['-C',origin,'-c','protocol.file.allow=always','submodule','add','-q',source,'module'],{env});
 const submodule=join(origin,'module');expect(()=>workspace.inspectApplicationWorkspace(submodule,submodule)).toThrow('application_workspace_mismatch');
 const root=join(origin,'linked');realExecFileSync('git',['-C',origin,'worktree','add','-qb','work',root],{env});const value=workspace.inspectApplicationWorkspace(root,root);
 writeFileSync(join(value.admin,'gitdir'),join(origin,'absent/.git')+'\n');expect(()=>workspace.inspectApplicationWorkspace(root,root)).toThrow('application_workspace_mismatch');
 writeFileSync(join(root,'.git'),'gitdir: invalid-synthetic-metadata\n');expect(()=>workspace.inspectApplicationWorkspace(root,root)).toThrow('application_workspace_mismatch');
 const alias=join(origin,'alias');symlinkSync(origin,alias);expect(()=>workspace.inspectApplicationWorkspace(alias,origin)).toThrow('application_workspace_mismatch');
});

test('filters inherited Git config, worktree and common-directory routing for every query',()=>{
 const root=repository(),other=repository();const injected={GIT_DIR:join(other,'.git'),GIT_WORK_TREE:other,GIT_COMMON_DIR:join(other,'.git'),GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'core.worktree',GIT_CONFIG_VALUE_0:other};
 const previous=Object.fromEntries(Object.keys(injected).map(key=>[key,process.env[key]]));Object.assign(process.env,injected);
 try{expect(workspace.inspectApplicationWorkspace(root,root)).toMatchObject({root,origin:root,common:join(root,'.git'),admin:join(root,'.git')});}finally{for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});


test.each(['root','admin','common'] as const)('rejects %s replacement during the separated observations of an assertion',part=>{
 const origin=repository(),root=join(origin,'linked');realExecFileSync('git',['-C',origin,'worktree','add','-qb','work',root],{env});const value=workspace.inspectApplicationWorkspace(root,root);
 let replaced=false;
 observeGit(args=>{if(!replaced&&args.includes('--git-common-dir')){
  replaced=true;const path=part==='root'?root:part==='admin'?value.admin:value.common;
  renameSync(path,path+'-old');cpSync(path+'-old',path,{recursive:true});
 }});
 expect(()=>workspace.assertApplicationWorkspace(value)).toThrow('application_workspace_changed');expect(replaced).toBe(true);
});


test('rejects admin rerouting within the same common repository between observations',()=>{
 const origin=repository(),root=join(origin,'linked'),other=join(origin,'other');
 realExecFileSync('git',['-C',origin,'worktree','add','-qb','work',root],{env});realExecFileSync('git',['-C',origin,'worktree','add','-qb','other',other],{env});
 const value=workspace.inspectApplicationWorkspace(root,root),alternative=workspace.inspectApplicationWorkspace(other,other);let reads=0;
 observeGit(args=>{if(args.includes('--git-common-dir')&&++reads===1)writeFileSync(join(root,'.git'),`gitdir: ${alternative.admin}\n`);});
 expect(()=>workspace.assertApplicationWorkspace(value)).toThrow('application_workspace_changed');expect(reads).toBe(2);
});


test('rejects compound top-level and superproject output aliasing a newline root after the first observation',()=>{
 const parent=repository(),prefix=join(parent,'selected'),root=join(prefix+'\n',parent.slice(1));mkdirSync(root,{recursive:true});
 realExecFileSync('git',['init','-q',root],{env});realExecFileSync('git',['-C',root,'-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','--allow-empty','-qm','Synthetic baseline'],{env});
 expect(workspace.inspectApplicationWorkspace(root,root).root).toBe(root);
 let reads=0;
 vi.mocked(execFileSync).mockImplementation((file,args,options)=>{
  const output=realExecFileSync(file,args,options);
  if(file==='git'&&args?.includes('--show-toplevel')&&++reads===2){
   // Distinct synthetic fields concatenate to the expected root when batched.
   return args.includes('--show-superproject-working-tree')?`${prefix}\n${parent}\n`:`${prefix}\n`;
  }
  return output;
 });
 expect(()=>workspace.inspectApplicationWorkspace(root,root)).toThrow('application_workspace_mismatch');expect(reads).toBe(2);
});

test.each(['common','admin'] as const)('falls back when the grouped %s field is empty',field=>{
 const root=repository(),directory=join(root,'.git');let injected=false;
 vi.mocked(execFileSync).mockImplementation((file,args,options)=>{
  const output=realExecFileSync(file,args,options);
  if(!injected&&file==='git'&&args?.includes('--git-common-dir')&&args.includes('--absolute-git-dir')){
   injected=true;return field==='common'?`\n${directory}\n`:`${directory}\n\n`;
  }
  return output;
 });
 expect(workspace.inspectApplicationWorkspace(root,root)).toMatchObject({root,origin:root,common:directory,admin:directory});expect(injected).toBe(true);
});
