import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { EventEmitter, once } from 'node:events';
import { expect, test } from 'vitest';
import { OwnedCliInvocation } from '../src/owned-cli-invocation.js';

test('owned CLI accepts a fifteen-minute duration and verifies immediate normal exit',async()=>{
 const result=await new OwnedCliInvocation({command:realpathSync(process.execPath),args:['-e','process.exit(0)'],cwd:realpathSync(process.cwd()),durationMs:900000,stdio:'ignore'}).run();
 expect(result).toMatchObject({status:'completed',exitCode:0,ownershipVerified:true,terminationVerified:true,terminationCause:'root_exit'});
});

test('owned CLI rejects a duration beyond fifteen minutes before spawning',()=>{
 expect(()=>new OwnedCliInvocation({command:realpathSync(process.execPath),args:[],cwd:realpathSync(process.cwd()),durationMs:900001,stdio:'ignore'})).toThrow('owned_cli_invalid');
});

test('owned terminal attention arrives before exit without a newline or approval input',async()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'owned-attention-fixture-')));
 const script=join(dir,'payload.mjs'),inputMarker=join(dir,'input.json');
 const attention=new EventEmitter();const notified=once(attention,'attention');let notifications=0,ended=false;
 writeFileSync(script,`import{writeFileSync}from'node:fs';import{setImmediate}from'node:timers/promises';process.stdin.setRawMode(true);process.stdin.on('data',b=>writeFileSync(${JSON.stringify(inputMarker)},JSON.stringify([...b])));for(const part of['\\x1b',']','9;','private synthetic notification','\\x07']){process.stdout.write(part);await setImmediate();}setTimeout(()=>process.exit(2),4000);`);
 const options={command:realpathSync(process.execPath),args:[script],cwd:dir,durationMs:5000,terminationMs:1500,termGraceMs:100,stdio:'ignore' as const,onTerminalAttention:()=>{notifications++;attention.emit('attention');}};
 const owner=new OwnedCliInvocation(options);const result=owner.run();void result.then(()=>{ended=true;});
 try{
  await Promise.race([notified,result.then(()=>{throw new Error('synthetic_attention_missing_before_exit');})]);
  expect(ended).toBe(false);expect(notifications).toBe(1);
  expect(()=>readFileSync(inputMarker,'utf8')).toThrow();
 }finally{owner.stop();const final=await result;rmSync(dir,{recursive:true,force:true});expect(final.terminationVerified).toBe(true);}
},7000);

test('terminal attention ignores text, empty notifications and OSC9 progress updates',async()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'owned-attention-noise-')));
 let notifications=0;
 try{
  const script=join(dir,'payload.mjs');
  writeFileSync(script,`process.stdout.write('synthetic approval text\\x1b[31m\\x1b]9;\\x07\\x1b]9;4;1;50\\x07');`);
  const result=await new OwnedCliInvocation({command:realpathSync(process.execPath),args:[script],cwd:dir,durationMs:2000,terminationMs:1500,termGraceMs:100,stdio:'ignore',onTerminalAttention:()=>{notifications++;}}).run();
  expect(result).toMatchObject({status:'completed',terminationVerified:true});
  expect(notifications).toBe(0);
 }finally{rmSync(dir,{recursive:true,force:true});}
},5000);

test.each(['\x1b]9;4;1;50\x1b\\','\x1b]9;4;'])('terminal attention resumes after non-BEL progress %j',async noise=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'owned-attention-recovery-')));
 let notifications=0;
 try{
  const script=join(dir,'payload.mjs');
  writeFileSync(script,`process.stdout.write(${JSON.stringify(noise+'\x1b]9;synthetic notification\x07')});`);
  const result=await new OwnedCliInvocation({command:realpathSync(process.execPath),args:[script],cwd:dir,durationMs:2000,terminationMs:1500,termGraceMs:100,stdio:'ignore',onTerminalAttention:()=>{notifications++;}}).run();
  expect(result).toMatchObject({status:'completed',terminationVerified:true});
  expect(notifications).toBe(1);
 }finally{rmSync(dir,{recursive:true,force:true});}
},5000);

