import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';
const root=fileURLToPath(new URL('../',import.meta.url));
function fail(code){process.stdout.write(`${JSON.stringify({status:'fail',failures:[code]})}\n`);process.exitCode=1;}
if(process.argv.length!==2)fail('unknown_arguments');
else if(![24,26].includes(Number(process.versions.node.split('.')[0])))fail('unsupported_node');
else {
  rmSync(new URL('../.harness-delta/analysis-validation-build/',import.meta.url),{recursive:true,force:true});
  const compiled=spawnSync(process.execPath,['node_modules/typescript/bin/tsc','-p','scripts/analysis-validation/tsconfig.json'],{cwd:root,encoding:'utf8'});
  if(compiled.status!==0)fail('study_compile_failed');
  else {
    const result=spawnSync(process.execPath,['.harness-delta/analysis-validation-build/scripts/analysis-validation/runner.js'],{cwd:root,stdio:'inherit'});
    process.exitCode=result.status??1;
  }
}
