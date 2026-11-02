import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Explicit projections only: never serialize tasks, errors, logs or arbitrary metadata.
export default class CiReporter {
  constructor() {
    const job = process.env.CI_RESULTS_JOB;
    if (!['process-budget', 'default'].includes(job)) throw new Error('Invalid CI result job');
    const directory = join('.harness-delta/ci-results', job);
    mkdirSync(directory, { recursive: true });
    this.file = join(directory, 'tests.jsonl');
    writeFileSync(this.file, '');
  }

  write(row) { appendFileSync(this.file, `${JSON.stringify(row)}\n`); }

  onTestRunStart() {
    this.write({ type: 'run', status: 'running', runner: { node: process.version, platform: process.platform, arch: process.arch } });
  }

  onTestCaseResult(test) {
    this.write({ type: 'test', project: test.project.name, file: test.module.relativeModuleId,
      id: test.id, name: test.fullName, status: test.result().state, durationMs: test.diagnostic()?.duration ?? null });
  }

  onTestModuleEnd(module) {
    this.write({ type: 'file', project: module.project.name, file: module.relativeModuleId,
      status: module.state(), durationMs: module.diagnostic().duration });
  }

  onTestRunEnd(_modules, errors, reason) {
    const status = reason === 'interrupted' ? 'interrupted' : errors.length > 0 ? 'failed' : reason;
    this.write({ type: 'run', status });
    console.log(`CI tests: ${status}`);
  }
}