// Node fixtures only: real products, auth, user processes and logs are excluded.
test('inherited terminal forwards harmless manual input and restores its raw mode',()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'owned-manual-input-')));
 try{
  const marker=join(dir,'received.json'),payload=join(dir,'payload.mjs'),runner=join(dir,'runner.mjs');
  writeFileSync(payload,`import{writeFileSync}from'node:fs';process.stdin.setRawMode(true);let input='';const expiry=setTimeout(()=>process.exit(3),6000);process.stdin.on('data',b=>{input+=b.toString();if(input.includes('harmless-manual-input\\r')){writeFileSync(${JSON.stringify(marker)},JSON.stringify({input,stdin:process.stdin.isTTY,stdout:process.stdout.isTTY}));clearTimeout(expiry);process.exit(0);}});process.stdout.write('READY-FOR-MANUAL-INPUT\\n');`);
  const source=fileURLToPath(new URL('../src/owned-cli-invocation.ts',import.meta.url));
  writeFileSync(runner,`import{OwnedCliInvocation}from${JSON.stringify(source)};const raw=process.stdin.isRaw??false;const result=await new OwnedCliInvocation({command:${JSON.stringify(realpathSync(process.execPath))},args:[${JSON.stringify(payload)}],cwd:${JSON.stringify(dir)},durationMs:4000,terminationMs:1500,termGraceMs:100,stdio:'inherit'}).run();console.log('OWNER-RESULT:'+JSON.stringify({...result,rawRestored:process.stdin.isRaw===raw}));`);
  const harness=`import os,pty,select,sys,time,signal,json
pid,master=pty.fork()
if pid==0: os.execv(sys.argv[1],[sys.argv[1],sys.argv[2]])
data=b'';sent=False;ended=False;code=None
try:
 deadline=time.monotonic()+8
 while time.monotonic()<deadline:
  if select.select([master],[],[],.05)[0]:
   try: data+=os.read(master,65536)
   except OSError: pass
  if not sent and b'READY-FOR-MANUAL-INPUT' in data:
   os.write(master,b'harmless-manual-input\\r');sent=True
  child,status=os.waitpid(pid,os.WNOHANG)
  if child: ended=True;code=os.waitstatus_to_exitcode(status);break
 print(json.dumps({'sent':sent,'ended':ended,'exitCode':code,'output':data.decode(errors='replace')}))
finally:
 os.close(master)
 if not ended:
  try: os.kill(pid,signal.SIGKILL)
  except ProcessLookupError: pass
  os.waitpid(pid,0)
`;
  const result=JSON.parse(execFileSync(OwnedCliInvocation.pythonExecutable(),['-c',harness,realpathSync(process.execPath),runner],{encoding:'utf8',timeout:10000})) as {sent:boolean;ended:boolean;exitCode:number;output:string};
  expect(result).toMatchObject({sent:true,ended:true,exitCode:0});
  expect(JSON.parse(readFileSync(marker,'utf8'))).toEqual({input:'harmless-manual-input\r',stdin:true,stdout:true});
  const line=result.output.split(/\r?\n/).find(line=>line.startsWith('OWNER-RESULT:'));expect(line).toBeDefined();
  expect(JSON.parse(line!.slice('OWNER-RESULT:'.length))).toMatchObject({status:'completed',terminationVerified:true,controllingTerminal:true,rawRestored:true});
 }finally{rmSync(dir,{recursive:true,force:true});}
},12000);

for (const mode of ['abort', 'root-exit', 'deadline'] as const) test(`owned CLI ${mode} stops an ignoring descendant and verifies the group is gone`, async () => {
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'owned-cli-fixture-')));
 try {
  const pidFile=join(dir,'child.pid'); const script=join(dir,'worker.mjs');
  writeFileSync(script,`import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';const c=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});writeFileSync(${JSON.stringify(pidFile)},String(c.pid));${mode==='root-exit'?'setTimeout(()=>process.exit(0),100);':'setInterval(()=>{},1000);'}`);
  const owner=new OwnedCliInvocation({command:realpathSync(process.execPath),args:[script],cwd:dir,durationMs:mode==='deadline'?300:3000,terminationMs:1500,termGraceMs:100,stdio:'ignore'});
  const controller=new AbortController(); const resultPromise=owner.run(controller.signal);
  await expect.poll(()=>{try{return Number(readFileSync(pidFile,'utf8'))>0;}catch{return false;}},{timeout:1500}).toBe(true);
  if(mode==='abort')controller.abort();
  const result=await resultPromise;
  expect(result.terminationVerified).toBe(true); expect(owner.isAlive()).toBe(false);
  expect(()=>process.kill(-result.pid,0)).toThrow();
  expect(result.status).toBe(mode==='deadline'?'timed_out':mode==='abort'?'stopped':'completed');
  expect(result.terminationCause).toBe(mode==='deadline'?'deadline':mode==='abort'?'control':'root_exit');
  expect(result.groupChanges).toEqual([]);expect(result.groupChangesTruncated).toBe(false);
  await expect(owner.run()).rejects.toThrow('owned_cli_already_started');
 }finally{rmSync(dir,{recursive:true,force:true});}
},5000);

