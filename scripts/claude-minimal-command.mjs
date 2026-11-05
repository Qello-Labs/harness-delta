// Manual internal qualification entry. Building/testing/prepare never launches
// a product. execute requires separately obtained actual user + settings consent.
import { readFileSync } from 'node:fs';
import { createClaudeMinimalIntent, executeClaudeMinimalIntent } from '../dist/qualification/claude-minimal-run.js';
const [command, ...args] = process.argv.slice(2);
try {
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('node24_required');
  if (command === 'prepare' && args.length === 4) {
    const [directory, binaryPath, sha256, mediatorPath] = args;
    const prepared = createClaudeMinimalIntent(directory, { path: binaryPath, sha256, version: '2.1.288' }, mediatorPath);
    process.stdout.write(JSON.stringify(prepared) + '\n');
  } else if (command === 'execute' && args.length === 2) {
    const result = await executeClaudeMinimalIntent(args[0], JSON.parse(readFileSync(args[1], 'utf8')));
    process.stdout.write(JSON.stringify(result) + '\n');
    if (result.status !== 'completed') process.exitCode = 1;
  } else throw new Error('explicit_prepare_or_execute_required');
} catch { process.stderr.write('claude_minimal_input_or_state_error\n'); process.exitCode = 2; }
