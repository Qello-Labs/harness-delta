import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { main } from '../src/cli.js';
import { Store } from '../src/store.js';
import { teamFixture } from './helpers/team-fixture.js';
import { readTeamSnapshot } from '../src/reports/team-snapshot.js';

test('offline public export→import→replay→freeze→report→delete→stale rejection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'team-cli-'));
  const paths = [join(dir, 'one.db'), join(dir, 'two.db')];
  const db = join(dir, 'team.db');
  const f = teamFixture(paths, db);
  const request = { ...f.request, as_of: new Date().toISOString() };
  f.close();
  let output = '';
  let errors = '';
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(v => {
    output += String(v);
    return true;
  });
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(v => {
    errors += String(v);
    return true;
  });
  const run = (path: string, args: string[]) => {
    output = '';
    return main(['--db', path, ...args]);
  };
  try {
    for (let i = 0; i < 2; i++) {
      const file = join(dir, `package-${i}.json`);
      expect(
        await run(paths[i]!, [
          'exchange',
          'export',
          '--protocol',
          'comparison-1',
          '--snapshot',
          'source-snapshot',
          '--id',
          f.packages[i]!.package_id,
          '--out',
          file
        ])
      ).toBe(0);
      expect(await run(db, ['exchange', 'import', '--file', file, '--project', 'destination'])).toBe(0);
      expect(await run(db, ['exchange', 'import', '--file', file, '--project', 'destination'])).toBe(0);
      expect(JSON.parse(output) as unknown).toEqual({ status: 'replayed' });
    }
    // Explicit receipt boundary after the imports, not the source occurrence cutoff.
    request.as_of = new Date().toISOString();
    const config = join(dir, 'snapshot.json');
    writeFileSync(config, JSON.stringify(request));
    expect(await run(db, ['team', 'snapshot', 'create', '--config', config])).toBe(0);
    expect(await run(db, ['team', 'report', request.snapshot_id, '--format', 'json'])).toBe(0);
    const report = JSON.parse(output) as { total: { assigned_tasks: number } };
    expect(report.total.assigned_tasks).toBe(8);
    const frozen = output;
    expect(await run(db, ['team', 'report', request.snapshot_id, '--format', 'json'])).toBe(0);
    expect(output).toBe(frozen);
    expect(await run(db, ['team', 'report', request.snapshot_id, '--format', 'markdown'])).toBe(0);
    expect(output).toContain('Team completeness: unverified');
    expect(output).not.toMatch(/PRIVATE_|source_key|session_id/);
    expect(await run(db, ['team', 'report', request.snapshot_id, '--format', 'markdown-readable'])).toBe(0);
    expect(output).toContain('| Imported cohort | 8 | 6 | 2 | 0 |');
    expect(await run(db, ['team', 'report', request.snapshot_id])).toBe(0);
    expect(output).toBe(frozen);
    expect(await run(db, ['exchange', 'delete-task', '--project', 'destination', '--shared-project', f.mapping.shared_project_id, '--task', 'task-1'])).toBe(0);
    expect(await run(db, ['team', 'report', request.snapshot_id, '--format', 'json'])).toBe(0);
    expect(JSON.parse(output) as unknown).toMatchObject({ validity_status: 'invalidated' });
    expect(await run(db, ['team', 'report', request.snapshot_id, '--format', 'markdown-readable'])).toBe(0);
    expect(output).toContain('Original cohort: unavailable\\_due\\_to\\_deletion');
    expect(output).not.toContain('task-1');
    expect(await run(db, ['exchange', 'import', '--file', join(dir, 'package-1.json'), '--project', 'destination'])).toBe(2);
    expect(errors).toBe('deleted_identifier\n');
    const restart = new Store(db);
    try {
      expect(readTeamSnapshot(restart, request.snapshot_id)).toMatchObject({ validity_status: 'invalidated' });
    } finally {
      restart.close();
    }
  } finally {
    out.mockRestore();
    err.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});
