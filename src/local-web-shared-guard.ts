import { applicationRequired, assertAppliedHarness } from './harness-application.js';
import { z } from 'zod';
import { Lifecycle, utcNow, type Clock } from './lifecycle.js';
import type { Store } from './store.js';
import { readRepositoryFile, readStrictJson, hashBytes, readComparison, checkOriginalTools } from './harness-config.js';
import { recordObservationGap } from './runtime-history.js';
const digest=z.string().regex(/^[a-f0-9]{64}$/);
export const SharedBindingSchema=z.strictObject({comparison_id:z.string(),descriptor_path:z.string(),settings_hash:digest,
  project_root:z.string(),template_id:z.string(),template_hash:digest,variant_ids:z.tuple([z.string(),z.string()]),bundle_hashes:z.tuple([digest,digest]),local_setup_path:z.string(),revision_hash:digest});
export type SharedBinding=z.infer<typeof SharedBindingSchema>;
export function checkSharedBinding(binding: SharedBinding, assignedVariant?: string, agentApplied = false) {
  const pair=readComparison(binding.project_root,binding.descriptor_path);
  if(pair.descriptor.settings_hash!==binding.settings_hash||pair.bundles.some((bundle,i)=>bundle.bundle_hash!==binding.bundle_hashes[i]))throw new Error('shared_content_mismatch');
  if(assignedVariant!==undefined){const index=binding.variant_ids.indexOf(assignedVariant);if(index<0)throw new Error('shared_registration_mismatch');if(pair.descriptor.application==='selected_markdown_only'&&!agentApplied&&checkOriginalTools(binding.project_root,pair.bundles[index]!)!=='matched')throw new Error('shared_tool_mismatch');}
  return pair;
}
/** Pinned comparison and assigned bundle of a shared task; integrity errors are thrown unchanged. */
export function sharedTaskPair(store:Store,taskId:string,clock:Clock=utcNow) {
  const marker=store.get<{project_id:string;settings_hash:string;setup_hash:string}>('SELECT project_id,settings_hash,setup_hash FROM shared_configuration_tasks WHERE task_id=?',[taskId]);if(!marker)return null;
    const task=new Lifecycle(store,clock).task(taskId);const root=store.get<{local_root:string}>('SELECT local_root FROM projects WHERE id=?',[task.project_id])?.local_root;
    if(marker.project_id!==task.project_id||!root||store.get("SELECT 1 FROM tombstones WHERE (kind='project' AND id=?) OR (kind='task' AND id=?)",[task.project_id,taskId]))throw new Error('deleted_identifier');
    const journal=z.strictObject({kind:z.literal('harness-delta.shared-task'),schema_version:z.literal(1),local_setup_path:z.string(),setup_hash:digest,settings_hash:digest}).parse(readStrictJson(readRepositoryFile(root,`.harness-delta/setup/tasks/${taskId}.json`)));
    if(journal.settings_hash!==marker.settings_hash||journal.setup_hash!==marker.setup_hash)throw new Error('shared_binding_changed');
    const bytes=readRepositoryFile(root,journal.local_setup_path);if(hashBytes(bytes)!==marker.setup_hash)throw new Error('shared_binding_changed');
    const data=readStrictJson(bytes) as {profile?:{shared_binding?:unknown}};const binding=SharedBindingSchema.parse(data.profile?.shared_binding);
    if(binding.project_root!==root||binding.settings_hash!==marker.settings_hash)throw new Error('shared_binding_changed');
    const assignment=store.get<{variant_id:string}>('SELECT variant_id FROM comparison_assignments WHERE task_id=?',[taskId]);if(!assignment)throw new Error('shared_registration_mismatch');
    // A task with its own application authority is verified through its reported outputs.
    const agentApplied=applicationRequired(store,taskId);
    const pair=checkSharedBinding(binding,assignment.variant_id,agentApplied);const index=binding.variant_ids.indexOf(assignment.variant_id);
    return {root,marker,pair,agentApplied,variantId:assignment.variant_id,bundle:pair.bundles[index]!,reference:index===0?pair.descriptor.arm_a:pair.descriptor.arm_b};
}
/** Durable opaque marker prevents missing private JSON from silently disabling a guard. */
export function assertSharedTask(store:Store,taskId:string,clock:Clock=utcNow,inputOnly=false):void {
  try {
    const shared=sharedTaskPair(store,taskId,clock);if(!shared)return;
    if((shared.pair.descriptor.application==='agent_applied'||shared.agentApplied)&&!inputOnly){if(!shared.agentApplied)throw new Error('application_required');assertAppliedHarness(store,taskId);}
  } catch(error) {
    configurationIntegrityFailed(store,taskId,clock,error);
  }
}

/** Persist a pause/gap for configuration failure, including application-only tasks. */
export function configurationIntegrityFailed(store:Store,taskId:string,clock:Clock,error:unknown):never {
    const life=new Lifecycle(store,clock);const task=store.get<{state:string}>('SELECT state FROM tasks WHERE id=?',[taskId]);
    if(task?.state==='active'){
      const at=clock();store.immediateTransaction(()=>{for(const session of store.all<{id:string}>('SELECT id FROM sessions WHERE task_id=?',[taskId])){
        const last=store.get<{at:string|null}>('SELECT max(occurred_at) AS at FROM events WHERE task_id=? AND session_id=?',[taskId,session.id])?.at;
        const start=store.get<{observed_since:string}>('SELECT observed_since FROM session_bindings WHERE task_id=? AND session_id=?',[taskId,session.id])?.observed_since??life.task(taskId).started_at??at;
        const lostFrom=new Date(last?Date.parse(last)+1:Math.min(Date.parse(at),Date.parse(start))).toISOString();
        recordObservationGap(store,taskId,session.id,lostFrom,new Date(Math.max(Date.parse(at),Date.parse(lostFrom))).toISOString(),'source_error',at);}life.pause(taskId);});
    }
    if(task&&task.state!=='finalized')store.execute("UPDATE external_preparations SET state='configuration_changed',reason_code='external_configuration_drift' WHERE task_id=?",[taskId]);
    const code=error instanceof Error&&/^(?:shared_|application_)[a-z_]+$/.test(error.message)?error.message:'shared_binding_changed';throw new Error(code,{cause:error});
}