test('slow exact-member metadata during teardown stays within the existing budget and reaps the root',async()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'owned-budget-fixture-')));let pids:number[]=[];
 try{
  const marker=join(dir,'pids.json');const script=join(dir,'payload.mjs');const worker=join(dir,'owner.py');
  writeFileSync(script,`import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';process.on('SIGTERM',()=>{});const c=Array.from({length:3},()=>spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setTimeout(()=>process.exit(0),20000)"],{stdio:'ignore',detached:true}));writeFileSync(${JSON.stringify(marker)},JSON.stringify([process.pid,...c.map(c=>c.pid)]));setTimeout(()=>process.exit(0),20000);`);
  // Inject latency only after successful discovery; no wrapper, product or body read.
  // Measure in the owner: control delivery, pre-cleanup discovery and Node result
  // scheduling are outside the production teardown budget. Keep its 5s limit.
  // Teardown cost grows per escaped group; three keep slow CI hosts inside it.
  const source=readFileSync(fileURLToPath(new URL('../scripts/owned-cli-pty.py',import.meta.url)),'utf8');
  writeFileSync(worker,source.replace('known = {}','known = {}\ntearing_down = False').replace('def metadata(pid):\n','def metadata(pid):\n    if tearing_down: time.sleep(.06)\n').replace('finally:\n','finally:\n    tearing_down = True\n').replace("emit({'type': 'result',", "emit({'syntheticCleanupElapsedMs': (time.monotonic() - (cleanup_until - cfg['terminationMs'] / 1000)) * 1000, 'type': 'result',"));
  const cfg={command:realpathSync(process.execPath),args:[script],cwd:dir,durationMs:3000,terminationMs:5000,termGraceMs:100};
  const owner=spawn(OwnedCliInvocation.pythonExecutable(),[worker,JSON.stringify(cfg)],{stdio:['ignore','ignore','pipe','pipe']});let lines='';
  if(!owner.stderr)throw new Error('synthetic_result_stream_missing');owner.stderr.on('data',(b:Buffer)=>{lines+=b.toString();});
  const ended=new Promise<void>((resolve,reject)=>{owner.once('exit',code=>code===0?resolve():reject(new Error('synthetic_owner_failed')));});
  await expect.poll(()=>{try{pids=JSON.parse(readFileSync(marker,'utf8')) as number[];return pids.length===4;}catch{return false;}},{timeout:1500}).toBe(true);
  await new Promise(r=>setTimeout(r,400));const control=owner.stdio[3];if(!(control instanceof Writable))throw new Error('synthetic_control_missing');control.write('stop\n');await ended;
  const result=lines.trim().split('\n').map(s=>JSON.parse(s) as {type:string;ownedMembers:number;exitCode:number|null;terminationVerified:boolean;escapedMemberObserved:boolean;syntheticCleanupElapsedMs:number}).find(r=>r.type==='result');
  expect(result,`Synthetic owner result: ${JSON.stringify(result)}`).toMatchObject({ownedMembers:4,terminationVerified:true,escapedMemberObserved:true});expect(result?.exitCode).not.toBeNull();
  expect(result?.syntheticCleanupElapsedMs).toBeGreaterThanOrEqual(0);
  expect(result?.syntheticCleanupElapsedMs).toBeLessThanOrEqual(cfg.terminationMs);
  await expect.poll(()=>pids.every(pid=>{try{process.kill(pid,0);return false;}catch{return true;}}),{timeout:500}).toBe(true);
 }finally{for(const pid of pids)try{process.kill(pid,'SIGKILL');}catch{/* own fixture already gone */}rmSync(dir,{recursive:true,force:true});}
},16000);

