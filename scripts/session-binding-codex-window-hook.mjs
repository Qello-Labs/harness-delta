#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, opendirSync, openSync, readSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value);
const pathHint = value => typeof value === 'string' && value.length <= 4096 && !value.includes('\0') && isAbsolute(value);
const invalid = () => {
  throw new Error('invalid');
};

function configuration() {
  const args = process.argv.slice(2);
  if (args.length !== 4) invalid();
  const values = new Map();
  for (let i = 0; i < args.length; i += 2) {
    if (!['--receipt-directory', '--project-root'].includes(args[i]) || values.has(args[i]) || !pathHint(args[i + 1])) invalid();
    values.set(args[i], args[i + 1]);
  }
  const directory = values.get('--receipt-directory');
  const projectRoot = values.get('--project-root');
  if (resolve(directory) !== directory || resolve(projectRoot) !== projectRoot) invalid();
  const distance = relative(projectRoot, directory);
  if (!distance || distance === '..' || distance.startsWith(`..${sep}`) || isAbsolute(distance)) invalid();
  // Only the explicitly configured owned storage is inspected, never hook path hints.
  const ancestors = [];
  for (let current = directory; ; current = dirname(current)) {
    ancestors.push(current);
    if (current === dirname(current)) break;
  }
  for (const current of ancestors.reverse()) {
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) invalid();
    if (current === directory && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)) invalid();
  }
  return { directory, projectRoot };
}

function receiptArmingLive(arming) {
  if (
    arming === null ||
    typeof arming !== 'object' ||
    Object.keys(arming).length !== 6 ||
    !id(arming.projectId) ||
    !id(arming.taskId) ||
    !Number.isSafeInteger(arming.generation) ||
    arming.generation < 0 ||
    typeof arming.policyDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(arming.policyDigest) ||
    typeof arming.armedAt !== 'string' ||
    typeof arming.expiresAt !== 'string'
  )
    return false;
  const started = Date.parse(arming.armedAt);
  const expires = Date.parse(arming.expiresAt);
  const now = Date.now();
  return Number.isFinite(started) && Number.isFinite(expires) && expires > started && expires - started <= 2_147_483_647 && now >= started && now < expires;
}

function activeControl({ directory, projectRoot }) {
  const fd = openSync(join(directory, 'ordinary-window-control.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > 4096) invalid();
    const buffer = Buffer.alloc(4097);
    const size = readSync(fd, buffer, 0, buffer.length, 0);
    if (size > 4096) invalid();
    const control = JSON.parse(buffer.subarray(0, size).toString('utf8'));
    if (control === null || typeof control !== 'object' || !['active', 'receipt_only'].includes(control.state)) return null;
    if (control.state === 'receipt_only' && !receiptArmingLive(control.arming)) return null;
    const expected = {
      schemaVersion: 1,
      projectRoot,
      product: 'codex',
      policyId: 'codex-binding-root-window-v1',
      policyRevision: 'codex-ordinary-root-window-v1',
      evidenceMode: 'source_only',
      state: control.state,
      ...(control.state === 'receipt_only' ? { arming: control.arming } : {})
    };
    return Object.keys(control).length === Object.keys(expected).length && Object.entries(expected).every(([key, value]) => control[key] === value)
      ? control
      : null;
  } finally {
    closeSync(fd);
  }
}

async function payload() {
  const chunks = [];
  let bytes = 0;
  const timer = setTimeout(() => process.stdin.destroy(new Error('invalid')), 2000);
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
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    invalid();
  }
  const event = input.hook_event_name;
  if (!['SessionStart', 'SubagentStart'].includes(event) || !id(input.session_id) || !pathHint(input.cwd)) invalid();
  const sourceRef = pathHint(input.transcript_path) ? input.transcript_path : null;
  const child = event === 'SubagentStart';
  if (child && (!id(input.agent_id) || input.agent_id === input.session_id || (input.turn_id != null && !id(input.turn_id)))) invalid();
  const lifecycle = input.source == null ? null : ['startup', 'resume', 'clear', 'compact'].includes(input.source) ? input.source : 'unsupported';
  return {
    schemaVersion: 2,
    kind: 'codex_window_pending',
    receipt: randomUUID(),
    product: 'codex',
    event,
    lifecycle,
    nativeSessionId: child ? input.agent_id : input.session_id,
    nativeRootSessionId: input.session_id,
    agentId: child ? input.agent_id : null,
    turnId: child ? (input.turn_id ?? null) : null,
    cwd: input.cwd,
    sourceRef,
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
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: record.event,
        additionalContext: `Harness Delta pending window receipt: ${record.receipt}`
      }
    })
  );
}

try {
  const config = configuration();
  const control = activeControl(config);
  if (control) {
    const record = await payload();
    if (control.state === 'receipt_only' && record.cwd !== config.projectRoot) {
      invalid();
    }
    const current = activeControl(config);
    if (current && (control.state !== 'receipt_only' || JSON.stringify(current) === JSON.stringify(control))) emit(config.directory, record);
  }
} catch {
  process.stderr.write('binding_window_hook_metadata_unavailable\n');
  process.exitCode = 1;
}
