import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { comparisonProtocol, protocolRow } from './comparison.js';
import { parseTaskMetadata } from './flexible-contracts.js';
import { Lifecycle } from './lifecycle.js';
import type { Store } from './store.js';
import type { VerifiedSessionIdentity, BindingUsageRecord } from './session-binding-contract.js';
import type { OwnedCliInvocation } from './owned-cli-invocation.js';
import { resolveSourceCompatibility } from './source-compatibility.js';
import { codexBindingQualificationPolicies, codexBindingQualificationVersions } from './codex-binding-qualification-versions.js';

/** Opaque, process-local native qualification capability. No browser/profile flag. */
export interface BindingQualificationLease { readonly qualificationOnly: true }
const collectorErrors=['clock_regression','invalid_gap','binding_qualification_revoked','binding_qualification_scope_invalid','binding_qualification_identity_invalid','binding_qualification_family_limit','binding_qualification_runtime_invalid','binding_qualification_request_conflict','binding_qualification_request_limit','binding_qualification_token_limit','binding_scope_revoked','external_window_closed','binding_source_changed','binding_source_unavailable','binding_identity_unavailable','binding_ancestry_unverified','binding_usage_incomplete','candidate_invalid_metadata'] as const;
export type QualificationCollectorError=typeof collectorErrors[number]|'unknown_collector_error';
interface State { store: Store; taskId: string; root: string; productVersion: (typeof codexBindingQualificationVersions)[number]; owner: OwnedCliInvocation; deadline: number; issuedAt: number; generation: number; taskState: string;
 rootId: string|null; childIds: Set<string>; arm: string; pricePin: string; revoked: boolean; requests: Map<string,BindingUsageRecord>; baseline: Set<string>; collectorError:QualificationCollectorError|null; limitWitness:QualificationStopWitness|null }
type LimitPredicate='root_request_limit'|'child_request_limit'|'total_request_limit'|'token_limit';
export interface QualificationStopWitness {
 predicate:'safety_limit'|'collector_limit'|'binding_gap'|'family_limit'|'lease_invalid'|'deadline'|'interrupted';
 safety:{root_requests:number;children:{session_id:string;requests:number;excluded_baseline_requests:number}[];total_requests:number;excluded_baseline_requests:number;input_output_tokens:number;reached:LimitPredicate[]}|null;
 attempted:{session_id:string;own_requests:number;total_requests:number;input_output_tokens:number;excluded_baseline:boolean;reached:LimitPredicate[]}|null;
}
const leases=new WeakMap<BindingQualificationLease,State>();
/** Internal executor seam: only an isolated, consumed qualification intent may issue.
 * Native and synthetic control attempts use different fresh stores and reserved intents.
 */
