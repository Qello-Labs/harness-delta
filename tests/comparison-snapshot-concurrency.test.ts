import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { expect, test } from 'vitest';
import { Store } from '../src/store.js';
import { Deletion } from '../src/deletion.js';
import { createComparisonSnapshot, readComparisonSnapshot } from '../src/reports/comparison-snapshot.js';
import { reportStore, request, evaluation } from './helpers/comparison-report-fixture.js';

for (const first of ['snapshot', 'deletion']) {
  test(`two SQLite connections serialize ${first} first and never retain deleted evidence`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'report-race-'));
    const file = join(root, 'local.db');
    let worker: Worker | undefined;
    try {
      const store = reportStore(file);
      const compiled = join(root, 'compiled');
      mkdirSync(compiled);
      writeFileSync(join(compiled, 'package.json'), '{"type":"module"}');
      symlinkSync(join(process.cwd(), 'node_modules'), join(compiled, 'node_modules'), 'dir');
      for (const name of readdirSync(new URL('../src/', import.meta.url), { recursive: true, encoding: 'utf8' })) {
        if (!name.endsWith('.ts')) continue;
        const output = transpileModule(readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8'), {
          compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2023 }
        }).outputText;
        mkdirSync(dirname(join(compiled, name)), { recursive: true });
        writeFileSync(join(compiled, name.replace(/\.ts$/, '.js')), output);
      }
      cpSync(new URL('../src/codex-admissions.json', import.meta.url), join(compiled, 'codex-admissions.json'));
      cpSync(new URL('../src/migrations/', import.meta.url), join(compiled, 'migrations'), { recursive: true });
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
            snapshotUrl: pathToFileURL(join(compiled, 'reports/comparison-snapshot.js')).href,
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
        Atomics.wait(flags, 1, 0, 1000);
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
  });
}
