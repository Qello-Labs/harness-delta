import { randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, realpathSync, mkdirSync, lstatSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { z } from 'zod';
import { IdSchema, ModelSchema } from './contracts.js';
import { bindConfigurationToSession } from './config-confirmation.js';
import { authorizeClaudeTraceScope } from './claude-trace-candidate.js';
import { prepareClaudeProbeSupervisor, verifyClaudeProbeBinary, verifyClaudeWorkflowVersion } from './claude-probe-supervisor.js';
import { claudeWorkflowChildAgentType } from './claude-native-probe.js';
import { recordAbandonedRunGap, recordObservationGap } from './runtime-history.js';
import type { CandidateScope } from './nested-candidate.js';
import { isClaudeWorkflowProductVersion, claudeWorkflowProfileId, claudeWorkflowChildProfileId } from './claude-workflow-versions.js';
import { resolveSourceCompatibility, assertCompatibilityAllowed, pinSessionCompatibility, invalidateCompatibility } from './source-compatibility.js';
import type { Store } from './store.js';
import type { WorkflowAdapter, WorkflowAdapterResult } from './task-workflow.js';

/** Admitted in the code-owned registry as two separate exact profiles: parent-only
 * (claude-workflow-02196-root-native-v1) and a fresh root with one fresh direct child
 * (claude-workflow-02196-direct-child-native-v1). The version comes from the pinned binary and
 * must match the configured product version. */
export { claudeWorkflowProfileId, claudeWorkflowChildProfileId };
const effort = z.enum(['low','medium','high','xhigh','max']);
export const ClaudeWorkflowExecutionSchema = z.strictObject({
  operation:z.enum(['launch','resume']), run_id:IdSchema,
  binary:z.strictObject({path:z.string().min(1).max(4096),version:z.string().refine(isClaudeWorkflowProductVersion),sha256:z.string().regex(/^[a-f0-9]{64}$/)}),
  workspace:z.string().min(1).max(4096), mediator_path:z.string().min(1).max(4096), prompt_file:z.string().min(1).max(4096),
  timeout_ms:z.number().int().min(1).max(3600000), max_turns:z.number().int().min(1).max(1024),
  request_limit:z.number().int().min(1).max(1024),
  /** read-only: Read/Glob/Grep. workspace-edit adds Edit/Write; never Bash. */
  permissions:z.enum(['read-only','workspace-edit']).default('read-only'),
  /** Passed to the CLI's own estimate; not a provider or subscription spending cap. */
  max_budget_usd:z.number().min(0.01).max(1000).optional(),
  child_runtime:z.strictObject({model:ModelSchema,effort}).optional(),
  /** launch only: keep the native session so that a later resume can continue it. */
  resumable:z.boolean().optional(),
  /** resume only: an earlier resumable run of the same task, in the same workspace. */
  resume_run_id:IdSchema.optional(),
}).superRefine((v,c)=>{
  // A resumed session is parent-only and stays resumable; a child run is never kept.
  if(v.operation==='resume'?v.resume_run_id===undefined||v.resume_run_id===v.run_id||v.child_runtime!==undefined||v.resumable!==undefined
    :v.resume_run_id!==undefined||v.resumable===true&&v.child_runtime!==undefined)c.addIssue({code:'custom',message:'claude_workflow_resume_options_invalid'});
});
const ResumableManifestSchema=z.object({schemaVersion:z.literal(1),nativeSessionId:z.uuid(),binary:z.object({version:z.string()}),sessionPersistence:z.enum(['persistent','resume'])});
/** The earlier run's own manifest names the kept native session. No transcript or user configuration is read. */
function readResumableSession(workspace:string,runId:string,version:string):string {
  let fd:number|undefined;
  try {
    if(realpathSync(workspace)!==workspace)throw new Error('invalid');
    const directory=lstatSync(join(workspace,runId));if(!directory.isDirectory()||(directory.mode&0o077)!==0)throw new Error('invalid');
    fd=openSync(join(workspace,runId,'claude-probe-manifest.json'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const stat=fstatSync(fd);if(!stat.isFile()||stat.size<1||stat.size>65536)throw new Error('invalid');
    const manifest=ResumableManifestSchema.parse(JSON.parse(readFileSync(fd,'utf8')) as unknown);
    if(manifest.binary.version!==version)throw new Error('invalid');return manifest.nativeSessionId;
  }catch{throw new Error('claude_workflow_resume_source_invalid');}
  finally{if(fd!==undefined)closeSync(fd);}
}

function readPrompt(path:string):string {
  let fd:number|undefined;
  try {
    if(realpathSync(path)!==path)throw new Error('invalid');
    fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const before=fstatSync(fd);if(!before.isFile()||before.size<1||before.size>1048576)throw new Error('invalid');
    const content=readFileSync(fd,'utf8');const after=fstatSync(fd);
    if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw new Error('invalid');return content;
  }catch{throw new Error('claude_workflow_prompt_failed');}
  finally{if(fd!==undefined)closeSync(fd);}
}
/** With edit tools, any file the harness executes or trusts must be unreachable:
 * an edited hook mediator (or its sibling modules) would run model-written code. */
function harnessOutsideProject(projectRoot:string|null,paths:string[]):void {
  // native realpath returns the on-disk spelling, so case-insensitive aliases compare equal.
  const real=(path:string):string=>existsSync(path)?realpathSync.native(path):join(real(dirname(path)),basename(path));
  let root:string;
  try{if(projectRoot===null)throw new Error('missing');root=realpathSync.native(projectRoot);}
  catch{throw new Error('claude_workflow_harness_inside_project');}
  for(const path of paths){
    const resolved=real(path);
    if(resolved===root||resolved.startsWith(root+sep))throw new Error('claude_workflow_harness_inside_project');
  }
}
export function createClaudeWorkflowAdapter(store:Store,input:unknown):WorkflowAdapter { return adapter(store,input,false); }
/** Test-only trusted dependency, with a synthetic workspace and synthetic usage.
 * Never exposed as a public flag, binary option, profile, or admission override.
 */
export function createSyntheticClaudeWorkflowAdapter(store:Store,input:unknown):WorkflowAdapter { return adapter(store,input,true); }
function adapter(store:Store,input:unknown,synthetic:boolean):WorkflowAdapter {
  const e=ClaudeWorkflowExecutionSchema.parse(input);
  const profileId=e.child_runtime?claudeWorkflowChildProfileId:claudeWorkflowProfileId;
  const compatibility=synthetic?null:resolveSourceCompatibility('claude_code',e.binary.version,'claude_workflow',profileId);
  const resume=e.operation==='resume';const persistent=resume||e.resumable===true;
  /** The earlier run names a kept parent-only session of this task and binary version. That session must
   * be idle and must already have observed usage; its newest run bounds the unobserved interval. */
  const priorRun=(taskId?:string,projectId?:string)=>{
    const row=store.get<{task_id:string;project_id:string;session_id:string}>('SELECT task_id,project_id,session_id FROM claude_workflow_runs WHERE id=?',[e.resume_run_id]);
    const session=row&&store.get<{parent_id:string|null;product:string|null;product_version:string|null}>('SELECT parent_id,product,product_version FROM sessions WHERE id=?',[row.session_id]);
    const last=row&&store.get<{at:string|null;running:number|null}>("SELECT max(coalesce(ended_at,started_at)) AS at,sum(state='running') AS running FROM claude_workflow_runs WHERE session_id=?",[row.session_id]);
    if(!row||!session||!last||last.at===null||last.running!==0||taskId!==undefined&&(row.task_id!==taskId||row.project_id!==projectId)||session.parent_id!==null||
      session.product!==(synthetic?'synthetic':'claude_code')||session.product_version!==(synthetic?'1.0.0':e.binary.version)||
      store.get('SELECT 1 FROM sessions WHERE parent_id=?',[row.session_id])||
      !store.get("SELECT 1 FROM events WHERE session_id=? AND json_extract(payload,'$.kind')='usage' LIMIT 1",[row.session_id]))throw new Error('claude_workflow_resume_source_invalid');
    return {session_id:row.session_id,lastEndedAt:last.at};
  };
  const admitted=(requested:string|null)=>{
    if(compatibility)assertCompatibilityAllowed(store,compatibility);
    if(requested!==null&&!effort.safeParse(requested).success)throw new Error('claude_workflow_effort_unsupported');
    if(store.get('SELECT 1 FROM claude_workflow_runs WHERE id=?',[e.run_id]))throw new Error('claude_workflow_already_reserved');
    // A child needs the exact direct-child admission of this version; a conditional version stays parent-only.
    if(!synthetic&&e.child_runtime&&compatibility?.state!=='verified')throw new Error('claude_workflow_child_unadmitted');
    // The direct-child evidence covers a read-only root with one read-only child.
    if(!synthetic&&e.child_runtime&&e.permissions!=='read-only')throw new Error('claude_workflow_child_read_only_required');
    // Keeping or resuming a native session is covered by the exact own-trace admission only.
    if(!synthetic&&persistent&&compatibility?.state!=='verified')throw new Error('claude_workflow_resume_unadmitted');
  };
  return {product:synthetic?'synthetic':'claude_code',productVersion:synthetic?'1.0.0':e.binary.version,
    profileId:synthetic?'synthetic-flexible-v1':profileId,
    preflight(runtime,scope){
      admitted(runtime.effort);
      if(e.permissions==='workspace-edit')harnessOutsideProject(scope?.projectRoot??null,[e.workspace,e.mediator_path,dirname(e.mediator_path),e.prompt_file,e.binary.path,process.execPath,
        ...(store.filename&&store.filename!==':memory:'?[store.filename]:[])]);
      // Supervisor preparation verifies the binary again before any launch.
      verifyClaudeProbeBinary(e.binary,[e.binary.version]);if(!synthetic)verifyClaudeWorkflowVersion(e.binary,e.workspace);readPrompt(e.prompt_file);
      if(resume){priorRun(scope?.taskId,scope?.projectId);readResumableSession(e.workspace,e.resume_run_id!,e.binary.version);}
    },
    async run(c){
      c.assertActive();
      admitted(c.runtime.effort);
      // The synthetic workspace scope exists only after assignment.
      if(synthetic&&!store.get('SELECT 1 FROM comparison_workspace_scope'))throw new Error('synthetic_store_required');
      // A resume continues the same native session and therefore the same session row.
      const prior=resume?priorRun(c.taskId,c.projectId):null;
      const sessionId=prior?.session_id??randomUUID();const nativeSessionId=prior?readResumableSession(e.workspace,e.resume_run_id!,e.binary.version):randomUUID();
      const processId=randomUUID();const startedAt=new Date().toISOString();
      const scope:CandidateScope={projectId:c.projectId,taskId:c.taskId,allowedRootTurnIds:[e.run_id],sessions:[{
        sessionId,rootSessionId:sessionId,parentSessionId:null,sourceId:randomUUID(),product:'claude_code',nativeSessionId,processId,agentId:null,
      }]};
      store.immediateTransaction(()=>{
        c.assertActive();
        if(store.get("SELECT 1 FROM codex_workflow_runs WHERE task_id=? AND state='running' UNION ALL SELECT 1 FROM claude_workflow_runs WHERE task_id=? AND state='running'",[c.taskId,c.taskId]))throw new Error('workflow_run_active');
        const verifiedPrior=prior?priorRun(c.taskId,c.projectId):null;
        if(!verifiedPrior)store.execute('INSERT INTO sessions(id,project_id,task_id,product,product_version) VALUES (?,?,?,?,?)',[sessionId,c.projectId,c.taskId,synthetic?'synthetic':'claude_code',synthetic?'1.0.0':e.binary.version]);
        if(compatibility)pinSessionCompatibility(store,sessionId,compatibility);
        bindConfigurationToSession(store,c.confirmationId,sessionId);
        authorizeClaudeTraceScope(store,scope,c.generation,synthetic,compatibility??undefined);
        store.execute("INSERT INTO claude_workflow_runs(id,task_id,project_id,session_id,confirmation_id,generation,instruction_manifest_hash,state,started_at) VALUES (?,?,?,?,?,?,?,'running',?)",[e.run_id,c.taskId,c.projectId,sessionId,c.confirmationId,c.generation,c.instructionManifestHash,startedAt]);
        // Nothing observed the kept session between its runs; that interval is never backfilled.
        if(verifiedPrior)recordObservationGap(store,c.taskId,sessionId,verifiedPrior.lastEndedAt,startedAt,'offline',startedAt);
      });
      let state:WorkflowAdapterResult['state']='failed';let reason:string|null='claude_workflow_prepare_failed';let observed=0;let application:WorkflowAdapterResult['harness_application']='unapplied';
      let supervisor:Awaited<ReturnType<typeof prepareClaudeProbeSupervisor>>|undefined;let processStarted=false;
      try{
        c.assertActive();const prompt=readPrompt(e.prompt_file);c.assertActive();
        mkdirSync(e.workspace,{recursive:true,mode:0o700});
        if(realpathSync(e.workspace)!==e.workspace||!lstatSync(e.workspace).isDirectory()||(lstatSync(e.workspace).mode&0o077)!==0)throw new Error('claude_workflow_private_workspace_required');
        // One private subdirectory per run: the probe manifest and reservations are one-use.
        const runWorkspace=join(e.workspace,e.run_id);
        try{mkdirSync(runWorkspace,{mode:0o700});}catch{throw new Error('claude_workflow_private_workspace_required');}
        supervisor=await prepareClaudeProbeSupervisor({store,rootScope:scope,generation:c.generation,
          child:{sessionId:randomUUID(),sourceId:randomUUID(),agentType:claudeWorkflowChildAgentType},workspace:runWorkspace,cwd:c.projectRoot,
          binary:e.binary,mediatorPath:e.mediator_path,durationMs:e.timeout_ms,
          workflow:{synthetic,model:c.runtime.model,effort:c.runtime.effort,childRuntime:e.child_runtime,permissions:e.permissions,maxBudgetUsd:e.max_budget_usd,
            ...(persistent?{session:resume?'resume' as const:'persistent' as const}:{}),
            instructions:c.instructions.map(row=>row.content).join('\n\n'),maxTurns:e.max_turns,requestLimit:e.request_limit,durationMs:e.timeout_ms,prompt,
            assertActive:()=>{c.assertActive();if(compatibility)assertCompatibilityAllowed(store,compatibility);},onChildBound:id=>bindConfigurationToSession(store,c.confirmationId,id),
            stopRequested:()=>store.get<{stop_requested:number}>('SELECT stop_requested FROM claude_workflow_runs WHERE id=?',[e.run_id])?.stop_requested!==0,
          }});
        c.assertActive();processStarted=true;const result=await supervisor.run();observed=result.state.requestsInserted;
        application=result.state.rootStarted&&result.state.lastSequence>=0?'invocation_settings_verified':'unapplied';
        state=result.status==='completed'?'completed':['stopped','timed_out'].includes(result.status)?'stopped':'failed';
        reason=result.reason;
      }catch(error){
        // Fixed diagnostics only; no producer error, prompt, response or path escapes.
        reason=error instanceof Error&&['claude_workflow_private_workspace_required','claude_workflow_prompt_failed','claude_probe_executable_mismatch'].includes(error.message)?error.message:'claude_workflow_failed';
      }finally{
        await supervisor?.dispose();
        if(compatibility?.state==='compatibility_unverified'&&['claude_probe_terminal_missing','claude_probe_executable_mismatch'].includes(reason??''))invalidateCompatibility(store,compatibility,'contract_failed');
        store.immediateTransaction(()=>{
          const endedAt=new Date().toISOString();
          // Deletion/revocation must never restore a journal, event or session.
          if(!store.get('SELECT 1 FROM claude_workflow_runs WHERE id=?',[e.run_id]))return;
          // A resumed session row also holds earlier runs' usage; count only this run's window.
          observed=store.get<{count:number}>("SELECT count(*) AS count FROM events WHERE task_id=? AND session_id IN (SELECT id FROM sessions WHERE id=? OR parent_id=?) AND json_extract(payload,'$.kind')='usage' AND occurred_at>=?",[c.taskId,sessionId,sessionId,startedAt])!.count;
          if(state!=='completed'){try{
            const last=store.get<{at:string|null}>("SELECT max(occurred_at) AS at FROM events WHERE task_id=? AND session_id IN (SELECT id FROM sessions WHERE id=? OR parent_id=?) AND occurred_at>=?",[c.taskId,sessionId,sessionId,startedAt])?.at;
            recordObservationGap(store,c.taskId,sessionId,last?new Date(Math.min(Date.parse(endedAt),Date.parse(last)+1)).toISOString():startedAt,endedAt,'incomplete',endedAt);
          }catch{/* Scope loss (pause, finish) forbids further measurement writes; the run still ends. */}}
          // A recovered (abandoned) run keeps its human-recorded terminal state.
          store.execute("UPDATE claude_workflow_runs SET state=?,ended_at=?,reason=?,observed_requests=? WHERE id=? AND state='running'",[state,endedAt,reason,observed,e.run_id]);
        });
      }
      return {run_id:e.run_id,session_id:sessionId,state,reason,observed_requests:observed,harness_application:application,process_started:processStarted};
    }};
}
/** Explicit fencing for a run whose process is gone; see recoverCodexWorkflow. */
export function recoverClaudeWorkflow(store:Store,runId:string,now:string=new Date().toISOString()){
  IdSchema.parse(runId);
  return store.immediateTransaction(()=>{
    const row=store.get<{state:string;task_id:string;session_id:string;started_at:string}>('SELECT state,task_id,session_id,started_at FROM claude_workflow_runs WHERE id=?',[runId]);
    if(!row)throw new Error('claude_workflow_run_missing');
    if(row.state!=='running')throw new Error('workflow_run_not_running');
    store.execute("UPDATE claude_workflow_runs SET state='failed',reason='abandoned',stop_requested=1,ended_at=? WHERE id=? AND state='running'",[now,runId]);
    const sessions=[row.session_id,...store.all<{id:string}>('SELECT id FROM sessions WHERE parent_id=?',[row.session_id]).map(s=>s.id)];
    const gaps=sessions.filter(session=>recordAbandonedRunGap(store,row.task_id,session,row.started_at,now)).length;
    return {run_id:runId,task_id:row.task_id,state:'failed' as const,reason:'abandoned' as const,observation_gaps:gaps,
      gaps_not_recorded:sessions.length-gaps,...(gaps<sessions.length?{gap_warning:'task_not_active' as const}:{})};
  });
}
export function stopClaudeWorkflow(store:Store,runId:string){
  IdSchema.parse(runId);
  return store.immediateTransaction(()=>{
    const row=store.get<{state:string}>('SELECT state FROM claude_workflow_runs WHERE id=?',[runId]);
    if(!row)throw new Error('claude_workflow_run_missing');
    if(row.state==='running')store.execute('UPDATE claude_workflow_runs SET stop_requested=1 WHERE id=?',[runId]);
    return {run_id:runId,state:row.state,stop_requested:row.state==='running'};
  });
}
