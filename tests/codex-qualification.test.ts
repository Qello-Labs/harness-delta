import { appendFileSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { Socket } from 'node:net';
import { once } from 'node:events';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';

// Lane budgets below must stay shorter than these timeouts to keep failure reasons visible.
vi.setConfig({ testTimeout: 30000 });
import * as collection from '../src/collection.js';
import { checkCandidatePermissions } from '../src/codex-candidate-permissions.js';
import { prepareCodexQualification } from '../src/codex-qualification.js';
import { codexQualificationFixture as fixture } from './helpers/codex-qualification-fixture.js';

vi.mock('node:child_process',async importOriginal=>{
  const actual=await importOriginal<typeof import('node:child_process')>();
  return {...actual,spawn:vi.fn(actual.spawn)};
});
const readSyntheticSource=collection.readSource;
test('abandoning a primed fixture cannot substitute a later process launch',async()=>{
  const f=fixture();let cleaned=false;
  try{
    const lane=await prepareCodexQualification(f.options);
    const primed=await f.primeNative(lane.argv);
    const exited=once(primed,'exit',{signal:AbortSignal.timeout(3000)});
    f.cleanup();cleaned=true;await exited;
    const next=spawn(process.execPath,['-e','process.exit(0)'],{stdio:'ignore'});
    const result=await once(next,'exit',{signal:AbortSignal.timeout(3000)});
    expect(result[0]).toBe(0);
  }finally{if(!cleaned)f.cleanup();}
});

test('concrete qualification entry registers real lifecycle sources before callback return and preserves initial contexts, root continuation and replay', async () => {
  const f = fixture(); try {
    const lane = await prepareCodexQualification(f.options);
    expect(f.store.eventCount()).toBe(0); expect(lane.argv).toContain('--skip-git-repo-check'); expect(lane.argv).toContain('model_reasoning_effort="high"');
    const result = await lane.run(); expect(result).toMatchObject({ status: 'completed', reason: null, observedRequests: 3, registeredSessions: 2 });
    expect(f.store.all('SELECT * FROM sessions')).toHaveLength(2);
    const rows = f.store.all<{payload:string}>('SELECT payload FROM runtime_evidence').map(r => JSON.parse(r.payload) as {model:string;effort:string});
    expect(rows.filter(r=>r.model==='gpt-6-astra')).toHaveLength(2); expect(rows.filter(r=>r.model==='gpt-6.1-sol')).toHaveLength(1); expect(rows.every(r=>r.effort==='high')).toBe(true);
    await expect(lane.run()).rejects.toThrow('candidate_root_already_started');
    expect(f.store.eventCount()).toBe(3);
  } finally { f.cleanup(); }
});

test.each(['child-id-missing','child-id-null','child-id-malformed','child-id-missing-path'] as const)('child native identity %s is rejected before source access, reservation or linkage without prior spawn progress', async mode => {
  const f=fixture(mode);try{
    const lane=await prepareCodexQualification(f.options);await f.primeNative(lane.argv);const startedAt=Date.now();const result=await lane.run();
    const rootPath=join(f.options.sessionsRoot,'00000000-0000-0000-0000-000000000001.jsonl');
    expect(f.sourceReadSpy.mock.calls.length,JSON.stringify({startedAt,result,timing:f.timing()})).toBeGreaterThan(0);
    expect(f.sourceReadSpy.mock.calls.filter(([path])=>path!==rootPath)).toHaveLength(0);
    expect(existsSync(join(f.options.ledgerDirectory,'codex-candidate','child.reserved'))).toBe(false);
    expect(f.store.all('SELECT id FROM sessions WHERE parent_id IS NOT NULL')).toHaveLength(0);
    expect(f.store.all('SELECT id FROM sessions')).toHaveLength(1);
    expect(result).toMatchObject({status:'stopped',registeredSessions:1,reason:mode==='child-id-null'||mode==='child-id-malformed'?'candidate_handshake_schema_invalid':'candidate_unapproved_handshake'});
    expect(result.diagnostics.some(d=>d.code==='candidate_spawn_progress_observed')).toBe(false);
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({phase:'handshake_schema',field:'hook_schema',code:result.reason})]));
    await expect(lane.run()).rejects.toThrow('candidate_root_already_started');
  }finally{f.cleanup();}
},20000);

