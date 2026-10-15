import {execFileSync} from 'node:child_process';
import {closeSync,constants,fchmodSync,fstatSync,fsyncSync,ftruncateSync,openSync,unlinkSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {canonicalJson,ensureRepositoryDirectory,hashBytes} from './harness-config.js';

export type RestorationFile = {
 readonly path:string;
 readonly before:Buffer|null;
 readonly beforeMode:number|undefined;
 readonly appliedHash:string|null|undefined;
 readonly current:Buffer|null;
};
export class ApplicationRestorationError extends Error {}
const digest=(bytes:Buffer|null)=>bytes===null?null:hashBytes(bytes);

export function restorationPreview(context:{readonly taskId:string;readonly attemptId:string;readonly workspace:string;readonly files:readonly RestorationFile[]}) {
 const files=context.files.map(file=>{
  const beforeHash=digest(file.before),currentHash=digest(file.current);
  const action=currentHash===beforeHash?'unchanged':file.appliedHash===undefined||currentHash!==file.appliedHash?'conflict':file.before===null?'delete':'restore';
  return {path:file.path,before_hash:beforeHash,applied_hash:file.appliedHash??null,current_hash:currentHash,action};
 });
 const value={task_id:context.taskId,attempt_id:context.attemptId,workspace:context.workspace,files};
 return {...value,digest:hashBytes(canonicalJson(value))};
}

/** Caller revalidates the pinned workspace and every file immediately before mutation. */
export function restoreApplicationFile(root:string,file:RestorationFile) {
 const target=join(root,file.path);
 if(file.before===null){unlinkSync(target);return;}
 if(file.current===null&&dirname(file.path)!=='.')ensureRepositoryDirectory(root,dirname(file.path));
 const flags=constants.O_WRONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK|(file.current===null?constants.O_CREAT|constants.O_EXCL:0);
 const fd=openSync(target,flags,file.beforeMode??0o600);
 try {
  const stat=fstatSync(fd);
  if(!stat.isFile()||stat.nlink!==1)throw new ApplicationRestorationError('application_path_forbidden');
  // Truncation happens only after opening a no-follow regular single-link file.
  writeFileSync(fd,file.before);
  ftruncateSync(fd,file.before.length);
  if(file.beforeMode!==undefined)fchmodSync(fd,file.beforeMode);
  fsyncSync(fd);
 } finally {closeSync(fd);}
}

/** Read the actual index, including alternate indexes supplied by a commit hook. */
export function checkApplicationIndex(root:string,files:readonly RestorationFile[]) {
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')||key==='GIT_INDEX_FILE'));
 const git=(args:readonly string[],input?:Buffer)=>execFileSync('git',['-C',root,...args],{input,env:{...env,GIT_OPTIONAL_LOCKS:'0'},timeout:5000,maxBuffer:16*1048576,stdio:['pipe','pipe','ignore']});
 const entries=new Map<string,{path:string;mode:string;oid:string;stage:string}>();
 const managedPaths=new Set(files.map(file=>file.path.toLowerCase()));
 const findings:{path:string;reason:string}[]=[];
 for(const entry of git(['ls-files','--stage','-z']).toString('utf8').split('\0').filter(Boolean)) {
  const tab=entry.indexOf('\t'),path=entry.slice(tab+1),[mode,oid,stage]=entry.slice(0,tab).split(' ');
  if(!mode||!oid||stage===undefined)throw new ApplicationRestorationError('application_index_invalid');
  if(path.split('/').some(part=>['.harness-delta','.harness-delta-managed'].includes(part.toLowerCase())))findings.push({path,reason:'private_record_staged'});
  const key=path.toLowerCase();
  if(!managedPaths.has(key))continue;
  if(entries.has(key)&&entries.get(key)?.path!==path)throw new ApplicationRestorationError('application_index_invalid');
  entries.set(key,{path,mode,oid,stage});
 }
 const changed=new Set(git(['diff','--cached','--name-only','--no-renames','-z','HEAD','--']).toString('utf8').split('\0').filter(Boolean).map(path=>path.toLowerCase()));
 for(const file of files) {
  if(!changed.has(file.path.toLowerCase())||file.appliedHash!==undefined&&file.appliedHash===digest(file.before))continue;
  const entry=entries.get(file.path.toLowerCase());
  if(entry&&(entry.stage!=='0'||!['100644','100755'].includes(entry.mode))) {
   findings.push({path:file.path,reason:'application_index_invalid'});continue;
  }
  // Baselines are working-tree bytes; apply the same clean conversion as staging.
  const beforeOid=file.before===null?null:git(['hash-object',`--path=${entry?.path??file.path}`,'--stdin'],file.before).toString('utf8').trim();
  if((entry?.oid??null)!==beforeOid)findings.push({path:file.path,reason:'application_change_staged'});
 }
 return {clean:findings.length===0,files:findings};
}
