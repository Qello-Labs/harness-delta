import { expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store } from '../../src/store.js';
import { prepareCodexWorkflowQualification, executeCodexWorkflowQualification } from '../../src/qualification/codex-workflow-qualification.js';
import { productionSourceEvidence } from '../../src/readiness.js';
import { compiledWorker } from '../helpers/compiled-worker.js';

function fixture(mode = 'success', durationMs = 180000) {
  const root = realpathSync(mkdtempSync('/tmp/hdwq-test-'));
  const home = join(root, 'home');
  mkdirSync(home);
  mkdirSync(join(home, 'sessions'));
  const prior = join(home, 'sessions', 'prior-native.jsonl');
  writeFileSync(prior, 'PRIVATE_PRIOR_SESSION');
  const script = join(root, 'fake.mjs');
  writeFileSync(
    script,
    `
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';import {join} from 'node:path';import {randomUUID} from 'node:crypto';import {spawnSync} from 'node:child_process';
const mode=${JSON.stringify(mode)};const args=process.argv.slice(2);let prompt='';for await(const b of process.stdin)prompt+=b;const get=p=>args.find(s=>s.startsWith(p))?.slice(p.length);
const dev=JSON.parse(get('developer_instructions='));const resumed=args.includes('resume');const phase=resumed?'RESUME':'LAUNCH';
if(JSON.parse(get('approvals_reviewer='))!=='auto_review')process.exit(5);
const marker=dev.match(new RegExp('QUALIFICATION_'+phase+'=([a-f0-9]{32})'))?.[1];if(!marker||!prompt.includes(phase)||!args.includes('--json'))process.exit(3);
const id=resumed?args[args.indexOf('resume')+1]:randomUUID();const path=join(process.env.CODEX_HOME,'sessions',id+'.jsonl');const cwd=process.cwd();let ordinal=resumed?readFileSync(path,'utf8').trimEnd().split('\\n').length:0;const at=()=>new Date().toISOString();const row=(type,payload)=>JSON.stringify({type,timestamp:at(),ordinal:ordinal++,payload})+'\\n';
if(!resumed)writeFileSync(path,row('session_meta',{id,session_id:id,cwd,cli_version:'0.160.0',source:'exec',history_mode:'paginated'}));
const turn=randomUUID();const model=args[args.indexOf('--model')+1];appendFileSync(path,row('event_msg',{type:'task_started',turn_id:turn})+row('turn_context',{cwd,turn_id:turn,model,effort:'high',multi_agent_version:'disabled',sandbox_policy:{type:'read-only'},approval_policy:'on-request',approvals_reviewer:'auto_review'}));
const command=get('hooks.SessionStart=').match(/command="([^"]+)"/)[1];const hook=spawnSync('/bin/sh',['-c',command],{input:JSON.stringify({session_id:id,transcript_path:path,cwd,hook_event_name:'SessionStart',source:resumed?'resume':'startup',permission_mode:'default'})});if(hook.status!==0)process.exit(4);
if(mode==='deadline'||mode==='resume-deadline'&&resumed){setTimeout(()=>{},10000);}else{
 if(mode==='resume-deadline')await new Promise(ok=>setTimeout(ok,1500));
 if(mode!=='missing-usage')appendFileSync(path,row('token_usage_record',{session_id:id,thread_id:id,turn_id:turn,root_turn_id:turn,response_id:randomUUID(),usage:{input_tokens:10,cached_input_tokens:2,cache_write_input_tokens:0,output_tokens:3,reasoning_output_tokens:1,total_tokens:13}}));
 appendFileSync(path,row('event_msg',{type:'task_complete',turn_id:turn}));console.log(JSON.stringify({type:'item.completed',item:{type:mode==='tool'?'command_execution':'agent_message',text:mode==='wrong-marker'?'WRONG':marker}}));
}
`
  );
  const input = {
    binary: { path: realpathSync(process.execPath), sha256: createHash('sha256').update(readFileSync(process.execPath)).digest('hex') },
    codex_home: home,
    hook_recorder: realpathSync(resolve('scripts/conformance/candidate-start-recorder.mjs'))
  };
  const dependencies = { fixtureScript: script, durationMs };
  const directory = join(root, 'qualification');
  const consent = (sha: string) => ({
    intent_sha256: sha,
    approval_reference: 'synthetic-test-only',
    actual_model_run: true,
    transient_harness_hooks: true,
    marker_response_validation: true
  });
  return { root, home, prior, script, input, dependencies, directory, consent, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
test('one-shot entry shares launch/resume/collection engine and emits content-free marker/usage/reopen replay evidence', async () => {
  const f = fixture();
  try {
    const priorRegistry = JSON.stringify(productionSourceEvidence);
    const prepared = prepareCodexWorkflowQualification(f.directory, f.input, f.dependencies);
    const result = await executeCodexWorkflowQualification(prepared.intentPath, f.consent(prepared.sha256), f.dependencies);
    expect(result).toMatchObject({
      status: 'completed',
      validation_kind: 'synthetic',
      native_invocations: 2,
      same_session: true,
      marker_verified: [true, true],
      own_responses: 2,
      replay_insertions: 0,
      product_gate_delta: false,
      complete_cost: null
    });
    const db = new Store(join(f.directory, 'measurement.sqlite'));
    try {
      expect(db.eventCount()).toBe(2);
      expect(db.all('SELECT * FROM sessions')).toHaveLength(1);
      expect(db.all('SELECT * FROM comparison_assignments')).toHaveLength(0);
      const evidence = JSON.stringify(result) + JSON.stringify(db.all('SELECT * FROM codex_workflow_runs')) + JSON.stringify(db.all('SELECT * FROM events'));
      const harness = readFileSync(join(f.directory, 'harness-a.md'), 'utf8');
      for (const marker of harness.match(/[a-f0-9]{32}/g) ?? []) expect(evidence).not.toContain(marker);
      expect(db.all<{ purpose: string }>('SELECT purpose FROM codex_workflow_runs').every(r => r.purpose === 'qualification')).toBe(true);
    } finally {
      db.close();
    }
    expect(readFileSync(f.prior, 'utf8')).toBe('PRIVATE_PRIOR_SESSION');
    expect(JSON.stringify(productionSourceEvidence)).toBe(priorRegistry);
    await expect(executeCodexWorkflowQualification(prepared.intentPath, f.consent(prepared.sha256), f.dependencies)).rejects.toThrow(
      'codex_qualification_already_reserved'
    );
  } finally {
    f.cleanup();
  }
}, 20000);
test('consent/intent/artifact drift and a synthetic intent on the public native entry fail before execution', async () => {
  const f = fixture();
  try {
    const prepared = prepareCodexWorkflowQualification(f.directory, f.input, f.dependencies);
    await expect(executeCodexWorkflowQualification(prepared.intentPath, f.consent('0'.repeat(64)), f.dependencies)).rejects.toThrow(
      'codex_qualification_consent_required'
    );
    await expect(executeCodexWorkflowQualification(prepared.intentPath, f.consent(prepared.sha256))).rejects.toThrow('codex_qualification_invalid_intent');
    writeFileSync(join(f.directory, 'harness-a.md'), 'CHANGED');
    writeFileSync(join(f.directory, 'harness-b.md'), 'CHANGED');
    await expect(executeCodexWorkflowQualification(prepared.intentPath, f.consent(prepared.sha256), f.dependencies)).rejects.toThrow(
      'codex_qualification_artifact_drift'
    );
    const db = new Store(join(f.directory, 'measurement.sqlite'));
    try {
      expect(db.all('SELECT * FROM codex_workflow_runs')).toHaveLength(0);
    } finally {
      db.close();
    }
  } finally {
    f.cleanup();
  }
});
test.each(['wrong-marker', 'missing-usage', 'tool', 'deadline'])(
  'qualification %s failure consumes the attempt and never resumes',
  async mode => {
    const f = fixture(mode, mode === 'deadline' ? 1000 : 180000);
    try {
      const prepared = prepareCodexWorkflowQualification(f.directory, f.input, f.dependencies);
      const result = await executeCodexWorkflowQualification(prepared.intentPath, f.consent(prepared.sha256), f.dependencies);
      expect(result.status).toBe('failed');
      expect(result.native_invocations).toBe(1);
      expect(result.product_gate_delta).toBe(false);
      await expect(executeCodexWorkflowQualification(prepared.intentPath, f.consent(prepared.sha256), f.dependencies)).rejects.toThrow(
        'codex_qualification_already_reserved'
      );
    } finally {
      f.cleanup();
    }
  },
  15000
);
test('resume consumes the remaining shared lease rather than resetting its execution window', async () => {
  const f = fixture('resume-deadline', 5000);
  try {
    const prepared = prepareCodexWorkflowQualification(f.directory, f.input, f.dependencies);
    const result = await executeCodexWorkflowQualification(prepared.intentPath, f.consent(prepared.sha256), f.dependencies);
    expect(result).toMatchObject({ status: 'failed', native_invocations: 2, own_responses: 1, actual_model_usage: 'observed_subset' });
    expect(Date.parse(result.deadline_at) - Date.parse(result.started_at)).toBe(5000);
    expect(result.elapsed_ms).toBeGreaterThanOrEqual(5000);
    expect(result.elapsed_ms).toBeLessThan(6000);
    expect(result.phases[1]).toMatchObject({ state: 'failed', reason: 'deadline' });
  } finally {
    f.cleanup();
  }
}, 15000);
test('built manual CLI prepare and execute produce the same full synthetic evidence without public bypass flags', async () => {
  const f = fixture();
  try {
    const compiled = compiledWorker(f.root);
    const entry = join(f.root, 'entry.mjs');
    writeFileSync(
      entry,
      `import {prepareCodexWorkflowQualification,executeCodexWorkflowQualification} from ${JSON.stringify(join(compiled, 'qualification/codex-workflow-qualification.js'))};import {readFileSync} from 'node:fs';const [command,path,json]=process.argv.slice(2);const dependencies=${JSON.stringify(f.dependencies)};console.log(JSON.stringify(command==='prepare'?prepareCodexWorkflowQualification(path,JSON.parse(readFileSync(json,'utf8')),dependencies):await executeCodexWorkflowQualification(path,JSON.parse(readFileSync(json,'utf8')),dependencies)));`
    );
    const run = (args: string[]) =>
      new Promise<string>((ok, no) => {
        const child = spawn(process.execPath, [entry, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        child.stdout.on('data', b => {
          output += String(b);
        });
        child.on('error', no);
        child.on('exit', code => (code === 0 ? ok(output) : no(new Error('synthetic_entry_failed'))));
      });
    const config = join(f.root, 'input.json');
    writeFileSync(config, JSON.stringify(f.input));
    const prepared = JSON.parse(await run(['prepare', f.directory, config])) as { intentPath: string; sha256: string };
    const consent = join(f.root, 'consent.json');
    writeFileSync(consent, JSON.stringify(f.consent(prepared.sha256)));
    const result = JSON.parse(await run(['execute', prepared.intentPath, consent])) as {
      status: string;
      native_invocations: number;
      replay_insertions: number;
    };
    expect(result).toMatchObject({ status: 'completed', native_invocations: 2, replay_insertions: 0 });
  } finally {
    f.cleanup();
  }
}, 20000);
