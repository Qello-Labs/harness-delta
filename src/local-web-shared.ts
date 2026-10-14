import { randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, linkSync, openSync, realpathSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { LocalWebProfileSchema, type LocalWebProfile } from './local-web-domain.js';
import { comparisonProtocol, comparisonVariant, protocolRow } from './comparison.js';
import { buildExternalTaskSetup } from './external-session-service.js';
import type { Store } from './store.js';
import { comparisonRelativePath, ensureRepositoryDirectory, hashBytes, readComparison, readRepositoryFile, readStrictJson, checkOriginalTools } from './harness-config.js';
import { checkSharedBinding } from './local-web-shared-guard.js';
import { readPriceTable } from './pricing.js';
// Private path strings retain their exact filesystem spelling.
function privateJson(value:unknown):string {
 if(Array.isArray(value))return '['+value.map(privateJson).join(',')+']';
 if(value&&typeof value==='object'){const record=value as Record<string,unknown>;return '{'+Object.keys(record).sort().map(key=>JSON.stringify(key)+':'+privateJson(record[key])).join(',')+'}';}
 return JSON.stringify(value);
}
interface ImportToken {path:string;expires:number;projects:Record<string,{settingsHash:string;templates:Record<string,string>}>}
function fail(code:string):never {throw new Error(code);}
export function writePrivateFile(root:string,path:string,bytes:Buffer):boolean {
  const directory=ensureRepositoryDirectory(root,dirname(path));const target=join(realpathSync(root),path);
  if(existsSync(target)){if(!readRepositoryFile(root,path).equals(bytes))fail('shared_binding_changed');return false;}
  const temp=join(directory,`.stage-${randomUUID()}`);const fd=openSync(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{
    try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
    try{linkSync(temp,target);}catch(error){if(!(error instanceof Error)||!('code' in error)||error.code!=='EEXIST'||!readRepositoryFile(root,path).equals(bytes))throw error;return false;}
  }finally{unlinkSync(temp);}
  return true;
}
export function readSharedLocalSetup(root:string,path:string,verifySnapshots=true):LocalWebProfile {
  const raw=z.strictObject({kind:z.literal('harness-delta.local-setup'),schema_version:z.literal(1),profile:LocalWebProfileSchema}).parse(readStrictJson(readRepositoryFile(root,path)));
  const profile=raw.profile;const binding=profile.shared_binding;if(!binding||binding.project_root!==realpathSync(root)||binding.local_setup_path!==path)fail('shared_binding_changed');
  const {id:ignored,...base}=profile;void ignored;const {local_setup_path:ignoredPath,revision_hash:ignoredHash,...fields}=binding;void ignoredPath;void ignoredHash;
  const revision=hashBytes(privateJson({...base,shared_binding:fields}));if(binding.revision_hash!==revision||profile.id!==`shared-${revision}`)fail('shared_binding_changed');if(verifySnapshots)checkSharedBinding(binding);return profile;
}
export function loadSharedStartup(store:Store,selected:string,revision?:string):LocalWebProfile[] {
  const choices:LocalWebProfile[]=[];
  for(const project of store.all<{id:string;local_root:string}>('SELECT id,local_root FROM projects')){
    let relative:string;let comparisonId:string;try{relative=comparisonRelativePath(project.local_root,selected);comparisonId=readComparison(project.local_root,relative).descriptor.id;}catch{continue;}
    const directory=join(project.local_root,'.harness-delta/setup');if(!existsSync(directory))continue;
    for(const file of readdirSync(directory)){if(revision&&file!==`${comparisonId}-${revision.replace(/^shared-/, '')}.json`)continue;if(!file.startsWith(comparisonId+'-')||!/^[a-z0-9-]+-[a-f0-9]{64}\.json$/.test(file))continue;const profile=readSharedLocalSetup(project.local_root,`.harness-delta/setup/${file}`,false);if(profile.setup.workflow.assignment.project_id!==project.id||store.get("SELECT 1 FROM tombstones WHERE kind='project' AND id=?",[project.id]))continue;if(profile.shared_binding?.descriptor_path===relative&&(!revision||profile.id===revision)){checkSharedBinding(profile.shared_binding);choices.push(profile);}}
  }
  if(!choices.length)fail('shared_binding_required');if(choices.length!==1)fail('shared_binding_selection_required');return choices;
}
export function createSharedSetupManager(store:Store,privateDb:Database.Database,profiles:()=>LocalWebProfile[],saveProfiles:(profiles:LocalWebProfile[])=>unknown){
  const tokens=new Map<string,ImportToken>();
  privateDb.exec('CREATE TABLE IF NOT EXISTS web_shared_versions(project_id TEXT,variant_id TEXT,bundle_hash TEXT NOT NULL,PRIMARY KEY(project_id,variant_id))');
  const projects=()=>store.all<{id:string;local_root:string}>('SELECT id,local_root FROM projects');
  function eligible(projectId:string,templateId:string,path:string){
    const project=projects().find(row=>row.id===projectId);if(!project)fail('unknown_project');
    const template=profiles().find(row=>row.id===templateId&&!row.shared_binding);if(!template||template.setup.workflow.assignment.project_id!==projectId)fail('shared_registration_required');
    buildExternalTaskSetup(store,{id:template.id,setup:template.setup},{projectId});const protocol=comparisonProtocol(store,protocolRow(store,template.setup.workflow.assignment.protocol_id));
    const pair=readComparison(project.local_root,comparisonRelativePath(project.local_root,path));
    const setupDirectory=join(project.local_root,'.harness-delta/setup');
    const prior=existsSync(setupDirectory)?readdirSync(setupDirectory).filter(file=>/^[a-z0-9-]+-[a-f0-9]{64}\.json$/.test(file)).map(file=>readSharedLocalSetup(project.local_root,`.harness-delta/setup/${file}`,false)):[];
    if(prior.some(profile=>profile.setup.workflow.assignment.project_id===projectId&&profile.shared_binding?.comparison_id===pair.descriptor.id&&profile.shared_binding.settings_hash!==pair.descriptor.settings_hash))fail('shared_settings_conflict');
    for(const [i,variantId] of protocol.variant_ids.entries()){
      const variant=comparisonVariant(store,variantId);const bundle=pair.bundles[i]!;
      if(variant.schema_version!==2||variant.instruction_manifest_hash!==bundle.instruction_manifest_hash||variant.policy_version!==bundle.policy_version)fail('shared_registration_mismatch');
      const old=privateDb.prepare('SELECT bundle_hash FROM web_shared_versions WHERE project_id=? AND variant_id=?').get(projectId,variantId) as {bundle_hash:string}|undefined;
      if(old&&old.bundle_hash!==bundle.bundle_hash)fail('shared_registration_mismatch');
      for(const profile of prior){if(profile.setup.workflow.assignment.project_id!==projectId)continue;const binding=profile.shared_binding!;const index=binding.variant_ids.indexOf(variantId);if(index>=0&&binding.bundle_hashes[index]!==bundle.bundle_hash)fail('shared_registration_mismatch');}
    }
    return {project,template,protocol,pair};
  }
  return {
    discardPreview(token:string){tokens.delete(token);},
    preview(path:string){
      const raw=readStrictJson(readRepositoryFile(dirname(path),basename(path))) as {kind?:unknown};if(raw.kind!=='harness-delta.comparison')fail('invalid_shared_config');
      const possible=projects().flatMap(project=>{try{const relative=comparisonRelativePath(project.local_root,path);const pair=readComparison(project.local_root,relative);return [{project_id:project.id,name:basename(project.local_root),pair:pair.descriptor,original_tools:pair.bundles.map(bundle=>checkOriginalTools(project.local_root,bundle)),templates:profiles().filter(profile=>!profile.shared_binding&&profile.setup.workflow.assignment.project_id===project.id).map(profile=>{
        let blocker:string|null=null;
        let review:{profile:LocalWebProfile;protocol:ReturnType<typeof comparisonProtocol>;price_table:ReturnType<typeof readPriceTable>}|undefined;
        try{
          const selected=eligible(project.id,profile.id,path);
          if(selected.protocol.schema_version!==2)fail('shared_registration_mismatch');
          review={profile,protocol:selected.protocol,price_table:readPriceTable(store,selected.protocol.price_table_id)};
        }catch(error){blocker=error instanceof Error&&/^(?:shared_|unknown_|protocol_|workflow_)/.test(error.message)?error.message:'shared_registration_required';}
        return {id:profile.id,name:profile.name,runtime:profile.setup.runtime,blocker,...(review?{review}:{})};
      })}];}catch{return [];}});
      if(!possible.length)fail('shared_project_required');for(const [key,value] of tokens)if(value.expires<Date.now())tokens.delete(key);if(tokens.size>=64)fail('shared_import_limit');const token=randomUUID();tokens.set(token,{path,expires:Date.now()+300000,projects:Object.fromEntries(possible.map(project=>[project.project_id,{settingsHash:project.pair.settings_hash,templates:Object.fromEntries(project.templates.map(template=>[template.id,hashBytes(JSON.stringify(profiles().find(profile=>profile.id===template.id)))]))}]))});return {shared:true,token,projects:possible};
    },
    bind(input:{token:string;project_id:string;template_id:string},onFileCreated?:(remove:()=>void)=>void){
      const selected=tokens.get(input.token);if(!selected||selected.expires<Date.now())fail('shared_import_expired');const {project,template,protocol,pair}=eligible(input.project_id,input.template_id,selected.path);
      const preview=selected.projects[input.project_id];if(!preview||preview.settingsHash!==pair.descriptor.settings_hash||preview.templates[input.template_id]!==hashBytes(JSON.stringify(template)))fail('shared_preview_changed');
      const descriptorPath=comparisonRelativePath(project.local_root,selected.path);
      const old=profiles().find(profile=>profile.shared_binding?.project_root===project.local_root&&profile.shared_binding.comparison_id===pair.descriptor.id&&profile.shared_binding.settings_hash!==pair.descriptor.settings_hash);if(old)fail('shared_settings_conflict');
      const bindingFields={comparison_id:pair.descriptor.id,descriptor_path:descriptorPath,settings_hash:pair.descriptor.settings_hash,project_root:realpathSync(project.local_root),template_id:template.id,template_hash:hashBytes(JSON.stringify(template)),variant_ids:protocol.variant_ids,bundle_hashes:pair.bundles.map(bundle=>bundle.bundle_hash) as [string,string]};
      const base={name:pair.descriptor.name.trim(),setup:{...template.setup,workflow:{...template.setup.workflow,...(pair.descriptor.application==='agent_applied'?{application:{schema_version:2,mode:'agent_applied',origin:realpathSync(project.local_root),bundles:pair.bundles.map((bundle,i)=>({variant_id:protocol.variant_ids[i]!,path:`harness-config/${bundle.version}/manifest.json`,bundle_hash:bundle.bundle_hash}))}}:{}),artifacts:pair.bundles.map((bundle,i)=>({variant_id:protocol.variant_ids[i]!,selected_artifacts:bundle.artifacts.filter(a=>a.role==='instruction').map(a=>({artifact_id:a.artifact_id,path:join(project.local_root,a.path)}))}))}},execution:template.execution,...(template.session_binding?{session_binding:template.session_binding}:{}),shared_binding:bindingFields};
      const revision=hashBytes(privateJson(base));const localPath=`.harness-delta/setup/${pair.descriptor.id}-${revision}.json`;
      const profile=LocalWebProfileSchema.parse({...base,id:`shared-${revision}`,shared_binding:{...bindingFields,local_setup_path:localPath,revision_hash:revision}});
      const bytes=Buffer.from(JSON.stringify({kind:'harness-delta.local-setup',schema_version:1,profile})+'\n');
      const already=profiles().some(row=>row.id===profile.id);const created=writePrivateFile(project.local_root,localPath,bytes);
      const removeCreatedFile=()=>{if(created&&existsSync(join(project.local_root,localPath))){if(!readRepositoryFile(project.local_root,localPath).equals(bytes))fail('shared_binding_changed');unlinkSync(join(project.local_root,localPath));}};
      if(created)onFileCreated?.(removeCreatedFile);
      try{privateDb.transaction(()=>{for(const [i,variantId] of protocol.variant_ids.entries())privateDb.prepare('INSERT OR IGNORE INTO web_shared_versions(project_id,variant_id,bundle_hash) VALUES(?,?,?)').run(project.id,variantId,pair.bundles[i]!.bundle_hash);saveProfiles([profile]);})();}
      catch(error){removeCreatedFile();throw error;}
      tokens.delete(input.token);
      return {imported:true,already_connected:already,profile_id:profile.id,local_setup_path:localPath};
    },
    assertProfile(profile:LocalWebProfile){if(!profile.shared_binding)return;const loaded=readSharedLocalSetup(profile.shared_binding.project_root,profile.shared_binding.local_setup_path);if(JSON.stringify(loaded)!==JSON.stringify(profile))fail('shared_binding_changed');},
    journalTask(profile:LocalWebProfile,taskId:string,requireExisting=false){if(!profile.shared_binding)return;const binding=profile.shared_binding;const bytes=readRepositoryFile(binding.project_root,binding.local_setup_path);const setupHash=hashBytes(bytes);
      const path=`.harness-delta/setup/tasks/${taskId}.json`;
      if(requireExisting&&!existsSync(join(binding.project_root,path)))fail('shared_binding_changed');
      writePrivateFile(binding.project_root,path,Buffer.from(JSON.stringify({kind:'harness-delta.shared-task',schema_version:1,local_setup_path:binding.local_setup_path,setup_hash:setupHash,settings_hash:binding.settings_hash})+'\n'));
      return {settingsHash:binding.settings_hash,setupHash};},
  };
}

export type SharedSetupImportResult = ReturnType<ReturnType<typeof createSharedSetupManager>['preview']>;
