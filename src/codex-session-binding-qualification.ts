import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import Database from 'better-sqlite3';
import { isDeepStrictEqual } from 'node:util';
import { Store } from './store.js';
import { Lifecycle } from './lifecycle.js';
import { registerVariant, freezeProtocol, comparisonProtocol, protocolRow } from './comparison.js';
import { registerProtocolWithCatalogDefaults } from './price-catalog-selection.js';
import { selectedArtifactSnapshot } from './config-confirmation.js';
import { createLocalWebDomain, LocalWebProfileSchema } from './local-web-domain.js';
import { createLocalWebServer } from './local-web-server.js';
import { codexBindingQualificationVersions, codexBindingQualificationBinarySha, codexBindingQualificationPolicies, codexBindingQualificationCodeModeHost } from './codex-binding-qualification-versions.js';
import { CodexSessionBindingProvider } from './session-binding-codex.js';
import { OwnedCliInvocation, type OwnedCliResult } from './owned-cli-invocation.js';
import { assertBindingQualification, bindingQualificationCompatibility, issueCodexBindingLease, revokeBindingQualification, qualificationBaselineKeys, qualificationRecordedRequests, qualificationRequestKey, qualificationStopReached, qualificationCollectorError, qualificationStopWitness, checkBindingQualificationIdentity, checkBindingQualificationRecord, noteBindingQualificationTransition, noteQualificationCollectorError, type QualificationStopWitness } from './session-binding-qualification-lease.js';
import { assertCompatibilityAllowed, resolveSourceCompatibility, sessionCompatibility } from './source-compatibility.js';
import { getCodexBindingAdmission, isAdmittedCodexBindingProtocol } from './codex-binding-admission.js';
import { setTimeout as delay } from 'node:timers/promises';

const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const path=z.string().startsWith('/').max(4096).refine(v=>!/[\0\r\n]/.test(v));
const sha=z.string().regex(/^[a-f0-9]{64}$/);
const startModeSchema=z.enum(['automatic','manual']);
const routeSchema=z.enum(['qualification','ordinary_admission']);
const productVersionSchema=z.enum(codexBindingQualificationVersions);
const postConnectInput='Spawn exactly two fresh direct children in parallel with gpt-6.1-sol/high and no inherited history. Each child must make no tool calls, return a short acknowledgement in one model request, and finish. Wait once for both children, then return a short acknowledgement. Do no other work, reconnect or spawn other children. Keep this root work turn within three model requests and stop.';
const intentSchema=z.strictObject({schema_version:z.literal(1),purpose:z.literal('codex_ordinary_binding_qualification'),
 route:routeSchema.default('qualification'),ordinary_snapshot_sha256:sha.nullable().default(null),
 product_version:productVersionSchema.default('0.160.0'),
 start_mode:startModeSchema.default('automatic'),
 validation_kind:z.enum(['real_operations','synthetic']),directory:path,project:path,database:path,metadata:path,receipts:path,codex_home:path,
 binary:path,binary_sha256:sha,node:path,node_sha256:sha,python:path,python_sha256:sha,worker:path,worker_sha256:sha,recorder:path,recorder_sha256:sha,package_digest:sha,wrapper:path,wrapper_sha256:sha,implementation_digest:sha,
 connector:path.nullable().default(null),connector_sha256:sha.nullable().default(null),
 code_mode_host:z.strictObject({path,sha256:sha}).nullable().default(null),
 post_connect_input:z.string().max(4096).nullable().default(null),
 task_id:z.string(),project_id:z.literal('qualification-project'),port:z.literal(4319),profile:LocalWebProfileSchema,
 duration_ms:z.number().int().min(100).max(900000),fixture_script:path.nullable(),fixture_sha256:sha.nullable(),
 root_model:z.literal('gpt-6.1-sol'),child_model:z.literal('gpt-6.1-sol'),effort:z.literal('high'),
 planned_roots:z.literal(1),planned_children:z.literal(2),root_request_stop:z.union([z.literal(4),z.literal(5),z.literal(8)]),child_request_stop:z.literal(1),ui_preparation_required:z.boolean(),observed_request_stop:z.union([z.literal(6),z.literal(7),z.literal(10)]),observed_token_stop:z.union([z.literal(100000),z.literal(200000)]),
 helper_network_permission:z.enum(['none','single_command_network_only']).default('none'),
 hard_billing_bound:z.null(),product_gate_delta:z.literal(false)});