export function issueCodexBindingLease(store: Store, taskId: string, owner: OwnedCliInvocation, deadline: number): BindingQualificationLease {
 const task=new Lifecycle(store).task(taskId);
 const reservation=store.get<{task_id:string;deadline:number;reserved:number}>('SELECT task_id,deadline,reserved FROM binding_qualification WHERE singleton=1');
 const assignment=store.get<{variant_id:string;protocol_id:string}>('SELECT variant_id,protocol_id FROM comparison_assignments WHERE task_id=?',[taskId]);
 const root=store.get<{local_root:string}>('SELECT local_root FROM projects WHERE id=?',[task.project_id])?.local_root;
 if(!reservation||reservation.task_id!==taskId||reservation.reserved!==1||reservation.deadline!==deadline||!root||!assignment||
  parseTaskMetadata(JSON.parse(task.metadata) as unknown).product!=='codex'||comparisonProtocol(store,protocolRow(store,assignment.protocol_id)).purpose!=='functional_pilot'||
  store.all('SELECT id FROM tasks').length!==1||store.all('SELECT id FROM projects').length!==1||store.all('SELECT id FROM sessions').length||store.eventCount())throw new Error('binding_qualification_scope_invalid');
 const protocol=comparisonProtocol(store,protocolRow(store,assignment.protocol_id));
 if(protocol.schema_version!==2||protocol.source_profiles.length!==1||protocol.source_profiles[0]?.product!=='codex')throw new Error('binding_qualification_scope_invalid');
 const productVersion=protocol.source_profiles[0].product_version;
 if(productVersion!=='0.160.0'&&productVersion!=='0.162.1')throw new Error('binding_qualification_scope_invalid');
 const lease=Object.freeze({qualificationOnly:true as const});
 leases.set(lease,{store,taskId,root:realpathSync(root),productVersion,owner,deadline,issuedAt:Date.now(),generation:task.generation,taskState:task.state,rootId:null,childIds:new Set(),arm:assignment.variant_id,pricePin:protocol.price_table_id,revoked:false,requests:new Map(),baseline:new Set(),collectorError:null,limitWitness:null});
 return lease;
}
/** Private diagnostic only: first fixed code, never error text/stack/content. */
export function noteQualificationCollectorError(lease:BindingQualificationLease,error:unknown):void {
 const state=leases.get(lease);if(!state||state.collectorError!==null)return;
 state.collectorError=collectorErrors.find(code=>error instanceof Error&&error.message===code)??'unknown_collector_error';
}
export function qualificationCollectorError(lease:BindingQualificationLease|undefined):QualificationCollectorError|null{return lease?leases.get(lease)?.collectorError??null:null;}
export function revokeBindingQualification(lease: BindingQualificationLease): void {const state=leases.get(lease);if(state){state.revoked=true;state.owner.stop();}}
export function assertBindingQualification(lease: BindingQualificationLease|undefined, store: Store, taskId: string): boolean {
 if(!lease)return false;const s=leases.get(lease);
 if(!s||s.store!==store||s.taskId!==taskId||s.revoked||!s.owner.hasSpawned()||s.owner.stopRequested()||Date.now()>=s.deadline)throw new Error('binding_qualification_revoked');
 const task=new Lifecycle(store).task(taskId);const assignment=store.get<{variant_id:string;protocol_id:string}>('SELECT variant_id,protocol_id FROM comparison_assignments WHERE task_id=?',[taskId]);
 const root=store.get<{local_root:string}>('SELECT local_root FROM projects WHERE id=?',[task.project_id])?.local_root;
 if(!assignment||assignment.variant_id!==s.arm||root!==s.root||realpathSync(root)!==s.root||
  !['registered','active','paused'].includes(task.state)||task.generation!==s.generation||task.state!==s.taskState||
  parseTaskMetadata(JSON.parse(task.metadata) as unknown).product!=='codex'||store.all('SELECT id FROM tasks').length!==1||store.all('SELECT id FROM projects').length!==1||
  store.get("SELECT 1 FROM tombstones WHERE (kind='task' AND id=?) OR (kind='project' AND id=?)",[taskId,task.project_id]))throw new Error('binding_qualification_revoked');
 const protocol=comparisonProtocol(store,protocolRow(store,assignment.protocol_id));
 if(protocol.schema_version!==2||protocol.price_table_id!==s.pricePin||protocol.purpose!=='functional_pilot'||
  protocol.source_profiles.length!==1||protocol.source_profiles[0]?.product!=='codex'||protocol.source_profiles[0].product_version!==s.productVersion)throw new Error('binding_qualification_revoked');
 return true;
}
export function bindingQualificationCompatibility(lease: BindingQualificationLease | undefined) {
 if(!lease)return null;
 const version=leases.get(lease)?.productVersion;
 return version==='0.162.1'?resolveSourceCompatibility('codex',version,'codex_workflow','codex-workflow-own-response-v1'):null;
}
/** Called synchronously after a lifecycle transition, before another body read.
 * Generation/pins and the independent owner deadline never reset on resume. */