test('synthetic interpreter setup longer than handoff timeout does not consume the identity operation budget',async()=>{
  const f=fixture('child-id-missing');f.options.handshakeTimeoutMs=4000;f.options.durationMs=8000;try{
    const lane=await prepareCodexQualification(f.options);await f.primeNative(lane.argv,4200);const result=await lane.run();
    expect(result).toMatchObject({status:'stopped',reason:'candidate_unapproved_handshake',registeredSessions:1});
    expect(f.sourceReadSpy.mock.calls.length).toBeGreaterThan(0);
    expect(existsSync(join(f.options.ledgerDirectory,'codex-candidate','child.reserved'))).toBe(false);
    expect(result.elapsedMs).toBeLessThan(f.options.handshakeTimeoutMs);
  }finally{f.cleanup();}
},20000);

test('synthetic hook interpreter startup stays outside the unchanged stage budgets',async()=>{
  const f=fixture('timing-extra');
  const preload=join(f.dir,'slow-hook-startup.mjs');
  writeFileSync(preload,`import {appendFileSync} from 'node:fs';
await new Promise(resolve=>setTimeout(resolve,2200));
appendFileSync(${JSON.stringify(f.timingPath)},JSON.stringify({phase:'interpreter_setup',pid:process.pid})+'\\n');
`);
  vi.stubEnv('NODE_OPTIONS',`${process.env.NODE_OPTIONS??''} --import=${preload}`);
  try{
    const lane=await prepareCodexQualification(f.options);
    await f.primeNative(lane.argv);
    const result=await lane.run();
    const marks=z.array(z.object({phase:z.string(),pid:z.number().optional()})).parse(f.timing().marks);
    const hookPids=marks.filter(mark=>mark.phase==='hook_ready').map(mark=>mark.pid);
    expect(hookPids).toEqual([expect.any(Number),expect.any(Number)]);
    expect(marks.filter(mark=>mark.phase==='interpreter_setup').map(mark=>mark.pid)).toEqual(expect.arrayContaining(hookPids));
    expect(result,JSON.stringify({result,timing:f.timing()})).toMatchObject({reason:'candidate_unapproved_spawn',registeredSessions:2});
    expect(result.elapsedMs).toBeLessThan(f.options.handshakeTimeoutMs);
  }finally{vi.unstubAllEnvs();f.cleanup();}
},20000);

test.each(['missing', 'late', 'late-partial', 'extra', 'settings', 'nonzero'] as const)('whole entry stops on %s without retrying', async mode => {
  const f = fixture(mode); try { const lane=await prepareCodexQualification(f.options); const result=await lane.run(); expect(result.status).not.toBe('completed'); expect(result.reason).toBe({missing:'candidate_missing_handshake',late:'candidate_late_handshake','late-partial':'candidate_incomplete_initial_source',extra:'candidate_unapproved_handshake',settings:'candidate_unapproved_handshake',nonzero:'candidate_failed'}[mode]); await expect(lane.run()).rejects.toThrow('candidate_root_already_started'); } finally { f.cleanup(); }
},20000);

test.each(['pause','cancel','source-error','relink'] as const)('observer stops active process on %s', async mode => {
  const f=fixture(mode); try {
    const lane=await prepareCodexQualification(f.options); const controller=new AbortController();
    const timer=setInterval(()=>{if(f.store.all('SELECT * FROM sessions').length===2){clearInterval(timer);if(mode==='pause')f.lifecycle.pause('t');else if(mode==='cancel')controller.abort();else if(mode==='relink')f.store.execute('UPDATE sessions SET source_path=? WHERE parent_id IS NULL',[join(f.options.sessionsRoot,'unapproved-source')]);else rmSync(join(f.options.sessionsRoot,'00000000-0000-0000-0000-000000000001.jsonl'));}},5);
    const result=await lane.run({signal:controller.signal});clearInterval(timer);expect(result.status).toBe('stopped');expect(result.reason).toBe({pause:'candidate_inactive_scope',cancel:'candidate_cancelled','source-error':'candidate_source_error',relink:'candidate_scope_mismatch'}[mode]);
  } finally {f.cleanup();}
});