type Intent=z.infer<typeof intentSchema>;
function networkQualification(version:Intent['product_version']):boolean{
 return codexBindingQualificationPolicies[version].helperNetworkPermission==='single_command_network_only';
}
/** Trusted Node fixture seam, absent from public CLI. Never accepts native logs. */
export interface BindingQualificationFixture {script:string;durationMs?:number;uiPreparation?:boolean;
 /** Synthetic late rows enter only after owned exit, immediately before projection. */
 beforeFinalSourceCheck?:(native:OwnedCliResult)=>void;
}
function implementationDigest(){
 // Freeze all transitive local implementation bytes and the actual built UI.
 // Source-fixture execution freezes src; the public built CLI freezes dist.
 return hash(JSON.stringify([packageDigest(dirname(fileURLToPath(import.meta.url))),
  packageDigest(realpathSync(fileURLToPath(new URL('../dist/local-ui/',import.meta.url))))]));
}
function privateBytes(file:string,max:number):Buffer {
 if(realpathSync(file)!==file||!lstatSync(file).isFile()||lstatSync(file).size>max)throw new Error('binding_qualification_file_invalid');
 return readFileSync(file);
}
function packageDigest(root:string):string{
 if(realpathSync(root)!==root||!lstatSync(root).isDirectory())throw new Error('binding_qualification_drift');
 const entries:Array<[string,string]>=[];
 function visit(directory:string,relative:string){for(const name of readdirSync(directory).sort()){
  const file=join(directory,name);const rel=relative?relative+'/'+name:name;
  if(lstatSync(file).isDirectory()&&!lstatSync(file).isSymbolicLink())visit(file,rel);
  else entries.push([rel,hash(privateBytes(file,1024*1024))]);
 }}visit(root,'');return hash(JSON.stringify(entries));
}
function quote(value:string){return `'${value.replaceAll("'","'\"'\"'")}'`;}
function ordinarySnapshot(i:Pick<Intent,'metadata'|'profile'|'task_id'>,store:Store):string{
 const metadata=new Database(i.metadata,{readonly:true,fileMustExist:true});
 try{
  const profile=z.object({payload:z.string()}).parse(metadata.prepare('SELECT payload FROM web_profiles WHERE id=?').get(i.profile.id));
  const task=z.object({profile_id:z.string(),setup:z.string()}).parse(metadata.prepare('SELECT profile_id,setup FROM web_tasks WHERE id=?').get(i.task_id));
  const protocolRecord=protocolRow(store,i.profile.setup.workflow.assignment.protocol_id);
   if(protocolRecord.status!=='frozen')throw new Error('binding_qualification_drift');
  const protocol=comparisonProtocol(store,protocolRecord);
   if(profile.payload!==JSON.stringify(i.profile)||task.profile_id!==i.profile.id||protocol.schema_version!==2||!isAdmittedCodexBindingProtocol(protocol))throw new Error('binding_qualification_drift');
  return hash(JSON.stringify([profile,task,protocolRecord.settings]));
 }finally{metadata.close();}
}
function assertOrdinarySnapshot(i:Intent,store:Store){
 if(i.route==='ordinary_admission'&&(ordinarySnapshot(i,store)!==i.ordinary_snapshot_sha256||
  store.get<{intent_hash:string}>('SELECT intent_hash FROM binding_qualification WHERE singleton=1')?.intent_hash!==hash(privateBytes(join(i.directory,'execution-intent.json'),65536))))throw new Error('binding_qualification_drift');
}
function verify(i:Intent,fixture?:BindingQualificationFixture){
 if(!isDeepStrictEqual(i.code_mode_host,!fixture&&i.product_version==='0.163.0'?codexBindingQualificationCodeModeHost(i.binary):null))
  throw new Error('binding_qualification_code_mode_host_invalid');
 if(i.route==='ordinary_admission'){
  const admission=getCodexBindingAdmission(i.product_version);
  if(!admission||i.ordinary_snapshot_sha256===null||
   i.profile.setup.runtime.model!==admission.model||i.profile.setup.runtime.effort!==admission.effort||
   i.profile.execution.sandbox!=='read-only'||i.profile.execution.binary.path!==i.binary||i.profile.execution.binary.sha256!==i.binary_sha256||
   i.profile.execution.codex_home!==i.codex_home||i.profile.execution.hook_recorder!==i.recorder||i.profile.execution.poll_ms!==250||
   !isDeepStrictEqual(i.profile.session_binding,{product:'codex',receipt_directory:i.receipts,source_roots:[join(i.codex_home,'sessions')],project_root:i.project})||
   i.profile.shared_binding!==undefined||i.profile.setup.workflow.application!==undefined)throw new Error('binding_qualification_invalid_intent');
 }else if(i.ordinary_snapshot_sha256!==null)throw new Error('binding_qualification_invalid_intent');
 const policy=codexBindingQualificationPolicies[i.product_version];
 if(i.root_request_stop!==policy.rootRequestStop||i.observed_request_stop!==policy.totalRequestStop||i.observed_token_stop!==policy.tokenStop||i.duration_ms>policy.durationMs||i.profile.execution.timeout_ms!==policy.durationMs||i.helper_network_permission!==policy.helperNetworkPermission)throw new Error('binding_qualification_invalid_intent');
 if(networkQualification(i.product_version)){
  if(i.post_connect_input!==postConnectInput)throw new Error('binding_qualification_invalid_intent');
  if(i.start_mode!=='automatic')throw new Error('binding_qualification_invalid_intent');
  if(i.connector!==join(i.directory,'connect-once.mjs')||i.connector_sha256!==hash(privateBytes(i.connector,65536)))throw new Error('binding_qualification_drift');
 }else if(i.connector!==null||i.connector_sha256!==null||i.post_connect_input!==null)throw new Error('binding_qualification_invalid_intent');
 const nodeMajor=Number(process.versions.node.split('.')[0]);
 if((nodeMajor!==24&&(nodeMajor!==26||i.validation_kind!=='synthetic'))||realpathSync(i.node)!==realpathSync(process.execPath)||
  i.node_sha256!==hash(privateBytes(i.node,256*1024*1024))||i.binary_sha256!==hash(privateBytes(i.binary,256*1024*1024))||
  i.python_sha256!==hash(privateBytes(i.python,256*1024*1024))||i.python!==OwnedCliInvocation.pythonExecutable()||
  i.worker!==realpathSync(fileURLToPath(new URL('../scripts/owned-cli-pty.py',import.meta.url)))||i.worker_sha256!==hash(privateBytes(i.worker,65536))||
  i.recorder!==join(i.directory,'recorder.mjs')||i.recorder_sha256!==hash(privateBytes(i.recorder,65536))||
  i.package_digest!==packageDigest(join(i.project,'.agents/skills/harness-connect'))||
  i.wrapper_sha256!==hash(privateBytes(i.wrapper,4096))||i.implementation_digest!==implementationDigest())throw new Error('binding_qualification_drift');
 if(i.validation_kind==='real_operations'){
  if(fixture||i.binary_sha256!==codexBindingQualificationBinarySha[i.product_version]||i.fixture_script!==null||i.fixture_sha256!==null||i.duration_ms!==policy.durationMs||!i.ui_preparation_required||process.platform!=='darwin'||process.arch!=='arm64')throw new Error('binding_qualification_invalid_intent');
 }else if(!fixture||i.binary!==realpathSync(process.execPath)||i.fixture_script!==realpathSync(fixture.script)||i.fixture_sha256!==hash(privateBytes(fixture.script,65536)))throw new Error('binding_qualification_invalid_fixture');
 for(const [name,file] of [['directory',i.directory],['project',i.project],['database',i.database],['metadata',i.metadata],['receipts',i.receipts],['codex_home',i.codex_home]] as const){
  if(realpathSync(file)!==file||name==='directory'&&(lstatSync(file).mode&0o077)!==0)throw new Error('binding_qualification_layout_invalid');
 }
 if(i.project!==join(i.directory,'project')||i.database!==join(i.directory,'measurement.sqlite')||i.metadata!==join(i.directory,'ui.sqlite')||i.receipts!==join(i.directory,'receipts')||i.wrapper!==join(i.directory,'start-hook'))throw new Error('binding_qualification_layout_invalid');
 if(networkQualification(i.product_version)&&readdirSync(i.project).includes('.codex'))throw new Error('binding_qualification_drift');
 if(i.profile.setup.workflow.product_version!==i.product_version)throw new Error('binding_qualification_invalid_intent');
 if(i.route==='ordinary_admission'){const store=new Store(i.database);try{assertOrdinarySnapshot(i,store);}finally{store.close();}}
}
/** Preparation creates ONLY a fresh disposable project/store and reviewed package;
 * no product/auth execution, original project hook/trust or global config writes.
 */
