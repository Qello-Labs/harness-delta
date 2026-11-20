import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { z } from 'zod';

const owner = fileURLToPath(new URL('../../scripts/owned-cli-pty.py', import.meta.url));
// Observe the unmodified owner's subprocess boundary, never fabricate query results.
const harness = `import json,os,pty,runpy,subprocess,sys
from unittest.mock import patch

owner,config=sys.argv[1:]
sys.argv=[owner,config]
control_read,control_write=os.pipe()
os.dup2(control_read,3)
if control_read!=3:
    os.close(control_read)
original_write=os.write
output=bytearray()
stop_sent=False

def observe_write(fd: int, data: bytes) -> int:
    global stop_sent
    written=original_write(fd,data)
    if fd==1:
        output.extend(data[:written])
        if not stop_sent and b'PS-BUDGET-READY\\n' in bytes(output).replace(b'\\r',b''):
            original_write(control_write,b'stop\\n')
            stop_sent=True
    return written

try:
    with patch('pty.fork',wraps=pty.fork) as fork, \\
         patch('subprocess.check_output',wraps=subprocess.check_output) as ps, \\
         patch('subprocess.run',wraps=subprocess.run) as queries, \\
         patch('os.write',side_effect=observe_write):
        try:
            runpy.run_path(owner,run_name='__main__')
        finally:
            observation={
                'type':'harness',
                'forks':fork.call_count,
                'ready':stop_sent,
                'psTimeouts':[call.kwargs['timeout'] for call in ps.call_args_list],
                'pgrepTimeouts':[call.kwargs['timeout'] for call in queries.call_args_list if call.args[0][0]=='pgrep']
            }
            sys.stderr.write(json.dumps(observation)+'\\n')
            sys.stderr.flush()
finally:
    os.close(3)
    os.close(control_write)
`;

const observationSchema = z.object({
  type: z.literal('harness'),
  forks: z.number().int().nonnegative(),
  ready: z.boolean(),
  psTimeouts: z.array(z.number().finite().positive()),
  pgrepTimeouts: z.array(z.number().finite().positive())
});
const resultSchema = z.object({
  type: z.literal('result'),
  status: z.string(),
  exitCode: z.number().int().nullable(),
  terminationCause: z.string(),
  terminationVerified: z.boolean(),
  ownershipVerified: z.boolean(),
  controllingTerminal: z.boolean(),
  escapedMemberObserved: z.boolean(),
  ownedMembers: z.number().int()
});

function runOwner(budgetJson: string | undefined) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'owned-ps-budget-')));
  try {
    const config = JSON.stringify({
      command: realpathSync(process.execPath),
      args: ['-e', "process.stdin.resume();setTimeout(()=>process.exit(97),10000);process.stdout.write('PS-BUDGET-READY\\n');"],
      cwd: root,
      durationMs: 10000,
      terminationMs: 5000,
      termGraceMs: 100
    });
    // Raw tokens retain NaN and infinities instead of JSON.stringify turning them into null.
    const input = budgetJson === undefined ? config : `${config.slice(0, -1)},"psQueryBudgetMs":${budgetJson}}`;
    const child = spawnSync('/usr/bin/python3', ['-I', '-c', harness, owner, input], {
      cwd: root,
      env: { PATH: '/usr/bin:/bin', HOME: root, TMPDIR: root, LC_ALL: 'C', TZ: 'UTC' },
      encoding: 'utf8',
      timeout: 20000,
      maxBuffer: 65536
    });
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    const lines = child.stderr.trim().split('\n');
    const records = z
      .array(z.object({ type: z.string() }).passthrough())
      .parse(lines.filter(line => line.startsWith('{')).map((line): unknown => JSON.parse(line)));
    return {
      status: child.status,
      diagnostics: lines.filter(line => !line.startsWith('{')),
      observation: observationSchema.parse(records.find(record => record.type === 'harness')),
      result: resultSchema.optional().parse(records.find(record => record.type === 'result'))
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test.each([
  { name: 'absent default', budgetJson: undefined, expectedSeconds: 0.2 },
  { name: 'inclusive lower bound', budgetJson: '200', expectedSeconds: 0.2 },
  { name: 'fractional override', budgetJson: '450.5', expectedSeconds: 0.4505 },
  { name: 'inclusive upper override', budgetJson: '1000', expectedSeconds: 1 }
])(
  'real owner ps queries receive $name without changing pgrep or ownership checks',
  ({ budgetJson, expectedSeconds }) => {
    const result = runOwner(budgetJson);

    expect(result.status).toBe(0);
    expect(result.diagnostics).toEqual([]);
    expect(result.observation).toMatchObject({ forks: 1, ready: true });
    expect(result.observation.psTimeouts[0]).toBe(expectedSeconds);
    expect(result.observation.pgrepTimeouts[0]).toBe(0.2);
    for (const timeout of result.observation.psTimeouts) expect(timeout).toBeLessThanOrEqual(expectedSeconds);
    for (const timeout of result.observation.pgrepTimeouts) expect(timeout).toBeLessThanOrEqual(0.2);
    expect(result.result).toMatchObject({
      status: 'stopped',
      exitCode: -15,
      terminationCause: 'control',
      terminationVerified: true,
      ownershipVerified: true,
      controllingTerminal: true,
      escapedMemberObserved: false,
      ownedMembers: 1
    });
  },
  25000
);

test.each(['true', 'false', 'null', '"1000"', '""', '[]', '{}', 'NaN', 'Infinity', '-Infinity', '199.999', '1000.001', '0', '-1'])(
  'invalid psQueryBudgetMs %s is refused before PTY fork or configured child launch',
  budgetJson => {
    const result = runOwner(budgetJson);

    expect(result.status).toBe(1);
    expect(result.diagnostics).toEqual(['invalid_ps_query_budget']);
    expect(result.observation).toEqual({ type: 'harness', forks: 0, ready: false, psTimeouts: [], pgrepTimeouts: [] });
    expect(result.result).toBeUndefined();
  },
  25000
);
