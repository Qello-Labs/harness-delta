import { readFileSync, writeFileSync } from 'node:fs';
import { codexWorkflowFixture } from './codex-workflow-fixture.js';
import { createSyntheticCodexWorkflowAdapter } from '../../src/codex-workflow-adapter.js';
import { runAssignedWorkflow } from '../../src/workflow/task-workflow.js';

export function codexNativeChildFixture(mode = 'callback-first', f = codexWorkflowFixture()) {
  const permissions = `permission_profile:{type:'managed',file_system:{type:'restricted',entries:[{path:{type:'special',value:{kind:'root'}},access:'read'}]},network:'restricted'}`;
  const baseScript = readFileSync(f.script, 'utf8');
  let script = baseScript.replace("multi_agent_version:'disabled'", `multi_agent_version:'v2',${permissions}`);
  script = script.replace(
    "if(prompt.includes('WAIT'))",
    `
const childModel=JSON.parse(get('agents.default_subagent_model='));const childEffort=JSON.parse(get('agents.default_subagent_reasoning_effort='));
if(get('agents.enabled=')!=='true'||get('agents.max_depth=')!=='1'||!get('hooks.SubagentStart='))process.exit(5);
const mode=${JSON.stringify(mode)};const kid=randomUUID();const kidTurn=randomUUID();const kidPath=join(process.env.CODEX_HOME,'sessions',kid+'.jsonl');
let ordinal=0;const kidRow=(type,payload)=>JSON.stringify({timestamp:at(),ordinal:ordinal++,type,payload})+'\\n';
const kidMeta={id:kid,session_id:native,parent_thread_id:native,cli_version:'0.160.0',cwd,history_mode:'paginated',source:{subagent:{thread_spawn:{parent_thread_id:native,depth:1}}}};
if(mode==='fork')kidMeta.forked_from_id=native;
writeFileSync(kidPath,kidRow('session_meta',kidMeta));
appendFileSync(kidPath,kidRow('turn_context',{cwd,turn_id:kidTurn,root_turn_id:turn,model:mode==='runtime-mismatch'?'wrong-model':childModel,effort:childEffort,multi_agent_version:'v2',sandbox_policy:{type:'read-only'},approval_policy:'on-request',approvals_reviewer:'auto_review',${permissions}}));
const progress=()=>appendFileSync(path,row('event_msg',{type:'item_completed',thread_id:native,turn_id:turn,item:{type:'SubAgentActivity',kind:'started',id:'spawn-1',agent_thread_id:kid}}));
if(mode==='progress-first')progress();
if(mode!=='missing-child'){
const command=get('hooks.SubagentStart=').match(/command="([^"]+)"/)[1];
const hook=spawnSync('/bin/sh',['-c',command],{input:JSON.stringify({cwd,session_id:native,transcript_path:kidPath,hook_event_name:'SubagentStart',model:childModel,permission_mode:'default',turn_id:kidTurn,agent_id:mode==='missing-id'?undefined:kid,agent_type:'default'})});
if(hook.status!==0)process.exit(4);
if(mode==='extra'){const extra=spawnSync('/bin/sh',['-c',command],{input:JSON.stringify({cwd,session_id:native,transcript_path:kidPath,hook_event_name:'SubagentStart',model:childModel,permission_mode:'default',turn_id:kidTurn,agent_id:randomUUID()})});if(extra.status!==0)process.exit(4);}
appendFileSync(kidPath,kidRow('token_usage_record',{session_id:native,thread_id:kid,turn_id:kidTurn,root_turn_id:turn,response_id:randomUUID(),usage:{input_tokens:10,cached_input_tokens:2,output_tokens:3,reasoning_output_tokens:1,total_tokens:13}}));
}
if(mode!=='progress-first')progress();
if(mode==='completed-activity')appendFileSync(path,row('event_msg',{type:'item_completed',thread_id:native,turn_id:turn,item:{type:'SubAgentActivity',kind:'completed',id:'done-1',agent_thread_id:kid}}));
appendFileSync(path,row('token_usage_record',{session_id:native,thread_id:native,turn_id:turn,root_turn_id:turn,response_id:randomUUID(),usage:{input_tokens:30,cached_input_tokens:5,cache_write_input_tokens:2,output_tokens:3,reasoning_output_tokens:1,total_tokens:33}}));
if(prompt.includes('WAIT'))`
  );
  if (mode.startsWith('native-start')) {
    // Pinned native SessionStartCommandInput omits turn_id and executes before
    // the first turn_context is necessarily available. Child still carries it.
    const initial = script.split('\n').find(line => line.startsWith("appendFileSync(path,row('event_msg',{type:'task_started'"))!;
    script = script
      .replace(initial + '\n', '')
      .replace("appendFileSync(path,row('token_usage_record'", initial + '\n' + "appendFileSync(path,row('token_usage_record'");
    if (mode === 'native-start-missing-task') script = script.replace("appendFileSync(path,row('event_msg',{type:'task_started',turn_id:turn}));", '');
  }
  writeFileSync(f.script, script);
  const execution = { ...f.execution('native-family'), sandbox: 'read-only' as const, child_runtime: { model: 'child-user-choice', effort: 'low' } };
  const run = () =>
    runAssignedWorkflow(f.store, f.input, createSyntheticCodexWorkflowAdapter(f.store, execution, f.script), { model: 'root-user-choice', effort: 'medium' });
  return { ...f, executionFactory: f.execution, execution, run, baseScript, nativeScript: script };
}
