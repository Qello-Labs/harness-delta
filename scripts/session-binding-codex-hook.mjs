#!/usr/bin/env node
// Proposed synchronous SessionStart/SubagentStart hook only. Never installs itself.
// Official input/output: https://learn.chatgpt.com/docs/hooks
import { randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value);
const path = value => typeof value === 'string' && value.length <= 4096 && isAbsolute(value);
const inside = (root, target) => { const r = relative(root, target); return r !== '' && r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r); };
try {
  const args = process.argv.slice(2); let directory; let productVersion = '0.160.0'; const roots = [];
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === '--receipt-directory') directory = args[i + 1];
    else if (args[i] === '--source-root') roots.push(args[i + 1]);
    else if (args[i] === '--product-version') productVersion = args[i + 1];
    else throw new Error('invalid');
  }
  if (!['0.160.0', '0.162.0', '0.162.1', '0.163.0'].includes(productVersion) || !path(directory) || roots.length === 0 || roots.some(root => !path(root))) throw new Error('invalid');
  let bytes = 0; const chunks = [];
  for await (const chunk of process.stdin) { bytes += chunk.length; if (bytes > 65536) throw new Error('invalid'); chunks.push(chunk); }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const event = input.hook_event_name;
  if (!['SessionStart', 'SubagentStart'].includes(event) || !id(input.session_id) || !path(input.cwd) || !path(input.transcript_path) ||
    event === 'SessionStart' && !['startup', 'resume', 'clear', 'compact'].includes(input.source) ||
    event === 'SubagentStart' && (!id(input.agent_id) || !id(input.turn_id) || input.agent_id === input.session_id)) throw new Error('invalid');
  // Check lexical containment before any source lookup, then canonical containment
  // to reject symlink escapes. Configure roots in the native hook's path spelling.
  if (!roots.some(root => inside(resolve(root), resolve(input.transcript_path)))) throw new Error('invalid');
  if (lstatSync(input.transcript_path).isSymbolicLink()) throw new Error('invalid');
  const source = realpathSync(input.transcript_path);
  if (!roots.map(root => realpathSync(root)).some(root => inside(root, source))) throw new Error('invalid');
  const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let stat;
  try { stat = fstatSync(fd); if (!stat.isFile()) throw new Error('invalid'); } finally { closeSync(fd); }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o077) !== 0 ||
    directoryStat.uid !== process.getuid?.()) throw new Error('invalid');
  const receipt = randomUUID();
  // Deliberately no object spread: arbitrary native hook fields never persist.
  // Version comes from reviewed hook configuration, never an unverified input field or environment.
  const record = { schemaVersion: 1, receipt, productVersion, event,
    sessionId: event === 'SessionStart' ? input.session_id : input.agent_id,
    // Native session_id is the shared family root, not the immediate parent.
    // The authorized provider resolves parentage from this exact source's header.
    parentSessionId: null,
    ...(event === 'SubagentStart' ? { nativeRootSessionId: input.session_id } : {}),
    turnId: event === 'SubagentStart' ? input.turn_id : null,
    sourceRef: source, sourceIdentity: `${stat.dev}:${stat.ino}`, cwd: realpathSync(input.cwd),
    createdAt: new Date().toISOString() };
  writeFileSync(join(directory, `${receipt}.json`), JSON.stringify(record), { flag: 'wx', mode: 0o600 });
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event,
    additionalContext: `Harness Delta session binding receipt: ${receipt}` } }));
} catch {
  // Never echo input, paths, environment, parser errors or native diagnostics.
  process.stderr.write('binding_hook_metadata_unavailable\n');
  process.exitCode = 1;
}