export async function prepareCodexSessionBindingQualification(directory:string,input:{binary:string;codexHome:string;startMode?:'automatic'|'manual';productVersion?:string;route?:'qualification'|'ordinary_admission'},fixture?:BindingQualificationFixture){
 const nodeMajor=Number(process.versions.node.split('.')[0]);
 if(nodeMajor!==24&&(nodeMajor!==26||!fixture))throw new Error('node24_required');
 const route=routeSchema.parse(input.route??'qualification');
 const startMode=startModeSchema.parse(input.startMode??'automatic');
 const productVersion=productVersionSchema.parse(input.productVersion??'0.160.0');
 const admission=getCodexBindingAdmission(productVersion);
 if(route==='ordinary_admission'&&!admission)throw new Error('binding_qualification_invalid_intent');
 const policy=codexBindingQualificationPolicies[productVersion];
 if(networkQualification(productVersion)&&startMode!=='automatic')throw new Error('binding_qualification_invalid_intent');
 const binary=realpathSync(input.binary);const binarySha=hash(privateBytes(binary,256*1024*1024));
 if(fixture?binary!==realpathSync(process.execPath):binarySha!==codexBindingQualificationBinarySha[productVersion])throw new Error('binding_qualification_binary_mismatch');
 const codeModeHost=!fixture&&productVersion==='0.163.0'?codexBindingQualificationCodeModeHost(binary):null;
 if(resolve(directory)!==directory||realpathSync(dirname(directory))!==dirname(directory))throw new Error('binding_qualification_layout_invalid');
 const home=realpathSync(input.codexHome);realpathSync(join(home,'sessions'));
 mkdirSync(directory,{mode:0o700});const project=join(directory,'project');mkdirSync(project,{mode:0o700});
 const receipts=join(directory,'receipts');mkdirSync(receipts,{mode:0o700});
 const packageSource=fileURLToPath(new URL('../skills/harness-connect',import.meta.url));
 mkdirSync(join(project,'.agents','skills'),{recursive:true});cpSync(packageSource,join(project,'.agents','skills','harness-connect'),{recursive:true,errorOnExist:true,force:false});
 // An empty disposable fixture baseline, not a commit in the user's repository.
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')));
 execFileSync('git',['init','-q',project],{env});execFileSync('git',['-C',project,'-c','user.name=Qualification','-c','user.email=qualification@example.invalid','commit','--allow-empty','-qm','Qualification fixture baseline'],{env});
 const node=realpathSync(process.execPath);const python=OwnedCliInvocation.pythonExecutable();const worker=realpathSync(fileURLToPath(new URL('../scripts/owned-cli-pty.py',import.meta.url)));const wrapper=join(directory,'start-hook');
 const recorder=join(directory,'recorder.mjs');copyFileSync(fileURLToPath(new URL('../scripts/session-binding-codex-hook.mjs',import.meta.url)),recorder);
 const connector=networkQualification(productVersion)?join(directory,'connect-once.mjs'):null;
 if(connector){copyFileSync(fileURLToPath(new URL('../scripts/codex-binding-qualification-connect.mjs',import.meta.url)),connector);chmodSync(connector,0o600);}
 writeFileSync(wrapper,`#!/bin/sh\nexec ${quote(node)} ${quote(recorder)} --receipt-directory ${quote(receipts)} --source-root ${quote(join(home,'sessions'))} --product-version ${quote(productVersion)}\n`,{flag:'wx',mode:0o700});
 const database=join(directory,'measurement.sqlite');writeFileSync(database,'',{flag:'wx',mode:0o600});const store=new Store(database);
 const metadata=join(directory,'ui.sqlite');let domain:ReturnType<typeof createLocalWebDomain>|undefined;
 try{
  new Lifecycle(store).registerProject('qualification-project',project);
  const artifacts=['a','b'].map(arm=>{const file=join(directory,`harness-${arm}.md`);writeFileSync(file,'Qualification only: connect once, use two fresh direct children gpt-6.1-sol/high, then stop. No other work or children.');
   const snapshot=selectedArtifactSnapshot([{artifactId:'instruction',path:file}]);registerVariant(store,{schema_version:2,id:`variant-${arm}`,harness_version:`qualification-${arm}`,instruction_manifest_hash:snapshot.hash,policy_version:'qualification-v1',policy_status:'eligible',runtime_policy:'flexible'});
   return{variant_id:`variant-${arm}`,selected_artifacts:[{artifact_id:'instruction',path:file}]};});
  const now=Date.now();registerProtocolWithCatalogDefaults(store,{schema_version:2,id:'qualification-protocol',project_id:'qualification-project',team_id:'qualification',mode:'randomized_task',purpose:'functional_pilot',protocol_version:'qualification-v1',eligibility_version:'qualification-v1',classification_version:'qualification-v1',participants:['qualification-user'],environment_ids:['qualification-environment'],variant_ids:['variant-a','variant-b'],
   recruitment_start:new Date(now-60000).toISOString(),recruitment_end:new Date(now+86400000).toISOString(),allocation_method:'balanced_blocks',allocation_version:'balanced-blocks-v1',allocation_ratio:[1,1],block_size:4,strata:[{id:'qualification-stratum',assignees:['qualification-user'],types:['qualification'],sizes:['small'],allocator_id:'qualification-allocator'}],primary_metric:'standardized_cost',quality_metric:'criterion_fulfillment',sample_plan:{target_tasks:4,planning_basis_id:'qualification-only'},followup_seconds:networkQualification(productVersion)?policy.durationMs/1000:180,
   stopping_rule:{kind:'fixed_recruitment',version:'qualification-v1'},missingness_policy:{version:'qualification-v1',max_usage_missing_rate:0.1,max_outcome_missing_rate:0.1},deviation_policy:{mismatch:'stop',unknown:'stop',version_drift:'stop'},analysis_plan_version:'not-enabled',sensitivity_plan_ids:['not-enabled'],estimand:'registered_task_mean',runtime_policy:'flexible',source_profiles:[{product:'codex',product_version:productVersion,profile_id:route==='ordinary_admission'&&admission?admission.profileId:'codex-workflow-own-response-v1'}],planning_basis_id:'qualification-only',collaboration_policy_id:'one-root-two-direct-children'});
  freezeProtocol(store,'qualification-protocol',new Date(now-120000).toISOString());
  const profile=LocalWebProfileSchema.parse({id:'qualification-profile',name:'Ordinary binding qualification only',setup:{workflow:{schema_version:1,assignment:{schema_version:2,protocol_id:'qualification-protocol',project_id:'qualification-project',logical_task_id:'qualification-logical',task_id:'qualification-task',metadata:{schema_version:2,type:'qualification',expected_size:'small',assignee:'qualification-user',product:'codex',initial_model:'gpt-6.1-sol',criterion_ids:['observed-parent-child']},environment_id:'qualification-environment',code_base_commit:'0'.repeat(40),allocator_id:'qualification-allocator'},product_version:productVersion,confirmation_id:'qualification-confirmation',artifacts},runtime:{model:'gpt-6.1-sol',effort:'high'},preparation:{schema_version:1,common_artifacts:[],common_manifest_hash:null,allowed_preimage_hashes:[]}},
   execution:{binary:{path:binary,sha256:binarySha},codex_home:home,hook_recorder:recorder,sandbox:'read-only',timeout_ms:policy.durationMs,poll_ms:250},session_binding:{product:'codex',receipt_directory:receipts,source_roots:[join(home,'sessions')],project_root:project}});
  domain=createLocalWebDomain({store,metadataFile:metadata,profiles:[profile]});
  const task=await domain.createTask({name:'Ordinary native binding qualification',project_id:'qualification-project',setup_id:profile.id}) as {id:string};const uiPreparation=!fixture||fixture.uiPreparation===true;if(!uiPreparation)await domain.taskAction(task.id,'apply',{});
  const i=intentSchema.parse({schema_version:1,purpose:'codex_ordinary_binding_qualification',product_version:productVersion,start_mode:startMode,validation_kind:fixture?'synthetic':'real_operations',directory,project,database,metadata,receipts,codex_home:home,binary,binary_sha256:binarySha,node,node_sha256:hash(privateBytes(node,256*1024*1024)),python,python_sha256:hash(privateBytes(python,256*1024*1024)),worker,worker_sha256:hash(privateBytes(worker,65536)),recorder,recorder_sha256:hash(privateBytes(recorder,65536)),package_digest:packageDigest(join(project,'.agents/skills/harness-connect')),wrapper,wrapper_sha256:hash(privateBytes(wrapper,4096)),implementation_digest:implementationDigest(),connector,connector_sha256:connector?hash(privateBytes(connector,65536)):null,post_connect_input:networkQualification(productVersion)?postConnectInput:null,task_id:task.id,project_id:'qualification-project',port:4319,profile,duration_ms:fixture?.durationMs??policy.durationMs,fixture_script:fixture?realpathSync(fixture.script):null,fixture_sha256:fixture?hash(privateBytes(fixture.script,65536)):null,root_model:'gpt-6.1-sol',child_model:'gpt-6.1-sol',effort:'high',planned_roots:1,planned_children:2,root_request_stop:policy.rootRequestStop,child_request_stop:1,ui_preparation_required:uiPreparation,observed_request_stop:policy.totalRequestStop,observed_token_stop:policy.tokenStop,helper_network_permission:policy.helperNetworkPermission,hard_billing_bound:null,product_gate_delta:false});
  store.execute('CREATE TABLE binding_qualification(singleton INTEGER PRIMARY KEY CHECK(singleton=1),task_id TEXT NOT NULL,intent_hash TEXT NOT NULL,reserved INTEGER NOT NULL DEFAULT 0,deadline INTEGER)',[]);
  i.code_mode_host=codeModeHost;
  i.route=route;if(route==='ordinary_admission')i.ordinary_snapshot_sha256=ordinarySnapshot(i,store);
  const data=JSON.stringify(i);store.execute('INSERT INTO binding_qualification(singleton,task_id,intent_hash) VALUES(1,?,?)',[task.id,hash(data)]);
  writeFileSync(join(directory,'execution-intent.json'),data,{flag:'wx',mode:0o600});chmodSync(metadata,0o600);
  return{intentPath:join(directory,'execution-intent.json'),sha256:hash(data),intent:i};
 }finally{await domain?.close?.();store.close();}
}
/** Offline UI preparation only. No native lease, launcher, source reader, picker,
 * extra task, price fetch or connection mutation is exposed by this server. */
