import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

try {
  const { values } = parseArgs({
    options: { receipt: { type: 'string' } }, strict: true, allowPositionals: false,
  });
  if (!values.receipt || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(values.receipt)) {
    throw new Error('binding_qualification_connector_invalid');
  }
  const directory = dirname(realpathSync(fileURLToPath(import.meta.url)));
  const intent = JSON.parse(readFileSync(join(directory, 'execution-intent.json'), 'utf8'));
  const helper = join(intent.project, '.agents', 'skills', 'harness-connect', 'scripts', 'connect.mjs');
  const options = ['--origin', 'http://127.0.0.1:4319', '--product', 'codex', '--project', intent.project_id, '--task', intent.task_id];
  execFileSync(process.execPath, [helper, 'inspect', ...options], { stdio: 'inherit' });
  execFileSync(process.execPath, [helper, 'connect', ...options, '--receipt', values.receipt], { stdio: 'inherit' });
} catch (error) {
  if (!(error instanceof Error && 'status' in error && typeof error.status === 'number')) {
    process.stdout.write(JSON.stringify({ status: 'blocked', reason_code: 'binding_qualification_connector_invalid', verified: false }) + '\n');
  }
  process.exitCode = 1;
}
