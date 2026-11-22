import { execFileSync, spawnSync } from 'node:child_process';
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

owner,config,*fault=sys.argv[1:]
sys.argv=[owner,config]
control_read,control_write=os.pipe()
os.dup2(control_read,3)
if control_read!=3:
    os.close(control_read)
original_write=os.write
output=bytearray()
stop_sent=False
timeout_sent=False
original_run=subprocess.run

def observe_query(args, **kwargs):
    global timeout_sent
    if fault and args[0]=='pgrep' and not timeout_sent:
        timeout_sent=True
        raise subprocess.TimeoutExpired(args,kwargs['timeout'])
    return original_run(args,**kwargs)

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
         patch('subprocess.run',side_effect=observe_query) as queries, \\
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

function runOwner(budgetJson: string | undefined, field: 'psQueryBudgetMs' | 'pgrepQueryBudgetMs' = 'psQueryBudgetMs', forcePgrepTimeout = false) {
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
    const input = budgetJson === undefined ? config : `${config.slice(0, -1)},"${field}":${budgetJson}}`;
    const child = spawnSync('/usr/bin/python3', ['-I', '-c', harness, owner, input, ...(forcePgrepTimeout ? ['pgrep_timeout'] : [])], {
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

for (const query of [
  {
    name: 'ps',
    field: 'psQueryBudgetMs',
    selected: 'psTimeouts',
    other: 'pgrepTimeouts',
    defaultSeconds: 0.5,
    otherSeconds: 0.5,
    error: 'invalid_ps_query_budget',
    status: 1
  },
  {
    name: 'pgrep',
    field: 'pgrepQueryBudgetMs',
    selected: 'pgrepTimeouts',
    other: 'psTimeouts',
    defaultSeconds: 0.5,
    otherSeconds: 0.5,
    error: 'invalid_pgrep_query_budget',
    status: 2
  }
] as const) {
  test.each([
    { name: 'absent default', budgetJson: undefined, expectedSeconds: query.defaultSeconds },
    { name: 'inclusive lower bound', budgetJson: '200', expectedSeconds: 0.2 },
    { name: 'fractional override', budgetJson: '450.5', expectedSeconds: 0.4505 },
    { name: 'inclusive upper override', budgetJson: '1000', expectedSeconds: 1 }
  ])(
    `real owner ${query.name} queries receive $name without changing other queries or ownership checks`,
    ({ budgetJson, expectedSeconds }) => {
      const result = runOwner(budgetJson, query.field);

      expect(result.status).toBe(0);
      expect(result.diagnostics).toEqual([]);
      expect(result.observation).toMatchObject({ forks: 1, ready: true });
      expect(result.observation[query.selected][0]).toBe(expectedSeconds);
      expect(result.observation[query.other][0]).toBe(query.otherSeconds);
      for (const timeout of result.observation[query.selected]) expect(timeout).toBeLessThanOrEqual(expectedSeconds);
      for (const timeout of result.observation[query.other]) expect(timeout).toBeLessThanOrEqual(query.otherSeconds);
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
    `invalid ${query.field} %s is refused before PTY fork or configured child launch`,
    budgetJson => {
      const result = runOwner(budgetJson, query.field);

      expect(result.status).toBe(query.status);
      expect(result.diagnostics).toEqual([query.error]);
      expect(result.observation).toEqual({ type: 'harness', forks: 0, ready: false, psTimeouts: [], pgrepTimeouts: [] });
      expect(result.result).toBeUndefined();
    },
    25000
  );
}

test.each([undefined, '1000'])(
  'pgrep timeout with budget %s still fails real owner verification',
  budgetJson => {
    const result = runOwner(budgetJson, 'pgrepQueryBudgetMs', true);

    expect(result.status).toBe(0);
    expect(result.diagnostics).toEqual([]);
    expect(result.observation).toMatchObject({ forks: 1, ready: true });
    expect(result.result).toMatchObject({
      status: 'failed',
      terminationCause: 'control',
      ownershipVerified: false,
      terminationVerified: false,
      controllingTerminal: true,
      escapedMemberObserved: false,
      ownedMembers: 1
    });
  },
  25000
);

test('discovery and both group queries clamp the override to the remaining cleanup deadline', () => {
  const code = `import ast,json,sys,types
tree=ast.parse(open(sys.argv[1]).read())
out=[]
for name,times in [('discover',[99.75]),('verified_group_members',[99.25,99.875])]:
 fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name==name)
 clock=iter(times);calls=[];record=(42,1,42,501,'synthetic root')
 def run(args,**kwargs):
  calls.append(kwargs['timeout'])
  return types.SimpleNamespace(returncode=1 if args[1]=='-P' else 0,stdout=b'' if args[1]=='-P' else b'42')
 ns={'known':{42:record},'absent':set(),'proofs':{42:None},'pid':42,'uid':501,'escape_seen':False,'ownership_failed':False,'cleanup_until':100,'pgrep_query_timeout':1,'metadata':lambda p:record,'identity_matches':lambda a,b:a==b,'note_group_change':lambda *a:None,'time':types.SimpleNamespace(monotonic=lambda:next(clock)),'subprocess':types.SimpleNamespace(run=run,SubprocessError=Exception,PIPE=-1,DEVNULL=-3)}
 exec(compile(ast.Module(body=[fn],type_ignores=[]),'<synthetic cleanup query deadline>','exec'),ns)
 result=ns[name]() if name=='discover' else ns[name](42)
 out.append({'function':name,'timeouts':calls,'verified':result is not None and result is not False,'failed':ns['ownership_failed']})
print(json.dumps(out))`;
  const result: unknown = JSON.parse(execFileSync('/usr/bin/python3', ['-I', '-c', code, owner], { encoding: 'utf8', timeout: 5000 }));

  expect(result).toEqual([
    { function: 'discover', timeouts: [0.25], verified: true, failed: false },
    { function: 'verified_group_members', timeouts: [0.75, 0.125], verified: true, failed: false }
  ]);
});