test('prepared lane rechecks authorization/hash/fresh scope and already-aborted cancellation before any launch', async () => {
  for(const invalidation of ['pause','hash','source-layout','cancel'] as const){
    const f=fixture();try{
      const lane=await prepareCodexQualification(f.options);const controller=new AbortController();
      if(invalidation==='pause')f.lifecycle.pause('t');
      if(invalidation==='hash')writeFileSync(f.options.executable,'changed synthetic executable');
      if(invalidation==='source-layout')writeFileSync(join(f.options.sessionsRoot,'unexpected'),'synthetic');
      if(invalidation==='cancel')controller.abort();
      if(invalidation==='cancel')expect(await lane.run({signal:controller.signal})).toMatchObject({status:'stopped',reason:'candidate_cancelled'});
      else await expect(lane.run()).rejects.toThrow({pause:'candidate_inactive_scope',hash:'candidate_executable_mismatch','source-layout':'candidate_invalid_invocation'}[invalidation]);
      expect(existsSync(join(f.options.ledgerDirectory,'codex-candidate','root.reserved'))).toBe(false);
      expect(f.store.eventCount()).toBe(0);
    }finally{f.cleanup();}
  }
});


test.each(['headless-never','auto-review'])('source-shaped headless %s policy retains declared read-only confinement and unchanged flags', async mode => {
  const f=fixture(mode);try{
    const lane=await prepareCodexQualification(f.options);const result=await lane.run();
    expect(result).toMatchObject({status:'completed',reason:null,observedRequests:3,registeredSessions:2});
    expect(lane.argv).toContain('read-only');expect(lane.argv).toContain('approval_policy="on-request"');
    expect(lane.argv.some(value=>value.includes('dangerously'))).toBe(false);
  }finally{f.cleanup();}
});

test('existing authenticated-home opt-in preserves unrelated prior sources and reads only fresh linked callbacks', async () => {
  const f = fixture(); const prior = join(f.options.sessionsRoot, 'prior-native.jsonl');
  writeFileSync(prior, 'PRIVATE_UNRELATED_PRIOR_SOURCE');
  try {
    expect(() => prepareCodexQualification(f.options)).toThrow('candidate_invalid_invocation');
    const lane = await prepareCodexQualification({ ...f.options, reuseExistingHome: true });
    expect(await lane.run()).toMatchObject({ status: 'completed', observedRequests: 3, registeredSessions: 2 });
    expect(f.sourceReadSpy.mock.calls.some(([path]) => path === prior)).toBe(false);
    expect(readFileSync(prior, 'utf8')).toBe('PRIVATE_UNRELATED_PRIOR_SOURCE');
  } finally { f.cleanup(); }
});

test('reusing a home cannot admit a pre-existing exact callback source before bounded content reads', async () => {
  const f = fixture(); const prior = join(f.options.sessionsRoot, '00000000-0000-0000-0000-000000000001.jsonl');
  writeFileSync(prior, 'PRIVATE_PREEXISTING_ROOT');
  try {
    const lane = await prepareCodexQualification({ ...f.options, reuseExistingHome: true }); const result = await lane.run();
    expect(result.status).not.toBe('completed'); expect(result.observedRequests).toBe(0);
    expect(f.sourceReadSpy.mock.calls.some(([path]) => path === prior)).toBe(false);
    expect(f.store.all('SELECT * FROM sessions')).toHaveLength(0);
  } finally { f.cleanup(); }
});

test.each(['wire-mismatch','permissions-missing','profile-write','profile-disabled','split-write','permission-relaxation'])('declared permissions %s stop before baseline/ack or later collection', async mode => {
  const f=fixture(mode);try{
    const lane=await prepareCodexQualification(f.options);const result=await lane.run();
    expect(result.status).toBe('stopped');expect(result.reason).toMatch(/^candidate_permission/);
    if(mode!=='permission-relaxation')expect(f.store.eventCount()).toBe(0);
  }finally{f.cleanup();}
});


test.each(['wire-unknown','wire-missing','source-malformed'])('result diagnoses %s using only fixed safe fields/enums', async mode => {
  const f=fixture(mode);try{
    const lane=await prepareCodexQualification(f.options);const result=await lane.run();
    const encoded=JSON.stringify(result.diagnostics);
    expect(result.status).toBe('stopped');expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining(
      mode==='source-malformed'?{phase:'source_metadata',code:'candidate_source_metadata_invalid'}:{phase:'handshake_schema',field:'permission_mode',wireMode:mode==='wire-unknown'?'unknown':'missing'})]));
    expect(encoded).not.toContain('PRIVATE_');expect(encoded).not.toContain(f.dir);expect(encoded).not.toContain('00000000-0000');
  }finally{f.cleanup();}
});


