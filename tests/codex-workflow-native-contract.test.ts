import { expect, test, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as collection from '../src/sources/collection.js';
import { createSyntheticCodexWorkflowAdapter } from '../src/codex-workflow-adapter.js';
import { runAssignedWorkflow } from '../src/workflow/task-workflow.js';
import { codexWorkflowFixture } from './helpers/codex-workflow-fixture.js';

const runtime = { model: 'gpt-6-astra', effort: 'high' };
// Structural reduction of the one authorized native root, not a transcript copy.
// Identifiers/paths/times are synthetic and every content/settings body is absent.
const shape = JSON.parse(
  '[' + readFileSync(resolve('tests/fixtures/adapters/codex-workflow-root-paginated.jsonl'), 'utf8').trim().split('\n').join(',') + ']'
) as { type: string; ordinal: number; payload: Record<string, unknown> }[];
function nativeShapeFixture(mode = 'ready') {
  const f = codexWorkflowFixture();
  writeFileSync(
    f.script,
    `import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';import {join} from 'node:path';import {randomUUID} from 'node:crypto';import {spawn} from 'node:child_process';
const shape=${JSON.stringify(shape)},mode=${JSON.stringify(mode)},args=process.argv.slice(2),cwd=process.cwd();for await(const _ of process.stdin){};
const resumed=args.includes('resume'),id=resumed?args[args.indexOf('resume')+1]:randomUUID(),path=join(process.env.CODEX_HOME,'sessions',id+'.jsonl'),turn=randomUUID();let ordinal=resumed?readFileSync(path,'utf8').trimEnd().split('\\n').length:mode==='nonzero'?1:0;
const row=(type,payload)=>JSON.stringify({timestamp:new Date().toISOString(),type,ordinal:ordinal++,payload})+'\\n';const get=p=>args.find(x=>x.startsWith(p))?.slice(p.length);
const model=args[args.indexOf('--model')+1],effort=JSON.parse(get('model_reasoning_effort='));
const prefix=shape.filter(x=>!resumed||x.type!=='session_meta').map(x=>{let p={...x.payload};if(x.type==='session_meta')p={...p,id,session_id:id,cwd,...(mode==='fork'?{forked_from_id:'PRIVATE_FORK'}:{})};if(x.type==='turn_context')p={...p,cwd,turn_id:turn,model,effort,sandbox_policy:{type:args[args.indexOf('--sandbox')+1]}};if(x.type==='event_msg')p={...p,turn_id:turn};if(mode==='ordinal-gap'&&x.type==='world_state')ordinal++;return row(x.type,p);}).join('');
if(!resumed){if(['empty','partial-header','no-header'].includes(mode)){const first=mode==='partial-header'?prefix.slice(0,25):'';writeFileSync(path,first);if(mode!=='no-header')setTimeout(()=>appendFileSync(path,prefix.slice(first.length)),80);}else writeFileSync(path,mode==='invalid-json'?'PRIVATE INVALID JSON\\n':prefix);}else appendFileSync(path,prefix);
const command=get('hooks.SessionStart=').match(/command="([^"]+)"/)[1];const code=await new Promise(ok=>{const c=spawn('/bin/sh',['-c',command],{stdio:['pipe','ignore','ignore']});c.on('close',ok);c.stdin.end(JSON.stringify({session_id:id,transcript_path:path,cwd,hook_event_name:'SessionStart',source:resumed?'resume':'startup',permission_mode:'default'}));});if(code!==0)process.exit(4);
const usage=row('token_usage_record',{thread_id:id,session_id:id,turn_id:turn,root_turn_id:turn,response_id:randomUUID(),usage:{input_tokens:10,cached_input_tokens:2,output_tokens:3,reasoning_output_tokens:1,total_tokens:13}});
if(mode==='partial-tail'){appendFileSync(path,usage.slice(0,30));await new Promise(ok=>setTimeout(ok,80));appendFileSync(path,usage.slice(30));}else appendFileSync(path,usage);appendFileSync(path,row('event_msg',{type:'task_complete',turn_id:turn}));
`
  );
  return f;
}
test('the sanitized native paginated root passes the actual collector baseline without inventing usage', async () => {
  const f = codexWorkflowFixture();
  try {
    const root = f.newRoot();
    const rows = shape.map(x => ({
      ...x,
      payload:
        x.type === 'session_meta'
          ? { ...x.payload, id: root.id, session_id: root.id, cwd: f.project }
          : x.type === 'turn_context'
            ? { ...x.payload, cwd: f.project }
            : x.payload
    }));
    writeFileSync(root.path, rows.map(x => JSON.stringify(x)).join('\n') + '\n');
    const result = await runAssignedWorkflow(
      f.store,
      f.input,
      createSyntheticCodexWorkflowAdapter(f.store, f.execution('native-shape', 'link', root.id, root.path), f.script),
      runtime
    );
    expect(result.adapter_result).toMatchObject({ state: 'completed', observed_requests: 0 });
    expect(f.store.eventCount()).toBe(0);
    expect(f.store.get('SELECT scope_verified,identity_verified FROM codex_workflow_runs WHERE id=?', ['native-shape'])).toEqual({
      scope_verified: 1,
      identity_verified: 1
    });
  } finally {
    f.cleanup();
  }
});
test.each(['ready', 'empty', 'partial-header', 'partial-tail'])(
  'native root shape %s binds before own usage and resumes without backfill',
  async mode => {
    const f = nativeShapeFixture(mode);
    try {
      const first = await runAssignedWorkflow(f.store, f.input, createSyntheticCodexWorkflowAdapter(f.store, f.execution('launch'), f.script), runtime);
      expect(first.adapter_result).toMatchObject({ state: 'completed', observed_requests: 1 });
      const id = first.adapter_result!.session_id!;
      const resumed = await runAssignedWorkflow(
        f.store,
        { ...f.input, confirmation_id: 'resume-confirmation' },
        createSyntheticCodexWorkflowAdapter(f.store, f.execution('resume', 'resume', id), f.script),
        runtime
      );
      expect(resumed.adapter_result).toMatchObject({ state: 'completed', session_id: id, observed_requests: 1 });
      expect(f.store.eventCount()).toBe(2);
      expect(f.store.all('SELECT id FROM sessions')).toHaveLength(1);
    } finally {
      f.cleanup();
    }
  },
  15000
);
test.each([
  ['fork', 'root_header', 'unsupported_root_history'],
  ['nonzero', 'root_header', 'invalid_root_ordinal'],
  ['ordinal-gap', 'projection', 'candidate_unsupported_history'],
  ['invalid-json', 'envelope', 'invalid_json']
])('native-shaped %s retains the first safe collector failure across the hook boundary', async (mode, stage, code) => {
  const f = nativeShapeFixture(mode);
  try {
    const result = await runAssignedWorkflow(f.store, f.input, createSyntheticCodexWorkflowAdapter(f.store, f.execution('reject'), f.script), runtime);
    expect(result.adapter_result).toMatchObject({ state: 'failed', diagnostic: { stage, code }, observed_requests: 0 });
    const retained = JSON.stringify(result.adapter_result) + JSON.stringify(f.store.all('SELECT diagnostic_stage,diagnostic_code FROM codex_workflow_runs'));
    expect(retained).not.toContain('PRIVATE');
    expect(f.store.eventCount()).toBe(0);
  } finally {
    f.cleanup();
  }
});
test('an initial empty source that never completes cannot extend the invocation deadline or admit usage', async () => {
  const f = nativeShapeFixture('no-header');
  try {
    const result = await runAssignedWorkflow(
      f.store,
      f.input,
      createSyntheticCodexWorkflowAdapter(f.store, { ...f.execution('empty-deadline'), timeout_ms: 1000 }, f.script),
      runtime
    );
    expect(result.adapter_result).toMatchObject({ state: 'failed', observed_requests: 0 });
    expect(['deadline', 'initial_source_incomplete']).toContain(result.adapter_result!.reason);
    expect(f.store.eventCount()).toBe(0);
    expect(f.store.all('SELECT id FROM codex_workflow_runs')).toHaveLength(1);
    expect(f.store.get('SELECT identity_verified FROM codex_workflow_runs')).toEqual({ identity_verified: 0 });
  } finally {
    f.cleanup();
  }
});
test('an unknown source exception persists only a fixed safe stage/code', async () => {
  const f = codexWorkflowFixture();
  const spy = vi.spyOn(collection, 'readSource').mockImplementation(() => {
    throw new Error('PRIVATE BODY sk-synthetic', { cause: 'PRIVATE CREDENTIAL' });
  });
  try {
    const root = f.newRoot();
    const result = await runAssignedWorkflow(
      f.store,
      f.input,
      createSyntheticCodexWorkflowAdapter(f.store, f.execution('unknown', 'link', root.id, root.path), f.script),
      runtime
    );
    expect(result.adapter_result).toMatchObject({ state: 'failed', diagnostic: { stage: 'source_read', code: 'unknown' } });
    expect(JSON.stringify(result.adapter_result)).not.toContain('PRIVATE');
  } finally {
    spy.mockRestore();
    f.cleanup();
  }
});