test('failed disappearance queries cannot verify termination even after the root group is gone',async()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'owned-query-fixture-')));let pid:number|undefined;
 try{
  const marker=join(dir,'root.pid'),script=join(dir,'payload.mjs'),worker=join(dir,'owner.py');
  writeFileSync(script,`import{writeFileSync}from'node:fs';process.on('SIGTERM',()=>{});writeFileSync(${JSON.stringify(marker)},String(process.pid));setTimeout(()=>process.exit(0),5000);`);
  const source=readFileSync(fileURLToPath(new URL('../scripts/owned-cli-pty.py',import.meta.url)),'utf8');
  writeFileSync(worker,source.replace('known = {}','known = {}\nforce_disappearance_timeout = False').replace('text = subprocess.check_output',"if force_disappearance_timeout: raise subprocess.TimeoutExpired('ps',.2)\n        text = subprocess.check_output").replace('send(signal.SIGKILL)\n','send(signal.SIGKILL)\n    force_disappearance_timeout = True\n'));
  const cfg={command:realpathSync(process.execPath),args:[script],cwd:dir,durationMs:300,terminationMs:1500,termGraceMs:50};
  const owner=spawn(OwnedCliInvocation.pythonExecutable(),[worker,JSON.stringify(cfg)],{stdio:['ignore','ignore','pipe','pipe']});let lines='';
  if(!owner.stderr)throw new Error('synthetic_result_stream_missing');owner.stderr.on('data',(b:Buffer)=>{lines+=b.toString();});
  await new Promise<void>((resolve,reject)=>{owner.once('exit',code=>code===0?resolve():reject(new Error('synthetic_owner_failed')));});
  pid=Number(readFileSync(marker,'utf8'));const result=lines.trim().split('\n').map(s=>JSON.parse(s) as {type:string}).find(r=>r.type==='result');
  expect(result).toMatchObject({status:'failed',ownedMembers:1,terminationVerified:false,exitCode:-9});expect(()=>process.kill(-pid!,0)).toThrow();
 }finally{if(pid)try{process.kill(pid,'SIGKILL');}catch{/* own fixture already gone */}rmSync(dir,{recursive:true,force:true});}
},5000);

test('owned discovery rejects query failure and exhausted budget while permitting observed no-children',()=>{
 // Evaluate only discovery with synthetic metadata/results: no fork, ps or pgrep.
 const code=`import ast,json,sys,time,types
tree=ast.parse(open(sys.argv[1]).read());fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='discover')
out=[]
for returncode,expired in [(0,False),(1,False),(2,False),(0,True)]:
 calls=[];record=(42,1,42,501,'synthetic start')
 def run(*args,**kwargs):
  calls.append(1);return types.SimpleNamespace(returncode=returncode,stdout=b'')
 ns={'known':{42:record},'absent':set(),'proofs':{42:None},'pid':42,'uid':501,'escape_seen':False,'ownership_failed':False,'cleanup_until':time.monotonic()-1 if expired else None,'metadata':lambda pid:record,'identity_matches':lambda a,b:a==b,'note_group_change':lambda *args:None,'time':time,'subprocess':types.SimpleNamespace(run=run,SubprocessError=Exception,PIPE=-1,DEVNULL=-3)}
 exec(compile(ast.Module(body=[fn],type_ignores=[]),'<synthetic discovery>','exec'),ns)
 out.append({'returncode':returncode,'expired':expired,'coverage':ns['discover'](),'queries':len(calls)})
print(json.dumps(out))`;
 const values=JSON.parse(execFileSync(OwnedCliInvocation.pythonExecutable(),['-c',code,fileURLToPath(new URL('../scripts/owned-cli-pty.py',import.meta.url))],{encoding:'utf8'})) as unknown;
 expect(values).toEqual([{returncode:0,expired:false,coverage:true,queries:1},{returncode:1,expired:false,coverage:true,queries:1},{returncode:2,expired:false,coverage:false,queries:1},{returncode:0,expired:true,coverage:false,queries:0}]);
});

test('cleanup discovery refreshes a parent without resampling known children or childless leaves',()=>{
 // A deterministic query-count regression guard complements the real teardown:
 // host scheduling cannot turn redundant metadata scans into a passing result.
 const code=`import ast,json,sys,types
tree=ast.parse(open(sys.argv[1]).read());fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='discover')
root=(42,1,42,501,'synthetic root');children={p:(p,42,p,501,'synthetic child') for p in range(43,51)}
records={42:root,**children};metadata_calls=[];queries=[]
def metadata(p):
 metadata_calls.append(p);return records[p]
def run(args,**kwargs):
 p=int(args[-1]);queries.append(p);return types.SimpleNamespace(returncode=0 if p==42 else 1,stdout=b'43 44 45 46 47 48 49 50' if p==42 else b'')
ns={'known':dict(records),'absent':set(),'proofs':{42:None,**{p:root for p in children}},'pid':42,'uid':501,'escape_seen':False,'ownership_failed':False,'cleanup_until':105,'metadata':metadata,'identity_matches':lambda a,b:a==b,'note_group_change':lambda *args:None,'time':types.SimpleNamespace(monotonic=lambda:100),'subprocess':types.SimpleNamespace(run=run,SubprocessError=Exception,PIPE=-1,DEVNULL=-3)}
exec(compile(ast.Module(body=[fn],type_ignores=[]),'<synthetic cleanup discovery>','exec'),ns)
coverage=ns['discover']()
print(json.dumps({'coverage':coverage,'metadata':metadata_calls,'queries':queries,'members':sorted(ns['known']),'failed':ns['ownership_failed']}))`;
 const result=JSON.parse(execFileSync(OwnedCliInvocation.pythonExecutable(),['-c',code,fileURLToPath(new URL('../scripts/owned-cli-pty.py',import.meta.url))],{encoding:'utf8'})) as unknown;
 expect(result).toEqual({coverage:true,metadata:[42],queries:[42,43,44,45,46,47,48,49,50],members:[42,43,44,45,46,47,48,49,50],failed:false});
});