test('narrow source declaration rejects enabled network, unrestricted/external/unknown profiles and conflicting split while accepting read/deny entries', () => {
  const context={approval_policy:'never',approvals_reviewer:'user',sandbox_policy:{type:'read-only'},permission_profile:{type:'managed',file_system:{type:'restricted',entries:[{path:{type:'special',value:{kind:'root'}},access:'read'},{path:{type:'path',path:'/synthetic/private'},access:'deny'}]},network:'restricted'}};
  expect(checkCandidatePermissions(context,'bypassPermissions')).toMatchObject({declaration:'managed_read_only_restricted',approvalPolicy:'never',reviewer:'user'});
  const changed:Record<string,unknown>[]=[
    {...context,sandbox_policy:{type:'read-only',network_access:true}},
    {...context,permission_profile:{...context.permission_profile,network:'enabled'}},
    {...context,permission_profile:{...context.permission_profile,file_system:{type:'unrestricted'}}},
    {...context,permission_profile:{type:'external',network:'restricted'}},
    {...context,permission_profile:{...context.permission_profile,file_system:{type:'restricted',entries:[{path:{type:'special',value:{kind:'unknown',path:'PRIVATE_UNKNOWN'}},access:'read'}]}}},
    {...context,file_system_sandbox_policy:{kind:'restricted',entries:[]}},
  ];
  for(const declaration of changed)expect(()=>checkCandidatePermissions(declaration,'bypassPermissions')).toThrow('candidate_permissions_invalid');
});


test('permission relaxation appended between handoff validation and Collector read is rejected on the exact projected bytes', async () => {
  const f=fixture();const realRead=readSyntheticSource;let reads=0;let injected=false;
  const acknowledgments=vi.spyOn(Socket.prototype,'end');
  const spy=vi.spyOn(collection,'readSource').mockImplementation(path=>{
    if(path===join(f.options.sessionsRoot,'00000000-0000-0000-0000-000000000001.jsonl')&&++reads===2){
      const row=JSON.parse(readFileSync(path,'utf8').split('\n')[1]!) as {timestamp:string;payload:{permission_profile:{file_system:{entries:{access:string}[]}}}};
      row.timestamp=new Date().toISOString();row.payload.permission_profile.file_system.entries[0]!.access='write';
      appendFileSync(path,JSON.stringify(row)+'\n');injected=true;
    }
    return realRead(path);
  });
  try{const lane=await prepareCodexQualification(f.options);const result=await lane.run();
    expect(injected).toBe(true);expect(acknowledgments.mock.calls.some(args=>args[0]==='ok\n')).toBe(false);expect(result).toMatchObject({status:'stopped',reason:'candidate_permissions_invalid',observedRequests:0});
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({phase:'permissions',field:'permission_profile',wireMode:'bypassPermissions'})]));
  }finally{spy.mockRestore();acknowledgments.mockRestore();f.cleanup();}
});


test.each(['timing-slow','timing-legacy','timing-callback-first'])('stage timing %s preserves slow root reasoning and accepts callback/progress in either order', async mode=>{
  const f=fixture(mode);try{const lane=await prepareCodexQualification(f.options);await f.primeNative(lane.argv);const result=await lane.run();
    expect(result,JSON.stringify({result,timing:f.timing()})).toMatchObject({status:'completed',reason:null,observedRequests:3,registeredSessions:2});
    expect(lane.argv.at(-1)).toContain('V2: fork_turns="none"');expect(lane.argv.at(-1)).toContain('V1: fork_context=false');
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({phase:'progress',code:'candidate_spawn_progress_observed'})]));
    const exported=JSON.stringify(result)+JSON.stringify(f.store.all('SELECT payload FROM runtime_evidence'));
    expect(exported).not.toContain('PRIVATE_');expect(exported).not.toContain('/synthetic/child');expect(exported).not.toContain('00000000-0000');
  }finally{f.cleanup();}
},12000);

