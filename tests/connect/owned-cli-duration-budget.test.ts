import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const owner = fileURLToPath(new URL('../../scripts/owned-cli-pty.py', import.meta.url));
// Synthetic time removes scheduling races while retaining the shipped observation and cleanup paths.
const harness = `import ast,json,signal,subprocess,sys,types
with open(sys.argv[1]) as source:
 tree=ast.parse(source.read())
site,outcome,mode=sys.argv[2:]
clock=[99.75];deadline=100;started=99
root=(42,1,42,501,'synthetic root');child=(43,42,43,501,'synthetic child')
known={42:root};proofs={42:None};absent=set();groups={42};alive={42}
pid=42;uid=501;root_exit=None;cleanup_until=None;cleanup_exhausted=False
ownership_failed=False;escape_seen=False;group_changes=[];group_changes_truncated=False
coverage=True;tty_verified=True;status='completed';termination_cause='owner_error'
cfg={'terminationMs':1750,'termGraceMs':100};ps_env={};master=0
ps_query_timeout=.8;pgrep_query_timeout=.9
calls=[];emitted=[];signals=[];group_queries=0;reaped=False
if outcome=='expired' and site!='group-after':
 clock[0]=deadline

def observe(label,kwargs):
 calls.append({'site':label,'timeout':kwargs['timeout'],'now':clock[0],'cleanup':cleanup_until is not None})
 if cleanup_until is None and label==site:
  if outcome=='timeout':
   clock[0]=deadline
   raise subprocess.TimeoutExpired(label,kwargs['timeout'])
  if outcome=='late':
   clock[0]=deadline+.125

def check_output(args,**kwargs):
 member=int(args[-1])
 observe('metadata' if member==42 else 'child-metadata',kwargs)
 if member not in alive:
  raise subprocess.CalledProcessError(1,args)
 return ('%d %d %d %d %s'%(root if member==42 else child)).encode()

def run(args,**kwargs):
 global group_queries
 label='discovery'
 if args[1]=='-g':
  group_queries+=1
  label='group-first' if group_queries==1 else 'group-after'
 observe(label,kwargs)
 ids=b''
 if args[1]=='-g' and 42 in alive:
  ids=b'42'
 if args[1]=='-P' and cleanup_until is None and site in ('discovery','child-metadata') and outcome!='success':
  ids=b'43'
 if args[1]=='-P' and cleanup_until is None and site=='child-metadata':
  ids=b'43'
 if label=='group-first' and site=='group-after':
  clock[0]=deadline if outcome=='expired' else 99.875
 return types.SimpleNamespace(returncode=0 if ids else 1,stdout=ids)

def kill(member,sig):
 signals.append(member)
 alive.discard(member)

def killpg(group,sig):
 if sig==0:
  if group not in alive:
   raise ProcessLookupError()
 else:
  kill(group,sig)

def waitpid(member,flags):
 global reaped
 if member not in alive and not reaped:
  reaped=True
  return (member,signal.SIGTERM)
 return (0,0)

def unexpected_wait(*args):
 raise AssertionError('synthetic deadline/cleanup must not wait')

time=types.SimpleNamespace(monotonic=lambda:clock[0],sleep=unexpected_wait)
os=types.SimpleNamespace(kill=kill,killpg=killpg,waitpid=waitpid,WNOHANG=1,waitstatus_to_exitcode=lambda value:-value,close=lambda fd:None)
select=types.SimpleNamespace(select=unexpected_wait)
emit=emitted.append
subprocess=types.SimpleNamespace(check_output=check_output,run=run,PIPE=-1,DEVNULL=-3,CalledProcessError=subprocess.CalledProcessError,TimeoutExpired=subprocess.TimeoutExpired,SubprocessError=subprocess.SubprocessError)
functions=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name in ('metadata','identity_matches','same','note_group_change','discover','verified_group_members','group_exists')]
exec(compile(ast.Module(body=functions,type_ignores=[]),'<synthetic duration functions>','exec'))
if mode=='query':
 if site=='metadata':
  value=metadata(42)
 elif site in ('discovery','child-metadata'):
  if site=='child-metadata':
   alive.add(43)
  value=discover()
 else:
  value=verified_group_members(42)
 active=[call for call in calls if not call['cleanup']]
 print(json.dumps({
  'verified':value is not None and value is not False,
  'ownershipRejected':ownership_failed if site!='discovery' else value is False,
  'timeouts':[call['timeout'] for call in active if call['site']==site],
  'bounded':all(0<call['timeout']<=min(.8 if call['site'] in ('metadata','child-metadata') else .9,deadline-call['now']) for call in active)
 }))
else:
 owner_try=next(node for node in tree.body if isinstance(node,ast.Try) and node.finalbody)
 active_loop=next(node for node in owner_try.body if isinstance(node,ast.While))
 if site=='child-metadata':
  alive.add(43)
 exec(compile(ast.Module(body=[active_loop],type_ignores=[]),'<synthetic duration loop>','exec'))
 # An unobserved child can escape before cleanup rediscovers the parent.
 exec(compile(ast.Module(body=owner_try.finalbody,type_ignores=[]),'<synthetic duration cleanup>','exec'))
 active=[call for call in calls if not call['cleanup']]
 cleanup=[call for call in calls if call['cleanup']]
 print(json.dumps({
  'result':emitted[0],
  'activeSkipped':not active,
  'activeAfterDeadline':[call['site'] for call in active if call['now']>=deadline],
  'cleanupBudgetMs':round((cleanup_until-cleanup_started)*1000),
  'rediscovered':any(call['site']=='discovery' for call in cleanup),
  'cleanupBounded':all(0<call['timeout']<=min(.8 if call['site'] in ('metadata','child-metadata') else .9,cleanup_until-call['now']) for call in cleanup),
  'rootReaped':reaped,
  'unobservedChildAlive':43 in alive
 }))
`;

function runScenario(site: string, outcome: string, mode = 'query'): unknown {
  return JSON.parse(
    execFileSync('/usr/bin/python3', ['-I', '-c', harness, owner, site, outcome, mode], {
      encoding: 'utf8',
      timeout: 5000
    })
  );
}

for (const site of ['metadata', 'discovery', 'group-first', 'group-after', 'child-metadata'] as const) {
  test.each(['success', 'expired', 'timeout', 'late'])(`${site} clamps active queries and rejects expired, cut-short or late observations: %s`, outcome => {
    const result = runScenario(site, outcome);

    expect(result).toEqual({
      verified: outcome === 'success',
      ownershipRejected: outcome !== 'success',
      timeouts: outcome === 'expired' ? [] : [site === 'group-after' ? 0.125 : 0.25],
      bounded: true
    });
  });
}

test.each([
  ['metadata', 'expired'],
  ['metadata', 'timeout'],
  ['metadata', 'late'],
  ['discovery', 'timeout'],
  ['discovery', 'late'],
  ['child-metadata', 'timeout'],
  ['child-metadata', 'late']
])('duration expiry after %s %s enters separate cleanup without verifying potentially missed members', (site, outcome) => {
  const result = runScenario(site, outcome, 'lifecycle');

  expect(result).toMatchObject({
    result: {
      status: 'failed',
      terminationCause: 'deadline',
      ownershipVerified: false,
      terminationVerified: false,
      ownedMembers: 1,
      exitCode: -15
    },
    activeSkipped: outcome === 'expired',
    activeAfterDeadline: [],
    cleanupBudgetMs: 1750,
    rediscovered: true,
    cleanupBounded: true,
    rootReaped: true,
    unobservedChildAlive: site === 'child-metadata'
  });
});