test('TERM discovery and signal queries count toward grace without starving verified KILL cleanup',()=>{
 const code=`import ast,json,sys,types,signal
tree=ast.parse(open(sys.argv[1]).read());cleanup=next(n.finalbody for n in tree.body if isinstance(n,ast.Try) and n.finalbody)
functions=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in ['metadata','identity_matches','same','discover','verified_group_members','note_group_change']]
clock=[100.0];records={p:(p,1 if p==42 else 42,p,501,'synthetic start '+str(p)) for p in range(42,51)}
alive=set(records);root_reaped=[False];signals=[];result=[]
def advance(seconds):clock[0]+=seconds
def check_output(args,**kwargs):
 if kwargs['timeout']<.08:
  advance(kwargs['timeout']);raise subprocess.TimeoutExpired(args,kwargs['timeout'])
 advance(.08)
 p=int(args[-1])
 if p not in alive:raise subprocess.CalledProcessError(1,args)
 return ('%d %d %d %d %s'%records[p]).encode()
def run(args,**kwargs):
 if kwargs['timeout']<.025:
  advance(kwargs['timeout']);raise subprocess.TimeoutExpired(args,kwargs['timeout'])
 advance(.025)
 ids=sorted(alive-{42}) if args[1]=='-P' and int(args[-1])==42 else [int(args[-1])] if args[1]=='-g' and int(args[-1]) in alive else []
 return types.SimpleNamespace(returncode=0 if ids else 1,stdout=' '.join(map(str,ids)).encode())
def kill(p,sig):
 signals.append((p,sig,round(clock[0]-100,3)))
 if sig==signal.SIGKILL:alive.discard(p)
def killpg(p,sig):
 if sig==0:
  if p not in alive:raise ProcessLookupError()
 else:kill(p,sig)
def waitpid(p,flags):
 if p not in alive and not root_reaped[0]:root_reaped[0]=True;return(p,signal.SIGKILL)
 return(0,0)
import subprocess
ns={'cfg':{'terminationMs':5000,'termGraceMs':2000},'time':types.SimpleNamespace(monotonic=lambda:clock[0],sleep=advance),'os':types.SimpleNamespace(kill=kill,killpg=killpg,waitpid=waitpid,WNOHANG=1,waitstatus_to_exitcode=lambda s:-s,close=lambda fd:None),'signal':signal,'subprocess':types.SimpleNamespace(check_output=check_output,run=run,PIPE=-1,DEVNULL=-3,CalledProcessError=subprocess.CalledProcessError,SubprocessError=subprocess.SubprocessError),'known':dict(records),'absent':set(),'proofs':{p:None if p==42 else records[42] for p in records},'groups':set(records),'pid':42,'uid':501,'root_exit':None,'cleanup_until':None,'cleanup_exhausted':False,'ownership_failed':False,'coverage':True,'escape_seen':True,'group_changes':[],'group_changes_truncated':False,'started':100,'ps_env':{},'status':'stopped','termination_cause':'control','tty_verified':True,'master':0,'emit':result.append}
exec(compile(ast.Module(body=functions,type_ignores=[]),'<synthetic owner functions>','exec'),ns)
ns['group_exists']=lambda g:g in alive
exec(compile(ast.Module(body=cleanup,type_ignores=[]),'<synthetic owner cleanup>','exec'),ns)
print(json.dumps({'result':result[0],'elapsedMs':round((clock[0]-100)*1000),'killCount':sum(s==signal.SIGKILL for p,s,t in signals),'firstKillMs':round(next(t for p,s,t in signals if s==signal.SIGKILL)*1000)}))`;
 const result=JSON.parse(execFileSync(OwnedCliInvocation.pythonExecutable(),['-c',code,fileURLToPath(new URL('../scripts/owned-cli-pty.py',import.meta.url))],{encoding:'utf8'})) as {result:unknown;elapsedMs:number;killCount:number;firstKillMs:number};
 expect(result.result,JSON.stringify(result)).toMatchObject({status:'stopped',exitCode:-9,ownershipVerified:true,terminationVerified:true,ownedMembers:9,terminationCause:'control'});
 expect(result.killCount).toBe(9);
 expect(result.firstKillMs).toBeLessThan(3000);
 expect(result.elapsedMs).toBeLessThanOrEqual(5000);
});

