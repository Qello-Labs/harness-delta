import { spawn, execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export interface OwnedCliOptions {
 command:string;args:readonly string[];cwd:string;durationMs:number;stdio:'inherit'|'ignore';env?:NodeJS.ProcessEnv;
 terminationMs?:number;termGraceMs?:number;pythonExecutable?:string;
 onTerminalAttention?:()=>void;
}
const startIdentity=z.string().max(64).regex(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/);
const groupChangeSchema=z.strictObject({pid:z.number().int().positive(),ppid:z.number().int().nonnegative(),uid:z.number().int().nonnegative(),startedAt:startIdentity,fromPgid:z.number().int().positive().nullable(),toPgid:z.number().int().positive(),parentPid:z.number().int().positive().nullable(),parentUid:z.number().int().nonnegative().nullable(),parentStartedAt:startIdentity.nullable(),sampleOffsetMs:z.number().int().nonnegative()});
const resultSchema=z.object({type:z.literal('result'),status:z.enum(['completed','failed','stopped','timed_out','launch_failed']),pid:z.number().int().positive(),exitCode:z.number().int().nullable(),terminationVerified:z.boolean(),ownershipVerified:z.boolean(),controllingTerminal:z.boolean(),escapedMemberObserved:z.boolean(),ownedMembers:z.number().int(),terminationCause:z.enum(['root_exit','deadline','control','owner_error']),groupChanges:z.array(groupChangeSchema).max(16),groupChangesTruncated:z.boolean()});
export type OwnedCliResult=Omit<z.infer<typeof resultSchema>,'type'>;
/** POSIX stdlib PTY owner is independent of the JS observer. Native owns /dev/tty;
 * control-pipe EOF/deadline terminates fresh root/known members after observer loss.
 * Unknown escaped processes/backend requests remain outside this guarantee.
 */
export class OwnedCliInvocation {
 private readonly options:OwnedCliOptions;private started=false;private alive=false;private spawned=false;
 private readonly stopController=new AbortController();
 constructor(options:OwnedCliOptions){
  if(process.platform==='win32'||!isAbsolute(options.command)||!isAbsolute(options.cwd)||options.args.some(a=>a.includes('\0'))||[options.command,options.cwd].some(a=>a.includes('\0'))||!Number.isInteger(options.durationMs)||options.durationMs<1||options.durationMs>900000||!Number.isInteger(options.terminationMs??5000)||(options.terminationMs??5000)<100||(options.terminationMs??5000)>5000||!Number.isInteger(options.termGraceMs??2000)||(options.termGraceMs??2000)<1||(options.termGraceMs??2000)>2000)throw new Error('owned_cli_invalid');
  this.options={...options,args:[...options.args],...(options.env?{env:{...options.env}}:{})};
 }
 static pythonExecutable():string{return realpathSync(execFileSync('which',['python3'],{encoding:'utf8',timeout:2000}).trim());}
 hasSpawned():boolean{return this.spawned;}
 stopRequested():boolean{return this.stopController.signal.aborted;}
 isAlive():boolean{return this.alive;}
 stop():void{this.stopController.abort();}
 async run(signal?:AbortSignal):Promise<OwnedCliResult>{
  if(this.started)throw new Error('owned_cli_already_started');
  if(this.options.stdio==='inherit'&&(!process.stdin.isTTY||!process.stdout.isTTY))throw new Error('owned_cli_terminal_required');
  if(signal?.aborted||this.stopController.signal.aborted)throw new Error('owned_cli_stopped_before_start');
  this.started=true;const o=this.options;const wasRaw=process.stdin.isRaw??false;
  const worker=fileURLToPath(new URL('../scripts/owned-cli-pty.py',import.meta.url));
  return await new Promise((resolve,reject)=>{
   const cfg={command:o.command,args:o.args,cwd:o.cwd,durationMs:o.durationMs,terminationMs:o.terminationMs??5000,termGraceMs:o.termGraceMs??2000,rows:process.stdout.rows??24,columns:process.stdout.columns??80};
   const child=spawn(o.pythonExecutable??OwnedCliInvocation.pythonExecutable(),[worker,JSON.stringify(cfg)],{shell:false,stdio:['pipe','pipe','pipe','pipe'],...(o.env?{env:o.env}:{})});
   let pending='';let result:OwnedCliResult|undefined;
   const control=child.stdio[3];
   const abort=()=>{if(control&&'write'in control)control.write('stop\n');};
   const input=(b:Buffer)=>{child.stdin.write(b);};
   if(o.stdio==='inherit'){process.stdin.setRawMode(true);process.stdin.on('data',input);process.stdin.resume();}
   // Observe framing only; notification messages can contain private command text.
   const attentionPrefix=[0x1b,0x5d,0x39,0x3b];
   let prefixLength=0,payloadLength=0,progressCandidate=false,progress=false;
   child.stdout.on('data',(b:Buffer)=>{
    if(o.onTerminalAttention)for(const byte of b){
     if(prefixLength<attentionPrefix.length){
      prefixLength=byte===attentionPrefix[prefixLength]?prefixLength+1:byte===0x1b?1:0;
     }else if(byte===0x1b){
      prefixLength=1;payloadLength=0;progressCandidate=false;progress=false;
     }else if(byte===0x07){
      if(payloadLength>0&&!progress)o.onTerminalAttention();
      prefixLength=0;payloadLength=0;progressCandidate=false;progress=false;
     }else{
      if(payloadLength===0)progressCandidate=byte===0x34;
      if(payloadLength===1)progress=progressCandidate&&byte===0x3b;
      payloadLength=Math.min(payloadLength+1,2);
     }
    }
    if(o.stdio==='inherit')process.stdout.write(b);
   });
   child.stdin.on('error',()=>{});control?.on('error',()=>{});
   child.stderr.on('data',(b:Buffer)=>{
    pending+=b.toString('utf8');if(pending.length>8192){abort();return;}
    let end:number;while((end=pending.indexOf('\n'))>=0){const line=pending.slice(0,end);pending=pending.slice(end+1);
     try{const v=JSON.parse(line) as unknown;const parsed=resultSchema.safeParse(v);if(parsed.success){const{type,...metadata}=parsed.data;void type;result=metadata;this.alive=false;}else if(z.object({type:z.literal('spawn'),pid:z.number(),controllingTerminal:z.literal(true)}).safeParse(v).success){this.spawned=true;this.alive=true;}}
     catch{abort();}
    }
   });
   signal?.addEventListener('abort',abort,{once:true});this.stopController.signal.addEventListener('abort',abort,{once:true});
   const cleanup=()=>{this.alive=false;signal?.removeEventListener('abort',abort);this.stopController.signal.removeEventListener('abort',abort);if(o.stdio==='inherit'){process.stdin.removeListener('data',input);process.stdin.setRawMode(wasRaw);process.stdin.pause();}};
   child.once('error',()=>{cleanup();reject(new Error('owned_cli_worker_failed'));});
   child.once('exit',()=>{cleanup();if(result)resolve(result);else reject(new Error('owned_cli_termination_unverified'));});
   if(signal?.aborted||this.stopController.signal.aborted)abort();
  });
 }
}
