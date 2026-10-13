import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { Command } from 'commander';
import { bundledCatalogBytes, catalogByteLimit, digest } from './price-catalog.js';
import { preparePriceBasis, refreshPriceCatalog } from './price-catalog-store.js';
import { readOnlinePriceCatalogStatus,refreshOnlinePriceCatalog } from './price-catalog-online.js';
import { selectTaskPriceTable } from './price-catalog-selection.js';
import { captureComparisonCostSnapshot, captureTaskCostSnapshot, createPriceRevaluation, readPriceRevaluation } from './price-revaluation.js';
import { captureInstrumentedCostSnapshot, createInstrumentedValuation, readInstrumentedValuation } from './instrumented-codex-cost.js';
import type { LegacyInputBasis } from './pricing.js';
import type { Store } from './store.js';

export function registerPriceCatalogCommands(prices:Command,store:()=>Store,print:(value:unknown)=>void):void {
  prices.command('catalog-status').description('Show reference catalog version, verification and local refresh status')
    .action(()=>{print(readOnlinePriceCatalogStatus(store()));});
  prices.command('refresh-catalog').description('Reload bundle, import a trusted artifact or try the configured online source')
    .option('--online','Use the tool configured HTTPS release source; fails explicitly before publication')
    .option('--artifact <file>').option('--sha256 <hash>').action(async(options:{artifact?:string;sha256?:string;online?:boolean})=>{
      if(options.online){
        if(options.artifact||options.sha256)throw new Error('catalog_refresh_mode_conflict');
        const result=await refreshOnlinePriceCatalog(store());print(result);
        if(result.status==='failed')throw new Error(result.reason);return;
      }
      if(Boolean(options.artifact)!==Boolean(options.sha256))throw new Error('catalog_artifact_and_hash_required');
      const bytes=options.artifact?null:bundledCatalogBytes();
      const result=await refreshPriceCatalog(store(),async()=>{
        if(bytes)return bytes;
        // Inspect the opened descriptor, so path replacement cannot turn a
        // size-checked artifact into a blocking special file or an unbounded read.
        const file=await open(options.artifact!,constants.O_RDONLY|constants.O_NONBLOCK);
        try {
          const metadata=await file.stat();
          if(!metadata.isFile())throw new Error('catalog_unavailable');
          if(metadata.size>catalogByteLimit)throw new Error('catalog_too_large');
          const buffer=Buffer.alloc(catalogByteLimit+1);let size=0;
          while(size<buffer.length) {
            const {bytesRead}=await file.read(buffer,size,buffer.length-size,size);
            if(bytesRead===0)break;size+=bytesRead;
          }
          if(size>catalogByteLimit)throw new Error('catalog_too_large');
          return buffer.subarray(0,size);
        } finally {await file.close();}
      },options.sha256??digest(bytes!));
      print(result);if(result.status==='failed')throw new Error(result.reason);
    });
  prices.command('snapshot-task <task-id>').description('Retain eligible metadata and window for later reference repricing')
    .option('--id <id>').option('--price-table <id>').requiredOption('--cutoff <UTC>')
    .option('--input-basis <basis>','Explicit legacy input assumption','output-only-v1')
    .action((taskId:string,options:{id?:string;priceTable?:string;cutoff:string;inputBasis:LegacyInputBasis})=>{
      const db=store();const table=options.priceTable??selectTaskPriceTable(db,taskId).tableId;
      const snapshot=captureTaskCostSnapshot(db,{inputId:options.id??randomUUID(),taskId,tableId:table,cutoff:options.cutoff,inputBasis:options.inputBasis});
      print({input_id:snapshot.input_id,snapshot_hash:snapshot.snapshot_hash,original_table_id:snapshot.original_table_id,cutoff:snapshot.cutoff});
    });
  prices.command('snapshot-comparison <report-id>').option('--id <id>')
    .description('Retain both original arms and the original frozen report window')
    .action((reportId:string,options:{id?:string})=>{
      const snapshot=captureComparisonCostSnapshot(store(),options.id??randomUUID(),reportId);
      print({input_id:snapshot.input_id,snapshot_hash:snapshot.snapshot_hash,base_report_id:snapshot.base_report_id,cutoff:snapshot.cutoff});
    });
  prices.command('reprice <input-id>').option('--id <id>').option('--price-table <id>')
    .description('Create a separate descriptive result with one catalog basis for all retained tasks')
    .action((inputId:string,options:{id?:string;priceTable?:string})=>{
      const db=store();print(createPriceRevaluation(db,{id:options.id??randomUUID(),inputId,targetTableId:options.priceTable??preparePriceBasis(db).table.id}));
    });
  prices.command('revaluation <id>').action((id:string)=>{print(readPriceRevaluation(store(),id));});
  prices.command('snapshot-instrumented <run-id>')
    .description('Freeze a sealed instrumented window and value it under its original immutable price pin')
    .option('--id <id>').option('--valuation-id <id>').requiredOption('--cutoff <UTC>')
    .action((runId:string,options:{id?:string;valuationId?:string;cutoff:string})=>{
      const db=store();
      const snapshot=captureInstrumentedCostSnapshot(db,{
        inputId:options.id??randomUUID(),runId,cutoff:options.cutoff,
      });
      print(createInstrumentedValuation(db,{
        id:options.valuationId??randomUUID(),inputId:snapshot.input_id,targetTableId:snapshot.price_table.id,
      }));
    });
  prices.command('reprice-instrumented <input-id>')
    .description('Revalue exactly the retained instrumented seal without changing usage coverage or the original pin')
    .option('--id <id>').requiredOption('--price-table <id>')
    .action((inputId:string,options:{id?:string;priceTable:string})=>{
      print(createInstrumentedValuation(store(),{
        id:options.id??randomUUID(),inputId,targetTableId:options.priceTable,
      }));
    });
  prices.command('instrumented-valuation <id>')
    .action((id:string)=>{print(readInstrumentedValuation(store(),id));});
}