test('ordinary interactive launch requires a terminal before any spawn', async()=>{
 const owner=new OwnedCliInvocation({command:realpathSync(process.execPath),args:['-e','process.exit(99)'],cwd:process.cwd(),durationMs:100,stdio:'inherit'});
 if(!process.stdin.isTTY||!process.stdout.isTTY)await expect(owner.run()).rejects.toThrow('owned_cli_terminal_required');
});

test('controlling PTY is available to the ordinary child',async()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'owned-tty-fixture-')));
 try{
  const marker=join(dir,'tty.json');const script=join(dir,'worker.mjs');
  writeFileSync(script,`import{openSync,closeSync,writeFileSync}from'node:fs';const fd=openSync('/dev/tty','r+');closeSync(fd);writeFileSync(${JSON.stringify(marker)},JSON.stringify({stdin:process.stdin.isTTY,stdout:process.stdout.isTTY,devTTY:true}));setTimeout(()=>process.exit(0),150);`);
  const result=await new OwnedCliInvocation({command:realpathSync(process.execPath),args:[script],cwd:dir,durationMs:1500,termGraceMs:100,stdio:'ignore'}).run();
  expect(JSON.parse(readFileSync(marker,'utf8'))).toEqual({stdin:true,stdout:true,devTTY:true});
  expect(result).toMatchObject({status:'completed',controllingTerminal:true,terminationVerified:true});
 }finally{rmSync(dir,{recursive:true,force:true});}
},5000);

test('verified fresh descendant in its own group is terminated without a same-PGID restriction',async()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'owned-escape-fixture-')));let escaped:number|undefined;
 try{
  const marker=join(dir,'escaped.pid');const script=join(dir,'worker.mjs');
  writeFileSync(script,`import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';const c=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore',detached:true});c.unref();writeFileSync(${JSON.stringify(marker)},String(c.pid));setTimeout(()=>process.exit(0),400);`);
  const result=await new OwnedCliInvocation({command:realpathSync(process.execPath),args:[script],cwd:dir,durationMs:2000,termGraceMs:100,stdio:'ignore'}).run();
  escaped=Number(readFileSync(marker,'utf8'));
  expect(result).toMatchObject({status:'completed',escapedMemberObserved:true,ownershipVerified:true,terminationVerified:true});
  expect(result.groupChanges).toContainEqual(expect.objectContaining({pid:escaped,fromPgid:null,toPgid:escaped}));
  expect(()=>process.kill(escaped!,0)).toThrow();expect(()=>process.kill(-escaped!,0)).toThrow();
 }finally{if(escaped)try{process.kill(escaped,'SIGKILL');}catch{/* already gone */}rmSync(dir,{recursive:true,force:true});}
},5000);

test('separate PTY owner survives observer exit and verifies root/member disappearance',async()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'owned-observer-fixture-')));const pids:number[]=[];
 try{
  const payload=join(dir,'payload.mjs');const observer=join(dir,'observer.mjs');
  const rootPid=join(dir,'root.pid');const childPid=join(dir,'child.pid');const workerPid=join(dir,'owner.pid');
  writeFileSync(payload,`import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';process.on('SIGTERM',()=>{});const c=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});writeFileSync(${JSON.stringify(rootPid)},String(process.pid));writeFileSync(${JSON.stringify(childPid)},String(c.pid));setInterval(()=>{},1000);`);
  const cfg={command:realpathSync(process.execPath),args:[payload],cwd:dir,durationMs:3000,terminationMs:1500,termGraceMs:100};
  writeFileSync(observer,`import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';const w=spawn(${JSON.stringify(OwnedCliInvocation.pythonExecutable())},[${JSON.stringify(fileURLToPath(new URL('../scripts/owned-cli-pty.py',import.meta.url)))},${JSON.stringify(JSON.stringify(cfg))}],{stdio:['ignore','ignore','ignore','pipe']});writeFileSync(${JSON.stringify(workerPid)},String(w.pid));setTimeout(()=>process.exit(0),400);`);
  const observed=spawn(realpathSync(process.execPath),[observer],{stdio:'ignore'});
  await expect.poll(()=>{try{return Number(readFileSync(childPid,'utf8'))>0;}catch{return false;}},{timeout:2000}).toBe(true);
  for(const file of[rootPid,childPid,workerPid])pids.push(Number(readFileSync(file,'utf8')));
  expect(()=>process.kill(pids[0]!,0)).not.toThrow();
  await new Promise<void>((resolve,reject)=>{observed.once('exit',code=>code===0?resolve():reject(new Error('fixture_observer_failed')));});
  await expect.poll(()=>pids.every(pid=>{try{process.kill(pid,0);return false;}catch{return true;}}),{timeout:3500}).toBe(true);
  expect(()=>process.kill(-pids[0]!,0)).toThrow();
 }finally{for(const pid of pids)try{process.kill(pid,'SIGKILL');}catch{/* already gone */}rmSync(dir,{recursive:true,force:true});}
},7000);

