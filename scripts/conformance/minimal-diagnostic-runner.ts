/** Explicit, bounded diagnostic only; never runs when imported by tests or package build. */
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';
import { createResumeWarningGuard, diagnosticVersion, isolationArguments, makeGuardDiagnostic, runDiagnostic, type DiagnosticDeps, type GuardDiagnostic, type ResumeWarningContext } from './minimal-diagnostic.js';
export { isolationArguments } from './minimal-diagnostic.js';
export interface SpawnOptions {cwd:string;timeoutMs:number;env:NodeJS.ProcessEnv;stdoutLimit?:number;observeEvents?:boolean;resumeWarningContext?:ResumeWarningContext}
export interface SpawnResult {code:number|null;timedOut:boolean;spawnError:boolean;stdout:string;streamStopped?:boolean;guardDiagnostic?:GuardDiagnostic;warningCounts?:{resume_model_changed:number}}
export interface DiagnosticEnvironment {cwd:string;binary:string;execute:()=>Promise<string>;write:(text:string)=>void}
export interface EnvironmentOptions {home:string;cwd:string;tempRoot:string;env:NodeJS.ProcessEnv;binary?:string;processRunner:(binary:string,args:readonly string[],options:SpawnOptions)=>Promise<SpawnResult>;write:(text:string)=>void}
const object = (x:unknown):Record<string,unknown> => x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Record<string,unknown> : {};
export function filteredDiagnosticEnvironment(env:NodeJS.ProcessEnv):NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/^(CLAUDE|OTEL_|CODEX_|BETA_TRACING|ENABLE_)/.test(key)));
}
/** Project only enabled flags; transport/auth fields never leave in-memory parsing. */
export function allMcpDisabled(stdout:string):boolean {
  try {
    const rows:unknown = JSON.parse(stdout);
    return Array.isArray(rows) && rows.length > 0 && rows.every((x:unknown) => typeof object(x).name === 'string' && object(x).enabled === false);
  } catch {return false;}
}
/** No retries. SIGINT immediately, SIGTERM after 1s, SIGKILL/final settlement after 2s. */
export function boundedSpawn(binary:string,args:readonly string[],options:SpawnOptions):Promise<SpawnResult> {
  return new Promise(resolveResult => {
    const child = spawn(binary,[...args],{cwd:options.cwd,env:filteredDiagnosticEnvironment(options.env),stdio:['ignore','pipe','pipe'],detached:true});
    const chunks:Buffer[] = []; let size = 0; let settled = false; let timedOut = false; let streamStopped = false;
    let guardDiagnostic:GuardDiagnostic | undefined;
    let pending = ''; const decoder = new StringDecoder('utf8');
    const counts = new Map<string,number>();
    const warning = createResumeWarningGuard(args,options.resumeWarningContext);
    let terminate:ReturnType<typeof setTimeout> | undefined; let kill:ReturnType<typeof setTimeout> | undefined;
    const signal = (value:NodeJS.Signals) => {try {if (child.pid !== undefined) process.kill(-child.pid,value);} catch { /* already exited */ }};
    const finish = (code:number|null,spawnError:boolean) => {
      if (settled) return; settled = true;
      clearTimeout(deadline); clearTimeout(terminate); clearTimeout(kill);
      resolveResult({code,timedOut,spawnError,streamStopped,warningCounts:{resume_model_changed:warning.count},...(guardDiagnostic === undefined ? {} : {guardDiagnostic}),stdout:size <= (options.stdoutLimit ?? 8 * 1024 * 1024) ? Buffer.concat(chunks).toString('utf8') : ''});
    };
    const stop = () => {
      if (terminate !== undefined || settled) return;
      signal('SIGINT'); terminate = setTimeout(() => signal('SIGTERM'),1000);
      kill = setTimeout(() => {signal('SIGKILL'); finish(null,false);},2000);
    };
    const stopStream = (branch:GuardDiagnostic['branch'],eventType:unknown = undefined,itemType:unknown = undefined,message:unknown = undefined) => {
      guardDiagnostic ??= makeGuardDiagnostic(branch,eventType,itemType,message);
      streamStopped = true; stop();
    };
    const deadline = setTimeout(() => {timedOut = true; stop();},options.timeoutMs);
    child.stderr.resume();
    child.stdout.on('data',(chunk:Buffer) => {
      size += chunk.length;
      if (size > (options.stdoutLimit ?? 8 * 1024 * 1024)) {chunks.length = 0; stopStream('stdout_bytes'); return;}
      chunks.push(chunk);
      if (!options.observeEvents || streamStopped) return;
      pending += decoder.write(chunk);
      let newline:number;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0,newline); pending = pending.slice(newline+1);
        if (!line.trim()) continue;
        try {
          const e = object(JSON.parse(line) as unknown); const type = String(e.type);
          counts.set(type,(counts.get(type) ?? 0)+1);
          if (!['thread.started','turn.started','turn.completed','item.started','item.updated','item.completed'].includes(type)) {
            stopStream('event_type',e.type,object(e.item).type,type === 'turn.failed' ? object(e.error).message : e.message); break;
          }
          if (['thread.started','turn.started','turn.completed'].includes(type) && counts.get(type)! > 1) {
            stopStream('boundary_count',e.type); break;
          }
          if (warning.accept(e)) continue;
          if (type.startsWith('item.') && !['agent_message','reasoning'].includes(String(object(e.item).type))) {
            stopStream('item_type',e.type,object(e.item).type,object(e.item).message); break;
          }
        } catch {stopStream('json_parse'); break;}
      }
    });
    child.once('error',() => finish(null,true));
    child.once('close',code => finish(code,false));
  });
}
function stamp(path:string):string {
  if (!existsSync(path)) return 'absent'; const s = statSync(path); return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}`;
}
function instructionBytes(home:string,fixture:string):number {
  const paths = new Set([join(home,'.codex/AGENTS.md'),join(home,'.codex/AGENTS.override.md')]);
  let current = resolve(fixture);
  for (;;) {
    paths.add(join(current,'AGENTS.md')); paths.add(join(current,'AGENTS.override.md'));
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
  return [...paths].reduce((sum,path) => sum + (existsSync(path) ? statSync(path).size : 0),0);
}
export function createDiagnosticEnvironment(options:EnvironmentOptions):DiagnosticEnvironment {
  const binary = options.binary ?? join(options.home,`.codex/packages/app-server-daemon/releases/${diagnosticVersion}-aarch64-apple-darwin/bin/codex`);
  return {cwd:options.cwd,binary,write:options.write,execute:async () => {
    const out = join(options.cwd,'.harness-delta/work/minimal-live-collection-cost-validation-2026-10-03');
    mkdirSync(out,{recursive:true,mode:0o700});
    const ledger = join(out,'generation-ledger.jsonl');
    const config = join(options.home,'.codex/config.toml'); const hooks = join(options.home,'.codex/hooks.json');
    const metadata = () => JSON.stringify([stamp(config),stamp(hooks),stamp(binary)]);
    const baseline = metadata(); const fixtures:string[] = []; let currentFixture = realpathSync(options.tempRoot);
    const product = (args:readonly string[],cwd:string,timeoutMs:number,observeEvents = false,resumeWarningContext?:ResumeWarningContext) =>
      options.processRunner(binary,[...isolationArguments,...args],{cwd,timeoutMs,env:options.env,observeEvents,...(resumeWarningContext === undefined ? {} : {resumeWarningContext})});
    const deps:DiagnosticDeps = {
      preflight:async () => {
        const version = await product(['--version'],currentFixture,30_000);
        // A failed support probe stops before any other product invocation.
        const exact = version.code === 0 && !version.timedOut && !version.spawnError && version.stdout.trim() === `codex-cli ${diagnosticVersion}`;
        const mcp = exact ? await product(['mcp','list','--json'],currentFixture,30_000) : null;
        const disabled = mcp !== null && mcp.code === 0 && !mcp.timedOut && !mcp.spawnError && allMcpDisabled(mcp.stdout);
        const raw = existsSync(config) ? readFileSync(config,'utf8') : '';
        return {versionMatches:exact,configurationStable:metadata() === baseline,globalInstructionBytes:instructionBytes(options.home,currentFixture),
          mcpServerCount:disabled ? 0 : 1,otherInstructionOverrides:/^\s*(instructions|developer_instructions|model_instructions_file|project_doc_fallback_filenames)\s*=/m.test(raw),
          hooksConfigured:existsSync(hooks) || /^\s*hooks\s*=|^\s*\[hooks(?:\.|\])/m.test(raw),codexHomeSet:options.env.CODEX_HOME !== undefined};
      },
      createFixture:() => {currentFixture = realpathSync(mkdtempSync(join(options.tempRoot,'hd-minimal-'))); chmodSync(currentFixture,0o700); fixtures.push(currentFixture); return currentFixture;},
      spawn:(args,cwd,resumeWarningContext) => product(args,cwd,180_000,true,resumeWarningContext),
    };
    try {return await runDiagnostic(ledger,deps);}
    finally {for (const fixture of fixtures) rmSync(fixture,{recursive:true,force:true}); options.write(`config_metadata_unchanged: ${metadata() === baseline}\n`);}
  }};
}
export async function diagnosticMain(argv:readonly string[],env:DiagnosticEnvironment):Promise<number> {
  if (argv.length !== 3 || argv[0] !== '--execute-approved-five-attempts' || argv[1] !== '--binary' || argv[2] !== env.binary || !isAbsolute(env.binary)) {
    env.write('explicit_execution_flag_and_pinned_binary_required\n'); return 2;
  }
  const reason = await env.execute(); env.write(`stop: ${reason}\n`);
  return reason === 'observed_semantics_unknown' ? 0 : 1;
}
const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href) {
  const argv = process.argv.slice(2); const binary = argv[2] ?? '';
  if (argv.length !== 3 || argv[0] !== '--execute-approved-five-attempts' || argv[1] !== '--binary' || !isAbsolute(binary)) {
    process.stdout.write('explicit_execution_flag_and_pinned_binary_required\n'); process.exitCode = 2;
  } else {
    diagnosticMain(argv,createDiagnosticEnvironment({home:homedir(),cwd:process.cwd(),tempRoot:'/tmp',env:process.env,binary,processRunner:boundedSpawn,write:text => {process.stdout.write(text);}})).then(
      code => {process.exitCode = code;},() => {process.stdout.write('stop: internal_error\n'); process.exitCode = 1;});
  }
}