test('stage timing starts the bounded missing-child wait only after independently observed persisted spawn progress',async()=>{
  const f=fixture('timing-missing-child');try{const lane=await prepareCodexQualification(f.options);await f.primeNative(lane.argv);const result=await lane.run();
    expect(result).toMatchObject({status:'stopped',reason:'candidate_missing_child_handshake',registeredSessions:1});
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({phase:'progress',code:'candidate_spawn_progress_observed'})]));
    expect(result.elapsedMs).toBeGreaterThan(4000);expect(result.elapsedMs).toBeLessThan(8000);
    await expect(lane.run()).rejects.toThrow('candidate_root_already_started');
  }finally{f.cleanup();}
},12000);

test.each(['timing-no-progress','timing-unknown'])('stage timing %s stays unknown and cannot reset or extend the absolute root deadline',async mode=>{
  const f=fixture(mode);try{
    // Interpreter startup is setup; keep the handoff and absolute runner deadlines unchanged.
    const lane=await prepareCodexQualification(f.options);await f.primeNative(lane.argv);const result=await lane.run();
    expect(result,JSON.stringify({result,timing:f.timing()})).toMatchObject({reason:'candidate_timed_out',registeredSessions:1,observedRequests:0});expect(result.elapsedMs).toBeGreaterThanOrEqual(4300);expect(result.elapsedMs).toBeLessThan(6500);
    expect(result.diagnostics.some(d=>d.code==='candidate_spawn_progress_observed')).toBe(false);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_');await expect(lane.run()).rejects.toThrow('candidate_root_already_started');
  }finally{f.cleanup();}
},12000);

test('stage timing explicitly disabled multi-agent declaration stops distinctly without treating root acknowledgment as tool/auth readiness',async()=>{
  const f=fixture('timing-disabled');try{const lane=await prepareCodexQualification(f.options);await f.primeNative(lane.argv);const result=await lane.run();
    expect(result).toMatchObject({status:'stopped',reason:'candidate_multi_agent_disabled',observedRequests:0});
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({phase:'capability',field:'multi_agent_version',code:'candidate_multi_agent_disabled'})]));
  }finally{f.cleanup();}
},12000);

test.each(['timing-extra','timing-late-reader','timing-conflict','timing-wrong-turn','timing-permissions'])('stage timing %s preserves scope/permission checks before trusting progress',async mode=>{
  const f=fixture(mode);try{const lane=await prepareCodexQualification(f.options);await f.primeNative(lane.argv);const result=await lane.run();
    expect(result.reason).toBe({'timing-extra':'candidate_unapproved_spawn','timing-late-reader':'candidate_missing_child_handshake','timing-conflict':'candidate_unapproved_handshake','timing-wrong-turn':'candidate_scope_mismatch','timing-permissions':'candidate_permissions_invalid'}[mode]);
    if(mode==='timing-conflict')expect(result.registeredSessions).toBe(1);
    if(mode==='timing-late-reader')expect(result.observedRequests).toBe(1);
    if(mode==='timing-permissions')expect(result.diagnostics.some(d=>d.code==='candidate_spawn_progress_observed')).toBe(false);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_');
  }finally{f.cleanup();}
},12000);

test('stage timing elapsed absolute deadline before invocation skips launch and durable reservation',async()=>{
  const f=fixture();f.options.durationMs=4500;f.options.handshakeTimeoutMs=4000;const realNow=Date.now;let reads=0;const clock=vi.spyOn(Date,'now').mockImplementation(()=>realNow()+(reads++===0?0:5000));
  try{const lane=await prepareCodexQualification(f.options);const result=await lane.run();
    expect(result.reason).toBe('candidate_timed_out');expect(result.registeredSessions).toBe(0);
    expect(existsSync(join(f.options.ledgerDirectory,'codex-candidate','root.reserved'))).toBe(false);
    expect(f.store.eventCount()).toBe(0);
  }finally{clock.mockRestore();f.cleanup();}
});


test('whole qualification preserves sanitized native failure signals without changing failed status or retrying', async () => {
  const f=fixture('diagnostic-native-error');try {
    const lane=await prepareCodexQualification(f.options);const result=await lane.run();
    expect(result).toMatchObject({status:'failed',reason:'candidate_failed',registeredSessions:1,observedRequests:0,nativeFailureDiagnostics:{channel:'stderr',signals:[{category:'auth_failed',code:'http_401'}],unknownErrorObserved:false,truncated:false}});
    expect(JSON.stringify(result)).not.toContain('PRIVATE');expect(f.store.eventCount()).toBe(0);
    await expect(lane.run()).rejects.toThrow('candidate_root_already_started');
  }finally{f.cleanup();}
});