test('a previously proved descendant that later changes PGID remains owned through verified teardown',async()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'owned-regroup-fixture-')));let escaped:number|undefined;
 try{
  const marker=join(dir,'escaped.pid');const regrouped=join(dir,'regrouped');const script=join(dir,'worker.mjs');
  // Slow hosts take hundreds of ms per discovery pass: keep the root-group window
  // wide enough to be sampled, and exit the root only after setsid has happened.
  const py="import os,sys,time,signal;signal.signal(signal.SIGTERM,lambda *args:None);time.sleep(1);os.setsid();open(sys.argv[1],'w').close();time.sleep(30)";
  writeFileSync(script,`import{spawn}from'node:child_process';import{existsSync,writeFileSync}from'node:fs';const c=spawn(${JSON.stringify(OwnedCliInvocation.pythonExecutable())},['-c',${JSON.stringify(py)},${JSON.stringify(regrouped)}],{stdio:'ignore'});c.unref();writeFileSync(${JSON.stringify(marker)},String(c.pid));const t=setInterval(()=>{if(existsSync(${JSON.stringify(regrouped)})){clearInterval(t);process.exit(0);}},20);`);
  const result=await new OwnedCliInvocation({command:realpathSync(process.execPath),args:[script],cwd:dir,durationMs:4000,termGraceMs:100,stdio:'ignore'}).run();
  escaped=Number(readFileSync(marker,'utf8'));
  expect(result).toMatchObject({status:'completed',escapedMemberObserved:true,ownershipVerified:true,terminationVerified:true});
  expect(result.groupChanges).toContainEqual(expect.objectContaining({pid:escaped,fromPgid:result.pid,toPgid:escaped}));
  expect(result.groupChanges.length).toBeLessThanOrEqual(16);expect(result.groupChangesTruncated).toBe(false);
  for(const change of result.groupChanges){expect(change.parentPid).toBe(result.pid);expect(change.parentUid).toBeTypeOf('number');expect(change.parentStartedAt).toBeTypeOf('string');expect(change.sampleOffsetMs).toBeGreaterThanOrEqual(0);expect(change.startedAt).toMatch(/\d{2}:\d{2}:\d{2} \d{4}$/);}
  expect(()=>process.kill(escaped!,0)).toThrow();expect(()=>process.kill(-escaped!,0)).toThrow();
 }finally{if(escaped)try{process.kill(escaped,'SIGKILL');}catch{/* already gone */}rmSync(dir,{recursive:true,force:true});}
},10000);

test('group signals require every sampled member identity to be proved; foreign, conflicting and failed queries reject',()=>{
 // Only the group-check function, with synthetic PID metadata; no real ps/signals.
 const code=`import ast,json,sys,types
tree=ast.parse(open(sys.argv[1]).read());fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='verified_group_members')
out=[]
for case in ['proved','leaderless','foreign','identity_conflict','wrong_group','query_failure','missing_proof','absent_identity','membership_change','malformed_recheck']:
 leader=(42,1,42,501,'start root');child=(43,42,42,501,'start child')
 records={42:leader,43:child};known=dict(records);proofs={42:None,43:leader}
 ids=b'43' if case=='leaderless' else b'42 43'
 if case=='foreign':ids+=b' 99';records[99]=(99,1,42,501,'foreign')
 if case=='identity_conflict':records[42]=(42,1,42,501,'reused identity')
 if case=='wrong_group':records[43]=(43,42,99,501,'start child')
 if case=='missing_proof':proofs[43]=None
 calls=[]
 def run(*args,**kwargs):
  calls.append(1);return types.SimpleNamespace(returncode=2 if case=='query_failure' else 1 if case=='malformed_recheck' and len(calls)>1 else 0,stdout=ids+b' 99' if case=='membership_change' and len(calls)>1 else ids)
 ns={'known':known,'absent':{43} if case=='absent_identity' else set(),'proofs':proofs,'pid':42,'uid':501,'cleanup_until':None,'metadata':lambda p:records.get(p),'identity_matches':lambda a,b:b is not None and a[0]==b[0] and a[3:]==b[3:],'note_group_change':lambda *args:None,'ownership_failed':False,'time':__import__('time'),'subprocess':types.SimpleNamespace(run=run,PIPE=-1,DEVNULL=-3,SubprocessError=Exception)}
 exec(compile(ast.Module(body=[fn],type_ignores=[]),'<synthetic group proof>','exec'),ns)
 result=ns['verified_group_members'](42)
 out.append({'case':case,'members':None if result is None else sorted(result),'failed':ns['ownership_failed']})
print(json.dumps(out))`;
 const result=JSON.parse(execFileSync(OwnedCliInvocation.pythonExecutable(),['-c',code,fileURLToPath(new URL('../scripts/owned-cli-pty.py',import.meta.url))],{encoding:'utf8'})) as unknown;
 expect(result).toEqual([{case:'proved',members:[42,43],failed:false},{case:'leaderless',members:[43],failed:false},...['foreign','identity_conflict','wrong_group','query_failure','missing_proof','absent_identity','membership_change','malformed_recheck'].map(c=>({case:c,members:null,failed:true}))]);
});

