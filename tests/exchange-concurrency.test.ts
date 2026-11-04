import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { expect, test } from 'vitest';
import { Store } from '../src/store.js';
import { Deletion } from '../src/deletion.js';
import { importExchangePackage } from '../src/exchange/import.js';
import { deleteImportedTask } from '../src/exchange/retention.js';
import { registerExchangeMapping } from '../src/exchange/mapping.js';
import { paired, receivedAt } from './helpers/exchange-import-fixture.js';
import { sharedProjectId } from './helpers/exchange-fixture.js';
import { compiledWorker } from './helpers/compiled-worker.js';
for (const first of ['import', 'delete', 'project'])
  test(`concurrent ${first} serializes with import and persists its result`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'exchange-race-'));
    const path = join(root, 'dest.db');
    const pair = paired();
    let worker: Worker | undefined;
    let db: Store | undefined;
    try {
      db = new Store(path);
      db.execute("INSERT INTO projects(id) VALUES ('destination')", []);
      registerExchangeMapping(db, pair.mapping);
      if (first !== 'import') importExchangePackage(db, pair.pkg, 'destination', () => receivedAt);
      const compiled = compiledWorker(root);
      const barrier = new SharedArrayBuffer(8);
      const flags = new Int32Array(barrier);
      worker = new Worker(
        `const {parentPort,workerData:d}=require('node:worker_threads');(async()=>{
      const {Store}=await import(d.store);const {importExchangePackage}=await import(d.importer);const db=new Store(d.path);const flags=new Int32Array(d.barrier);
      parentPort.postMessage('ready');Atomics.wait(flags,0,0);Atomics.store(flags,1,1);Atomics.notify(flags,1);
      try{parentPort.postMessage(importExchangePackage(db,d.pkg,'destination',()=>d.now));}catch(e){parentPort.postMessage({error:e.message});}finally{db.close();}
    })();`,
        {
          eval: true,
          workerData: {
            store: pathToFileURL(join(compiled, 'store.js')).href,
            importer: pathToFileURL(join(compiled, 'exchange/import.js')).href,
            path,
            pkg: pair.pkg,
            now: receivedAt,
            barrier
          }
        }
      );
      const ready = new Promise<void>((resolve, reject) => {
        worker!.on('message', v => {
          if (v === 'ready') resolve();
        });
        worker!.on('error', reject);
      });
      const done = new Promise<unknown>((resolve, reject) => {
        worker!.on('message', (v: unknown) => {
          if (typeof v === 'object') resolve(v);
        });
        worker!.on('error', reject);
      });
      await ready;
      db.immediateTransaction(() => {
        Atomics.store(flags, 0, 1);
        Atomics.notify(flags, 0);
        Atomics.wait(flags, 1, 0, 1000);
        if (first === 'import') importExchangePackage(db!, pair.pkg, 'destination', () => receivedAt);
        else if (first === 'delete')
          deleteImportedTask(db!, { local_project_id: 'destination', shared_project_id: sharedProjectId, task_id: 'task-1' }, () => receivedAt);
        else new Deletion(db!, () => receivedAt).deleteProject('destination');
      });
      expect(await done).toEqual(first === 'import' ? { status: 'replayed' } : { error: 'deleted_identifier' });
      db.close();
      db = new Store(path);
      expect(db.all('SELECT * FROM exchange_tasks')).toHaveLength(first === 'import' ? 1 : 0);
    } finally {
      if (worker) await worker.terminate();
      db?.close();
      pair.source.close();
      pair.dest.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15000);
