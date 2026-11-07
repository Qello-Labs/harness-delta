import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync, appendFileSync, statSync, readdirSync } from 'node:fs';
import * as fs from 'node:fs';
import { watch } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { OwnedCliInvocation } from '../../src/connect/owned-cli-invocation.js';
import {
  prepareCodexSessionBindingQualification,
  executeCodexSessionBindingQualification,
  codexBindingQualificationArgv,
  serveCodexSessionBindingQualificationUiPreparation,
  serveCodexSessionBindingQualificationResults
} from '../../src/qualification/codex-session-binding-qualification.js';
import { createLocalWebDomain } from '../../src/web/local-web-domain.js';
import {
  assertBindingQualification,
  issueCodexBindingLease,
  noteQualificationCollectorError,
  qualificationCollectorError
} from '../../src/binding/session-binding-qualification-lease.js';
import * as qualificationLease from '../../src/binding/session-binding-qualification-lease.js';
import { Store } from '../../src/store.js';
import { EventSchema, SourceCompatibilitySchema } from '../../src/contracts.js';
import { z } from 'zod';
import * as priceSelection from '../../src/pricing/price-catalog-selection.js';
import * as localWeb from '../../src/web/local-web-domain.js';
import * as localServer from '../../src/web/local-web-server.js';
import { command as runFixtureCommand } from '../../src/instrumented-codex/instrumented-codex-qualification.js';
import { createSessionBindingService } from '../../src/session-binding-service.js';
import { CodexSessionBindingProvider } from '../../src/session-binding-codex.js';
import { comparisonProtocol, protocolRow } from '../../src/core/protocol-store.js';
import * as bindingService from '../../src/session-binding-service.js';
import Database from 'better-sqlite3';
import { codexBindingAdmission } from '../../src/codex-binding-admission.js';
import { prepareBindingQualificationFixture } from '../helpers/codex-binding-qualification-fixture.js';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, openSync: vi.fn(actual.openSync) };
});

