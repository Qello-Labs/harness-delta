import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { verifyClaudeWorkflowVersion } from '../src/claude-probe-supervisor.js';
import { expect, test } from 'vitest';
import { Store } from '../src/store.js';
import { CodexWorkflowExecutionSchema, createCodexWorkflowAdapter } from '../src/codex-workflow-adapter.js';
import { ClaudeWorkflowExecutionSchema, createClaudeWorkflowAdapter } from '../src/claude-workflow-adapter.js';
import { evaluateReadiness, productionSourceEvidence } from '../src/readiness.js';
import { makeFlexibleFixture } from './helpers/flexible-fixture.js';

const codex = { run_id: 'run-forward', operation: 'launch', product_version: '0.161.0', binary: { path: '/synthetic/codex', sha256: 'a'.repeat(64) }, codex_home: '/synthetic/home', hook_recorder: '/synthetic/recorder', prompt_file: '/synthetic/prompt', sandbox: 'read-only', timeout_ms: 1000 };
const claude = { run_id: 'run-forward', operation: 'launch', binary: { path: '/synthetic/claude', version: '2.1.297', sha256: 'a'.repeat(64) }, workspace: '/synthetic/workspace', mediator_path: '/synthetic/mediator', prompt_file: '/synthetic/prompt', timeout_ms: 1000, max_turns: 1, request_limit: 1 };
test.each([['0.161.0', '2.1.297'], ['0.162.1', '2.1.298'], ['0.163.0', '2.1.301']])('functional native execution accepts %s and %s with their actual identity', (codexVersion, claudeVersion) => {
  const codexExecution = { ...codex, product_version: codexVersion };
  const claudeExecution = { ...claude, binary: { ...claude.binary, version: claudeVersion } };
  expect(CodexWorkflowExecutionSchema.safeParse(codexExecution).success).toBe(true);
  expect(ClaudeWorkflowExecutionSchema.safeParse(claudeExecution).success).toBe(true);
  const store = new Store(':memory:'); try {
    expect(createCodexWorkflowAdapter(store, codexExecution).productVersion).toBe(codexVersion);
    expect(createClaudeWorkflowAdapter(store, claudeExecution).productVersion).toBe(claudeVersion);
  } finally { store.close(); }
});
test.each(['0.159.0', '0.164.0', '0.161.0-rc.1', '00.161.0'])('Codex native rejects unsupported version %s', product_version => {
  expect(CodexWorkflowExecutionSchema.safeParse({ ...codex, product_version }).success).toBe(false);
});
test.each(['2.1.290', '2.2.0', '2.1.297-rc.1', '2.01.292'])('Claude native rejects unsupported version %s', version => {
  expect(ClaudeWorkflowExecutionSchema.safeParse({ ...claude, binary: { ...claude.binary, version } }).success).toBe(false);
});
test.each([['codex', '0.161.0', 'codex-workflow-own-response-v1'], ['codex', '0.162.1', 'codex-workflow-own-response-v1'], ['codex', '0.163.0', 'codex-workflow-own-response-v1'], ['claude_code', '2.1.297', 'claude-workflow-own-trace-v1'], ['claude_code', '2.1.298', 'claude-workflow-own-trace-v1'], ['claude_code', '2.1.301', 'claude-workflow-own-trace-v1']] as const)('forward %s versions never gain exact experiment readiness', (product, product_version, profile_id) => {
  const f = makeFlexibleFixture();
  expect(evaluateReadiness({ protocol: { ...f.protocol, purpose: 'real_experiment', source_profiles: [{ product, product_version, profile_id }] }, source_evidence_ids: productionSourceEvidence.map(e => e.id), coverage: [], analysis_evidence_id: null, invalidated: false, followup_complete: false })).toMatchObject({ real_allocation: false, complete_cost: false, inference: false });
});

test.each([['codex','0.161.0','codex-cli 0.161.0'],['codex','0.162.1','codex-cli 0.162.1'],['codex','0.163.0','codex-cli 0.163.0'],['claude','2.1.297','2.1.297 (Claude Code)'],['claude','2.1.298','2.1.298 (Claude Code)'],['claude','2.1.301','2.1.301 (Claude Code)']] as const)('conditional %s verifies actual executable version and detects replacement', (product, version, output)=>{
  const root=realpathSync(mkdtempSync('/tmp/hd-forward-bin-'));const store=new Store(':memory:');try{
    const path=join(root,'binary');writeFileSync(path,`#!/bin/sh\nprintf '%s\\n' '${output}'\n`);chmodSync(path,0o700);
    const binary={path,version,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')};
    const prompt=join(root,'prompt');writeFileSync(prompt,'SYNTHETIC');
    const verify=()=>product==='claude'?verifyClaudeWorkflowVersion(binary,root):createCodexWorkflowAdapter(store,{...codex,product_version:version,binary:{path,sha256:binary.sha256},codex_home:root,prompt_file:prompt,hook_recorder:realpathSync(resolve('scripts/conformance/candidate-start-recorder.mjs'))}).preflight?.({model:null,effort:null});
    expect(verify).not.toThrow();
    writeFileSync(path,"#!/bin/sh\nprintf '%s\\n' 'unexpected version'\n");chmodSync(path,0o700);binary.sha256=createHash('sha256').update(readFileSync(path)).digest('hex');
    expect(verify).toThrow(product==='claude'?'claude_probe_executable_mismatch':'binary_mismatch');
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('Claude rejects a changed executable before invoking its version command',()=>{
  const root=realpathSync(mkdtempSync('/tmp/hd-forward-swap-'));try{
    const path=join(root,'binary');writeFileSync(path,"#!/bin/sh\nprintf '%s\\n' '2.1.297 (Claude Code)'\n");chmodSync(path,0o700);
    const binary={path,version:'2.1.297',sha256:createHash('sha256').update(readFileSync(path)).digest('hex')};
    const marker=join(root,'unexpected');writeFileSync(path,`#!/bin/sh\ntouch '${marker}'\nprintf '%s\\n' '2.1.297 (Claude Code)'\n`);chmodSync(path,0o700);
    expect(()=>verifyClaudeWorkflowVersion(binary,root)).toThrow('claude_probe_executable_mismatch');
    expect(()=>readFileSync(marker)).toThrow();
  }finally{rmSync(root,{recursive:true,force:true});}
});
