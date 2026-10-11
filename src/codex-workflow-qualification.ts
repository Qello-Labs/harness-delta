import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {constants,closeSync,fstatSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,readSync,realpathSync,readdirSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {z} from 'zod';
import {IdSchema,TaskMetadataSchema} from './contracts.js';
import {RuntimeEvidenceSchema,UsageV2Schema} from './flexible-contracts.js';
import {selectedArtifactSnapshot} from './config-confirmation.js';
import {Lifecycle} from './lifecycle.js';
import {Store} from './store.js';
import {pinnedCodexWorkflowBinarySha,runCodexQualificationPhase,verifyCodexWorkflowStartupContract} from './codex-workflow-adapter.js';
import type {WorkflowAdapterResult,WorkflowExecutionContext} from './task-workflow.js';

const hash=(data:string|Buffer)=>createHash('sha256').update(data).digest('hex');
const sha=z.string().regex(/^[a-f0-9]{64}$/);const path=z.string().startsWith('/').max(4096).refine(v=>!/[\0\r\n]/.test(v));
const inputSchema=z.strictObject({binary:z.strictObject({path,sha256:sha}),codex_home:path,hook_recorder:path,topology:z.enum(['root_resume','root_direct_child']).default('root_resume')});
/** Trusted test seam only; never a command-line flag or a native substitute. */
export interface CodexQualificationTestDependency {fixtureScript:string;durationMs?:number}
const intentSchema=z.strictObject({schema_version:z.literal(1),purpose:z.literal('codex_workflow_qualification'),validation_kind:z.enum(['real_operations','synthetic']),
  topology:z.enum(['root_resume','root_direct_child']),directory:path,cwd:path,database:path,project_id:IdSchema,task_id:IdSchema,generation:z.literal(1),
  binary:inputSchema.shape.binary,codex_home:path,hook_recorder:path,recorder_sha256:sha,node_path:path,node_sha256:sha,
  implementation_digest:sha,fixture_script:path.nullable(),fixture_sha256:sha.nullable(),duration_ms:z.number().int().min(1000).max(180000),
  selected_variant:z.enum(['a','b']),artifacts:z.array(z.strictObject({variant:z.enum(['a','b']),path,manifest_hash:sha})).length(2),
  runtime:z.tuple([z.strictObject({model:z.literal('gpt-6-astra'),effort:z.literal('high')}),z.strictObject({model:z.literal('gpt-6.1-sol'),effort:z.literal('high')})]),
  sandbox:z.literal('read-only'),approval_policy:z.literal('on-request'),approvals_reviewer:z.literal('auto_review'),planned_native_invocations:z.union([z.literal(1),z.literal(2)]),planned_own_responses:z.union([z.literal(2),z.literal(4)]),
  existing_login_only:z.literal(true),provider_verified:z.literal(false),automatic_retry:z.literal(false),hard_billing_bound:z.null(),product_gate_delta:z.literal(false)});
type Intent=z.infer<typeof intentSchema>;
const consentSchema=z.strictObject({intent_sha256:sha,approval_reference:IdSchema,actual_model_run:z.literal(true),transient_harness_hooks:z.literal(true),marker_response_validation:z.literal(true)});
function bytes(file:string,max=2*1024*1024){
  if(realpathSync(file)!==file)throw new Error('unsafe_file');const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const before=fstatSync(fd);if(!before.isFile()||before.size>max)throw new Error('unsafe_file');const b=Buffer.alloc(before.size);let n=0;
    while(n<b.length){const got=readSync(fd,b,n,b.length-n,n);if(!got)throw new Error('short_read');n+=got;}
    const after=fstatSync(fd);if(before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw new Error('unstable_read');return b;
  }finally{closeSync(fd);}
}
function durable(file:string,value:unknown){const fd=openSync(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{writeFileSync(fd,JSON.stringify(value));fsyncSync(fd);}finally{closeSync(fd);}const parent=openSync(dirname(file),constants.O_RDONLY);try{fsyncSync(parent);}finally{closeSync(parent);}}
function implementationDigest(){
  const extension=import.meta.url.endsWith('.ts')?'.ts':'.js';
  const names=['codex-workflow-qualification','codex-workflow-adapter','codex-workflow-journal','codex-candidate-rollout','codex-candidate-permissions','nested-candidate','runtime-history','collection','source-errors','contracts','flexible-contracts','lifecycle','store','config-confirmation'];
  return hash(JSON.stringify(names.map(name=>({name,sha256:hash(readFileSync(new URL(name+extension,import.meta.url)))})).concat([{name:'migration014',sha256:hash(readFileSync(new URL('migrations/014_codex_workflow.sql',import.meta.url)))},{name:'migration015',sha256:hash(readFileSync(new URL('migrations/015_codex_workflow_child.sql',import.meta.url)))},{name:'migration016',sha256:hash(readFileSync(new URL('migrations/016_claude_workflow.sql',import.meta.url)))}])));
}
function verifyIdentity(i:Intent,dependency?:CodexQualificationTestDependency){
  if(i.planned_native_invocations!==(i.topology==='root_direct_child'?1:2)||i.planned_own_responses!==(i.topology==='root_direct_child'?4:2))throw new Error('codex_qualification_invalid_intent');
  if(i.implementation_digest!==implementationDigest()||realpathSync(i.node_path)!==realpathSync(process.execPath)||hash(bytes(i.node_path,256*1024*1024))!==i.node_sha256||
    realpathSync(i.codex_home)!==i.codex_home||realpathSync(join(i.codex_home,'sessions'))!==join(i.codex_home,'sessions')||
    hash(bytes(i.binary.path,256*1024*1024))!==i.binary.sha256||hash(bytes(i.hook_recorder,65536))!==i.recorder_sha256||i.recorder_sha256!=='e20dc70b2864cead9819cbb4f6717164778121b4aef510c820e795eb19835bf0')throw new Error('codex_qualification_invalid_intent');
  if(i.validation_kind==='synthetic'){
    if(!dependency||i.fixture_script!==realpathSync(dependency.fixtureScript)||i.binary.path!==realpathSync(process.execPath)||i.fixture_sha256!==hash(bytes(dependency.fixtureScript))||i.duration_ms!==(dependency.durationMs??180000))throw new Error('codex_qualification_invalid_intent');
  }else if(dependency||i.fixture_script!==null||i.fixture_sha256!==null||i.duration_ms!==180000||i.binary.sha256!==pinnedCodexWorkflowBinarySha||process.platform!=='darwin'||process.arch!=='arm64')throw new Error('codex_qualification_invalid_intent');
}
function intentInstructions(topology:Intent['topology']){return topology==='root_direct_child'?'For LAUNCH: spawn exactly one fresh direct child using model gpt-6.1-sol and effort high. Use fork_turns=none and omit fork_context (V2), or fork_context=false (V1). Give it the LAUNCH marker and ask it to return that marker only. Wait for the child, then return the same marker only.':'';}
/** No product/auth execution. Creates a private qualification store, not a real
 * experiment or a synthetic comparison store containing native data. */
export function prepareCodexWorkflowQualification(directory:string,input:unknown,dependency?:CodexQualificationTestDependency){
  verifyCodexWorkflowStartupContract();
  const config=inputSchema.parse(input);const nodeMajor=Number(process.versions.node.split('.')[0]);
  if(nodeMajor!==24&&(nodeMajor!==26||!dependency))throw new Error('node24_required');
  const nativeNode=realpathSync(process.execPath);const canonicalParent=realpathSync(dirname(directory));if(join(canonicalParent,directory.slice(directory.lastIndexOf('/')+1))!==directory)throw new Error('codex_qualification_invalid_directory');
  const project=`qualification-project-${randomUUID()}`;const task=`qualification-task-${randomUUID()}`;
  const artifacts=['a','b'].map(variant=>({variant:variant as 'a'|'b',path:join(directory,`harness-${variant}.md`),manifest_hash:'0'.repeat(64)}));
  const initial=intentSchema.parse({schema_version:1,purpose:'codex_workflow_qualification',validation_kind:dependency?'synthetic':'real_operations',directory,cwd:join(directory,'fixture'),database:join(directory,'measurement.sqlite'),project_id:project,task_id:task,generation:1,
    ...config,recorder_sha256:hash(bytes(config.hook_recorder,65536)),node_path:nativeNode,node_sha256:hash(bytes(nativeNode,256*1024*1024)),implementation_digest:implementationDigest(),
    fixture_script:dependency?realpathSync(dependency.fixtureScript):null,fixture_sha256:dependency?hash(bytes(dependency.fixtureScript)):null,duration_ms:dependency?.durationMs??180000,
    selected_variant:randomBytes(1)[0]!%2===0?'a':'b',artifacts,runtime:[{model:'gpt-6-astra',effort:'high'},{model:'gpt-6.1-sol',effort:'high'}],sandbox:'read-only',approval_policy:'on-request',approvals_reviewer:'auto_review',planned_native_invocations:config.topology==='root_direct_child'?1:2,planned_own_responses:config.topology==='root_direct_child'?4:2,
    existing_login_only:true,provider_verified:false,automatic_retry:false,hard_billing_bound:null,product_gate_delta:false});
  verifyIdentity(initial,dependency);mkdirSync(directory,{mode:0o700});mkdirSync(initial.cwd,{mode:0o700});
  for(const artifact of initial.artifacts){writeFileSync(artifact.path,intentInstructions(initial.topology)+` Qualification-only harness. ${initial.topology==='root_resume'?'Never use tools, shell, files, agents, retries or background work.':'Only spawn one fresh direct child, wait for it, and return the LAUNCH marker. Never use files, shell, external tools, retries, background work or further children.'} For the LAUNCH task return only QUALIFICATION_LAUNCH=${randomBytes(16).toString('hex')}. For the RESUME task return only QUALIFICATION_RESUME=${randomBytes(16).toString('hex')}. Return just the 32 hex characters, no prefix or explanation.`,{flag:'wx',mode:0o600});
    artifact.manifest_hash=selectedArtifactSnapshot([{artifactId:'qualification-instructions',path:artifact.path}]).hash;}
  closeSync(openSync(initial.database,'wx',0o600));const store=new Store(initial.database);
  const intent= intentSchema.parse(initial);const intentSha=hash(JSON.stringify(intent));
  try{const life=new Lifecycle(store);life.registerProject(project,intent.cwd);life.createTask(project,task,{type:'qualification',expected_size:'small',assignee:'qualification-user',product:'codex',model:'gpt-6-astra',criterion_ids:['marker-and-resume']});life.start(task);
    store.execute('CREATE TABLE codex_workflow_qualification(singleton INTEGER PRIMARY KEY CHECK(singleton=1),intent_sha256 TEXT NOT NULL,project_id TEXT NOT NULL,task_id TEXT NOT NULL,cwd TEXT NOT NULL,codex_home TEXT NOT NULL,binary_path TEXT NOT NULL,binary_sha TEXT NOT NULL,hook_recorder TEXT NOT NULL,manifest_hash TEXT NOT NULL,validation_kind TEXT NOT NULL,fixture_script TEXT,reserved INTEGER NOT NULL DEFAULT 0,deadline INTEGER,phase TEXT,session_id TEXT,topology TEXT NOT NULL,child_session_id TEXT,child_source_path TEXT)',[]);
    store.execute('INSERT INTO codex_workflow_qualification(singleton,intent_sha256,project_id,task_id,cwd,codex_home,binary_path,binary_sha,hook_recorder,manifest_hash,validation_kind,fixture_script,topology) VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?)',[intentSha,project,task,intent.cwd,intent.codex_home,intent.binary.path,intent.binary.sha256,intent.hook_recorder,intent.artifacts.find(a=>a.variant===intent.selected_variant)!.manifest_hash,intent.validation_kind,intent.fixture_script,intent.topology]);
  }finally{store.close();}
  const intentPath=join(directory,'execution-intent.json');durable(intentPath,intent);return {intentPath,sha256:intentSha,intent};
}
function readIntent(file:string,dependency?:CodexQualificationTestDependency){
  try{if((lstatSync(file).mode&0o777)!==0o600)throw new Error('mode');const data=bytes(file,16384);const intent=intentSchema.parse(JSON.parse(data.toString('utf8')));
    if(realpathSync(intent.directory)!==intent.directory||file!==join(intent.directory,'execution-intent.json')||intent.cwd!==join(intent.directory,'fixture')||intent.database!==join(intent.directory,'measurement.sqlite')||
      realpathSync(intent.cwd)!==intent.cwd||realpathSync(intent.database)!==intent.database||intent.artifacts.some(a=>a.path!==join(intent.directory,`harness-${a.variant}.md`))||new Set(intent.artifacts.map(a=>a.variant)).size!==2)throw new Error('scope');
    verifyIdentity(intent,dependency);return {intent,sha256:hash(data)};
  }catch{throw new Error('codex_qualification_invalid_intent');}
}
export interface CodexWorkflowQualificationEvidence {
  status:'completed'|'failed';reason:string|null;topology:'root_resume'|'root_direct_child';validation_kind:'synthetic'|'real_operations';intent_sha256:string;implementation_digest:string;
  project_id:string;task_id:string;selected_variant:string;instruction_manifest_hash:string;
  started_at:string;deadline_at:string;ended_at:string|null;elapsed_ms:number|null;actual_model_usage:'observed_subset'|'unknown';
  native_invocations:number;session_id:string|null;same_session:boolean;marker_verified:boolean[];own_responses:number;replay_insertions:number|null;
  runtime:{model:string|null;effort:string|null;request_id:string|null;session_id:string}[];phases:WorkflowAdapterResult[];
  observed_usage:{event_id:string;session_id:string;payload:z.infer<typeof UsageV2Schema>}[];
  product_gate_delta:false;complete_cost:null;hard_billing_bound:null;limitations:string[];
}
/** EXACT MODEL BOUNDARY: consent is a trusted executor witness, not independent
 * proof of user approval. Obtain explicit approval and execution-policy allowance
 * before calling this default native entry. There is no automatic retry. */
export async function executeCodexWorkflowQualification(file:string,consent:unknown,dependency?:CodexQualificationTestDependency):Promise<CodexWorkflowQualificationEvidence>{
  verifyCodexWorkflowStartupContract();
  const {intent:i,sha256}=readIntent(file,dependency);const approved=consentSchema.safeParse(consent);
  if(!approved.success||approved.data.intent_sha256!==sha256)throw new Error('codex_qualification_consent_required');
  const snapshots=i.artifacts.map(a=>({variant:a.variant,snapshot:selectedArtifactSnapshot([{artifactId:'qualification-instructions',path:a.path}])}));
  if(snapshots.some(s=>s.snapshot.hash!==i.artifacts.find(a=>a.variant===s.variant)!.manifest_hash))throw new Error('codex_qualification_artifact_drift');
  try{durable(join(i.directory,'execution-request.reserved'),approved.data);}catch{throw new Error('codex_qualification_already_reserved');}
  const deadline=Date.now()+i.duration_ms;let store=new Store(i.database);
  const selected=snapshots.find(s=>s.variant===i.selected_variant)!.snapshot;const marker=(phase:string)=>selected.instructions[0]!.content.match(new RegExp(`QUALIFICATION_${phase}=([a-f0-9]{32})`))?.[1];
  const evidence:CodexWorkflowQualificationEvidence={status:'failed',reason:null,topology:i.topology,validation_kind:i.validation_kind,intent_sha256:sha256,implementation_digest:i.implementation_digest,project_id:i.project_id,task_id:i.task_id,selected_variant:i.selected_variant,instruction_manifest_hash:selected.hash,
    started_at:new Date(deadline-i.duration_ms).toISOString(),deadline_at:new Date(deadline).toISOString(),ended_at:null,elapsed_ms:null,actual_model_usage:'unknown',native_invocations:0,session_id:null,same_session:false,marker_verified:[],own_responses:0,replay_insertions:null,runtime:[],observed_usage:[],phases:[],product_gate_delta:false,complete_cost:null,hard_billing_bound:null,
    limitations:['observed_subset_only','native_spawn_does_not_prove_backend_model_call','marker_behavior_is_not_resolved_harness_attestation','provider_requests_tokens_and_cost_not_hard_bounded','source_registry_unchanged','no_complete_cost_or_analysis_admission']};
  const assertActive=()=>{const task=store.get<{state:string;generation:number;project_id:string;metadata:string}>('SELECT * FROM tasks WHERE id=?',[i.task_id]);const project=store.get<{local_root:string}>('SELECT local_root FROM projects WHERE id=?',[i.project_id]);
    if(task?.state!=='active'||task.generation!==i.generation||task.project_id!==i.project_id||project?.local_root!==i.cwd||store.get("SELECT 1 FROM tombstones WHERE (kind='task' AND id=?) OR (kind='project' AND id=?)",[i.task_id,i.project_id])||readdirSync(i.cwd).length!==0)throw new Error('workflow_scope_revoked');
    const metadata=TaskMetadataSchema.parse(JSON.parse(task.metadata));
    if(metadata.product!=='codex'||metadata.model!=='gpt-6-astra'||metadata.type!=='qualification'||metadata.assignee!=='qualification-user')throw new Error('workflow_scope_revoked');
    if(Date.now()>=deadline)throw new Error('deadline');
  };
  try{
    if(store.all('SELECT id FROM projects').length!==1||store.all('SELECT id FROM tasks').length!==1||store.all('SELECT id FROM sessions').length||store.eventCount()||store.all('SELECT id FROM codex_workflow_runs').length)throw new Error('qualification_store_used');
    store.execute('UPDATE codex_workflow_qualification SET reserved=1,deadline=? WHERE singleton=1 AND intent_sha256=? AND reserved=0',[deadline,sha256]);
    const phases=i.topology==='root_direct_child'?['launch','replay']:['launch','resume','replay'];
    for(const [index,phase] of phases.entries()){
      assertActive();if(hash(bytes(file,16384))!==sha256)throw new Error('intent_changed');verifyIdentity(i,dependency);
      const liveSnapshot=selectedArtifactSnapshot([{artifactId:'qualification-instructions',path:i.artifacts.find(a=>a.variant===i.selected_variant)!.path}]);if(liveSnapshot.hash!==selected.hash)throw new Error('artifact_drift');
      store.execute('UPDATE codex_workflow_qualification SET phase=?,session_id=? WHERE singleton=1',[phase,evidence.session_id]);
      const operation=phase==='replay'?'collect':phase as 'launch'|'resume';const runtime=i.runtime[index===0||i.topology==='root_direct_child'?0:1];
      const context:WorkflowExecutionContext={projectId:i.project_id,projectRoot:i.cwd,taskId:i.task_id,generation:i.generation,assignedVariantId:i.selected_variant,confirmationId:`qualification-${phase}`,instructionManifestHash:selected.hash,runtime,instructions:liveSnapshot.instructions,assertActive};
      const prompt=join(i.directory,`prompt-${phase}.txt`);if(phase!=='replay')writeFileSync(prompt,`Qualification ${phase.toUpperCase()}: return only the marker required by the developer instructions. ${i.topology==='root_direct_child'?'Perform only the one direct child and wait required by the developer instructions.':'Use no tools.'}\n`,{mode:0o600,flag:'wx'});
      const expected=phase==='replay'?null:marker(phase.toUpperCase());if(phase!=='replay'&&!expected)throw new Error('marker_missing');
      const directChild=phase==='replay'&&i.topology==='root_direct_child'?store.get<{session_id:string;source_path:string}>('SELECT session_id,source_path FROM codex_workflow_children WHERE run_id=?',['qualification-launch']):undefined;
      const result=await runCodexQualificationPhase(store,{run_id:`qualification-${phase}`,operation,binary:i.binary,codex_home:i.codex_home,hook_recorder:i.hook_recorder,sandbox:i.sandbox,timeout_ms:i.duration_ms,poll_ms:25,...(phase!=='replay'?{prompt_file:prompt}:{}),...(evidence.session_id?{session_id:evidence.session_id}:{}),...(i.topology==='root_direct_child'&&phase==='launch'?{child_runtime:i.runtime[1]}:{}),...(directChild?{direct_child:directChild}:{})},context,{intent_sha256:sha256,deadline,expectedMarker:expected??null,onNativeSpawn:()=>{evidence.native_invocations++;},...(dependency?{fixtureScript:dependency.fixtureScript}:{})});
      evidence.phases.push(result);
      if(phase==='replay'){evidence.replay_insertions=result.observed_requests;if(result.state!=='stopped'||result.reason!=='stop_requested'||result.observed_requests!==0)throw new Error('replay_failed');}
      else{evidence.marker_verified.push(result.marker_verified);evidence.own_responses+=result.observed_requests;if(result.state!=='completed'||!result.marker_verified||(i.topology==='root_resume'?result.observed_requests!==1:result.observed_requests<2||result.observed_requests>4)||!result.session_id)throw new Error(result.reason??'phase_evidence_missing');
        if(phase==='launch'){evidence.session_id=result.session_id;
          if(i.topology==='root_direct_child'){const child=store.get<{session_id:string;source_path:string}>('SELECT session_id,source_path FROM codex_workflow_children WHERE run_id=?',['qualification-launch']);if(!child)throw new Error('child_evidence_missing');store.execute('UPDATE codex_workflow_qualification SET child_session_id=?,child_source_path=? WHERE singleton=1',[child.session_id,child.source_path]);}
        }else evidence.same_session=result.session_id===evidence.session_id;}
      if(phase==='resume'||i.topology==='root_direct_child'&&phase==='launch'){store.close();store=new Store(i.database);}
    }
    if(i.topology==='root_resume'){if(!evidence.same_session||store.eventCount()!==2||store.all('SELECT id FROM runtime_evidence').length!==2)throw new Error('final_evidence_missing');}
    else{if(store.eventCount()!==evidence.own_responses||store.all('SELECT id FROM runtime_evidence').length!==evidence.own_responses||store.all('SELECT id FROM sessions').length!==2||store.all('SELECT id FROM events WHERE session_id IN (SELECT id FROM sessions WHERE parent_id IS NOT NULL)').length!==1)throw new Error('final_evidence_missing');}
    evidence.status='completed';
  }catch{evidence.reason='codex_qualification_failed';}
  finally{
    evidence.runtime=store.all<{payload:string}>('SELECT payload FROM runtime_evidence WHERE task_id=? ORDER BY occurred_at,id',[i.task_id]).map(r=>{const p=RuntimeEvidenceSchema.parse(JSON.parse(r.payload));return {model:p.model,effort:p.effort,request_id:p.request_id,session_id:p.session_id};});
    evidence.observed_usage=store.all<{id:string;session_id:string;payload:string}>('SELECT id,session_id,payload FROM events WHERE task_id=? ORDER BY occurred_at,id',[i.task_id]).map(r=>({event_id:r.id,session_id:r.session_id,payload:UsageV2Schema.parse(JSON.parse(r.payload))}));
    evidence.ended_at=new Date().toISOString();evidence.elapsed_ms=Date.now()-(deadline-i.duration_ms);evidence.actual_model_usage=evidence.observed_usage.length>0?'observed_subset':'unknown';store.close();durable(join(i.directory,'execution-evidence.json'),evidence);
  }
  return evidence;
}
