#!/usr/bin/env node
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { Command, Option } from 'commander';
import { prepareCodexSessionBindingQualification, executeCodexSessionBindingQualification, codexBindingQualificationArgv, serveCodexSessionBindingQualificationUiPreparation, serveCodexSessionBindingQualificationResults } from '../dist/codex-session-binding-qualification.js';

const program=new Command().name('codex-session-binding-qualification').description('Prepare or explicitly approve one isolated ordinary Codex root/two-direct-children qualification.');
program.command('prepare').requiredOption('--directory <absolute-path>').requiredOption('--binary <absolute-path>').requiredOption('--codex-home <absolute-path>').addOption(new Option('--route <route>','qualification authority or code-owned ordinary admission').choices(['qualification','ordinary_admission']).default('qualification')).addOption(new Option('--product-version <version>','exact reviewed qualification binary').choices(['0.160.0','0.162.1','0.163.0']).default('0.160.0')).addOption(new Option('--start-mode <mode>','automatic initial prompt or manual terminal input').choices(['automatic','manual']).default('automatic')).action(async options=>{
 const prepared=await prepareCodexSessionBindingQualification(options.directory,{binary:options.binary,codexHome:options.codexHome,startMode:options.startMode,productVersion:options.productVersion,route:options.route});
 console.log(JSON.stringify({route:prepared.intent.route,ordinary_admission_verified:false,intent_path:prepared.intentPath,intent_sha256:prepared.sha256,product_version:prepared.intent.product_version,task_id:prepared.intent.task_id,start_mode:prepared.intent.start_mode,argv:codexBindingQualificationArgv(prepared.intent),post_connect_input:prepared.intent.post_connect_input,root_model:prepared.intent.root_model,child_model:prepared.intent.child_model,effort:prepared.intent.effort,planned_roots:1,planned_children:2,root_request_stop:prepared.intent.root_request_stop,child_request_stop:1,ui_preparation_required:true,duration_ms:prepared.intent.duration_ms,observed_request_stop:prepared.intent.observed_request_stop,observed_token_stop:prepared.intent.observed_token_stop,helper_network_permission:prepared.intent.helper_network_permission,hard_billing_bound:null,product_gate_delta:false},null,2));
});
program.command('prepare-ui').requiredOption('--intent <absolute-path>').action(async options=>{
 const server=await serveCodexSessionBindingQualificationUiPreparation(options.intent);
 console.log(JSON.stringify({origin:server.origin,task_id:server.taskId,mode:'offline_ui_preparation_only',native_launch:false}));
 await new Promise(resolve=>{
  const stop=()=>{void server.close().then(resolve);};process.once('SIGINT',stop);process.once('SIGTERM',stop);
 });
});
program.command('results-ui').requiredOption('--intent <absolute-path>').action(async options=>{
 const server=await serveCodexSessionBindingQualificationResults(options.intent);
 console.log(JSON.stringify({origin:server.origin,task_id:server.taskId,mode:'source_free_results_only',native_launch:false}));
 await new Promise(resolve=>{const stop=()=>{void server.close().then(resolve);};process.once('SIGINT',stop);process.once('SIGTERM',stop);});
});
program.command('execute').requiredOption('--intent <absolute-path>').requiredOption('--consent <absolute-path>').action(async options=>{
 const consentPath=realpathSync(options.consent);const info=statSync(consentPath);
 if(consentPath!==options.consent||!info.isFile()||info.size>4096||(info.mode&0o077)!==0)throw new Error('binding_qualification_consent_file_invalid');
 const result=await executeCodexSessionBindingQualification(options.intent,JSON.parse(readFileSync(consentPath,'utf8')));
 console.log(JSON.stringify(result,null,2));if(result.status!=='completed')process.exitCode=1;
});
try{await program.parseAsync();}catch(error){
 const code=error instanceof Error&&/^(binding_qualification_|owned_cli_|node24_)[a-z_]+$/.test(error.message)?error.message:'binding_qualification_command_failed';
 console.error(code);process.exitCode=1;
}
