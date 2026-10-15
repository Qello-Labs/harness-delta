import type {Command} from 'commander';
import type {Store} from './store.js';
import {ApplicationCoordinator} from './harness-application.js';

export function registerApplicationCommands(program:Command,db:()=>Store,print:(value:unknown)=>void) {
 const application=program.command('application').description('Preview restoration and check staged application files');
 const coordinator=()=>new ApplicationCoordinator(db(),[],false);
 application.command('preview <task-id>').description('Inspect checkpoint-based restoration without editing files')
  .action((taskId:string)=>{print(coordinator().restorationPreview(taskId));});
 application.command('restore <task-id>').requiredOption('--preview <digest>','digest of the reviewed preview')
  .description('Restore unchanged application outputs; never update the Git index')
  .action((taskId:string,options:{preview:string})=>{print(coordinator().restore(taskId,options.preview));});
 application.command('check-staged <task-id>').description('Reject staged application changes and private local records')
  .action((taskId:string)=>{
   const result=coordinator().checkStaged(taskId);print(result);
   if(!result.clean)throw new Error('application_changes_staged');
  });
}
