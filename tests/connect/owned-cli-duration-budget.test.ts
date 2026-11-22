import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beforeAll, expect, test } from 'vitest';

const owner = fileURLToPath(new URL('../../scripts/owned-cli-pty.py', import.meta.url));
// Interpreter cold starts need a separate budget from the synthetic-duration cases.
beforeAll(() => {
  execFileSync('/usr/bin/python3', ['-I', '-c', 'pass'], { timeout: 15000 });
}, 20000);

// Synthetic time removes scheduling races while retaining the shipped observation and cleanup paths.
const harness = `import ast,json,signal,subprocess,sys,types
with open(sys.argv[1]) as source:
 tree=ast.parse(source.read())
site,outcome,mode=sys.argv[2:]
clock=[99.75];deadline=100;started=99
root=(42,1,42,501,'synthetic root');child=(43,42,42,501,'synthetic child')
known={42:root};proofs={42:None};absent=set();groups={42};alive={42}
pid=42;uid=501;root_exit=None;cleanup_until=None;cleanup_exhausted=False
ownership_failed=False;escape_seen=False;group_changes=[];group_changes_truncated=False
coverage=True;tty_verified=True;status='completed';termination_cause='owner_error'
cfg={'terminationMs':1750,'termGraceMs':100};ps_env={};master=0
ps_query_timeout=.8;pgrep_query_timeout=.9
calls=[];emitted=[];signals=[];group_queries=0;reaped=False;missing=set()
class ActiveDeadlineReached(Exception):
 pass
if outcome=='expired' and site!='group-after':
 clock[0]=deadline
if outcome=='budget-timeout':
 clock[0]=99
 ps_query_timeout=pgrep_query_timeout=.2

def observe(label,kwargs):
 calls.append({'site':label,'timeout':kwargs['timeout'],'now':clock[0],'cleanup':cleanup_until is not None})
 if cleanup_until is None and label==site:
  if outcome=='timeout':
   clock[0]=deadline
   raise subprocess.TimeoutExpired(label,kwargs['timeout'])
  if outcome=='budget-timeout':
   clock[0]=deadline+.125
   raise subprocess.TimeoutExpired(label,kwargs['timeout'])
  if outcome in ('late','late-absent','late-malformed'):
   clock[0]=deadline+.125

def check_output(args,**kwargs):
 member=int(args[-1])
 observe('metadata' if member==42 else 'child-metadata',kwargs)
 if cleanup_until is None and site==('metadata' if member==42 else 'child-metadata'):
  if outcome=='exit-error':
   raise subprocess.CalledProcessError(2,args)
  if outcome=='late-absent':
   raise subprocess.CalledProcessError(1,args)
  if outcome in ('malformed','late-malformed'):
   return b'invalid'
 if member not in alive:
  raise subprocess.CalledProcessError(1,args)
 return ('%d %d %d %d %s'%(root if member==42 else child)).encode()

def run(args,**kwargs):
 global group_queries
 label='discovery'
 if args[1]=='-g':
  group_queries+=1
  label='group-first' if group_queries==1 else 'group-after'
 if args[1]=='-P' and cleanup_until is None and (site=='child-metadata' or site=='discovery' and outcome!='success'):
  alive.add(43)
 observe(label,kwargs)
 ids=b''
 if args[1]=='-g':
  ids=b' '.join(str(member).encode() for member in sorted(alive))
 if args[1]=='-P' and cleanup_until is None and site in ('discovery','child-metadata') and outcome!='success':
  ids=b'43'
 if args[1]=='-P' and cleanup_until is None and site=='child-metadata':
  ids=b'43'
 if args[1]=='-P' and cleanup_until is not None and mode!='missed' and 42 in alive and 43 in alive:
  ids=b'43'
 if args[1]=='-P' and ids:
  alive.add(43)
 if cleanup_until is None and site==label:
  if outcome=='exit-error':
   return types.SimpleNamespace(returncode=2,stdout=b'')
  if outcome in ('malformed','late-malformed'):
   ids=b'invalid'
 if label=='group-first' and site=='group-after':
  clock[0]=deadline if outcome=='expired' else 99.125 if outcome=='budget-timeout' else 99.875
 return types.SimpleNamespace(returncode=0 if ids else 1,stdout=ids)

def kill(member,sig):
 signals.append(member)
 alive.discard(member)

def killpg(group,sig):
 if sig==0:
  if not alive:
   raise ProcessLookupError()
 else:
  for member in list(alive):
   kill(member,sig)

def waitpid(member,flags):
 global reaped
 if member not in alive and not reaped:
  reaped=True
  return (member,signal.SIGTERM)
 return (0,0)

def unexpected_wait(*args):
 raise AssertionError('synthetic deadline/cleanup must not wait')

def cleanup_tick(seconds):
 if mode!='missed':
  unexpected_wait()
 clock[0]+=seconds

time=types.SimpleNamespace(monotonic=lambda:clock[0],sleep=cleanup_tick)
os=types.SimpleNamespace(kill=kill,killpg=killpg,waitpid=waitpid,WNOHANG=1,waitstatus_to_exitcode=lambda value:-value,close=lambda fd:None)
select=types.SimpleNamespace(select=unexpected_wait)
emit=emitted.append
subprocess=types.SimpleNamespace(check_output=check_output,run=run,PIPE=-1,DEVNULL=-3,CalledProcessError=subprocess.CalledProcessError,TimeoutExpired=subprocess.TimeoutExpired,SubprocessError=subprocess.SubprocessError)
functions=[node for node in tree.body if isinstance(node,ast.ClassDef) and node.name=='ActiveDeadlineReached' or isinstance(node,ast.FunctionDef) and node.name in ('metadata','identity_matches','same','note_group_change','discover','verified_group_members','group_exists')]
exec(compile(ast.Module(body=functions,type_ignores=[]),'<synthetic duration functions>','exec'))
if mode=='query':
 cut=False
 try:
  if site=='metadata':
   value=metadata(42,missing)
  elif site in ('discovery','child-metadata'):
   if site=='child-metadata':
    alive.add(43)
   value=discover()
  else:
   value=verified_group_members(42)
 except ActiveDeadlineReached:
  cut=True;value=None
 except ValueError:
  value=False
 active=[call for call in calls if not call['cleanup']]
 print(json.dumps({
  'verified':value is not None and value is not False and not ownership_failed,
  'ownershipRejected':ownership_failed or value is False,
  'cut':cut,
  'absent':sorted(absent),
  'missing':sorted(missing),
  'childAdmitted':43 in known,
  'timeouts':[call['timeout'] for call in active if call['site']==site],
  'bounded':all(0<call['timeout']<=min(.8 if call['site'] in ('metadata','child-metadata') else .9,deadline-call['now']) for call in active)
 }))
else:
 owner_try=next(node for node in tree.body if isinstance(node,ast.Try) and node.finalbody)
 active_loop=next(node for node in owner_try.body if isinstance(node,ast.While))
 if site=='child-metadata':
  alive.add(43)
 active=ast.Try(body=[active_loop],handlers=owner_try.handlers,orelse=[],finalbody=[])
 exec(compile(ast.fix_missing_locations(ast.Module(body=[active],type_ignores=[])),'<synthetic duration loop>','exec'))
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
      ownershipRejected: false,
      cut: outcome !== 'success',
      absent: [],
      missing: [],
      childAdmitted: site === 'child-metadata' && outcome === 'success',
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
])('duration expiry after %s %s preserves coverage through cleanup rediscovery', (site, outcome) => {
  const result = runScenario(site, outcome, 'lifecycle');

  expect(result).toMatchObject({
    result: {
      status: 'timed_out',
      terminationCause: 'deadline',
      ownershipVerified: true,
      terminationVerified: true,
      ownedMembers: site === 'discovery' || site === 'child-metadata' ? 2 : 1,
      exitCode: -15
    },
    activeSkipped: outcome === 'expired',
    activeAfterDeadline: [],
    cleanupBudgetMs: 1750,
    rediscovered: true,
    cleanupBounded: true,
    rootReaped: true,
    unobservedChildAlive: false
  });
});

test('a cut hiding a member that cleanup cannot rediscover still fails closed', () => {
  expect(runScenario('discovery', 'timeout', 'missed')).toMatchObject({
    result: { status: 'failed', terminationCause: 'deadline', ownershipVerified: false, terminationVerified: false, ownedMembers: 1 },
    rediscovered: true,
    rootReaped: true,
    unobservedChildAlive: true
  });
});

test('a late ps absence records neither known absence nor a missing candidate', () => {
  expect(runScenario('metadata', 'late-absent')).toMatchObject({
    verified: false,
    ownershipRejected: false,
    cut: true,
    absent: [],
    missing: []
  });
});

for (const site of ['metadata', 'discovery', 'group-first', 'group-after', 'child-metadata'] as const) {
  test.each(['budget-timeout', 'exit-error', 'malformed', 'late-malformed'])(`${site} genuine query failure stays fail-closed: %s`, outcome => {
    expect(runScenario(site, outcome)).toMatchObject({ verified: false, ownershipRejected: true, cut: false, childAdmitted: false });
  });
}
