#!/usr/bin/env node
import {readFileSync} from 'node:fs';
const fail=code=>{process.stderr.write(code+'\n');process.exitCode=1;};
try{
 if(![24,26].includes(Number(process.versions.node.split('.')[0])))throw new Error('unsupported_node');
 const [action,...args]=process.argv.slice(2),options=new Map();
 if(!['status','context','checkpoint','report','identity'].includes(action)||args.length%2)throw new Error('invalid_application_request');
 for(let i=0;i<args.length;i+=2){if(!['--origin','--task','--attempt','--input'].includes(args[i])||options.has(args[i])||!args[i+1])throw new Error('invalid_application_request');options.set(args[i],args[i+1]);}
 const task=options.get('--task'),attempt=options.get('--attempt');let url;try{url=new URL(options.get('--origin'));}catch{throw new Error('invalid_application_request');}
 if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||!url.port||!task||!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(task))throw new Error('invalid_application_request');
 if(action!=='status'&&(!attempt||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(attempt)))throw new Error('invalid_application_request');
 const mutate=['checkpoint','report','identity'].includes(action);if(mutate!==options.has('--input'))throw new Error('invalid_application_request');
 const base=url.origin;const request=async(path,init={})=>{const reply=await fetch(base+path,{...init,redirect:'error',signal:AbortSignal.timeout(15000),headers:{Origin:base,...init.headers}});const body=await reply.json();if(!reply.ok)throw new Error(typeof body.error==='string'&&/^(?:application_|ui_|local_|binding_)[a-z_]+$/.test(body.error)?body.error:'application_request_failed');return body;};
 const current=await request(`/api/tasks/${encodeURIComponent(task)}`);if(!current.application)throw new Error('application_required');
 let result;
 if(action==='status')result={task_id:task,project_id:current.project_id,assigned_variant_id:current.preparation.assigned_variant_id,application:current.application};
 else{
  const context=await request(`/api/tasks/${encodeURIComponent(task)}/application-context?attempt=${encodeURIComponent(attempt)}`);
  if(context.task_id!==task||context.attempt_id!==attempt||context.variant_id!==current.preparation.assigned_variant_id)throw new Error('application_input_changed');
  if(action==='context')result=context;
  else{const bytes=readFileSync(options.get('--input'));if(bytes.length>1048576)throw new Error('invalid_application_request');const input=JSON.parse(bytes.toString('utf8'));if(!input||input.attempt_id!==attempt)throw new Error('application_attempt_stale');if(action==='report'&&input.bundle_hash!==context.bundle_hash)throw new Error('application_input_changed');const bootstrap=await request('/api/bootstrap');result=await request(`/api/tasks/${encodeURIComponent(task)}/application-${action}`,{method:'POST',headers:{'Content-Type':'application/json','X-Harness-CSRF':bootstrap.csrf,'Idempotency-Key':crypto.randomUUID(),'If-Match':current.version},body:JSON.stringify(input)});}
 }
 process.stdout.write(JSON.stringify(result)+'\n');
}catch(error){fail(error instanceof Error&&/^(?:unsupported_node|invalid_application_request|(?:application_|ui_|local_|binding_)[a-z_]+)$/.test(error.message)?error.message:'application_request_failed');}
