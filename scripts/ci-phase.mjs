import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { constants } from 'node:os';

const [job, phase, command, ...args] = process.argv.slice(2);
if (!['static', 'process-budget', 'default'].includes(job)
  || !['install', 'privacy', 'lint', 'typecheck', 'build', 'tests'].includes(phase) || !command) {
  throw new Error('Invalid CI phase invocation');
}
const directory = join('.harness-delta/ci-results', job);
mkdirSync(directory, { recursive: true });
const file = join(directory, 'phases.jsonl');
const started = performance.now();
const write = (row) => appendFileSync(file, `${JSON.stringify({ phase, ...row })}\n`);
write({ status: 'running', runner: { node: process.version, platform: process.platform, arch: process.arch } });
const child = spawn(command, args, { stdio: 'inherit', env: { ...process.env, CI_RESULTS_JOB: job } });
let interrupted;
const handlers = new Map(['SIGINT', 'SIGTERM'].map((signal) => {
  const handler = () => { interrupted = signal; child.kill(signal); };
  process.on(signal, handler);
  return [signal, handler];
}));
child.on('error', () => { /* The close event records launch failure without error text. */ });
child.on('close', (code, signal) => {
  for (const [name, handler] of handlers) process.off(name, handler);
  const exitCode = interrupted || signal ? 128 + (constants.signals[interrupted ?? signal] ?? 1) : code === null || code < 0 ? 1 : code;
  const status = interrupted ? 'interrupted' : exitCode === 0 ? 'passed' : 'failed';
  const durationMs = Math.round(performance.now() - started);
  write({ status, durationMs, exitCode });
  console.log(`CI phase ${phase}: ${status} (${durationMs} ms, exit ${exitCode})`);
  process.exitCode = exitCode;
});
