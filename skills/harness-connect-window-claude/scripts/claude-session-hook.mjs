#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, opendirSync, openSync, readSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const invalid = () => {
  throw new Error('binding_window_hook_metadata_unavailable');
};
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value);
const hint = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\0\r\n]/.test(value);
const privateOwned = stat => stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0;

function configuration() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] !== 'record') invalid();
  const directory = process.env.HARNESS_DELTA_CLAUDE_WINDOW_RECEIPT_DIR;
  if (
    !hint(directory) ||
    !isAbsolute(directory) ||
    resolve(directory) !== directory ||
    directory !== join(dirname(dirname(directory)), '.harness-delta', 'claude-window-receipts')
  )
    invalid();
  const projectRoot = dirname(dirname(directory));
  const ancestors = [];
  for (let current = directory; ; current = dirname(current)) {
    ancestors.push(current);
    if (current === dirname(current)) break;
  }
  // Check each ancestor before descending, so a symlink is never traversed.
  for (const current of ancestors.reverse()) {
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) invalid();
    if ((current === directory || current === dirname(directory)) && !privateOwned(stat)) invalid();
    if (current === projectRoot && (stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0)) invalid();
  }
  return { directory, projectRoot };
}
function activeControl({ directory, projectRoot }) {
  const fd = openSync(join(directory, 'ordinary-window-control.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || !privateOwned(stat) || stat.nlink !== 1 || stat.size > 4096) invalid();
    const buffer = Buffer.alloc(4097);
    const size = readSync(fd, buffer, 0, buffer.length, 0);
    if (size > 4096) invalid();
    const control = JSON.parse(buffer.subarray(0, size).toString('utf8'));
    const expected = {
      schemaVersion: 1,
      projectRoot,
      product: 'claude_code',
      policyId: 'claude-binding-root-window-v1',
      policyRevision: 'claude-ordinary-root-window-v1',
      evidenceMode: 'publisher_verified_local_pin',
      state: 'active'
    };
    return (
      control !== null &&
      typeof control === 'object' &&
      !Array.isArray(control) &&
      Object.keys(control).length === Object.keys(expected).length &&
      Object.entries(expected).every(([key, value]) => control[key] === value)
    );
  } finally {
    closeSync(fd);
  }
}
async function payload() {
  const chunks = [];
  let bytes = 0;
  const timer = setTimeout(() => process.stdin.destroy(new Error('binding_window_hook_metadata_unavailable')), 2000);
  try {
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > 65536) invalid();
      chunks.push(chunk);
    }
  } finally {
    clearTimeout(timer);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (input === null || typeof input !== 'object' || Array.isArray(input) || !uuid(input.session_id) || !hint(input.cwd)) invalid();
  let event;
  switch (input.hook_event_name) {
    case 'SessionStart':
      event = 'connect';
      break;
    case 'SubagentStart':
      event = 'subagent_start';
      break;
    case 'SubagentStop':
      event = 'subagent_stop';
      break;
    default:
      invalid();
  }
  const child = event !== 'connect';
  if ((child && !id(input.agent_id)) || (!child && input.agent_id != null)) {
    invalid();
  }
  return {
    schemaVersion: 2,
    kind: 'claude_window_pending',
    receipt: randomUUID(),
    product: 'claude_code',
    event,
    nativeSessionId: input.session_id,
    nativeRootSessionId: input.session_id,
    agentId: child ? input.agent_id : null,
    sourceRef: hint(input.transcript_path) ? input.transcript_path : null,
    cwd: input.cwd,
    processIdHint: Number.isSafeInteger(process.ppid) && process.ppid > 0 ? process.ppid : null,
    recordedAt: new Date().toISOString()
  };
}
function emit(directory, record) {
  const entries = opendirSync(directory);
  try {
    let count = 0;
    while (entries.readSync() !== null) {
      count += 1;
      if (count >= 1024) invalid();
    }
  } finally {
    entries.closeSync();
  }
  const serialized = JSON.stringify(record);
  if (Buffer.byteLength(serialized) > 16384) invalid();
  const fd = openSync(join(directory, `${record.receipt}.json`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, serialized);
  } finally {
    closeSync(fd);
  }
  const hookEventName = { connect: 'SessionStart', subagent_start: 'SubagentStart', subagent_stop: 'SubagentStop' }[record.event];
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: `Harness Delta pending window receipt: ${record.receipt}` } }) + '\n'
  );
}
try {
  const config = configuration();
  if (activeControl(config)) {
    const record = await payload();
    // Revocation while stdin was pending suppresses emission, but never grants native access.
    const current = configuration();
    if (current.directory === config.directory && activeControl(current)) {
      emit(current.directory, record);
    }
  }
} catch {
  process.stderr.write('binding_window_hook_metadata_unavailable\n');
  process.exitCode = 1;
}
