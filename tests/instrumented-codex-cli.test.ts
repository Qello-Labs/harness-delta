import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { InstrumentedCostResultSchema } from '../src/instrumented-codex-contracts.js';
import { makeInstrumentedCostFixture } from './helpers/instrumented-codex-fixture.js';

test('the built CLI captures a sealed window without promoting caller-created metadata', async () => {
  const root = mkdtempSync(join(tmpdir(), 'instrumented-cost-cli-'));
  const file = join(root, 'measurement.sqlite');
  const fixture = makeInstrumentedCostFixture(file);
  fixture.request(); fixture.seal();
  const cutoff = fixture.now();
  fixture.store.close();
  try {
    const child = spawn(process.execPath, [
      join(process.cwd(), 'dist/cli.js'), '--db', file, 'price-table',
      'snapshot-instrumented', 'run-1', '--id', 'input-1', '--valuation-id', 'valuation-1',
      '--cutoff', cutoff,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = once(child, 'close');
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (text: string) => { stdout += text; });
    child.stderr.on('data', (text: string) => { stderr += text; });
    const timer = setTimeout(() => child.kill('SIGTERM'), 10000);
    let termination: readonly [number | null, string | null];
    try { termination = z.tuple([z.number().int().nullable(), z.string().nullable()]).parse(await closed); }
    finally { clearTimeout(timer); }
    expect({ code: termination[0], signal: termination[1], stderr }).toEqual({ code: 0, signal: null, stderr: '' });
    const result = InstrumentedCostResultSchema.parse(JSON.parse(stdout) as unknown);
    expect(result).toMatchObject({
      valuation_id: 'valuation-1', coverage_scope: 'work_window', complete_amount: null,
      complete_window_amount: null, partial_amount: null, source_unverified_partial_amount: '0.22',
    });
    expect(stdout).not.toContain(root);
  } finally { rmSync(root, { recursive: true }); }
});