export function noteBindingQualificationTransition(lease:BindingQualificationLease|undefined,store:Store,taskId:string):void {
 if(!lease)return;const s=leases.get(lease);const task=new Lifecycle(store).task(taskId);
 if(s && (s.revoked || !s.owner.isAlive() || s.owner.stopRequested())) return;
 if(!s||s.store!==store||s.taskId!==taskId||Date.now()>=s.deadline||task.generation!==s.generation+1||
   !(s.taskState==='registered'&&task.state==='active'||s.taskState==='active'&&task.state==='paused'||s.taskState==='paused'&&task.state==='active'))throw new Error('binding_qualification_revoked');
 s.generation=task.generation;s.taskState=task.state;assertBindingQualification(lease,store,taskId);
}
export function bindingQualificationOwnerLive(lease:BindingQualificationLease|undefined):boolean {
 const s=lease?leases.get(lease):undefined;return !!s?.owner.isAlive();
}
export function checkBindingQualificationIdentity(lease:BindingQualificationLease|undefined,store:Store,taskId:string,value:VerifiedSessionIdentity,commit=true):void {
 if(!lease)return;assertBindingQualification(lease,store,taskId);const s=leases.get(lease)!;
 if(value.product!=='codex'||value.productVersion!==s.productVersion||value.cwd!==s.root||Date.parse(value.createdAt)<s.issuedAt-5000||
  statSync(value.sourceRef).birthtimeMs<s.issuedAt-5000)throw new Error('binding_qualification_identity_invalid');
 // Validate before a DB transaction; adopt family pins only after its commit.
 if(value.parentSessionId===null){if(s.rootId!==null&&s.rootId!==value.sessionId)throw new Error('binding_qualification_family_limit');if(commit)s.rootId=value.sessionId;}
 else{if(value.parentSessionId!==s.rootId||!s.childIds.has(value.sessionId)&&s.childIds.size>=2)throw new Error('binding_qualification_family_limit');if(commit)s.childIds.add(value.sessionId);}
}
export function qualificationRequestKey(record:BindingUsageRecord):string {return createHash('sha256').update(JSON.stringify(['binding-request-v1','codex',record.requestId])).digest('hex');}
export function qualificationRecordedRequests(lease:BindingQualificationLease):ReadonlyMap<string,BindingUsageRecord>{return new Map(leases.get(lease)?.requests);}
export function qualificationBaselineKeys(lease:BindingQualificationLease):ReadonlySet<string>{return new Set(leases.get(lease)?.baseline);}
/** In-memory counts only; no authorization reset or native source read. */
export function qualificationStopWitness(lease:BindingQualificationLease|undefined,predicate:QualificationStopWitness['predicate']):QualificationStopWitness {
 const s=lease?leases.get(lease):undefined;if(!s)return{predicate,safety:null,attempted:null};
 if(s.limitWitness)return structuredClone(s.limitWitness);
 const records=[...s.requests.values()];const own=(id:string|null)=>records.filter(r=>r.sessionId===id).length;
 const tokens=records.reduce((n,r)=>n+(r.payload.input_total.value??0)+(r.payload.output_total.value??0),0);const reached:LimitPredicate[]=[];
 const policy=codexBindingQualificationPolicies[s.productVersion];
 if(own(s.rootId)>=policy.rootRequestStop)reached.push('root_request_limit');if([...s.childIds].some(id=>own(id)>1))reached.push('child_request_limit');
 if(records.length>=policy.totalRequestStop)reached.push('total_request_limit');if(tokens>=policy.tokenStop)reached.push('token_limit');
 return{predicate,safety:{root_requests:own(s.rootId),children:[...s.childIds].sort().map(id=>({session_id:id,requests:own(id),excluded_baseline_requests:records.filter(r=>r.sessionId===id&&s.baseline.has(qualificationRequestKey(r))).length})),total_requests:records.length,excluded_baseline_requests:s.baseline.size,input_output_tokens:tokens,reached},attempted:null};
}
export function checkBindingQualificationRecord(lease:BindingQualificationLease|undefined,store:Store,taskId:string,value:BindingUsageRecord,baseline=false):void {
 if(!lease)return;assertBindingQualification(lease,store,taskId);const s=leases.get(lease)!;
 if(value.payload.model!=='gpt-6.1-sol'||value.effort!=='high'||value.payload.input_total.status!=='observed'||value.payload.output_total.status!=='observed')throw new Error('binding_qualification_runtime_invalid');
 const key=qualificationRequestKey(value);const old=s.requests.get(key);
 if(old){if(JSON.stringify(old)!==JSON.stringify(value))throw new Error('binding_qualification_request_conflict');return;}
 if(value.sessionId!==s.rootId&&!s.childIds.has(value.sessionId))throw new Error('binding_qualification_identity_invalid');
 const requests=[...s.requests.values()];const own=requests.filter(r=>r.sessionId===value.sessionId).length;
 const tokens=[...requests,value].reduce((n,r)=>n+(r.payload.input_total.value??0)+(r.payload.output_total.value??0),0);
 const policy=codexBindingQualificationPolicies[s.productVersion];
 const reached:LimitPredicate[]=[];if(own>=(value.sessionId===s.rootId?policy.rootRequestStop:1))reached.push(value.sessionId===s.rootId?'root_request_limit':'child_request_limit');
 if(requests.length>=policy.totalRequestStop)reached.push('total_request_limit');if(tokens>policy.tokenStop)reached.push('token_limit');
 if(reached.length){s.limitWitness??={...qualificationStopWitness(lease,'collector_limit'),attempted:{session_id:value.sessionId,own_requests:own+1,total_requests:requests.length+1,input_output_tokens:tokens,excluded_baseline:baseline,reached}};throw new Error(reached.some(r=>r!=='token_limit')?'binding_qualification_request_limit':'binding_qualification_token_limit');}
 s.requests.set(key,value);if(baseline)s.baseline.add(key);
}
export function qualificationStopReached(lease:BindingQualificationLease):boolean{
 const witness=qualificationStopWitness(lease,'safety_limit');return witness.predicate==='collector_limit'||(witness.safety?.reached.length??1)>0;
}
