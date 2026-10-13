import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test } from 'vitest';

test.each([
  ['22.0.0', 2, 'unsupported_node'],
  ['24.21.0', 3, 'build_required'],
  ['25.0.0', 2, 'unsupported_node'],
  ['26.10.0', 3, 'build_required'],
  ['27.0.0', 2, 'unsupported_node'],
] as const)(
  'first run rejects %s before importing the missing build', (version, code, error) => {
    const root = mkdtempSync(join(tmpdir(), 'hm-first-run-'));
    try {
      const launcher = new URL('../scripts/hm.mjs', import.meta.url).href;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e',
        `import {launch} from ${JSON.stringify(launcher)}; process.exitCode=await launch([],new URL(${JSON.stringify(pathToFileURL(root + '/').href)}),${JSON.stringify(version)});`], { encoding: 'utf8' });
      expect(result.status).toBe(code);
      expect(JSON.parse(result.stderr)).toMatchObject({ error });
    } finally { rmSync(root, { recursive: true, force: true }); }
  },
);

test('installed supported Node launcher preserves CLI help and arguments', () => {
  const result = spawnSync(process.execPath, ['scripts/hm.mjs', '--help'], { encoding: 'utf8' });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Usage: hm');
});

test('a build without installed dependencies has a distinct prerequisite result', () => {
  const root = mkdtempSync(join(tmpdir(), 'hm-first-run-'));
  try {
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist', 'cli.js'), 'throw new Error("entry must not be imported");');
    const launcher = new URL('../scripts/hm.mjs', import.meta.url).href;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import {launch} from ${JSON.stringify(launcher)}; process.exitCode=await launch([],new URL(${JSON.stringify(pathToFileURL(root + '/').href)}));`], { encoding: 'utf8' });
    expect(result.status).toBe(4);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: 'dependencies_required' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test.each([
  { script: 'skills/harness-register/scripts/run.mjs', args: ['--harness-delta', '/synthetic', '--root', '/synthetic', '--input', '/synthetic'], json: false },
  { script: 'skills/harness-compare-config/scripts/run.mjs', args: ['--harness-delta', '/synthetic', '--root', '/synthetic', '--input', '/synthetic'], json: false },
  { script: 'skills/harness-apply/scripts/apply.mjs', args: ['status', '--origin', 'http://127.0.0.1:1', '--task', 'synthetic'], json: false },
  { script: 'scripts/analysis-validation-command.mjs', args: [], json: true },
  { script: 'scripts/confidence-validation-command.mjs', args: [], json: true },
].flatMap(config => ['25.0.0', '27.0.0'].map(version => ({ ...config, version }))))(
  '$script rejects Node $version before downstream operations', ({ script, args, json, version }) => {
    const entry = new URL('../' + script, import.meta.url).href;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `Object.defineProperty(process.versions,'node',{value:${JSON.stringify(version)}});process.argv=[process.execPath,${JSON.stringify(script)},...${JSON.stringify(args)}];await import(${JSON.stringify(entry)});`], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    if (json) expect(JSON.parse(result.stdout)).toEqual({ status: 'fail', failures: ['unsupported_node'] });
    else expect(result.stderr.trim()).toBe('unsupported_node');
  },
);

test.each([
  ['24.21.0', 'claude_probe_executable_mismatch'],
  ['25.0.0', 'claude_probe_invalid_supervisor'],
  ['26.10.0', 'claude_probe_executable_mismatch'],
  ['27.0.0', 'claude_probe_invalid_supervisor'],
] as const)('Claude supervisor under Node %s validates the runtime before binary identity', (version, error) => {
  const entry = new URL('../dist/claude-probe-supervisor.js', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `Object.defineProperty(process.versions,'node',{value:${JSON.stringify(version)}});const {prepareClaudeProbeSupervisor}=await import(${JSON.stringify(entry)});try{await prepareClaudeProbeSupervisor({});process.exitCode=1;}catch(error){console.log(JSON.stringify({error:error.message}));}`], { encoding: 'utf8' });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ error });
});