test('final conflicting identities cannot prove absence and fresh group observations set the historical flag immediately',()=>{
 const code=`import ast,json,sys,time
tree=ast.parse(open(sys.argv[1]).read());functions=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in ['same','identity_matches','note_group_change']]
root=(42,1,42,501,'start root');record=(43,42,43,501,'start child')
ns={'metadata':lambda p:(43,42,99,501,'reused child'),'absent':set(),'ownership_failed':False,'escape_seen':False,'proofs':{43:root},'pid':42,'groups':set(),'group_changes':[],'group_changes_truncated':False,'started':time.monotonic(),'time':time}
exec(compile(ast.Module(body=functions,type_ignores=[]),'<synthetic absence>','exec'),ns)
present=ns['same'](record);ns['note_group_change'](None,record)
print(json.dumps({'present':present,'ownership_failed':ns['ownership_failed'],'non_root_observed':ns['escape_seen']}))`;
 expect(JSON.parse(execFileSync(OwnedCliInvocation.pythonExecutable(),['-c',code,fileURLToPath(new URL('../scripts/owned-cli-pty.py',import.meta.url))],{encoding:'utf8'}))).toEqual({present:false,ownership_failed:true,non_root_observed:true});
});

test('a changed parent identity cannot admit a fresh child; unproved groups receive no group signals',()=>{
 const code=`import ast,json,sys,types,time
tree=ast.parse(open(sys.argv[1]).read());discover=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='discover');send=next(n for n in ast.walk(tree) if isinstance(n,ast.FunctionDef) and n.name=='send')
parent=(42,1,42,501,'start root');child=(43,42,43,501,'start child');calls=[]
def metadata(p):
 calls.append(p);return child if p==43 else parent if calls.count(42)==1 else (42,1,42,501,'reused parent')
ns={'known':{42:parent},'absent':set(),'proofs':{42:None},'pid':42,'uid':501,'escape_seen':False,'ownership_failed':False,'cleanup_until':None,'metadata':metadata,'identity_matches':lambda a,b:b is not None and a[0]==b[0] and a[3:]==b[3:],'note_group_change':lambda *a:None,'time':time,'subprocess':types.SimpleNamespace(run=lambda *a,**k:types.SimpleNamespace(returncode=0,stdout=b'43'),SubprocessError=Exception,PIPE=-1,DEVNULL=-3)}
exec(compile(ast.Module(body=[discover],type_ignores=[]),'<synthetic ancestry>','exec'),ns);covered=ns['discover']()
signals=[];group_signals=[]
ns.update({'known':{42:parent,43:child},'groups':{42,43},'root_exit':None,'metadata':lambda p:parent if p==42 else (43,42,43,501,'reused child'),'verified_group_members':lambda g:None,'os':types.SimpleNamespace(kill=lambda p,s:signals.append(p),killpg=lambda g,s:group_signals.append(g)),'reap':lambda:None})
exec(compile(ast.Module(body=[send],type_ignores=[]),'<synthetic signal>','exec'),ns);ns['send'](15)
print(json.dumps({'coverage':covered,'child_admitted':43 in ns['proofs'],'failed':ns['ownership_failed'],'individual_signals':signals,'group_signals':group_signals}))`;
 expect(JSON.parse(execFileSync(OwnedCliInvocation.pythonExecutable(),['-c',code,fileURLToPath(new URL('../scripts/owned-cli-pty.py',import.meta.url))],{encoding:'utf8'}))).toEqual({coverage:false,child_admitted:false,failed:true,individual_signals:[42],group_signals:[]});
});