export async function serveCodexSessionBindingQualificationUiPreparation(file:string,fixture?:BindingQualificationFixture){
 const data=privateBytes(file,65536);const i=intentSchema.parse(JSON.parse(data.toString('utf8')) as unknown);
 if(file!==join(i.directory,'execution-intent.json')||(lstatSync(file).mode&0o077)!==0||!i.ui_preparation_required)throw new Error('binding_qualification_invalid_intent');verify(i,fixture);
 const store=new Store(i.database);let domain:ReturnType<typeof createLocalWebDomain>|undefined;let app:ReturnType<typeof createLocalWebServer>|undefined;
 try{
  const row=store.get<{reserved:number;intent_hash:string}>('SELECT reserved,intent_hash FROM binding_qualification WHERE singleton=1');
  if(row?.reserved!==0||row.intent_hash!==hash(data))throw new Error('binding_qualification_already_reserved');
  domain=createLocalWebDomain({store,metadataFile:i.metadata,profiles:[i.profile]});const ownedDomain=domain;
  const task=(id:string)=>{
   if(id!==i.task_id)throw new Error('binding_qualification_scope_invalid');
   const dto=z.object({version:z.string(),actions:z.array(z.object({code:z.string(),enabled:z.boolean(),reason:z.string().nullable()}))}).passthrough().parse(ownedDomain.task(id));return{...dto,actions:dto.actions.map(action=>action.code==='apply'?action:{...action,enabled:false,reason:'binding_qualification_prepare_only'})};
  };
  const forbidden=()=>Promise.reject(new Error('binding_qualification_prepare_only'));
  app=createLocalWebServer({origin:`http://127.0.0.1:${i.port}`,metadataFile:i.metadata,uiRoot:fileURLToPath(new URL('../dist/local-ui/',import.meta.url)),domain:{
   metadataStore:store,async bootstrap(){const dto=z.object({tasks:z.array(z.object({id:z.string()}).passthrough())}).passthrough().parse(await ownedDomain.bootstrap());return{...dto,tasks:dto.tasks.map(t=>task(t.id))};},task,
   registerProject:forbidden,createTask:forbidden,refreshPrices:forbidden,chooseDirectory:forbidden,importSetup:forbidden,chooseSession:forbidden,
   async taskAction(id,action,input){if(id!==i.task_id||action!=='apply')throw new Error('binding_qualification_prepare_only');await ownedDomain.taskAction(id,action,input);return task(id);},
   async close(){await ownedDomain.close?.();store.close();},
  }});
  await app.listen({host:'127.0.0.1',port:i.port});const server=app;return{app:server,origin:`http://127.0.0.1:${i.port}`,taskId:i.task_id,close:()=>server.close()};
 }catch(error){if(app)await app.close();else{await domain?.close?.();store.close();}throw error;}
}

