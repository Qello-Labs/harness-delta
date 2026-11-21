import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { expect, test } from 'vitest';
import { Store } from '../../src/store.js';
import { Deletion } from '../../src/deletion.js';
import { createComparisonSnapshot, readComparisonSnapshot } from '../../src/comparison/reports/comparison-snapshot.js';
import { reportStore, request, evaluation } from '../helpers/comparison-report-fixture.js';
import { compiledWorker } from '../helpers/compiled-worker.js';

for (const first of ['snapshot', 'deletion']) {
  test(`two SQLite connections serialize ${first} first and never retain deleted evidence`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'report-race-'));
    const file = join(root, 'local.db');
    let worker: Worker | undefined;
    try {
      const store = reportStore(file);
      const compiled = compiledWorker(root);
      const barrier = new SharedArrayBuffer(8);
      const flags = new Int32Array(barrier);
      worker = new Worker(
        `const { parentPort, workerData: d } = require('node:worker_threads');
        (async () => {
          const { Store } = await import(d.storeUrl); const { Deletion } = await import(d.deletionUrl);
          const { createComparisonSnapshot } = await import(d.snapshotUrl); const db = new Store(d.file);
          const flags = new Int32Array(d.barrier); parentPort.postMessage('ready');
          Atomics.wait(flags,0,0); Atomics.store(flags,1,1); Atomics.notify(flags,1);
          try { if (d.first === 'snapshot') new Deletion(db, () => d.now).deleteTask('task-1');
            else createComparisonSnapshot(db, d.request, () => d.now);
            parentPort.postMessage({ ok: true });
          } catch (e) { parentPort.postMessage({ error: e.message }); } finally { db.close(); }
        })().catch(e => { throw e; });`,
        {
          eval: true,
          workerData: {
            storeUrl: pathToFileURL(join(compiled, 'store.js')).href,
            deletionUrl: pathToFileURL(join(compiled, 'deletion.js')).href,
            snapshotUrl: pathToFileURL(join(compiled, 'comparison/reports/comparison-snapshot.js')).href,
            file,
            barrier,
            first,
            request,
            now: evaluation
          }
        }
      );
      const ready = new Promise<void>((resolve, reject) => {
        worker!.on('message', value => {
          if (value === 'ready') resolve();
        });
        worker!.on('error', reject);
      });
      const done = new Promise<{ ok?: boolean; error?: string }>((resolve, reject) => {
        worker!.on('message', (value: unknown) => {
          if (typeof value === 'object' && value !== null) resolve(value);
        });
        worker!.on('error', reject);
      });
      await ready;
      store.immediateTransaction(() => {
        Atomics.store(flags, 0, 1);
        Atomics.notify(flags, 0);
        expect(Atomics.wait(flags, 1, 0, 1000), 'snapshot worker did not acknowledge the transaction within 1000 ms').not.toBe('timed-out');
        if (first === 'snapshot') createComparisonSnapshot(store, request, () => evaluation);
        else new Deletion(store, () => evaluation).deleteTask('task-1');
      });
      expect(await done).toEqual(first === 'snapshot' ? { ok: true } : { error: 'protocol_not_active' });
      if (first === 'snapshot') expect(readComparisonSnapshot(store, 'report-1')).toMatchObject({ validity_status: 'invalidated' });
      else expect(() => readComparisonSnapshot(store, 'report-1')).toThrow('unknown_report');
      expect(store.all('SELECT * FROM comparison_report_snapshots')).toEqual([]);
      expect(store.all('SELECT * FROM comparison_report_dependencies')).toEqual([]);
      store.close();
      const reopen = new Store(file);
      expect(reopen.all('SELECT id FROM tasks')).toEqual([]);
      reopen.close();
    } finally {
      if (worker) await worker.terminate();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15000);
}