const digest = (s: Buffer | string) => createHash('sha256').update(s).digest('hex');
function fixture(mode = 'normal') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ordinary-binding-qualification-')));
  const home = join(root, 'home');
  mkdirSync(home);
  mkdirSync(join(home, 'sessions'));
  const scenarioMode = mode.startsWith('scenario-');
  const scenarioChildren = mode.includes('family') ? 2 : 0;
  const budgetMode = mode.startsWith('scenario-budget-');
  if (scenarioMode) vi.useFakeTimers({ toFake: ['Date'] });
  const deterministic = scenarioMode || mode.startsWith('six-requests') || mode.startsWith('late-');
  const stimulusPids: number[] = [];
  const stimulusController = new AbortController();
  const serverFactory = localServer.createLocalWebServer;
  // Harness helpers must not enter the process tree whose disappearance is measured.
  const stimulus = vi.spyOn(localServer, 'createLocalWebServer').mockImplementation(options => {
    const app = serverFactory(options);
    app.post('/synthetic-stimulus', async request => {
      const input = z
        .discriminatedUnion('operation', [
          z.strictObject({ operation: z.literal('hook'), payload: z.record(z.string(), z.unknown()) }),
          z.strictObject({ operation: z.literal('connect'), receipt: z.uuid() }),
          z.strictObject({ operation: z.literal('advance') })
        ])
        .parse(request.body);
      if (input.operation === 'advance') {
        vi.setSystemTime(Date.now() + 100);
        return { now: new Date().toISOString() };
      }
      const intent = z
        .object({
          node: z.string(),
          project: z.string(),
          wrapper: z.string(),
          codex_home: z.string(),
          connector: z.string().nullable(),
          project_id: z.string(),
          task_id: z.string()
        })
        .parse(JSON.parse(readFileSync(join(root, 'attempt', 'execution-intent.json'), 'utf8')));
      const env = { ...process.env, CODEX_HOME: intent.codex_home };
      const signal = AbortSignal.any([stimulusController.signal, AbortSignal.timeout(4000)]);
      const output =
        input.operation === 'hook'
          ? await runFixtureCommand(intent.wrapper, [], intent.project, env, Buffer.from(JSON.stringify(input.payload)), [0], signal)
          : await runFixtureCommand(
              intent.node,
              mode.startsWith('six-requests') || scenarioMode
                ? [z.string().parse(intent.connector), '--receipt', input.receipt]
                : [
                    join(intent.project, '.agents/skills/harness-connect/scripts/connect.mjs'),
                    'connect',
                    '--origin',
                    options.origin,
                    '--product',
                    'codex',
                    '--project',
                    intent.project_id,
                    '--task',
                    intent.task_id,
                    '--receipt',
                    input.receipt
                  ],
              intent.project,
              env,
              undefined,
              [0],
              signal
            );
      stimulusPids.push(process.pid);
      const response: unknown = input.operation === 'hook' ? JSON.parse(output.toString('utf8')) : { connected: true };
      return response;
    });
    return app;
  });

  const uiAction = `const b=await(await fetch(origin+'/api/bootstrap')).json();const action=async code=>{const current=await(await fetch(origin+'/api/tasks/'+i.task_id)).json();const response=await fetch(origin+'/api/tasks/'+i.task_id+'/'+code,{method:'POST',headers:{origin,'content-type':'application/json','x-harness-csrf':b.csrf,'idempotency-key':randomUUID(),'if-match':current.version},body:'{}'});if(!response.ok)throw Error(code+response.status);return await response.json();};`;
  const followUp: Record<string, string> = {
    'root-stop': "for(let n=0;n<2;n++)appendFileSync(file(root),usage(root,'extra-'+n));await new Promise(r=>setTimeout(r,1200));",
    'token-stop': "appendFileSync(file(root),usage(root,'token-boundary','gpt-6.1-sol',99958));await new Promise(r=>setTimeout(r,1200));",
    'child-overflow': "appendFileSync(file(children[0]),usage(children[0],'extra-child'));await new Promise(r=>setTimeout(r,1200));",
    'late-request': "writeFileSync(join(i.directory,'late-record.json'),JSON.stringify({file:file(root),bytes:usage(root,'late-turn')}));",
    'late-runtime': "writeFileSync(join(i.directory,'late-record.json'),JSON.stringify({file:file(root),bytes:usage(root,'late-turn','wrong-model')}));",
    'late-tokens': "writeFileSync(join(i.directory,'late-record.json'),JSON.stringify({file:file(root),bytes:usage(root,'late-turn','gpt-6.1-sol',100000)}));",
    'late-gap': "writeFileSync(join(i.directory,'late-record.json'),JSON.stringify({file:file(root),bytes:row('compacted',{})}));",
    'pause-exit': uiAction + "await action('pause');await new Promise(r=>setTimeout(r,1000));",
    emergency: uiAction + "await action('emergency-stop');await new Promise(r=>setTimeout(r,1000));",
    'pause-resume':
      uiAction +
      `for(let cycle=0;cycle<2;cycle++){await action('pause');appendFileSync(file(root),usage(root,'paused-'+cycle));const before=await(await fetch(origin+'/api/tasks/'+i.task_id)).json();if(before.measurement.state!=='paused'||before.binding.requests!==3||before.actions.some(a=>['apply','ticket','connect','rework','release'].includes(a.code)&&a.enabled)||before.actions.some(a=>a.code.startsWith('finish-')&&a.enabled))throw Error('paused contract');await action('resume-binding');}await new Promise(r=>setTimeout(r,350));`,
    continued:
      uiAction +
      `await action('pause');const pending=usage(root,'continued-turn').split('\\n');appendFileSync(file(root),pending[0]+'\\n');await action('resume-binding');appendFileSync(file(root),pending[1]+'\\n');await new Promise(r=>setTimeout(r,350));`
  };
  const script = join(root, 'native-fixture.mjs');
  writeFileSync(
    script,
    `import{readFileSync,writeFileSync,appendFileSync,mkdirSync}from'node:fs';import{watch}from'node:fs/promises';import{join}from'node:path';import{randomUUID}from'node:crypto';
 const i=JSON.parse(readFileSync(process.env.HARNESS_BINDING_TEST_INTENT,'utf8'));const origin='http://127.0.0.1:'+i.port;const root=randomUUID();const children=${scenarioMode ? `Array.from({length:${scenarioChildren}},()=>randomUUID())` : '[randomUUID(),randomUUID()]'};let syntheticNow;const at=()=>syntheticNow??new Date().toISOString();const row=(type,payload)=>JSON.stringify({timestamp:at(),type,payload})+'\\n';
 const stimulus=async body=>{const bootstrap=await(await fetch(origin+'/api/bootstrap')).json();const response=await fetch(origin+'/synthetic-stimulus',{method:'POST',headers:{origin,'content-type':'application/json','x-harness-csrf':bootstrap.csrf},body:JSON.stringify(body),signal:AbortSignal.timeout(4000)});if(!response.ok)throw Error('synthetic_stimulus_failed');return await response.json();};
 ${mode === 'deadline-before-connect' ? 'setInterval(()=>{},1000);await new Promise(()=>{});' : ''}
 ${
   mode === 'attention-notification' || mode === 'attention-publication-failure'
     ? `
 ${mode === 'attention-publication-failure' ? "mkdirSync(join(i.directory,'native-attention.json'));" : ''}
 const denied=(async()=>{for await(const event of watch(i.directory,{signal:AbortSignal.timeout(4000)})){if(event.filename==='operator-deny')return;}throw Error('synthetic_denial_missing');})();
 process.stdout.write('\\x1b]9;synthetic private command notification\\x07');
 await denied;process.exit(0);
 `
     : ''
 }
 const file=id=>join(i.codex_home,'sessions',id+'.jsonl');const meta=(id,parent)=>row('session_meta',{id,session_id:root,cwd:i.project,cli_version:i.product_version,parent_thread_id:parent,source:parent?{subagent:{thread_spawn:{parent_thread_id:parent,depth:1}}}:'cli'});
 ${budgetMode ? "syntheticNow=(await stimulus({operation:'advance'})).now;" : ''}
 writeFileSync(file(root),meta(root,null));const record=async(id,parent)=>{const payload={hook_event_name:parent?'SubagentStart':'SessionStart',session_id:root,agent_id:parent?id:undefined,turn_id:parent?'child-turn':undefined,source:parent?undefined:'startup',cwd:i.project,transcript_path:file(id)};const output=await stimulus({operation:'hook',payload});return /[a-f0-9-]{36}/.exec(output.hookSpecificOutput.additionalContext)[0];};
 const usage=(id,turn,model='gpt-6.1-sol',input=${mode === 'six-requests-tokens' || mode.startsWith('six-requests-late-tokens') ? 20000 : 10})=>row('turn_context',{cwd:i.project,turn_id:turn,root_turn_id:id===root?turn:'root-turn',model,effort:'high'})+row('token_usage_record',{thread_id:id,session_id:root,turn_id:turn,root_turn_id:id===root?turn:'root-turn',response_id:randomUUID(),usage:{input_tokens:input,cached_input_tokens:2,output_tokens:3,reasoning_output_tokens:1,total_tokens:input+3}});
 ${mode === 'baseline' || mode === 'root-stop' ? "appendFileSync(file(root),usage(root,'baseline-turn'));" : ''}
 ${budgetMode ? "for(let n=0;n<2;n++)appendFileSync(file(root),usage(root,'setup-'+n));" : ''}
 ${mode.startsWith('six-requests-staged') ? "for(let n=0;n<2;n++)appendFileSync(file(root),usage(root,'connection-turn'));" : ''}
 const receipt=await record(root,null);await stimulus({operation:'connect',receipt});
 ${
   scenarioMode
     ? `
 const signal=filename=>(async()=>{for await(const event of watch(i.directory,{signal:AbortSignal.timeout(6000)})){if(event.filename===filename)return;}throw Error('synthetic_completion_missing');})();
 const collected=signal('collector-before-restart');
 syntheticNow=(await stimulus({operation:'advance'})).now;
 for(const child of children){writeFileSync(file(child),meta(child,root));await record(child,root);}
 for(let n=0;n<${budgetMode ? 4 : 1};n++)appendFileSync(file(root),usage(root,'root-before-'+n));
 for(const child of children)appendFileSync(file(child),usage(child,'child-turn'));
 await collected;
 ${uiAction}
 ${
   mode.includes('missing-restart')
     ? ''
     : `
 await action('pause');
 syntheticNow=(await stimulus({operation:'advance'})).now;
 appendFileSync(file(root),${mode.includes('context-only') ? "usage(root,'root-offline').split('\\n')[0]+'\\n'" : "usage(root,'root-offline')"});
 await action('resume-binding');
 `
 }
 const completed=signal('collector-complete');
 syntheticNow=(await stimulus({operation:'advance'})).now;
 appendFileSync(file(root),usage(root,${mode.includes('stale-context') || mode.includes('context-only') ? "'root-offline'" : "'root-after'"},'gpt-6.1-sol',${mode === 'scenario-budget-family-token-stop' ? 299880 : 10}));
 ${mode === 'scenario-budget-root-stop' || mode === 'scenario-budget-family-total-stop' ? "for(let n=0;n<2;n++)appendFileSync(file(root),usage(root,'stop-'+n));" : ''}
 ${mode === 'scenario-budget-family-child-stop' ? "appendFileSync(file(children[0]),usage(children[0],'second-child'));" : ''}
 writeFileSync(join(i.directory,'scenario-final-ready'),'');
 await completed;process.exit(0);
 `
     : ''
 }
 ${mode.startsWith('six-requests-staged') ? "appendFileSync(file(root),usage(root,'connection-turn').split('\\n')[1]+'\\n');" : ''}
 ${
   deterministic
     ? `
 const completion=(async()=>{for await(const event of watch(i.directory,{signal:AbortSignal.timeout(4000)})){if(event.filename==='collector-complete')return;}throw Error('synthetic_completion_missing');})();
 for(const child of children){writeFileSync(file(child),meta(child,root));await record(child,root);}
 for(let n=0;n<${mode.startsWith('late-') ? 1 : 4};n++)appendFileSync(file(root),usage(root,'root-'+n));
 for(const child of children)appendFileSync(file(child),usage(child,'child-turn'));
 ${mode.startsWith('late-') ? followUp[mode] : ''}
    ${mode === 'six-requests-ordinary-child-overflow' ? "appendFileSync(file(children[0]),usage(children[0],'extra-child'));" : ''}
 ${mode === 'six-requests-late-one' || mode === 'six-requests-late-over-limit' ? `writeFileSync(join(i.directory,'late-record.json'),JSON.stringify({file:file(root),bytes:${mode === 'six-requests-late-over-limit' ? "Array.from({length:5},(_,n)=>usage(root,'late-root-'+n)).join('')" : "usage(root,'late-root-5')"}}));` : ''}
 ${mode.startsWith('six-requests-late-tokens') ? `writeFileSync(join(i.directory,'late-record.json'),JSON.stringify({file:file(root),bytes:usage(root,'late-root-5','gpt-6.1-sol',${mode === 'six-requests-late-tokens-at-limit' ? 79979 : 79980})}));` : ''}
    await completion;
    ${mode.includes('ordinary') ? `const dto=await(await fetch(origin+'/api/tasks/'+i.task_id)).json();writeFileSync(join(i.directory,'ordinary-dto.json'),JSON.stringify(dto));` : ''}
    process.exit(0);
 `
     : `
 await new Promise(r=>setTimeout(r,30));for(const child of children){writeFileSync(file(child),meta(child,root));await record(child,root);}
 for(const id of[root,...children]){appendFileSync(file(id),row('turn_context',{cwd:i.project,turn_id:id===root?'root-turn':'child-turn',root_turn_id:'root-turn',model:'gpt-6.1-sol',effort:'high'})+row('token_usage_record',{thread_id:id,session_id:root,turn_id:id===root?'root-turn':'child-turn',root_turn_id:'root-turn',response_id:randomUUID(),usage:{input_tokens:10,cached_input_tokens:2,output_tokens:3,reasoning_output_tokens:1,total_tokens:13}}));}
 for(let n=0;n<150;n++){const t=await(await fetch(origin+'/api/tasks/'+i.task_id)).json();if(t.binding?.requests===3&&t.binding.children===2){${followUp[mode] ?? ''}process.exit(0);}await new Promise(r=>setTimeout(r,20));}process.exit(4);
 `
 }
 `
  );
  let completionObserved = false;
  let beforeRestartObserved = false;
  let expiredClock: string | null = null;
  const bindingFactory = bindingService.createSessionBindingService;
  const clockOverride =
    mode === 'six-requests-staged-window-expiry'
      ? vi
          .spyOn(bindingService, 'createSessionBindingService')
          .mockImplementation(options => bindingFactory({ ...options, clock: () => expiredClock ?? new Date().toISOString() }))
      : undefined;
  const factory = localWeb.createLocalWebDomain;
  // Keep the real collector and snapshot; only deliver its exact completion state.
  const observation = deterministic
    ? vi.spyOn(localWeb, 'createLocalWebDomain').mockImplementation(options => {
        const domain = factory(options);
        if (options.qualificationLease || options.bindingObservation) {
          const task = domain.task.bind(domain);
          domain.task = id => {
            const snapshot = task(id);
            const binding = snapshot.binding;
            if (scenarioMode && binding && typeof binding === 'object' && 'requests' in binding) {
              if (!beforeRestartObserved && binding.requests === (budgetMode ? 4 : 1) + scenarioChildren) {
                beforeRestartObserved = true;
                writeFileSync(join(root, 'attempt', 'collector-before-restart'), '');
              }
              if (!completionObserved && !mode.endsWith('-stop') && binding.requests === (budgetMode ? 5 : 2) + scenarioChildren) {
                completionObserved = true;
                writeFileSync(join(root, 'attempt', 'collector-complete'), '');
              }
            }
            if (
              !scenarioMode &&
              !completionObserved &&
              binding &&
              typeof binding === 'object' &&
              'roots' in binding &&
              binding.roots === 1 &&
              'children' in binding &&
              binding.children === 2 &&
              'requests' in binding &&
              binding.requests === (mode.startsWith('late-') ? 3 : 6)
            ) {
              completionObserved = true;
              if (mode === 'six-requests-staged-window-expiry') {
                const contract = z
                  .object({ ends_at: z.string() })
                  .parse(options.store.get('SELECT ends_at FROM external_task_contracts WHERE task_id=?', [id]));
                expiredClock = new Date(Date.parse(contract.ends_at) + 1).toISOString();
              } else writeFileSync(join(root, 'attempt', 'collector-complete'), '');
            }
            return snapshot;
          };
        }
        return domain;
      })
    : undefined;
  let finalInjectionObserved = false;
  const beforeFinalSourceCheck =
    mode.startsWith('late-') ||
    mode === 'six-requests-late-one' ||
    mode === 'six-requests-late-over-limit' ||
    mode.startsWith('six-requests-late-tokens') ||
    mode === 'six-requests-pin-conflict' ||
    mode === 'six-requests-event-compat-conflict'
      ? (native: { status: string; terminationVerified: boolean }) => {
          expect(native).toMatchObject({ status: 'completed', terminationVerified: true });
          if (mode === 'six-requests-pin-conflict' || mode === 'six-requests-event-compat-conflict') {
            const db = new Store(join(root, 'attempt', 'measurement.sqlite'));
            try {
              if (mode === 'six-requests-pin-conflict') {
                const row = db.get<{ session_id: string; payload: string }>('SELECT session_id,payload FROM session_source_compatibility LIMIT 1');
                if (!row) throw new Error('synthetic_pin_missing');
                const pin = SourceCompatibilitySchema.parse(JSON.parse(row.payload));
                // Model corrupted storage without disabling the immutable-update trigger.
                db.execute('INSERT OR REPLACE INTO session_source_compatibility(session_id,payload) VALUES (?,?)', [
                  row.session_id,
                  JSON.stringify({ ...pin, state: 'verified' })
                ]);
              } else {
                const row = db.get<{
                  id: string;
                  project_id: string;
                  task_id: string;
                  session_id: string;
                  source_key: string;
                  occurred_at: string;
                  payload: string;
                }>("SELECT id,project_id,task_id,session_id,source_key,occurred_at,payload FROM events WHERE json_extract(payload,'$.kind')='usage' LIMIT 1");
                if (!row) throw new Error('synthetic_event_missing');
                const payload: unknown = JSON.parse(row.payload);
                const event = EventSchema.parse({ ...row, payload });
                if (event.payload.kind !== 'usage' || !event.payload.source_compatibility) throw new Error('synthetic_compatibility_missing');
                db.execute('UPDATE events SET payload=? WHERE id=?', [
                  JSON.stringify({ ...event.payload, source_compatibility: { ...event.payload.source_compatibility, state: 'verified' } }),
                  row.id
                ]);
              }
            } finally {
              db.close();
            }
            finalInjectionObserved = true;
            return;
          }
          const late = JSON.parse(readFileSync(join(root, 'attempt', 'late-record.json'), 'utf8')) as { file: string; bytes: string };
          appendFileSync(late.file, late.bytes);
          finalInjectionObserved = true;
        }
      : undefined;
  return {
    root,
    home,
    script,
    dir: join(root, 'attempt'),
    dependency: {
      script,
      durationMs: mode === 'deadline-before-connect' ? 500 : scenarioMode ? 12000 : 5000,
      ...(beforeFinalSourceCheck ? { beforeFinalSourceCheck } : {})
    },
    stimulusPids: () => stimulusPids,
    completionObserved: () => completionObserved,
    finalInjectionObserved: () => finalInjectionObserved,
    cleanup: () => {
      stimulusController.abort();
      stimulus.mockRestore();
      observation?.mockRestore();
      clockOverride?.mockRestore();
      if (scenarioMode) vi.useRealTimers();
      rmSync(root, { recursive: true, force: true });
    }
  };
}
const consent = (sha: string) => ({
  intent_sha256: sha,
  approval_reference: 'synthetic-test-only',
  actual_model_run: true,
  transient_hooks: true,
  native_source_reads: true,
  owned_process_termination: true
});
test.each([
  ['root_normal_observer_restart', 'scenario-root', 0, null],
  ['family_normal_observer_restart', 'scenario-family', 2, null],
  ['family_normal_observer_restart', 'scenario-root', 2, 'binding_qualification_evidence_incomplete'],
  ['root_normal_observer_restart', 'scenario-family', 0, 'binding_qualification_observer_failed'],
  ['root_normal_observer_restart', 'scenario-root-missing-restart', 0, 'binding_qualification_observer_restart_incomplete'],
  ['family_normal_observer_restart', 'scenario-family-missing-restart', 2, 'binding_qualification_observer_restart_incomplete'],
  ['root_normal_observer_restart', 'scenario-root-stale-context', 0, 'binding_qualification_observer_restart_incomplete'],
  ['root_normal_observer_restart', 'scenario-root-context-only', 0, 'binding_qualification_observer_restart_incomplete'],
  ['family_normal_observer_restart', 'scenario-family-context-only', 2, 'binding_qualification_observer_restart_incomplete']
] as const)(
  '0.166 scenario %s with %s requires frozen topology and observed restart',
  async (scenario, mode, plannedChildren, reason) => {
    const f = fixture(mode);
    const sourceOpens = vi.mocked(fs.openSync);
    sourceOpens.mockClear();
    try {
      const input = { binary: realpathSync(process.execPath), codexHome: f.home, productVersion: '0.166.0', route: 'ordinary_admission' as const, scenario };
      const p = await prepareCodexSessionBindingQualification(f.dir, input, f.dependency);
      expect(p.intent).toMatchObject({
        scenario,
        planned_children: plannedChildren,
        root_request_stop: 10,
        observed_request_stop: 12,
        observed_token_stop: 300000
      });
      const result = await executeCodexSessionBindingQualification(p.intentPath, { ...consent(p.sha256), network_command_permission: true }, f.dependency);
      expect(result, JSON.stringify(result)).toMatchObject({
        status: reason ? 'failed' : 'completed',
        reason,
        ordinary_admission_verified: false,
        native: { terminationVerified: true }
      });
      if (mode === 'scenario-root-stale-context')
        expect(result).toMatchObject({
          status: 'failed',
          reason: 'binding_qualification_observer_restart_incomplete',
          binding: { requests: 2 },
          observer_restart: { new_root_context_measured: false },
          native: { terminationVerified: true }
        });
      if (mode.includes('context-only'))
        expect(result).toMatchObject({
          binding: { requests: 2 + plannedChildren },
          observer_restart: { new_root_context_measured: false },
          native: { status: 'completed', terminationVerified: true }
        });
      if (mode === 'scenario-family' && plannedChildren === 0)
        expect(result).toMatchObject({ collector_error: 'unknown_collector_error', binding: { children: 0 } });
      if (mode === 'scenario-family' && plannedChildren === 0) {
        const receipts = readdirSync(p.intent.receipts)
          .filter(name => name.endsWith('.json'))
          .map(name =>
            z
              .object({ event: z.enum(['SessionStart', 'SubagentStart']), sourceRef: z.string() })
              .parse(JSON.parse(readFileSync(join(p.intent.receipts, name), 'utf8')))
          );
        const root = receipts.find(receipt => receipt.event === 'SessionStart')!;
        expect(receipts.filter(receipt => receipt.event === 'SubagentStart')).toHaveLength(2);
        const opened = sourceOpens.mock.calls.map(([path]) => String(path)).filter(path => path.startsWith(join(f.home, 'sessions') + '/'));
        expect(opened.length).toBeGreaterThan(0);
        expect(new Set(opened)).toEqual(new Set([root.sourceRef]));
      }
      if (reason === null)
        expect(result).toMatchObject({
          ordinary_path_verified: true,
          binding: { roots: 1, children: plannedChildren, requests: 2 + plannedChildren },
          observer_restart: { same_source: true, fresh_baseline: true, new_root_context_measured: true },
          independent_source_check: {
            sources: 1 + plannedChildren,
            observed_request_matches: 2 + plannedChildren,
            native_owned_requests: 3 + plannedChildren,
            excluded_baseline_requests: 1
          }
        });
    } finally {
      sourceOpens.mockClear();
      f.cleanup();
    }
  },
  20000
);