/** Source-free results UI, available only after positively verified owned teardown.
 * Human outcome choices cannot launch, reconnect, resume or read any native source. */
export async function serveCodexSessionBindingQualificationResults(file:string,fixture?:BindingQualificationFixture){
 const bytes=privateBytes(file,65536);const i=intentSchema.parse(JSON.parse(bytes.toString('utf8')) as unknown);
 if(file!==join(i.directory,'execution-intent.json'))throw new Error('binding_qualification_layout_invalid');verify(i,fixture);
 const evidence=z.object({intent_sha256:sha,native:z.object({terminationVerified:z.literal(true)})}).parse(JSON.parse(privateBytes(join(i.directory,'evidence.json'),65536).toString('utf8')) as unknown);
 if(evidence.intent_sha256!==hash(bytes))throw new Error('binding_qualification_drift');
 const store=new Store(i.database);let domain:ReturnType<typeof createLocalWebDomain>|undefined;let app:ReturnType<typeof createLocalWebServer>|undefined;
 try{
  const reservation=store.get<{reserved:number;intent_hash:string}>('SELECT reserved,intent_hash FROM binding_qualification WHERE singleton=1');
  if(reservation?.reserved!==1||reservation.intent_hash!==hash(bytes))throw new Error('binding_qualification_scope_invalid');
  domain=createLocalWebDomain({store,metadataFile:i.metadata,profiles:[i.profile]});const owned=domain;
  const permitted=new Set(['finish-success','finish-failed','finish-abandoned']);
  const task=(id:string)=>{if(id!==i.task_id)throw new Error('binding_qualification_scope_invalid');const dto=z.object({version:z.string(),actions:z.array(z.object({code:z.string(),enabled:z.boolean(),reason:z.string().nullable()}))}).passthrough().parse(owned.task(id));return{...dto,actions:dto.actions.map(a=>permitted.has(a.code)?a:{...a,enabled:false,reason:'binding_qualification_results_only'})};};
  const forbidden=()=>Promise.reject(new Error('binding_qualification_results_only'));
  app=createLocalWebServer({origin:`http://127.0.0.1:${i.port}`,metadataFile:i.metadata,uiRoot:fileURLToPath(new URL('../dist/local-ui/',import.meta.url)),domain:{
   metadataStore:store,async bootstrap(){const dto=z.object({tasks:z.array(z.object({id:z.string()}).passthrough())}).passthrough().parse(await owned.bootstrap());return{...dto,tasks:dto.tasks.map(t=>task(t.id))};},task,
   registerProject:forbidden,createTask:forbidden,refreshPrices:forbidden,chooseDirectory:forbidden,importSetup:forbidden,chooseSession:forbidden,
   async taskAction(id,action,input){if(id!==i.task_id||!permitted.has(action))throw new Error('binding_qualification_results_only');await owned.taskAction(id,action,input);return task(id);},
   async close(){await owned.close?.();store.close();},
  }});await app.listen({host:'127.0.0.1',port:i.port});const server=app;return{app:server,origin:`http://127.0.0.1:${i.port}`,taskId:i.task_id,close:()=>server.close()};
 }catch(error){if(app)await app.close();else{await domain?.close?.();store.close();}throw error;}
}

export function codexBindingQualificationArgv(i:Intent):string[]{
 let networkInstruction='';
 if(networkQualification(i.product_version)){
  if(i.start_mode!=='automatic'||i.connector===null)throw new Error('binding_qualification_invalid_intent');
  networkInstruction=`Run only ${quote(i.node)} ${quote(i.connector)} --receipt followed by the actual current hook receipt in one exec_command, with no chained commands. Request sandbox_permissions="with_additional_permissions" and additional_permissions={"network":{"enabled":true}} only for that command. Do not request file_system permissions, require_escalated, a prefix rule or a turn/session grant. If permission, inspect or connection is denied, unavailable or blocked, stop without retrying or spawning children. `;
 }
 const args=['--cd',i.project,'--model',i.root_model,'--sandbox','read-only','-c','approval_policy="on-request"','-c','model_reasoning_effort="high"','-c','agents.enabled=true','-c','agents.default_subagent_model="gpt-6.1-sol"','-c','agents.default_subagent_reasoning_effort="high"','-c','agents.max_depth=1'];const states:string[]=[];
 // Inline tables keep project paths out of Codex's literal dotted-key parser.
 if(networkQualification(i.product_version))args.push('--no-daemon','--enable','exec_permission_approvals','-c',`projects={${JSON.stringify(i.project)}={trust_level="trusted"}}`,'-c','tui.notifications=["approval-requested","agent-turn-complete"]','-c','tui.notification_method="osc9"','-c','tui.notification_condition="always"');
 for(const[event,label]of[['SessionStart','session_start'],['SubagentStart','subagent_start']]as const){
  args.push('-c',`hooks.${event}=[{hooks=[{type="command",command=${JSON.stringify(i.wrapper)},timeout=5}]}]`);
  const trusted=hash(JSON.stringify({event_name:label,hooks:[{async:false,command:i.wrapper,timeout:5,type:'command'}]}));states.push(`"/<session-flags>/config.toml:${label}:0:0"={trusted_hash="sha256:${trusted}"}`);
 }
 args.push('-c',`hooks.state={${states.join(',')}}`);
 // Ordinary TUI startup input: avoid unconfirmed pasted composer submission.
 // Its exact bounded instructions are frozen with this implementation.
 if(i.start_mode==='automatic')args.push(`$harness-connect Connect once to project qualification-project, task ${i.task_id}, at http://127.0.0.1:4319 using the current hook-provided receipt. ${networkInstruction}${networkQualification(i.product_version)?'After successful connection, return a short connection acknowledgement and stop this turn. Do not spawn children or do other work until the separately approved post-connect input. Keep this connection turn within three model requests.':'Then spawn exactly two fresh direct children with gpt-6.1-sol/high and no inherited history. Each child must make no tool calls, return a short acknowledgement in one model request, and finish. Wait once for both children. Do no other work. Keep the root within four model requests and stop.'}`);return args;
}

