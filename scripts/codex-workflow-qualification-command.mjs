// Internal manual entry. prepare never starts a product; execute requires fresh
// separately obtained model + transient harness/hook + marker-validation consent.
import {readFileSync} from 'node:fs';
import {prepareCodexWorkflowQualification,executeCodexWorkflowQualification} from '../dist/qualification/codex-workflow-qualification.js';
const [command,...args]=process.argv.slice(2);
try{
  if(Number(process.versions.node.split('.')[0])!==24)throw new Error('node24_required');
  if((command==='prepare'||command==='prepare-child')&&args.length===5){const [directory,binaryPath,sha256,codexHome,hookRecorder]=args;
    process.stdout.write(JSON.stringify(prepareCodexWorkflowQualification(directory,{binary:{path:binaryPath,sha256},codex_home:codexHome,hook_recorder:hookRecorder,topology:command==='prepare-child'?'root_direct_child':'root_resume'}))+'\n');
  }else if(command==='execute'&&args.length===2){const result=await executeCodexWorkflowQualification(args[0],JSON.parse(readFileSync(args[1],'utf8')));process.stdout.write(JSON.stringify(result)+'\n');if(result.status!=='completed')process.exitCode=1;}
  else throw new Error('explicit_prepare_or_execute_required');
}catch{process.stderr.write('codex_workflow_qualification_input_or_state_error\n');process.exitCode=2;}