test.each([
  ['0.166.0', 'root', 'scenario-root', 10, 10, 130, ['root_request_limit'], 'binding_qualification_request_limit'],
  ['0.166.0', 'total', 'scenario-family', 10, 12, 156, ['root_request_limit', 'total_request_limit'], 'binding_qualification_request_limit'],
  ['0.166.0', 'tokens', 'scenario-root', 4, 4, 300000, ['token_limit'], 'binding_qualification_token_limit'],
  ['0.163.0', 'tokens', 'six-requests', 5, 7, 200000, ['token_limit'], null]
] as const)(
  '%s final %s stop equality after owned exit',
  async (productVersion, stop, mode, rootRequests, totalRequests, tokens, reached, reason) => {
    const f = fixture(mode);
    const bindingFactory = bindingService.createSessionBindingService;
    let service: ReturnType<typeof createSessionBindingService> | undefined;
    const binding = vi.spyOn(bindingService, 'createSessionBindingService').mockImplementation(options => {
      service = bindingFactory(options);
      return service;
    });
    const issue = qualificationLease.issueCodexBindingLease;
    let lease: ReturnType<typeof issueCodexBindingLease> | undefined;
    const issued = vi.spyOn(qualificationLease, 'issueCodexBindingLease').mockImplementation((...args) => {
      lease = issue(...args);
      return lease;
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Called only with the original owning instance.
    const run = OwnedCliInvocation.prototype.run;
    let collectedAfterExit = false;
    const owned = vi.spyOn(OwnedCliInvocation.prototype, 'run').mockImplementation(async function (this: OwnedCliInvocation, signal) {
      const native = await run.call(this, signal);
      expect(native).toMatchObject({ status: 'completed', terminationVerified: true });
      expect(this.isAlive()).toBe(false);
      if (!lease || !service) throw new Error('synthetic_collector_missing');
      const intent = z
        .object({ database: z.string(), task_id: z.string(), project: z.string(), root_request_stop: z.number(), observed_token_stop: z.number() })
        .parse(JSON.parse(readFileSync(join(f.dir, 'execution-intent.json'), 'utf8')));
      const db = new Store(intent.database);
      try {
        const root = z.object({ identity: z.string() }).parse(db.get('SELECT identity FROM session_bindings WHERE session_id=root_id'));
        const identity = z.object({ sessionId: z.string(), sourceRef: z.string() }).parse(JSON.parse(root.identity));
        const before = [...qualificationLease.qualificationRecordedRequests(lease).values()];
        const count = stop === 'tokens' ? 1 : intent.root_request_stop - before.filter(record => record.sessionId === identity.sessionId).length;
        const beforeTokens = before.reduce((n, record) => n + (record.payload.input_total.value ?? 0) + (record.payload.output_total.value ?? 0), 0);
        const input = stop === 'tokens' ? intent.observed_token_stop - beforeTokens - 3 : 10;
        for (let n = 0; n < count; n++) {
          const turn = 'final-stop-' + n;
          const timestamp = new Date().toISOString();
          appendFileSync(
            identity.sourceRef,
            JSON.stringify({
              timestamp,
              type: 'turn_context',
              payload: { cwd: intent.project, turn_id: turn, root_turn_id: turn, model: 'gpt-6.1-sol', effort: 'high' }
            }) +
              '\n' +
              JSON.stringify({
                timestamp,
                type: 'token_usage_record',
                payload: {
                  thread_id: identity.sessionId,
                  session_id: identity.sessionId,
                  turn_id: turn,
                  root_turn_id: turn,
                  response_id: randomUUID(),
                  usage: { input_tokens: input, cached_input_tokens: 2, output_tokens: 3, reasoning_output_tokens: 1, total_tokens: input + 3 }
                }
              }) +
              '\n'
          );
        }
        await service.tick(intent.task_id);
        expect(this.isAlive()).toBe(false);
        expect(qualificationLease.qualificationStopWitness(lease, 'safety_limit')).toMatchObject({
          safety: { root_requests: rootRequests, total_requests: totalRequests, input_output_tokens: tokens, reached }
        });
        const observed = db.all<{ request_key: string }>('SELECT request_key FROM binding_requests');
        const covered = new Set([...qualificationLease.qualificationBaselineKeys(lease), ...observed.map(row => row.request_key)]);
        expect(new Set(qualificationLease.qualificationRecordedRequests(lease).keys())).toEqual(covered);
        expect(observed).toHaveLength(totalRequests - (productVersion === '0.166.0' ? 1 : 0));
        collectedAfterExit = true;
      } finally {
        db.close();
      }
      return native;
    });
    try {
      const p = await prepareCodexSessionBindingQualification(
        f.dir,
        {
          binary: realpathSync(process.execPath),
          codexHome: f.home,
          productVersion,
          route: 'ordinary_admission',
          ...(productVersion === '0.166.0'
            ? { scenario: mode === 'scenario-family' ? ('family_normal_observer_restart' as const) : ('root_normal_observer_restart' as const) }
            : {})
        },
        f.dependency
      );
      const result = await executeCodexSessionBindingQualification(p.intentPath, { ...consent(p.sha256), network_command_permission: true }, f.dependency);
      expect(collectedAfterExit, JSON.stringify(result)).toBe(true);
      expect(result, JSON.stringify(result)).toMatchObject({
        status: reason ? 'failed' : 'completed',
        reason,
        phase: 'source_check',
        observer_stop_reason: null,
        collector_error: null,
        ordinary_path_verified: reason === null,
        native: { status: 'completed', exitCode: 0, terminationVerified: true },
        binding: { requests: totalRequests - (productVersion === '0.166.0' ? 1 : 0) }
      });
      if (reason) expect(result).toMatchObject({ first_diagnostic: { stage: 'source_check', code: reason } });
      else
        expect(result).toMatchObject({
          independent_source_check: { native_owned_requests: totalRequests, observed_request_matches: totalRequests, excluded_baseline_requests: 0 }
        });
    } finally {
      owned.mockRestore();
      issued.mockRestore();
      binding.mockRestore();
      f.cleanup();
    }
  },
  20000
);

test('0.166 budget permits historical-shaped family counts through normal observer restart', async () => {
  const f = fixture('scenario-budget-family');
  try {
    const p = await prepareCodexSessionBindingQualification(
      f.dir,
      {
        binary: realpathSync(process.execPath),
        codexHome: f.home,
        productVersion: '0.166.0',
        route: 'ordinary_admission',
        scenario: 'family_normal_observer_restart'
      },
      f.dependency
    );
    const result = await executeCodexSessionBindingQualification(p.intentPath, { ...consent(p.sha256), network_command_permission: true }, f.dependency);
    expect(result, JSON.stringify(result)).toMatchObject({
      status: 'completed',
      reason: null,
      ordinary_path_verified: true,
      ordinary_admission_verified: false,
      native: { status: 'completed', terminationVerified: true },
      binding: { roots: 1, children: 2, requests: 7 },
      observer_restart: { same_source: true, fresh_baseline: true, new_root_context_measured: true },
      independent_source_check: { sources: 3, observed_request_matches: 7, native_owned_requests: 10, excluded_baseline_requests: 3 }
    });
    const receipts = readdirSync(p.intent.receipts)
      .filter(name => name.endsWith('.json'))
      .map(name => z.object({ event: z.string(), sourceRef: z.string() }).parse(JSON.parse(readFileSync(join(p.intent.receipts, name), 'utf8'))));
    const root = receipts.find(receipt => receipt.event === 'SessionStart');
    if (!root) throw new Error('synthetic_root_missing');
    const rows = readFileSync(root.sourceRef, 'utf8')
      .trim()
      .split('\n')
      .map(row => z.object({ type: z.string(), payload: z.record(z.string(), z.unknown()) }).parse(JSON.parse(row)));
    expect(rows.filter(row => row.type === 'token_usage_record')).toHaveLength(8);
    expect(rows.filter(row => row.type === 'turn_context' && row.payload.turn_id === 'root-after')).toHaveLength(1);
  } finally {
    f.cleanup();
  }
}, 20000);

test.each([
  ['scenario-budget-root-stop', 'root_normal_observer_restart', 10, 10, 130, ['root_request_limit'], null],
  ['scenario-budget-family-total-stop', 'family_normal_observer_restart', 10, 12, 156, ['root_request_limit', 'total_request_limit'], null],
  ['scenario-budget-family-token-stop', 'family_normal_observer_restart', 8, 10, 300000, ['token_limit'], null],
  [
    'scenario-budget-family-child-stop',
    'family_normal_observer_restart',
    8,
    10,
    130,
    [],
    { own_requests: 2, total_requests: 11, reached: ['child_request_limit'] }
  ]
] as const)(
  '0.166 budget %s stops the real runner at its exact boundary',
  async (mode, scenario, rootRequests, totalRequests, tokens, reached, attempted) => {
    const f = fixture(mode);
    try {
      const p = await prepareCodexSessionBindingQualification(
        f.dir,
        { binary: realpathSync(process.execPath), codexHome: f.home, productVersion: '0.166.0', route: 'ordinary_admission', scenario },
        f.dependency
      );
      const result = await executeCodexSessionBindingQualification(p.intentPath, { ...consent(p.sha256), network_command_permission: true }, f.dependency);
      expect(result, JSON.stringify(result)).toMatchObject({
        status: 'failed',
        ordinary_path_verified: false,
        ordinary_admission_verified: false,
        native: { status: 'stopped', terminationVerified: true },
        stop_witness: {
          predicate: attempted ? 'collector_limit' : 'safety_limit',
          safety: { root_requests: rootRequests, total_requests: totalRequests, input_output_tokens: tokens, excluded_baseline_requests: 3, reached },
          attempted
        }
      });
    } finally {
      f.cleanup();
    }
  },
  20000
);

test.each([
  ['0.166.0', { root_request_stop: 8, observed_request_stop: 10, observed_token_stop: 200000 }],
  ['0.163.0', { root_request_stop: 10, observed_request_stop: 12, observed_token_stop: 300000 }]
] as const)('version %s rejects another version budget before reservation', async (productVersion, stops) => {
  const f = fixture('scenario-family');
  try {
    const p = await prepareCodexSessionBindingQualification(
      f.dir,
      {
        binary: realpathSync(process.execPath),
        codexHome: f.home,
        productVersion,
        route: 'ordinary_admission',
        ...(productVersion === '0.166.0' ? { scenario: 'family_normal_observer_restart' } : {})
      },
      f.dependency
    );
    writeFileSync(p.intentPath, JSON.stringify({ ...p.intent, ...stops }));
    await expect(
      executeCodexSessionBindingQualification(p.intentPath, { ...consent(p.sha256), network_command_permission: true }, f.dependency)
    ).rejects.toThrow('binding_qualification_invalid_intent');
    const store = new Store(p.intent.database);
    try {
      expect(store.get('SELECT reserved FROM binding_qualification')).toEqual({ reserved: 0 });
    } finally {
      store.close();
    }
    expect(() => readFileSync(join(p.intent.directory, 'execution.reserved'))).toThrow();
  } finally {
    f.cleanup();
  }
});

test('0.166 root final reconciliation never opens an unexpected child source', async () => {
  const f = fixture('scenario-root');
  const sourceOpens = vi.mocked(fs.openSync);
  sourceOpens.mockClear();
  try {
    let lateReceiptWritten = false;
    const dependency = {
      ...f.dependency,
      beforeFinalSourceCheck() {
        const receipts = readdirSync(join(f.dir, 'receipts'))
          .filter(name => name.endsWith('.json'))
          .map(name =>
            z
              .object({ event: z.enum(['SessionStart', 'SubagentStart']), sessionId: z.string(), sourceRef: z.string() })
              .parse(JSON.parse(readFileSync(join(f.dir, 'receipts', name), 'utf8')))
          );
        const root = receipts.find(receipt => receipt.event === 'SessionStart')!;
        const child = randomUUID();
        const source = join(f.home, 'sessions', child + '.jsonl');
        writeFileSync(
          source,
          JSON.stringify({
            timestamp: new Date().toISOString(),
            type: 'session_meta',
            payload: {
              id: child,
              session_id: root.sessionId,
              parent_thread_id: root.sessionId,
              cwd: join(f.dir, 'project'),
              cli_version: '0.166.0',
              source: { subagent: { thread_spawn: { parent_thread_id: root.sessionId, depth: 1 } } }
            }
          }) + '\n'
        );
        const stat = statSync(source);
        execFileSync(
          realpathSync(process.execPath),
          [
            join(process.cwd(), 'scripts/session-binding-codex-hook.mjs'),
            '--receipt-directory',
            join(f.dir, 'receipts'),
            '--source-root',
            join(f.home, 'sessions'),
            '--product-version',
            '0.166.0'
          ],
          {
            cwd: join(f.dir, 'project'),
            input: JSON.stringify({
              hook_event_name: 'SubagentStart',
              session_id: root.sessionId,
              agent_id: child,
              turn_id: 'unexpected-child',
              cwd: join(f.dir, 'project'),
              transcript_path: source
            }),
            timeout: 5000
          }
        );
        lateReceiptWritten = true;
        vi.setSystemTime(Math.max(vi.getRealSystemTime(), stat.birthtimeMs, stat.mtimeMs) + 1);
      }
    };
    const p = await prepareCodexSessionBindingQualification(
      f.dir,
      {
        binary: realpathSync(process.execPath),
        codexHome: f.home,
        productVersion: '0.166.0',
        route: 'ordinary_admission',
        scenario: 'root_normal_observer_restart'
      },
      dependency
    );
    const result = await executeCodexSessionBindingQualification(p.intentPath, { ...consent(p.sha256), network_command_permission: true }, dependency);
    expect(result).toMatchObject({ status: 'failed', ordinary_admission_verified: false, native: { terminationVerified: true } });
    expect(lateReceiptWritten).toBe(true);
    const roots = readdirSync(p.intent.receipts)
      .filter(name => name.endsWith('.json'))
      .map(name =>
        z
          .object({ event: z.enum(['SessionStart', 'SubagentStart']), sourceRef: z.string() })
          .parse(JSON.parse(readFileSync(join(p.intent.receipts, name), 'utf8')))
      )
      .filter(receipt => receipt.event === 'SessionStart');
    expect(roots).toHaveLength(1);
    const opened = sourceOpens.mock.calls.map(([path]) => String(path)).filter(path => path.startsWith(join(f.home, 'sessions') + '/'));
    expect(opened.length).toBeGreaterThan(0);
    expect(new Set(opened)).toEqual(new Set([roots[0]!.sourceRef]));
  } finally {
    sourceOpens.mockClear();
    f.cleanup();
  }
}, 20000);

test.each([
  ['0.166.0', 'qualification', 'root_normal_observer_restart'],
  ['0.166.0', 'ordinary_admission', undefined],
  ['0.166.0', 'ordinary_admission', 'unknown'],
  ['0.163.0', 'ordinary_admission', 'root_normal_observer_restart']
] as const)('scenario preparation refuses %s %s %s before directory creation', async (productVersion, route, scenario) => {
  const f = fixture();
  try {
    await expect(
      prepareCodexSessionBindingQualification(
        f.dir,
        { binary: realpathSync(process.execPath), codexHome: f.home, productVersion, route, ...(scenario ? { scenario } : {}) },
        f.dependency
      )
    ).rejects.toThrow('binding_qualification_invalid_intent');
    expect(() => statSync(f.dir)).toThrow();
  } finally {
    f.cleanup();
  }
});

test.each(['scenario', 'planned_children', 'route'] as const)('0.166 frozen %s drift refuses before reservation', async field => {
  const f = fixture();
  try {
    const input = {
      binary: realpathSync(process.execPath),
      codexHome: f.home,
      productVersion: '0.166.0',
      route: 'ordinary_admission' as const,
      scenario: 'root_normal_observer_restart'
    };
    const p = await prepareCodexSessionBindingQualification(f.dir, input, f.dependency);
    writeFileSync(
      p.intentPath,
      JSON.stringify({ ...p.intent, [field]: field === 'scenario' ? 'family_normal_observer_restart' : field === 'route' ? 'qualification' : 2 })
    );
    await expect(
      executeCodexSessionBindingQualification(p.intentPath, { ...consent(p.sha256), network_command_permission: true }, f.dependency)
    ).rejects.toThrow('binding_qualification_invalid_intent');
    expect(() => statSync(join(f.dir, 'execution.reserved'))).toThrow();
  } finally {
    f.cleanup();
  }
});
test.each([
  ['0.162.1', 'codex-binding-01621-direct-family-v1', 'verified', 'verified_bounded_family'],
  ['0.163.0', 'codex-binding-01630-direct-family-v1', 'verified', 'verified_bounded_family']
] as const)(
  'ordinary %s observes root4 child1 each without qualification authority or complete cost',
  async (productVersion, profileId, state, support) => {
    const f = fixture('six-requests-staged-ordinary');
    try {
      const p = await prepareCodexSessionBindingQualification(
        f.dir,
        { binary: realpathSync(process.execPath), codexHome: f.home, productVersion, route: 'ordinary_admission' },
        f.dependency
      );

      const result = await executeCodexSessionBindingQualification(p.intentPath, { ...consent(p.sha256), network_command_permission: true }, f.dependency);

      expect(f.completionObserved(), JSON.stringify(result)).toBe(true);
      expect(f.stimulusPids()).toEqual(Array.from({ length: 4 }, () => process.pid));
      expect(result, JSON.stringify(result)).toMatchObject({
        route: 'ordinary_admission',
        ordinary_path_verified: true,
        ordinary_admission_verified: false,
        validation_kind: 'synthetic',
        status: 'completed',
        reason: null,
        collector_error: null,
        safety_usage_verification: 'verified',
        native: { status: 'completed', exitCode: 0, ownershipVerified: true, terminationVerified: true, ownedMembers: 1 },
        binding: { roots: 1, children: 2, requests: 6 },
        product_gate_delta: false,
        complete_cost: null,
        hard_billing_bound: null,
        independent_source_check: {
          sources: 3,
          observed_request_matches: 6,
          native_owned_requests: 9,
          excluded_baseline_requests: 3,
          scope: 'exact_new_linked_sources',
          complete_cost: false
        }
      });
      const options = vi.mocked(localWeb.createLocalWebDomain).mock.calls.find(([o]) => o.bindingObservation)?.[0];
      expect(options).toBeDefined();
      expect(options).not.toHaveProperty('qualificationLease');
      expect(options).not.toHaveProperty('humanPilot');
      expect(options).not.toHaveProperty('nativePilot');
      const dto = z
        .object({
          binding: z.object({ support: z.string(), roots: z.number(), children: z.number(), requests: z.number() }),
          support_details: z.object({ family: z.string() }),
          actions: z.array(z.object({ code: z.string(), enabled: z.boolean() }))
        })
        .passthrough()
        .parse(JSON.parse(readFileSync(join(f.dir, 'ordinary-dto.json'), 'utf8')));
      expect(dto.binding).toEqual({ support, roots: 1, children: 2, requests: 6 });
      expect(dto.support_details.family).toBe(support);
      expect(dto.actions.filter(a => !['session-connect', 'pause', 'resume-binding', 'emergency-stop'].includes(a.code)).every(a => !a.enabled)).toBe(true);
      const store = new Store(p.intent.database);
      try {
        const pins = store.all<{ payload: string }>('SELECT payload FROM session_source_compatibility');
        expect(pins).toHaveLength(3);
        for (const pin of pins)
          expect(SourceCompatibilitySchema.parse(JSON.parse(pin.payload))).toMatchObject({
            state,
            source: 'codex_binding',
            product_version: productVersion,
            parser_version: productVersion,
            profile_id: profileId
          });
        const counts = store.all<{ requests: number }>(
          'SELECT count(*) AS requests FROM binding_requests r JOIN events e ON e.id=r.event_id GROUP BY e.session_id ORDER BY requests'
        );
        expect(counts.map(c => c.requests)).toEqual([1, 1, 4]);
      } finally {
        store.close();
      }
    } finally {
      f.cleanup();
    }
  },
  10000
);

test('ordinary observation safety rejects a second child request without granting qualification authority', async () => {
  const f = fixture('six-requests-ordinary-child-overflow');
  try {
    const p = await prepareCodexSessionBindingQualification(
      f.dir,
      { binary: realpathSync(process.execPath), codexHome: f.home, productVersion: '0.162.1', route: 'ordinary_admission' },
      f.dependency
    );

    const result = await executeCodexSessionBindingQualification(p.intentPath, { ...consent(p.sha256), network_command_permission: true }, f.dependency);

    expect(result, JSON.stringify(result)).toMatchObject({
      route: 'ordinary_admission',
      ordinary_admission_verified: false,
      status: 'failed',
      collector_error: 'binding_qualification_request_limit',
      native: { terminationVerified: true },
      complete_cost: null,
      product_gate_delta: false
    });
  } finally {
    f.cleanup();
  }
}, 10000);

test('ordinary preparation freezes the same read-only recipe and all 0.162.1 safety bounds', async () => {
  const p = await prepareBindingQualificationFixture('0.162.1', 'ordinary_admission');
  try {
    expect(p.intent).toMatchObject({
      route: 'ordinary_admission',
      product_version: '0.162.1',
      root_model: 'gpt-6.1-sol',
      child_model: 'gpt-6.1-sol',
      effort: 'high',
      planned_roots: 1,
      planned_children: 2,
      root_request_stop: 8,
      child_request_stop: 1,
      observed_request_stop: 10,
      observed_token_stop: 200000,
      helper_network_permission: 'single_command_network_only',
      profile: { execution: { sandbox: 'read-only', timeout_ms: 900000, poll_ms: 250 } },
      product_gate_delta: false,
      hard_billing_bound: null
    });
    expect(p.intent.ordinary_snapshot_sha256).toMatch(/^[a-f0-9]{64}$/);
    const store = new Store(p.intent.database);
    try {
      const protocol = comparisonProtocol(store, protocolRow(store, 'qualification-protocol'));
      expect(protocol).toMatchObject({
        purpose: 'functional_pilot',
        followup_seconds: 900,
        source_profiles: [{ product: 'codex', product_version: '0.162.1', profile_id: codexBindingAdmission.profileId }]
      });
      expect(protocolRow(store, 'qualification-protocol').status).toBe('frozen');
    } finally {
      store.close();
    }
    const argv = codexBindingQualificationArgv(p.intent);
    expect(argv).toContain('approval_policy="on-request"');
    expect(argv).toContain('agents.max_depth=1');
    expect(argv).toContain('--no-daemon');
    expect(argv).toContain('agents.default_subagent_model="gpt-6.1-sol"');
    expect(argv).toContain('agents.default_subagent_reasoning_effort="high"');
  } finally {
    p.cleanup();
  }
});

test('ordinary admission refuses legacy versions before creating preparation files', async () => {
  const f = fixture();
  try {
    await expect(
      prepareCodexSessionBindingQualification(
        f.dir,
        { binary: realpathSync(process.execPath), codexHome: f.home, productVersion: '0.160.0', route: 'ordinary_admission' },
        f.dependency
      )
    ).rejects.toThrow('binding_qualification_invalid_intent');
    expect(() => statSync(f.dir)).toThrow();
  } finally {
    f.cleanup();
  }
});

for (const change of ['route', 'version', 'profile', 'metadata-profile', 'metadata-task', 'protocol', 'intent-bytes'] as const)
  test(`ordinary ${change} drift refuses execution before reservation`, async () => {
    const p = await prepareBindingQualificationFixture('0.162.1', 'ordinary_admission');
    try {
      if (change === 'route') writeFileSync(p.intentPath, JSON.stringify({ ...p.intent, route: 'qualification' }));
      else if (change === 'version') writeFileSync(p.intentPath, JSON.stringify({ ...p.intent, product_version: '0.160.0' }));
      else if (change === 'profile')
        writeFileSync(
          p.intentPath,
          JSON.stringify({ ...p.intent, profile: { ...p.intent.profile, execution: { ...p.intent.profile.execution, sandbox: 'workspace-write' } } })
        );
      else if (change === 'intent-bytes') writeFileSync(p.intentPath, readFileSync(p.intentPath, 'utf8') + '\n');
      else if (change === 'protocol') {
        const store = new Store(p.intent.database);
        try {
          store.execute("UPDATE comparison_protocols SET status='draft' WHERE id='qualification-protocol'", []);
        } finally {
          store.close();
        }
      } else {
        const metadata = new Database(p.intent.metadata);
        try {
          if (change === 'metadata-profile')
            metadata
              .prepare('UPDATE web_profiles SET payload=? WHERE id=?')
              .run(
                JSON.stringify({ ...p.intent.profile, session_binding: { ...p.intent.profile.session_binding, source_roots: [p.root] } }),
                p.intent.profile.id
              );
          else metadata.prepare('UPDATE web_tasks SET profile_id=? WHERE id=?').run('other-profile', p.intent.task_id);
        } finally {
          metadata.close();
        }
      }

      await expect(
        executeCodexSessionBindingQualification(p.intentPath, { ...consent(p.sha256), network_command_permission: true }, p.fixture)
      ).rejects.toThrow(
        change === 'route' || change === 'version' || change === 'profile' ? 'binding_qualification_invalid_intent' : 'binding_qualification_drift'
      );

      expect(() => statSync(join(p.intent.directory, 'execution.reserved'))).toThrow();
      const store = new Store(p.intent.database);
      try {
        expect(store.get<{ reserved: number }>('SELECT reserved FROM binding_qualification')?.reserved).toBe(0);
        expect(store.eventCount()).toBe(0);
      } finally {
        store.close();
      }
    } finally {
      p.cleanup();
    }
  });

test('an omitted legacy route remains qualification and cannot report ordinary admission', async () => {
  const f = fixture('six-requests');
  try {
    const p = await prepareCodexSessionBindingQualification(
      f.dir,
      { binary: realpathSync(process.execPath), codexHome: f.home, productVersion: '0.162.1' },
      f.dependency
    );
    const { route, ordinary_snapshot_sha256: snapshot, ...legacy } = p.intent;
    expect(route).toBe('qualification');
    expect(snapshot).toBeNull();
    const bytes = JSON.stringify(legacy);
    writeFileSync(p.intentPath, bytes);
    const store = new Store(p.intent.database);
    try {
      store.execute('UPDATE binding_qualification SET intent_hash=?', [digest(bytes)]);
    } finally {
      store.close();
    }

    const result = await executeCodexSessionBindingQualification(p.intentPath, { ...consent(digest(bytes)), network_command_permission: true }, f.dependency);

    expect(result, JSON.stringify(result)).toMatchObject({
      route: 'qualification',
      ordinary_admission_verified: false,
      status: 'completed',
      product_gate_delta: false,
      complete_cost: null
    });
  } finally {
    f.cleanup();
  }
}, 10000);

for (const [productVersion, followupSeconds] of [
  ['0.160.0', 180],
  ['0.162.1', 900]
] as const)
  test(`qualification freezes ${productVersion} collection window independently of fixture runtime`, async () => {
    const f = fixture();
    try {
      const p = await prepareCodexSessionBindingQualification(
        f.dir,
        { binary: realpathSync(process.execPath), codexHome: f.home, productVersion },
        f.dependency
      );
      const store = new Store(p.intent.database);
      try {
        expect(comparisonProtocol(store, protocolRow(store, 'qualification-protocol')).followup_seconds).toBe(followupSeconds);
        expect(p.intent.duration_ms).toBe(5000);
      } finally {
        store.close();
      }
    } finally {
      f.cleanup();
    }
  });

test('expired collection window stops a completely observed staged family with its fixed diagnostic', async () => {
  const f = fixture('six-requests-staged-window-expiry');
  try {
    const p = await prepareCodexSessionBindingQualification(
      f.dir,
      { binary: realpathSync(process.execPath), codexHome: f.home, productVersion: '0.162.1' },
      f.dependency
    );
    const result = await executeCodexSessionBindingQualification(p.intentPath, { ...consent(p.sha256), network_command_permission: true }, f.dependency);
    expect(f.completionObserved()).toBe(true);
    expect(result).toMatchObject({
      status: 'failed',
      reason: 'binding_qualification_observer_failed',
      collector_error: 'external_window_closed',
      first_diagnostic: { stage: 'collector', code: 'external_window_closed' },
      native: { status: 'stopped', ownershipVerified: true, terminationVerified: true },
      binding: { roots: 1, children: 2, requests: 6 },
      stop_witness: { predicate: 'lease_invalid', safety: { root_requests: 7, total_requests: 9, excluded_baseline_requests: 3, reached: [] } },
      independent_source_check: { reason: 'task_paused_no_source_read' }
    });
  } finally {
    f.cleanup();
  }
}, 10000);

test('target attention file wakes before owned exit without retaining content or granting permission', async () => {
  const f = fixture('attention-notification');
  const controller = new AbortController();
  let execution: ReturnType<typeof executeCodexSessionBindingQualification> | undefined;
  try {
    const p = await prepareCodexSessionBindingQualification(
      f.dir,
      { binary: realpathSync(process.execPath), codexHome: f.home, productVersion: '0.162.1' },
      f.dependency
    );
    const attention = (async () => {
      for await (const event of watch(f.dir, { signal: controller.signal })) {
        if (event.filename === 'native-attention.json') return;
      }
      throw new Error('synthetic_attention_missing');
    })();
    let ended = false;
    execution = executeCodexSessionBindingQualification(p.intentPath, { ...consent(p.sha256), network_command_permission: true }, f.dependency);
    void execution.then(() => {
      ended = true;
    });
    try {
      await Promise.race([
        attention,
        execution.then(() => {
          throw new Error('synthetic_attention_missing_before_exit');
        })
      ]);
      const notification = z
        .strictObject({
          schema_version: z.literal(1),
          event: z.literal('native_terminal_attention'),
          intent_sha256: z.string(),
          notification_count: z.number().int().positive()
        })
        .parse(JSON.parse(readFileSync(join(f.dir, 'native-attention.json'), 'utf8')));
      expect(notification).toEqual({ schema_version: 1, event: 'native_terminal_attention', intent_sha256: p.sha256, notification_count: 1 });
      expect(statSync(join(f.dir, 'native-attention.json')).mode & 0o077).toBe(0);
      expect(ended).toBe(false);
    } finally {
      writeFileSync(join(f.dir, 'operator-deny'), '');
      controller.abort();
    }
    await expect(execution).resolves.toMatchObject({
      status: 'failed',
      reason: 'binding_qualification_evidence_incomplete',
      native: { status: 'completed', terminationVerified: true },
      binding: { roots: 0, children: 0, requests: 0 }
    });
  } finally {
    controller.abort();
    try {
      await execution;
    } finally {
      f.cleanup();
    }
  }
}, 10000);

test('attention publication failure after reservation stops the owned trial without overwriting its target', async () => {
  const f = fixture('attention-publication-failure');
  try {
    const p = await prepareCodexSessionBindingQualification(
      f.dir,
      { binary: realpathSync(process.execPath), codexHome: f.home, productVersion: '0.162.1' },
      f.dependency
    );
    const attention = join(f.dir, 'native-attention.json');
    const result = await executeCodexSessionBindingQualification(p.intentPath, { ...consent(p.sha256), network_command_permission: true }, f.dependency);
    expect(result).toMatchObject({
      status: 'failed',
      reason: 'binding_qualification_attention_failed',
      first_diagnostic: { stage: 'owner_run', code: 'binding_qualification_attention_failed' },
      native: { status: 'stopped', terminationVerified: true },
      binding: { roots: 0, children: 0, requests: 0 }
    });
    expect(statSync(attention).isDirectory()).toBe(true);
  } finally {
    f.cleanup();
  }
}, 10000);

for (const productVersion of ['0.162.1', '0.163.0'])
  for (const [mode, reason] of [
    ['six-requests', null],
    ['six-requests-staged', null],
    ['six-requests-tokens', null],
    ['six-requests-late-tokens-at-limit', 'binding_qualification_final_unobserved_request'],
    ['six-requests-late-tokens-over-limit', 'binding_qualification_token_limit'],
    ['six-requests-late-one', 'binding_qualification_final_unobserved_request'],
    ['six-requests-late-over-limit', 'binding_qualification_request_limit'],
    ['six-requests-pin-conflict', 'binding_qualification_counter_mismatch'],
    ['six-requests-event-compat-conflict', 'binding_qualification_counter_mismatch']
  ] as const)
    test(`synthetic ${productVersion} execution reserves and tears down root4 plus child1 each with ${mode}`, async () => {
      const f = fixture(mode);
      try {
        const p = await prepareCodexSessionBindingQualification(
          f.dir,
          { binary: realpathSync(process.execPath), codexHome: f.home, productVersion },
          f.dependency
        );
        expect(p.intent).toMatchObject({
          validation_kind: 'synthetic',
          product_version: productVersion,
          root_request_stop: 8,
          observed_request_stop: 10,
          helper_network_permission: 'single_command_network_only',
          product_gate_delta: false
        });
        const before = new Store(p.intent.database);
        try {
          expect(before.get<{ reserved: number }>('SELECT reserved FROM binding_qualification')?.reserved).toBe(0);
        } finally {
          before.close();
        }

        const result = await executeCodexSessionBindingQualification(p.intentPath, { ...consent(p.sha256), network_command_permission: true }, f.dependency);

        expect(f.completionObserved(), JSON.stringify(result)).toBe(true);
        expect(f.finalInjectionObserved()).toBe(reason !== null);
        expect(result, JSON.stringify(result)).toMatchObject({
          status: reason === null ? 'completed' : 'failed',
          reason,
          phase: 'source_check',
          product_gate_delta: false,
          observer_stop_reason: null,
          collector_error: null,
          native: { status: 'completed', exitCode: 0, ownershipVerified: true, terminationVerified: true },
          binding: { roots: 1, children: 2, requests: 6 }
        });
        if (reason === null)
          expect(result).toMatchObject({
            safety_usage_verification: 'verified',
            first_diagnostic: null,
            independent_source_check: {
              sources: 3,
              native_owned_requests: mode === 'six-requests-staged' ? 9 : 6,
              observed_request_matches: 6,
              excluded_baseline_requests: mode === 'six-requests-staged' ? 3 : 0,
              scope: 'exact_new_linked_sources',
              complete_cost: false
            }
          });
        else
          expect(result).toMatchObject({
            safety_usage_verification: 'unverified',
            first_diagnostic: { stage: 'source_check', code: reason },
            independent_source_check: null
          });
        const reserved: unknown = JSON.parse(readFileSync(join(f.dir, 'execution.reserved'), 'utf8'));
        expect(reserved).toMatchObject({ intent_sha256: p.sha256, network_command_permission: true });
        const after = new Store(p.intent.database);
        try {
          expect(after.get<{ reserved: number }>('SELECT reserved FROM binding_qualification')?.reserved).toBe(1);
          expect(
            after
              .all<{ requests: number }>(
                'SELECT count(*) AS requests FROM binding_requests r JOIN events e ON e.id=r.event_id WHERE e.task_id=? GROUP BY e.session_id',
                [p.intent.task_id]
              )
              .map(row => row.requests)
              .sort((a, b) => a - b)
          ).toEqual([1, 1, 4]);
        } finally {
          after.close();
        }
      } finally {
        f.cleanup();
      }
    }, 10000);

test('manual start is frozen and omits only the automatic initial prompt', async () => {
  const f = fixture();
  try {
    const p = await prepareCodexSessionBindingQualification(
      f.dir,
      { binary: realpathSync(process.execPath), codexHome: f.home, startMode: 'manual' },
      f.dependency
    );
    expect(p.intent).toMatchObject({ start_mode: 'manual', root_request_stop: 4, observed_request_stop: 6, duration_ms: 5000 });
    const automatic = codexBindingQualificationArgv({ ...p.intent, start_mode: 'automatic' });
    const manual = codexBindingQualificationArgv(p.intent);
    expect(automatic.at(-1)).toMatch(/^\$harness-connect /);
    expect(manual).toEqual(automatic.slice(0, -1));
    expect(manual.join(' ')).toContain('/<session-flags>/config.toml');
    expect(manual).not.toContain('exec');
    const bytes = readFileSync(p.intentPath, 'utf8');
    expect(JSON.parse(bytes)).toMatchObject({ start_mode: 'manual' });
    expect(digest(bytes)).toBe(p.sha256);
  } finally {
    f.cleanup();
  }
});
test('omitted start mode keeps automatic startup and unknown modes create no preparation', async () => {
  const f = fixture();
  const invalid = fixture();
  try {
    const p = await prepareCodexSessionBindingQualification(f.dir, { binary: realpathSync(process.execPath), codexHome: f.home }, f.dependency);
    expect(p.intent).toMatchObject({ start_mode: 'automatic' });
    expect(codexBindingQualificationArgv(p.intent).at(-1)).toMatch(/^\$harness-connect /);
    await expect(
      prepareCodexSessionBindingQualification(
        invalid.dir,
        { binary: realpathSync(process.execPath), codexHome: invalid.home, startMode: 'unknown' as 'manual' },
        invalid.dependency
      )
    ).rejects.toThrow();
    expect(() => readFileSync(join(invalid.dir, 'execution-intent.json'))).toThrow();
  } finally {
    f.cleanup();
    invalid.cleanup();
  }
});
test('changing the frozen manual mode cannot use its original consent or reserve execution', async () => {
  const f = fixture();
  try {
    const p = await prepareCodexSessionBindingQualification(
      f.dir,
      { binary: realpathSync(process.execPath), codexHome: f.home, startMode: 'manual' },
      f.dependency
    );
    writeFileSync(p.intentPath, JSON.stringify({ ...p.intent, start_mode: 'automatic' }));
    await expect(executeCodexSessionBindingQualification(p.intentPath, consent(p.sha256), f.dependency)).rejects.toThrow(
      'binding_qualification_consent_required'
    );
    const store = new Store(p.intent.database);
    try {
      expect(store.get<{ reserved: number }>('SELECT reserved FROM binding_qualification')?.reserved).toBe(0);
    } finally {
      store.close();
    }
  } finally {
    f.cleanup();
  }
});
test('a fresh synthetic legacy intent without start_mode still parses as automatic', async () => {
  const f = fixture();
  try {
    const p = await prepareCodexSessionBindingQualification(f.dir, { binary: realpathSync(process.execPath), codexHome: f.home }, f.dependency);
    const { start_mode: mode, ...legacy } = p.intent;
    expect(mode).toBe('automatic');
    const bytes = JSON.stringify(legacy);
    writeFileSync(p.intentPath, bytes);
    const store = new Store(p.intent.database);
    try {
      store.execute('UPDATE binding_qualification SET intent_hash=?', [digest(bytes)]);
    } finally {
      store.close();
    }
    const result = await executeCodexSessionBindingQualification(p.intentPath, consent(digest(bytes)), f.dependency);
    expect(result).toMatchObject({ status: 'completed', start_mode: 'automatic', native: { terminationVerified: true } });
  } finally {
    f.cleanup();
  }
}, 10000);
test('failed binding transaction preserves lease generation and permits another fresh root', async () => {
  const f = fixture();
  let store: Store | undefined;
  const spawned = vi.spyOn(OwnedCliInvocation.prototype, 'hasSpawned').mockReturnValue(true);
  const alive = vi.spyOn(OwnedCliInvocation.prototype, 'isAlive').mockReturnValue(true);
  try {
    const p = await prepareCodexSessionBindingQualification(f.dir, { binary: realpathSync(process.execPath), codexHome: f.home }, f.dependency);
    store = new Store(p.intent.database);
    const deadline = Date.now() + 5000;
    store.execute('UPDATE binding_qualification SET reserved=1,deadline=?', [deadline]);
    const owner = new OwnedCliInvocation({ command: realpathSync(process.execPath), args: [], cwd: f.root, durationMs: 100, stdio: 'ignore' });
    const lease = issueCodexBindingLease(store, p.intent.task_id, owner, deadline);
    const provider = new CodexSessionBindingProvider({
      receiptDirectory: p.intent.receipts,
      sourceRoots: [join(f.home, 'sessions')],
      projectRoot: p.intent.project,
      maxDepth: 1,
      maxFamilyMembers: 3
    });
    const service = createSessionBindingService({ store, providers: [provider], qualificationLease: lease, setupFor: () => p.intent.profile.setup });
    const fresh = () => {
      const id = randomUUID();
      const source = join(f.home, 'sessions', id + '.jsonl');
      writeFileSync(
        source,
        JSON.stringify({
          timestamp: new Date().toISOString(),
          type: 'session_meta',
          payload: { id, session_id: id, cwd: p.intent.project, cli_version: '0.160.0', source: 'cli' }
        }) + '\n'
      );
      const output = execFileSync(p.intent.wrapper, [], {
        input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: id, source: 'startup', cwd: p.intent.project, transcript_path: source }),
        encoding: 'utf8'
      });
      const receipt = /[a-f0-9-]{36}/.exec(
        (JSON.parse(output) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext
      )![0];
      return { receipt };
    };
    const first = fresh();
    const fail = vi.spyOn(priceSelection, 'selectTaskPriceTable').mockImplementationOnce(() => {
      throw new Error('synthetic_bind_failure');
    });
    try {
      await expect(service.connect(p.intent.task_id, 'codex', first)).rejects.toThrow('synthetic_bind_failure');
    } finally {
      fail.mockRestore();
    }
    expect(store.get('SELECT state,generation FROM tasks')).toEqual({ state: 'registered', generation: 0 });
    expect(store.all('SELECT id FROM sessions')).toEqual([]);
    expect(() => assertBindingQualification(lease, store!, p.intent.task_id)).not.toThrow();
    expect(await service.connect(p.intent.task_id, 'codex', fresh())).toMatchObject({ status: 'connected', roots: 1 });
  } finally {
    store?.close();
    spawned.mockRestore();
    alive.mockRestore();
    f.cleanup();
  }
});

for (const code of ['clock_regression', 'private diagnostic /secret'] as const)
  test(`first task snapshot diagnostic survives termination failure with ${code === 'clock_regression' ? 'a fixed code' : 'redaction'}`, async () => {
    const f = fixture();
    let live = false;
    const factory = localWeb.createLocalWebDomain;
    const domain = vi.spyOn(localWeb, 'createLocalWebDomain').mockImplementation(options => {
      const result = factory(options);
      if (options.qualificationLease) {
        result.task = () => {
          throw new Error(code);
        };
        if (code !== 'clock_regression') {
          const close = result.close?.bind(result);
          result.close = async () => {
            await close?.();
            throw new Error('late cleanup /secret');
          };
        }
      }
      return result;
    });
    const spawned = vi.spyOn(OwnedCliInvocation.prototype, 'hasSpawned').mockReturnValue(true);
    const alive = vi.spyOn(OwnedCliInvocation.prototype, 'isAlive').mockImplementation(() => live);
    const run = vi.spyOn(OwnedCliInvocation.prototype, 'run').mockImplementation(async () => {
      live = true;
      await delay(80);
      live = false;
      return {
        status: 'stopped',
        pid: 42,
        exitCode: null,
        terminationVerified: false,
        ownershipVerified: true,
        controllingTerminal: true,
        escapedMemberObserved: false,
        ownedMembers: 1,
        terminationCause: 'control',
        groupChanges: [],
        groupChangesTruncated: false
      };
    });
    try {
      const p = await prepareCodexSessionBindingQualification(f.dir, { binary: realpathSync(process.execPath), codexHome: f.home }, f.dependency);
      const result = await executeCodexSessionBindingQualification(p.intentPath, consent(p.sha256), f.dependency);
      expect(result).toMatchObject({
        reason: 'owned_cli_termination_unverified',
        first_diagnostic: { stage: 'task_snapshot', code: code === 'clock_regression' ? 'clock_regression' : 'unknown_error' },
        observer_stop_reason: 'binding_qualification_observer_failed'
      });
      expect(JSON.stringify(result)).not.toContain('/secret');
    } finally {
      domain.mockRestore();
      spawned.mockRestore();
      alive.mockRestore();
      run.mockRestore();
      f.cleanup();
    }
  });
test('an unlinked owner reaching its fixed deadline reports timeout separately from observer failure', async () => {
  const f = fixture('deadline-before-connect');
  try {
    const p = await prepareCodexSessionBindingQualification(f.dir, { binary: realpathSync(process.execPath), codexHome: f.home }, f.dependency);
    const result = await executeCodexSessionBindingQualification(p.intentPath, consent(p.sha256), f.dependency);
    expect(result, JSON.stringify(result)).toMatchObject({
      status: 'failed',
      reason: 'binding_qualification_deadline_reached',
      safety_usage_verification: 'unverified',
      native: { terminationVerified: true },
      binding: { roots: 0, children: 0, requests: 0 },
      independent_source_check: null
    });
  } finally {
    f.cleanup();
  }
}, 5000);
test('one ordinary fixture connects through real helper/server, inherits two direct children without child connect, records native product separately, verifies shutdown and independent counters', async () => {
  const f = fixture();
  try {
    const prepared = await prepareCodexSessionBindingQualification(f.dir, { binary: realpathSync(process.execPath), codexHome: f.home }, f.dependency);
    const args = codexBindingQualificationArgv(prepared.intent);
    expect(args[0]).toBe('--cd');
    expect(args).not.toContain('exec');
    expect(args.join(' ')).toContain('/<session-flags>/config.toml');
    expect(args.at(-1)).toBe(
      `$harness-connect Connect once to project qualification-project, task ${prepared.intent.task_id}, at http://127.0.0.1:4319 using the current hook-provided receipt. Then spawn exactly two fresh direct children with gpt-6.1-sol/high and no inherited history. Each child must make no tool calls, return a short acknowledgement in one model request, and finish. Wait once for both children. Do no other work. Keep the root within four model requests and stop.`
    );
    expect(digest(readFileSync(prepared.intentPath))).toBe(prepared.sha256);
    // A synthetic intent has no public execution switch: native entry rejects it.
    await expect(executeCodexSessionBindingQualification(prepared.intentPath, consent(prepared.sha256))).rejects.toThrow(
      'binding_qualification_invalid_fixture'
    );
    const result = await executeCodexSessionBindingQualification(prepared.intentPath, consent(prepared.sha256), f.dependency);
    expect(result, JSON.stringify(result)).toMatchObject({
      status: 'completed',
      product_gate_delta: false,
      native: { terminationVerified: true },
      binding: { roots: 1, children: 2, requests: 3 },
      independent_source_check: { sources: 3, observed_request_matches: 3 }
    });
    const store = new Store(prepared.intent.database);
    try {
      expect(store.all<{ product: string }>('SELECT product FROM sessions').map(r => r.product)).toEqual(['codex', 'codex', 'codex']);
      expect(store.all<{ payload: string }>('SELECT payload FROM runtime_evidence').map(r => (JSON.parse(r.payload) as { product: string }).product)).toEqual([
        'codex',
        'codex',
        'codex'
      ]);
    } finally {
      store.close();
    }
    const results = await serveCodexSessionBindingQualificationResults(prepared.intentPath, f.dependency);
    try {
      const bootstrap = (await results.app.inject({ url: '/api/bootstrap', headers: { host: '127.0.0.1:4319' } })).json<{ csrf: string }>();
      const task = (await results.app.inject({ url: '/api/tasks/' + prepared.intent.task_id, headers: { host: '127.0.0.1:4319' } })).json<{
        version: string;
        actions: { code: string; enabled: boolean }[];
      }>();
      expect(task.actions.filter(a => a.enabled).map(a => a.code)).toEqual(['finish-success', 'finish-failed', 'finish-abandoned']);
      const outcome = await results.app.inject({
        method: 'POST',
        url: '/api/tasks/' + prepared.intent.task_id + '/finish-success',
        headers: {
          host: '127.0.0.1:4319',
          origin: results.origin,
          'x-harness-csrf': bootstrap.csrf,
          'idempotency-key': randomUUID(),
          'if-match': task.version
        },
        payload: {}
      });
      expect(outcome.statusCode, outcome.body).toBe(200);
      expect(outcome.json()).toMatchObject({ outcome: { status: 'success' } });
    } finally {
      await results.close();
    }
    await expect(executeCodexSessionBindingQualification(prepared.intentPath, consent(prepared.sha256), f.dependency)).rejects.toThrow();
  } finally {
    f.cleanup();
  }
}, 10000);
test('intent drift or missing exact approval cannot start a reserved execution', async () => {
  const f = fixture();
  try {
    const p = await prepareCodexSessionBindingQualification(f.dir, { binary: realpathSync(process.execPath), codexHome: f.home }, f.dependency);
    await expect(executeCodexSessionBindingQualification(p.intentPath, consent('0'.repeat(64)), f.dependency)).rejects.toThrow(
      'binding_qualification_consent_required'
    );
    writeFileSync(p.intent.wrapper, 'changed');
    await expect(executeCodexSessionBindingQualification(p.intentPath, consent(p.sha256), f.dependency)).rejects.toThrow('binding_qualification_drift');
  } finally {
    f.cleanup();
  }
});

for (const changed of ['recorder', 'helper'] as const)
  test(`frozen ${changed} bytes cannot change before reservation or launch`, async () => {
    const f = fixture();
    try {
      const p = await prepareCodexSessionBindingQualification(f.dir, { binary: realpathSync(process.execPath), codexHome: f.home }, f.dependency);
      writeFileSync(changed === 'recorder' ? p.intent.recorder : join(p.intent.project, '.agents/skills/harness-connect/scripts/connect.mjs'), 'changed');
      await expect(executeCodexSessionBindingQualification(p.intentPath, consent(p.sha256), f.dependency)).rejects.toThrow('binding_qualification_drift');
      const store = new Store(p.intent.database);
      try {
        expect(store.get<{ reserved: number }>('SELECT reserved FROM binding_qualification')?.reserved).toBe(0);
      } finally {
        store.close();
      }
    } finally {
      f.cleanup();
    }
  });
for (const [mode, reason] of [
  ['late-request', 'binding_qualification_final_unobserved_request'],
  ['late-runtime', 'binding_qualification_runtime_invalid'],
  ['late-tokens', 'binding_qualification_token_limit'],
  ['late-gap', 'binding_qualification_final_gap']
] as const)
  test(`final independent projection rejects ${mode} after the last collector tick`, async () => {
    const f = fixture(mode);
    try {
      const p = await prepareCodexSessionBindingQualification(f.dir, { binary: realpathSync(process.execPath), codexHome: f.home }, f.dependency);
      const result = await executeCodexSessionBindingQualification(p.intentPath, consent(p.sha256), f.dependency);
      expect(f.finalInjectionObserved(), JSON.stringify(result)).toBe(true);
      expect(result, JSON.stringify(result)).toMatchObject({ status: 'failed', reason, phase: 'source_check', native: { terminationVerified: true } });
    } finally {
      f.cleanup();
    }
  }, 10000);
test('pre-connect baseline stays excluded from measured usage while final native request bounds include it', async () => {
  const f = fixture('baseline');
  try {
    const p = await prepareCodexSessionBindingQualification(f.dir, { binary: realpathSync(process.execPath), codexHome: f.home }, f.dependency);
    const result = await executeCodexSessionBindingQualification(p.intentPath, consent(p.sha256), f.dependency);
    expect(result, JSON.stringify(result)).toMatchObject({
      status: 'completed',
      binding: { requests: 3 },
      independent_source_check: { native_owned_requests: 4, observed_request_matches: 3, excluded_baseline_requests: 1 }
    });
  } finally {
    f.cleanup();
  }
}, 10000);

test('no lease or a browser-shaped forged lease can open native binding admission', async () => {
  const f = fixture();
  try {
    const p = await prepareCodexSessionBindingQualification(f.dir, { binary: realpathSync(process.execPath), codexHome: f.home }, f.dependency);
    const store = new Store(p.intent.database);
    const domain = createLocalWebDomain({ store, metadataFile: p.intent.metadata, profiles: [p.intent.profile] });
    try {
      expect(assertBindingQualification(undefined, store, p.intent.task_id)).toBe(false);
      expect(() => assertBindingQualification({ qualificationOnly: true }, store, p.intent.task_id)).toThrow('binding_qualification_revoked');
      await expect(
        domain.taskAction(p.intent.task_id, 'session-connect', { product: 'codex', receipt: '00000000-0000-4000-8000-000000000000' })
      ).rejects.toThrow('binding_source_unqualified');
    } finally {
      await domain.close?.();
      store.close();
    }
  } finally {
    f.cleanup();
  }
});
test('native exit while UI paused reports safety usage unverified without final source reads', async () => {
  const f = fixture('pause-exit');
  try {
    const p = await prepareCodexSessionBindingQualification(f.dir, { binary: realpathSync(process.execPath), codexHome: f.home }, f.dependency);
    const result = await executeCodexSessionBindingQualification(p.intentPath, consent(p.sha256), f.dependency);
    expect(result, JSON.stringify(result)).toMatchObject({
      status: 'failed',
      reason: 'binding_qualification_safety_usage_unverified',
      native: { status: 'completed', terminationVerified: true },
      independent_source_check: { safety_usage_verification: 'unverified', reason: 'task_paused_no_source_read' }
    });
  } finally {
    f.cleanup();
  }
}, 10000);

test('browser preparation leaves the exact native-intent task unprepared until the UI applies configuration', async () => {
  const f = fixture();
  try {
    const dependency = { ...f.dependency, uiPreparation: true };
    const p = await prepareCodexSessionBindingQualification(f.dir, { binary: realpathSync(process.execPath), codexHome: f.home }, dependency);
    const store = new Store(p.intent.database);
    const domain = createLocalWebDomain({ store, metadataFile: p.intent.metadata, profiles: [p.intent.profile] });
    try {
      expect(domain.task(p.intent.task_id).actions).toContainEqual({ code: 'apply', enabled: true, reason: null });
    } finally {
      await domain.close?.();
      store.close();
    }
  } finally {
    f.cleanup();
  }
});

test('offline preparation UI applies only the exact task and cannot connect, choose a source or reserve native execution', async () => {
  const f = fixture();
  const dependency = { ...f.dependency, uiPreparation: true };
  try {
    const p = await prepareCodexSessionBindingQualification(f.dir, { binary: realpathSync(process.execPath), codexHome: f.home }, dependency);
    await expect(executeCodexSessionBindingQualification(p.intentPath, consent(p.sha256), dependency)).rejects.toThrow(
      'binding_qualification_ui_preparation_required'
    );
    const server = await serveCodexSessionBindingQualificationUiPreparation(p.intentPath, dependency);
    try {
      const bootstrap = (await server.app.inject({ url: '/api/bootstrap', headers: { host: '127.0.0.1:4319' } })).json<{ csrf: string }>();
      const task = (await server.app.inject({ url: '/api/tasks/' + p.intent.task_id, headers: { host: '127.0.0.1:4319' } })).json<{ version: string }>();
      const headers = {
        host: '127.0.0.1:4319',
        origin: server.origin,
        'content-type': 'application/json',
        'x-harness-csrf': bootstrap.csrf,
        'idempotency-key': randomUUID(),
        'if-match': task.version
      };
      const apply = await server.app.inject({ method: 'POST', url: '/api/tasks/' + p.intent.task_id + '/apply', headers, payload: '{}' });
      expect(apply.statusCode, apply.body).toBe(200);
      expect(apply.json()).toMatchObject({ preparation: { configuration_evidence: 'verified_at_preparation' } });
      const denied = await server.app.inject({
        method: 'POST',
        url: '/api/tasks/' + p.intent.task_id + '/session-picker',
        headers: { ...headers, 'idempotency-key': randomUUID(), 'if-match': apply.json<{ version: string }>().version },
        payload: '{}'
      });
      expect(denied.statusCode).toBe(400);
    } finally {
      await server.close();
    }
    const store = new Store(p.intent.database);
    try {
      expect(store.get<{ reserved: number }>('SELECT reserved FROM binding_qualification')?.reserved).toBe(0);
      expect(store.all('SELECT id FROM sessions')).toHaveLength(0);
    } finally {
      store.close();
    }
  } finally {
    f.cleanup();
  }
}, 10000);

for (const mode of ['pause-resume', 'emergency'] as const)
  test(`qualification ${mode} preserves measurement fences and independent owner control`, async () => {
    const f = fixture(mode);
    try {
      const p = await prepareCodexSessionBindingQualification(f.dir, { binary: realpathSync(process.execPath), codexHome: f.home }, f.dependency);
      const result = await executeCodexSessionBindingQualification(p.intentPath, consent(p.sha256), f.dependency);
      expect(result, JSON.stringify(result)).toMatchObject(
        mode === 'pause-resume'
          ? {
              status: 'completed',
              binding: { requests: 3, gaps: ['unobserved_interval'] },
              native: { status: 'completed', terminationVerified: true },
              independent_source_check: { native_owned_requests: 5, excluded_baseline_requests: 2, observed_request_matches: 3 }
            }
          : { status: 'failed', native: { status: 'stopped', terminationVerified: true } }
      );
    } finally {
      f.cleanup();
    }
  }, 10000);

test('request continuing a pre-resume context stays excluded from measurement but safety ledger reconciles it', async () => {
  const f = fixture('continued');
  try {
    const p = await prepareCodexSessionBindingQualification(f.dir, { binary: realpathSync(process.execPath), codexHome: f.home }, f.dependency);
    const result = await executeCodexSessionBindingQualification(p.intentPath, consent(p.sha256), f.dependency);
    expect(result, JSON.stringify(result)).toMatchObject({
      status: 'completed',
      binding: { requests: 3, gaps: ['unobserved_interval', 'binding_unobserved_context'] },
      independent_source_check: { native_owned_requests: 4, excluded_baseline_requests: 1, observed_request_matches: 3 }
    });
  } finally {
    f.cleanup();
  }
}, 10000);

for (const mode of ['root-stop', 'child-overflow', 'token-stop'] as const)
  test(`active ${mode} stops the live owner at changed own-request bounds`, async () => {
    const f = fixture(mode);
    try {
      const p = await prepareCodexSessionBindingQualification(f.dir, { binary: realpathSync(process.execPath), codexHome: f.home }, f.dependency);
      const result = await executeCodexSessionBindingQualification(p.intentPath, consent(p.sha256), f.dependency);
      expect(result, JSON.stringify(result)).toMatchObject({ status: 'failed', native: { status: 'stopped', terminationVerified: true } });
      expect(result.binding).toMatchObject({ requests: mode === 'root-stop' ? 5 : mode === 'token-stop' ? 4 : 3 });
      const expected =
        mode === 'root-stop'
          ? {
              predicate: 'safety_limit',
              safety: {
                reached: ['root_request_limit', 'total_request_limit'],
                root_requests: 4,
                total_requests: 6,
                excluded_baseline_requests: 1,
                input_output_tokens: 78
              },
              attempted: null
            }
          : mode === 'child-overflow'
            ? {
                predicate: 'collector_limit',
                safety: { root_requests: 1, total_requests: 3, input_output_tokens: 39 },
                attempted: { own_requests: 2, total_requests: 4, input_output_tokens: 52, excluded_baseline: false }
              }
            : {
                predicate: 'safety_limit',
                safety: { reached: ['token_limit'], root_requests: 2, total_requests: 4, input_output_tokens: 100000 },
                attempted: null
              };
      expect(result, JSON.stringify(result)).toMatchObject({ stop_witness: expected });
    } finally {
      f.cleanup();
    }
  }, 10000);

test('first fixed collector error and observer stop reason survive a later termination failure', async () => {
  const f = fixture('child-overflow');
  // eslint-disable-next-line @typescript-eslint/unbound-method -- The original is invoked only with the owning instance through call.
  const run = OwnedCliInvocation.prototype.run;
  const spy = vi.spyOn(OwnedCliInvocation.prototype, 'run');
  spy.mockImplementation(async function (this: OwnedCliInvocation, signal) {
    const result = await run.call(this, signal);
    return { ...result, terminationVerified: false };
  });
  try {
    const p = await prepareCodexSessionBindingQualification(f.dir, { binary: realpathSync(process.execPath), codexHome: f.home }, f.dependency);
    const result = await executeCodexSessionBindingQualification(p.intentPath, consent(p.sha256), f.dependency);
    expect(result).toMatchObject({
      reason: 'owned_cli_termination_unverified',
      collector_error: 'binding_qualification_request_limit',
      observer_stop_reason: 'binding_qualification_observer_failed',
      stop_witness: { predicate: 'collector_limit', safety: { root_requests: 1, total_requests: 3 }, attempted: { own_requests: 2, total_requests: 4 } }
    });
  } finally {
    spy.mockRestore();
    f.cleanup();
  }
}, 10000);

test('collector diagnostics keep only the first fixed code and redact arbitrary error text', async () => {
  const f = fixture();
  try {
    const p = await prepareCodexSessionBindingQualification(f.dir, { binary: realpathSync(process.execPath), codexHome: f.home }, f.dependency);
    const store = new Store(p.intent.database);
    try {
      const deadline = Date.now() + 5000;
      store.execute('UPDATE binding_qualification SET reserved=1,deadline=? WHERE singleton=1', [deadline]);
      for (const first of [
        new Error('binding_qualification_token_limit'),
        new Error('clock_regression'),
        new Error('invalid_gap'),
        new Error('external_window_closed'),
        new Error('private body /secret/location')
      ]) {
        const owner = new OwnedCliInvocation({ command: realpathSync(process.execPath), args: [], cwd: f.root, durationMs: 100, stdio: 'ignore' });
        const lease = issueCodexBindingLease(store, p.intent.task_id, owner, deadline);
        noteQualificationCollectorError(lease, first);
        noteQualificationCollectorError(lease, new Error('binding_qualification_request_limit'));
        expect(qualificationCollectorError(lease)).toBe(first.message.startsWith('private body') ? 'unknown_collector_error' : first.message);
      }
    } finally {
      store.close();
    }
  } finally {
    f.cleanup();
  }
});

test('collector failure just before owner return remains the first diagnostic', async () => {
  const f = fixture();
  let lease: Parameters<typeof noteQualificationCollectorError>[0];
  const factory = localWeb.createLocalWebDomain;
  const domain = vi.spyOn(localWeb, 'createLocalWebDomain').mockImplementation(options => {
    if (options.qualificationLease) lease = options.qualificationLease;
    return factory(options);
  });
  const spawned = vi.spyOn(OwnedCliInvocation.prototype, 'hasSpawned').mockReturnValue(true);
  const alive = vi.spyOn(OwnedCliInvocation.prototype, 'isAlive').mockReturnValue(false);
  const run = vi.spyOn(OwnedCliInvocation.prototype, 'run').mockImplementation(() => {
    noteQualificationCollectorError(lease, new Error('clock_regression'));
    return Promise.resolve({
      status: 'stopped',
      pid: 42,
      exitCode: null,
      terminationVerified: false,
      ownershipVerified: true,
      controllingTerminal: true,
      escapedMemberObserved: false,
      ownedMembers: 1,
      terminationCause: 'control',
      groupChanges: [],
      groupChangesTruncated: false
    });
  });
  try {
    const p = await prepareCodexSessionBindingQualification(f.dir, { binary: realpathSync(process.execPath), codexHome: f.home }, f.dependency);
    const result = await executeCodexSessionBindingQualification(p.intentPath, consent(p.sha256), f.dependency);
    expect(result).toMatchObject({
      reason: 'owned_cli_termination_unverified',
      collector_error: 'clock_regression',
      first_diagnostic: { stage: 'collector', code: 'clock_regression' }
    });
  } finally {
    domain.mockRestore();
    spawned.mockRestore();
    alive.mockRestore();
    run.mockRestore();
    f.cleanup();
  }
});

for (const omitted of ['cost-dependency', 'built-ui'] as const)
  test(`frozen ${omitted} changes block before native reservation`, async () => {
    const f = fixture();
    const target =
      omitted === 'cost-dependency'
        ? new URL('../../src/pricing/catalog-cost-report.ts', import.meta.url)
        : new URL('../../dist/local-ui/index.html', import.meta.url);
    const original = readFileSync(target);
    try {
      const p = await prepareCodexSessionBindingQualification(f.dir, { binary: realpathSync(process.execPath), codexHome: f.home }, f.dependency);
      writeFileSync(target, Buffer.concat([original, Buffer.from('\n')]));
      await expect(executeCodexSessionBindingQualification(p.intentPath, consent(p.sha256), f.dependency)).rejects.toThrow('binding_qualification_drift');
      const store = new Store(p.intent.database);
      try {
        expect(store.get<{ reserved: number }>('SELECT reserved FROM binding_qualification')?.reserved).toBe(0);
      } finally {
        store.close();
      }
    } finally {
      writeFileSync(target, original);
      f.cleanup();
    }
  });