const taskSchema=z.object({binding:z.object({roots:z.number(),children:z.number(),requests:z.number(),gaps:z.array(z.string()),sessions:z.array(z.object({session_id:z.string()}))}),measurement:z.object({state:z.string()})});
function qualificationTask(domain:ReturnType<typeof createLocalWebDomain>,id:string){return taskSchema.parse(domain.task(id));}
async function independentSourceCheck(i:Intent,store:Store,lease:ReturnType<typeof issueCodexBindingLease>){
 // Active scope, exact three newly linked sources only; never scan native history.
 const initial = new Lifecycle(store).task(i.task_id);
 const active = () => { assertOrdinarySnapshot(i,store);if(i.route==='ordinary_admission')assertBindingQualification(lease,store,i.task_id);const current=new Lifecycle(store).task(i.task_id); if(current.state!=='active'||current.generation!==initial.generation)throw new Error('binding_qualification_scope_revoked'); }; active();
 const provider=new CodexSessionBindingProvider({receiptDirectory:i.receipts,sourceRoots:[join(i.codex_home,'sessions')],projectRoot:i.project,productVersion:i.product_version,maxDepth:1,maxFamilyMembers:3,
  ...(i.route==='ordinary_admission'?{ordinaryFamilyAdmission:true}:networkQualification(i.product_version)?{ordinaryFamilyQualification:true}:{})});
 const identities=store.all<{identity:string}>('SELECT identity FROM session_bindings WHERE task_id=?',[i.task_id]).map(r=>JSON.parse(r.identity) as import('./session-binding-contract.js').VerifiedSessionIdentity);
 const root=identities.find(r=>r.parentSessionId===null);
 if(!root||identities.length!==3||identities.filter(r=>r.parentSessionId===root.sessionId).length!==2)throw new Error('binding_qualification_family_limit');
 const compatibility=i.route==='ordinary_admission'?resolveSourceCompatibility('codex',i.product_version,'codex_binding',getCodexBindingAdmission(i.product_version)?.profileId):bindingQualificationCompatibility(lease);
 if(compatibility)assertCompatibilityAllowed(store,compatibility);
 for(const identity of identities)if(!isDeepStrictEqual(sessionCompatibility(store,identity.sessionId),compatibility))throw new Error('binding_qualification_counter_mismatch');
 const scope={projectId:i.project_id,taskId:i.task_id,allowedRootTurnIds:['qualification'],sessions:identities.map(v=>({sessionId:v.sessionId,rootSessionId:root.sessionId,parentSessionId:v.parentSessionId,sourceId:v.sessionId,product:v.product,nativeSessionId:v.sessionId,processId:null,agentId:null}))};
 const records:import('./session-binding-contract.js').BindingUsageRecord[]=[];
 for(const identity of identities){
  active(); if(JSON.stringify(await provider.resolveCurrent({receipt:identity.identityEvidenceId}))!==JSON.stringify(identity))throw new Error('binding_qualification_source_changed');
  active(); const family=await provider.discoverChildren(identity);
  active();
  if(family.gaps.length||family.children.some(c=>!identities.some(v=>JSON.stringify(v)===JSON.stringify(c.identity))))throw new Error('binding_qualification_family_limit');
  active(); const batch=await provider.readUsage(identity,null,scope,{baseline:false});
  active(); if(batch.gaps.length)throw new Error('binding_qualification_final_gap');records.push(...batch.records);
 }
 const byKey=new Map<string,import('./session-binding-contract.js').BindingUsageRecord>();
 for(const record of records){
  if(record.payload.model!==i.root_model||record.effort!==i.effort||record.payload.input_total.status!=='observed'||record.payload.output_total.status!=='observed')throw new Error('binding_qualification_runtime_invalid');
  const key=qualificationRequestKey(record);if(byKey.has(key))throw new Error('binding_qualification_request_conflict');byKey.set(key,record);
 }
 if(records.length>i.observed_request_stop||records.filter(r=>r.sessionId===root.sessionId).length>i.root_request_stop||identities.filter(v=>v.parentSessionId!==null).some(v=>records.filter(r=>r.sessionId===v.sessionId).length>1))throw new Error('binding_qualification_request_limit');
 if(records.reduce((n,r)=>n+(r.payload.input_total.value??0)+(r.payload.output_total.value??0),0)>i.observed_token_stop)throw new Error('binding_qualification_token_limit');
 const observed=store.all<{request_key:string;payload:string}>('SELECT r.request_key,e.payload FROM binding_requests r JOIN events e ON e.id=r.event_id WHERE e.task_id=?',[i.task_id]);
 const baseline=qualificationBaselineKeys(lease);
 for(const [key,record] of qualificationRecordedRequests(lease)){if(!isDeepStrictEqual(byKey.get(key),record))throw new Error('binding_qualification_counter_mismatch');}
 const covered=new Set<string>(baseline);
 for(const row of observed){const native=byKey.get(row.request_key);const{runtime_evidence_id:runtimeId,...payload}=JSON.parse(row.payload) as Record<string,unknown>;void runtimeId;
  if(!native||!isDeepStrictEqual({...native.payload,...(compatibility?{source_compatibility:compatibility}:{})},payload))throw new Error('binding_qualification_counter_mismatch');covered.add(row.request_key);}
 if([...byKey.keys()].some(key=>!covered.has(key))||[...baseline].some(key=>!byKey.has(key)))throw new Error('binding_qualification_final_unobserved_request');
 return{sources:identities.length,observed_request_matches:observed.length,native_owned_requests:records.length,excluded_baseline_requests:baseline.size,scope:'exact_new_linked_sources',complete_cost:false};
}

/** Paid boundary: explicit trusted consent witness plus frozen intent. No automatic
 * retry and no synthetic CLI flag. Interactive TTY is required for native mode.
 */
