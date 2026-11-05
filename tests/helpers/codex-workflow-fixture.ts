import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { PriceTable } from '../../src/flexible-contracts.js';
import { Store } from '../../src/store.js';
import { Lifecycle } from '../../src/lifecycle.js';
import { registerVariant, registerProtocol, freezeProtocol } from '../../src/comparison.js';
import { registerPriceTable } from '../../src/pricing.js';
import { makeFlexibleFixture } from './flexible-fixture.js';
import { assignmentInput } from './comparison-fixture.js';

export function codexWorkflowFixture(
  nativeProfile?: string,
  purpose: 'real_experiment' | 'functional_pilot' = 'real_experiment',
  native?: { product: 'codex' | 'claude_code'; productVersion: string; priceTable?: PriceTable }
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-workflow-')));
  const project = join(root, 'project');
  mkdirSync(project);
  const home = join(root, 'home');
  mkdirSync(home);
  mkdirSync(join(home, 'sessions'));
  const database = join(root, 'measurement.sqlite');
  const store = new Store(database);
  const f = makeFlexibleFixture();
  if (native?.priceTable) {
    f.priceTable = native.priceTable;
    f.protocol.price_table_id = native.priceTable.id;
  }
  if (nativeProfile) {
    f.protocol.purpose = purpose;
    if (purpose === 'functional_pilot') {
      delete f.protocol.minimum_effect;
      delete f.protocol.quality_margin;
      delete f.protocol.confidence_level;
    }
    f.protocol.source_profiles = [{ product: native?.product ?? 'codex', product_version: native?.productVersion ?? '0.160.0', profile_id: nativeProfile }];
    f.metadata.product = native?.product ?? 'codex';
  }
  const now = Date.now();
  f.protocol.recruitment_start = new Date(now - 60000).toISOString();
  f.protocol.recruitment_end = new Date(now + 3600000).toISOString();
  new Lifecycle(store).registerProject('project-1', project);
  const artifacts = f.variants.map((variant, index) => {
    const path = join(root, `${variant.id}.md`);
    const content = `SYNTHETIC_PRIVATE_HARNESS_${index}`;
    writeFileSync(path, content);
    variant.instruction_manifest_hash = createHash('sha256')
      .update(JSON.stringify([{ artifact_id: 'instruction', sha256: createHash('sha256').update(content).digest('hex') }]))
      .digest('hex');
    registerVariant(store, variant);
    return { variant_id: variant.id, selected_artifacts: [{ artifact_id: 'instruction', path }] };
  });
  registerPriceTable(store, f.priceTable);
  registerProtocol(store, f.protocol);
  freezeProtocol(store, f.protocol.id, new Date(now - 120000).toISOString());
  const input = {
    schema_version: 1,
    assignment: { ...assignmentInput, schema_version: 2, metadata: f.metadata },
    product_version: nativeProfile ? (native?.productVersion ?? '0.160.0') : '1.0.0',
    confirmation_id: 'confirmation-1',
    artifacts
  };
  const prompt = join(root, 'prompt.txt');
  writeFileSync(prompt, 'SYNTHETIC_PRIVATE_TASK');
  const script = join(root, 'fake-codex.mjs');
  writeFileSync(
    script,
    `import {readFileSync,writeFileSync,appendFileSync} from 'node:fs'; import {join} from 'node:path'; import {randomUUID} from 'node:crypto'; import {spawnSync} from 'node:child_process';
const args=process.argv.slice(2);const cwd=process.cwd();let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
const get=prefix=>args.find(s=>s.startsWith(prefix))?.slice(prefix.length);const dev=JSON.parse(get('developer_instructions='));
if(!['SYNTHETIC_PRIVATE_HARNESS_0','SYNTHETIC_PRIVATE_HARNESS_1'].includes(dev)||!prompt.startsWith('SYNTHETIC_PRIVATE_TASK'))process.exit(3);
const resumed=args.includes('resume');const native=resumed?args[args.indexOf('resume')+1]:randomUUID();const path=join(process.env.CODEX_HOME,'sessions',native+'.jsonl');
const at=()=>new Date().toISOString();const row=(type,payload)=>JSON.stringify({timestamp:at(),type,payload})+'\\n';
if(!resumed)writeFileSync(path,row('session_meta',{id:native,session_id:native,cwd,cli_version:'0.160.0',source:'exec'}));
const turn=randomUUID();const model=args.includes('--model')?args[args.indexOf('--model')+1]:'native-default-model';const effort=JSON.parse(get('model_reasoning_effort=')??'"native-default-effort"');
appendFileSync(path,row('event_msg',{type:'thread_settings_applied',thread_id:native,thread_settings:{cwd,model,developer_instructions:dev}}));
appendFileSync(path,row('event_msg',{type:'task_started',turn_id:turn}));appendFileSync(path,row('turn_context',{cwd,turn_id:turn,model,effort,multi_agent_version:'disabled',sandbox_policy:{type:args[args.indexOf('--sandbox')+1]},approval_policy:'on-request',approvals_reviewer:'auto_review'}));
const command=get('hooks.SessionStart=').match(/command="([^"]+)"/)[1];const hook=spawnSync('/bin/sh',['-c',command],{input:JSON.stringify({cwd,session_id:native,transcript_path:path,hook_event_name:'SessionStart',source:resumed?'resume':'startup',model,permission_mode:'default'})});if(hook.status!==0)process.exit(4);
appendFileSync(path,row('token_usage_record',{session_id:native,thread_id:native,turn_id:turn,root_turn_id:turn,response_id:randomUUID(),usage:{input_tokens:30,cached_input_tokens:5,cache_write_input_tokens:2,output_tokens:3,reasoning_output_tokens:1,total_tokens:33}}));
if(prompt.includes('WAIT'))setTimeout(()=>{},60000);else appendFileSync(path,row('event_msg',{type:'task_complete',turn_id:turn}));
`
  );
  // timeout_ms leaves room for slow CI runners but stays below the 20s timeouts of
  // long tests, so a stuck run reports the adapter's own reason. Deadline tests set their own.
  const execution = (runId: string, operation: 'launch' | 'resume' | 'link' | 'collect' = 'launch', sessionId?: string, sourcePath?: string) => ({
    run_id: runId,
    operation,
    binary: { path: realpathSync(process.execPath), sha256: createHash('sha256').update(readFileSync(process.execPath)).digest('hex') },
    codex_home: home,
    hook_recorder: realpathSync(resolve('scripts/conformance/candidate-start-recorder.mjs')),
    prompt_file: prompt,
    sandbox: 'workspace-write',
    timeout_ms: 15000,
    poll_ms: 10,
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(sourcePath ? { source_path: sourcePath } : {})
  });
  const newRoot = () => {
    const id = randomUUID();
    const path = join(home, 'sessions', `${id}.jsonl`);
    writeFileSync(path, JSON.stringify({ type: 'session_meta', payload: { id, session_id: id, cwd: project, cli_version: '0.160.0', source: 'exec' } }) + '\n');
    return { id, path };
  };
  const appendUsage = (session: { id: string; path: string }, model = 'external-user-model', extra: Record<string, unknown> = {}) => {
    const turn = randomUUID();
    const response = randomUUID();
    const row = (type: string, payload: unknown) => JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + '\n';
    appendFileSync(
      session.path,
      row('event_msg', { type: 'task_started', turn_id: turn }) +
        row('turn_context', { cwd: project, turn_id: turn, model, effort: null, multi_agent_version: 'disabled', ...extra }) +
        row('token_usage_record', {
          session_id: session.id,
          thread_id: session.id,
          turn_id: turn,
          root_turn_id: turn,
          response_id: response,
          usage: { input_tokens: 30, cached_input_tokens: 5, cache_write_input_tokens: 2, output_tokens: 3, reasoning_output_tokens: 1, total_tokens: 33 }
        }) +
        row('event_msg', { type: 'task_complete', turn_id: turn })
    );
    return response;
  };
  return {
    root,
    project,
    home,
    database,
    store,
    input,
    script,
    prompt,
    execution,
    newRoot,
    appendUsage,
    cleanup: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
}