export async function executeCodexSessionBindingQualification(file:string,consent:unknown,fixture?:BindingQualificationFixture){
 const data=privateBytes(file,65536);if((lstatSync(file).mode&0o077)!==0)throw new Error('binding_qualification_file_invalid');
 const i=intentSchema.parse(JSON.parse(data.toString('utf8')) as unknown);if(file!==join(i.directory,'execution-intent.json'))throw new Error('binding_qualification_layout_invalid');verify(i,fixture);
 const approved=z.strictObject({intent_sha256:sha,approval_reference:z.string().min(1).max(128),actual_model_run:z.literal(true),transient_hooks:z.literal(true),native_source_reads:z.literal(true),owned_process_termination:z.literal(true),network_command_permission:z.literal(true).optional()}).parse(consent);
 if(approved.intent_sha256!==hash(data)||i.helper_network_permission==='single_command_network_only'&&approved.network_command_permission!==true)throw new Error('binding_qualification_consent_required');
 if(networkQualification(i.product_version)&&readdirSync(i.directory).includes('native-attention.json'))throw new Error('binding_qualification_attention_exists');
 if(!fixture&&(!process.stdin.isTTY||!process.stdout.isTTY))throw new Error('owned_cli_terminal_required');
 const preparationStore=new Store(i.database);try{if(preparationStore.get<{state:string}>('SELECT state FROM external_preparations WHERE task_id=?',[i.task_id])?.state!=='configuration_verified')throw new Error('binding_qualification_ui_preparation_required');}finally{preparationStore.close();}
 writeFileSync(join(i.directory,'execution.reserved'),JSON.stringify(approved),{flag:'wx',mode:0o600});
 const store=new Store(i.database);const deadline=Date.now()+i.duration_ms;
 let attentionCount=0;
 const onTerminalAttention=networkQualification(i.product_version)?()=>{
  attentionCount++;
  try{writeFileSync(join(i.directory,'native-attention.json'),JSON.stringify({schema_version:1,event:'native_terminal_attention',intent_sha256:hash(data),notification_count:attentionCount}),{flag:attentionCount===1?'wx':'w',mode:0o600});}
  catch{reason??='binding_qualification_attention_failed';firstDiagnostic??={stage:'owner_run',code:'binding_qualification_attention_failed'};owner.stop();}
 }:undefined;
 const owner=new OwnedCliInvocation({command:i.binary,args:fixture?[fixture.script]:codexBindingQualificationArgv(i),cwd:i.project,pythonExecutable:i.python,durationMs:i.duration_ms,stdio:fixture?'ignore':'inherit',env:{...process.env,CODEX_HOME:i.codex_home,HARNESS_BINDING_TEST_INTENT:fixture?file:undefined},termGraceMs:fixture?100:2000,...(onTerminalAttention?{onTerminalAttention}:{})});
 let domain:ReturnType<typeof createLocalWebDomain>|undefined;let app:ReturnType<typeof createLocalWebServer>|undefined;let native:OwnedCliResult|undefined;let lease:ReturnType<typeof issueCodexBindingLease>|undefined;let reason:string|null=null;let state:unknown=null;let owned:Promise<OwnedCliResult>|undefined;let independent:unknown=null;let phase='reservation';
 let observerStopReason:'binding_qualification_deadline_reached'|'binding_qualification_observer_stopped'|'binding_qualification_observer_failed'|null=null;
 let stopWitness:QualificationStopWitness|null=null;
 const diagnosticCodes=['clock_regression','invalid_gap','binding_qualification_revoked','binding_qualification_scope_revoked','binding_qualification_scope_invalid','binding_qualification_already_reserved','ui_setup_conflict','binding_qualification_counter_mismatch','binding_qualification_source_changed','binding_qualification_family_limit','binding_qualification_final_gap','binding_qualification_runtime_invalid','binding_qualification_request_limit','binding_qualification_token_limit','binding_qualification_request_conflict','binding_qualification_final_unobserved_request','owned_cli_termination_unverified'] as const;
 type DiagnosticStage='reservation'|'lease'|'domain'|'receiver'|'owner_run'|'lease_assertion'|'task_snapshot'|'binding_check'|'safety_check'|'deadline'|'final_snapshot'|'source_check'|'termination'|'domain_close'|'receiver_close';
 let diagnosticStage:DiagnosticStage='reservation';
 let firstDiagnostic:{stage:DiagnosticStage|'collector';code:string}|null=null;
 const noteDiagnostic=(stage:DiagnosticStage,error:unknown)=>{firstDiagnostic??={stage,code:diagnosticCodes.find(code=>error instanceof Error&&error.message===code)??'unknown_error'};};
 const noteCollectorDiagnostic=()=>{const code=qualificationCollectorError(lease);if(code)firstDiagnostic??={stage:'collector',code};};
 const stopObserver=(code:NonNullable<typeof observerStopReason>,predicate:QualificationStopWitness['predicate'])=>{stopWitness??=qualificationStopWitness(lease,predicate);observerStopReason??=code;reason??=code;firstDiagnostic??={stage:predicate==='deadline'?'deadline':predicate==='safety_limit'?'safety_check':'binding_check',code};owner.stop();};
 const interrupt=()=>{stopWitness??=qualificationStopWitness(lease,'interrupted');owner.stop();};process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
 try{
  const row=store.get<{intent_hash:string;reserved:number}>('SELECT intent_hash,reserved FROM binding_qualification WHERE singleton=1');if(row?.intent_hash!==hash(data)||row.reserved!==0)throw new Error('binding_qualification_already_reserved');
  store.execute('UPDATE binding_qualification SET reserved=1,deadline=? WHERE singleton=1',[deadline]);phase='lease';diagnosticStage='lease';lease=issueCodexBindingLease(store,i.task_id,owner,deadline);
  const safetyLease=lease;
  phase='domain';diagnosticStage='domain';domain=createLocalWebDomain({store,metadataFile:i.metadata,profiles:[i.profile],
   ...(i.route==='ordinary_admission'?{bindingObservation:{
    identity(taskId,identity){assertOrdinarySnapshot(i,store);checkBindingQualificationIdentity(safetyLease,store,taskId,identity,true);},
    record(taskId,record,excluded){assertOrdinarySnapshot(i,store);checkBindingQualificationRecord(safetyLease,store,taskId,record,excluded);},
    transition(taskId){assertOrdinarySnapshot(i,store);noteBindingQualificationTransition(safetyLease,store,taskId);},
    error(error){noteQualificationCollectorError(safetyLease,error);owner.stop();},
   }}:{qualificationLease:safetyLease})});
  const ownedDomain=domain;
  const allowedActions=new Set(['session-connect','pause','resume-binding','emergency-stop']);
  const scopedTask=(id:string)=>{
   if(id!==i.task_id)throw new Error('binding_qualification_scope_invalid');
   assertOrdinarySnapshot(i,store);
   const dto=z.object({version:z.string(),actions:z.array(z.object({code:z.string(),enabled:z.boolean(),reason:z.string().nullable()}))}).passthrough().parse(ownedDomain.task(id));
   return{...dto,actions:dto.actions.map(action=>action.code==='emergency-stop'?{...action,enabled:owner.isAlive(),reason:owner.isAlive()?null:'owned_native_inactive'}:allowedActions.has(action.code)?action:{...action,enabled:false,reason:'binding_qualification_control_only'})};
  };
  const forbidden=()=>Promise.reject(new Error('binding_qualification_control_only'));
  const serverDomain=i.route==='ordinary_admission'?{
   metadataStore:store,
   async bootstrap(){const dto=z.object({tasks:z.array(z.object({id:z.string()}).passthrough())}).passthrough().parse(await ownedDomain.bootstrap());return{...dto,tasks:dto.tasks.map(task=>scopedTask(task.id))};},task:scopedTask,
   registerProject:forbidden,createTask:forbidden,refreshPrices:forbidden,chooseDirectory:forbidden,importSetup:forbidden,chooseSession:forbidden,
   bindSetup:forbidden,reviewSetup:forbidden,saveReviewedSetup:forbidden,applicationWorkspace:forbidden,applicationContext:forbidden,applicationLaunchContext:forbidden,applicationHandoff:forbidden,applicationReview:forbidden,
   async taskAction(id:string,action:string,input:Record<string,unknown>){
    if(id!==i.task_id||!allowedActions.has(action))throw new Error('binding_qualification_control_only');
    assertOrdinarySnapshot(i,store);
    if(action==='emergency-stop'){revokeBindingQualification(safetyLease);await ownedDomain.taskAction(id,'pause',{});}
    else {
     const result=z.record(z.string(),z.unknown()).parse(await ownedDomain.taskAction(id,action,input));
     return{...scopedTask(id),...('connection'in result?{connection:result.connection}:{})};
    }
    return scopedTask(id);
   },
  }:ownedDomain;
  phase='receiver';diagnosticStage='receiver';app=createLocalWebServer({origin:`http://127.0.0.1:${i.port}`,domain:serverDomain,metadataFile:i.metadata,uiRoot:fileURLToPath(new URL('../dist/local-ui/',import.meta.url))});app.addHook('onClose',()=>{owner.stop();});await app.listen({host:'127.0.0.1',port:i.port});
  phase='process';diagnosticStage='owner_run';const ownerDone=owner.run();owned=ownerDone;
  const monitor=(async()=>{while(owner.isAlive()||Date.now()<deadline&&native===undefined){
   if(owner.isAlive()){
    noteCollectorDiagnostic();let monitorStage:DiagnosticStage='lease_assertion';
    if(Date.now()>=deadline)stopObserver('binding_qualification_deadline_reached','deadline');
    else try{assertOrdinarySnapshot(i,store);assertBindingQualification(lease,store,i.task_id);monitorStage='task_snapshot';const task=qualificationTask(ownedDomain,i.task_id);monitorStage='binding_check';
     if(task.binding.gaps.some(g=>g!=='unobserved_interval'&&g!=='binding_unobserved_context'))stopObserver('binding_qualification_observer_stopped','binding_gap');
     else if(task.binding.roots>1||task.binding.children>2)stopObserver('binding_qualification_observer_stopped','family_limit');
     else{monitorStage='safety_check';if(qualificationStopReached(lease))stopObserver('binding_qualification_observer_stopped','safety_limit');}
    }catch(error){noteDiagnostic(monitorStage,error);stopObserver(Date.now()>=deadline?'binding_qualification_deadline_reached':'binding_qualification_observer_failed',Date.now()>=deadline?'deadline':'lease_invalid');}
   }
   await delay(25);
  }})();
  native=await ownerDone;await monitor;noteCollectorDiagnostic();diagnosticStage='final_snapshot';state=qualificationTask(domain,i.task_id).binding;
  if(!native.terminationVerified)reason='owned_cli_termination_unverified';
  else if(native.status!=='completed'){reason??=native.terminationCause==='deadline'?'binding_qualification_deadline_reached':'binding_qualification_native_stopped';if(new Lifecycle(store).task(i.task_id).state==='paused')independent={safety_usage_verification:'unverified',reason:'task_paused_no_source_read',complete_cost:false};}
  else if(new Lifecycle(store).task(i.task_id).state==='paused'){reason='binding_qualification_safety_usage_unverified';independent={safety_usage_verification:'unverified',reason:'task_paused_no_source_read',complete_cost:false};}
  else{const binding=qualificationTask(domain,i.task_id).binding;const requests=store.all<{session_id:string}>('SELECT e.session_id FROM binding_requests r JOIN events e ON e.id=r.event_id WHERE e.task_id=?',[i.task_id]);
   if(binding.roots!==1||binding.children!==2||binding.gaps.some(g=>g!=='unobserved_interval'&&g!=='binding_unobserved_context')||binding.sessions.some(s=>!requests.some(r=>r.session_id===s.session_id)))reason='binding_qualification_evidence_incomplete';
   else{phase='source_check';diagnosticStage='source_check';fixture?.beforeFinalSourceCheck?.(native);independent=await independentSourceCheck(i,store,lease);}}
 }catch(error){noteCollectorDiagnostic();noteDiagnostic(diagnosticStage,error);const known=['binding_qualification_scope_revoked','binding_qualification_scope_invalid','binding_qualification_already_reserved','ui_setup_conflict','binding_qualification_counter_mismatch','binding_qualification_source_changed','binding_qualification_family_limit','binding_qualification_final_gap','binding_qualification_runtime_invalid','binding_qualification_request_limit','binding_qualification_token_limit','binding_qualification_request_conflict','binding_qualification_final_unobserved_request'];reason??=error instanceof Error&&known.includes(error.message)?error.message:'binding_qualification_execution_failed';owner.stop();}
 finally{owner.stop();noteCollectorDiagnostic();if(owned)try{native=await owned;}catch(error){noteCollectorDiagnostic();noteDiagnostic('termination',error);reason='owned_cli_termination_unverified';}noteCollectorDiagnostic();if(native&&!native.terminationVerified){firstDiagnostic??={stage:'termination',code:'owned_cli_termination_unverified'};reason='owned_cli_termination_unverified';}if(lease)revokeBindingQualification(lease);
  try{await domain?.close?.();}catch(error){noteDiagnostic('domain_close',error);reason??='binding_qualification_execution_failed';}
  try{await app?.close();}catch(error){noteDiagnostic('receiver_close',error);reason??='binding_qualification_execution_failed';}
  store.close();process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);}
 const result={route:i.route,ordinary_admission_verified:i.route==='ordinary_admission'&&reason===null&&independent!==null&&typeof independent==='object'&&'sources' in independent,safety_usage_verification:independent&&typeof independent==='object'&&'sources' in independent?'verified':'unverified',status:reason?'failed':'completed',reason,first_diagnostic:firstDiagnostic,observer_stop_reason:observerStopReason,stop_witness:stopWitness,collector_error:qualificationCollectorError(lease),phase,validation_kind:i.validation_kind,start_mode:i.start_mode,intent_sha256:hash(data),native:native??null,binding:state,independent_source_check:independent,product_gate_delta:false,complete_cost:null,hard_billing_bound:null};
 const outcome={...result,ordinary_path_verified:result.ordinary_admission_verified,
  ordinary_admission_verified:result.ordinary_admission_verified&&i.validation_kind==='real_operations'};
 writeFileSync(join(i.directory,'evidence.json'),JSON.stringify(outcome),{flag:'wx',mode:0o600});return outcome;
}
