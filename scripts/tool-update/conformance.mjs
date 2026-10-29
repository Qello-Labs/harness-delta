import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { assertPins, awaitSupervisor, ConformanceError, failureCodes, observedProcess, prepareFixture, privateDirectory,
  privateRead, repository, requireCondition, safeCode, snapshotPins, verifySystemPs, writePrivateJson } from './fixtures.mjs';

export const admittedImage = Object.freeze({ version: '2.1.306',
  sha256: 'b5d795b7760032d79954b55a9cd1876dcf3a8dc9608fd6bb9f618593f69fd44b', size: 272984176 });
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const pinKeys = ['binary', 'runtime', 'source', 'build', 'instrument', 'skill', 'lockfile',
  'package', 'supervisor', 'python', 'ps', 'pgrep', 'git'];
export const approvalSchema = z.strictObject({
  schema_version: z.literal(1), approved: z.literal(true), run_id: z.uuid(),
  approved_at: z.iso.datetime(), expires_at: z.iso.datetime(),
  product: z.literal('claude_code'), version: z.literal(admittedImage.version),
  binary_sha256: z.literal(admittedImage.sha256), binary_size: z.literal(admittedImage.size),
  route: z.literal('claude_binding'), profile_id: z.literal('claude-binding-2-1-306-family-v1'),
  runtime: z.strictObject({ version: z.string().regex(/^v24\.\d+\.\d+$/), sha256: digest,
    platform: z.literal('darwin'), arch: z.literal('arm64') }),
  scope: z.strictObject({ kind: z.literal('localhost_synthetic_print'), roots: z.literal(1),
    members: z.literal(2), scenarios: z.tuple([z.literal('normal'), z.literal('sigint')]),
    model: z.literal('claude-sonnet-5-5') }),
  mode: z.enum(['manual', 'unattended']), localhost_only_not_isolated: z.literal(true),
  budgets: z.strictObject({ duration_ms: z.number().int().min(10000).max(120000),
    termination_ms: z.number().int().min(1000).max(10000),
    term_grace_ms: z.number().int().min(100).max(2000) }),
  pins: z.strictObject(Object.fromEntries(pinKeys.map(key => [key, digest]))),
});
export const failureEvidenceSchema = z.strictObject({
  schema_version: z.literal(1), status: z.literal('failed'), code: z.enum(failureCodes),
  run_id: z.uuid().nullable(), stage: z.enum(['initialization', 'scenario', 'cleanup', 'finalization']),
  scenario: z.enum(['normal', 'sigint']).nullable(), execution_attempted: z.boolean(),
  lane: z.literal('claude-2.1.306-localhost-print'), endpoint: z.literal('localhost_synthetic'),
  authenticated: z.literal(false), interactive_qualified: z.literal(false),
  ordinary_qualified: z.literal(false), complete_cost: z.literal(false), egress_isolation_verified: z.literal(false),
});
export function persistFailure(directory, state, error) {
  const code = safeCode(error);
  const evidence = failureEvidenceSchema.parse({
    schema_version: 1, status: 'failed', code, run_id: state.runId,
    stage: code === 'cleanup_unverified' ? 'cleanup' : state.stage,
    scenario: state.scenario, execution_attempted: state.executionAttempted,
    lane: 'claude-2.1.306-localhost-print', endpoint: 'localhost_synthetic',
    authenticated: false, interactive_qualified: false, ordinary_qualified: false,
    complete_cost: false, egress_isolation_verified: false,
  });
  writePrivateJson(join(privateDirectory(directory), `failure-${randomUUID()}.json`), evidence);
  return evidence;
}

export function validateApproval(input, context) {
  const parsed = approvalSchema.safeParse(input);
  requireCondition(parsed.success, 'approval_invalid');
  const approval = parsed.data;
  requireCondition(approval.mode === 'manual', 'unattended_isolation_unverified');
  requireCondition(Date.parse(approval.approved_at) <= context.now &&
    Date.parse(approval.expires_at) > context.now &&
    Date.parse(approval.expires_at) - Date.parse(approval.approved_at) <= 3600000, 'approval_expired');
  requireCondition(approval.budgets.term_grace_ms < approval.budgets.termination_ms, 'approval_invalid');
  requireCondition(context.version === approval.runtime.version && context.platform === approval.runtime.platform &&
    context.arch === approval.runtime.arch && context.runtimeSha256 === approval.runtime.sha256, 'runtime_mismatch');
  requireCondition(context.binarySha256 === approval.binary_sha256 && context.binarySize === approval.binary_size, 'binary_mismatch');
  requireCondition(JSON.stringify(pinKeys.map(k => context.pins[k])) === JSON.stringify(pinKeys.map(k => approval.pins[k])), 'approval_mismatch');
  return approval;
}
export function loadApproval(path, binary) {
  requireCondition(isAbsolute(path) && isAbsolute(binary) && realpathSync(binary) === binary, 'private_input_invalid');
  const input = JSON.parse(privateRead(path, privateDirectory(realpathSync(join(path, '..'))), () => true, 65536));
  // Reject unknown and unregistered inputs before any subprocess, including ps.
  const parsed = approvalSchema.safeParse(input);
  requireCondition(parsed.success, 'approval_invalid');
  requireCondition(parsed.data.mode === 'manual', 'unattended_isolation_unverified');
  const stat = lstatSync(binary);
  requireCondition(stat.isFile() && !stat.isSymbolicLink() && stat.size === admittedImage.size &&
    (stat.mode & 0o111) !== 0, 'binary_mismatch');
  const pins = snapshotPins(binary);
  return validateApproval(input, { now: Date.now(), version: process.version, platform: process.platform,
    arch: process.arch, runtimeSha256: pins.runtime, binarySha256: pins.binary, binarySize: stat.size, pins });
}
export async function preflight(path, binary) {
  const approval = loadApproval(path, binary);
  const { getClaudeBindingAdmission } = await import(join(repository, 'dist/claude-binding-admission.js'));
  const admission = getClaudeBindingAdmission(approval.version);
  requireCondition(admission?.admitted === true && admission.binarySha256 === approval.binary_sha256 &&
    admission.profileId === approval.profile_id && admission.maxFamilyMembers === 3 &&
    admission.qualified === false, 'admission_missing');
  verifySystemPs();
  assertPins(approval.pins, binary);
  return approval;
}

/** Only fixed statuses/counts escape the supervisor; process metadata stays transient. */
function verifyCleanup(result) {
  requireCondition(result?.ownershipVerified === true && result.terminationVerified === true &&
    result.controllingTerminal === true && Number.isSafeInteger(result.ownedMembers) && result.ownedMembers >= 1, 'cleanup_unverified');
  return { tracked_identities_gone: true, ownership_verified: true,
    observed_escape: result.escapedMemberObserved === true, tracked_count: result.ownedMembers,
    unobserved_escapes_excluded: false };
}
function verifyWorkerExit(result, exit) {
  requireCondition(result.status === 'completed' && result.exitCode === 0 && exit[0] === 0 && exit[1] === null, 'native_failed');
}
export function verifyOwner(result, exit) {
  const owner = verifyCleanup(result);
  verifyWorkerExit(result, exit);
  return owner;
}

export function startOwnedWorker(config, onEvidence = () => {}) {
  let protocol = '', output = '', result, evidence, failure;
  const recordFailure = code => { failure ??= code; launched.child.stdio[3]?.end(); };
  const launched = observedProcess('/usr/bin/python3', [join(repository, 'scripts/owned-cli-pty.py'), JSON.stringify(config)],
    { cwd: config.cwd, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC',
      HOME: join(config.cwd, 'home'), TMPDIR: join(config.cwd, 'tmp') },
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'] }, child => {
      child.once('spawn', () => {
        child.stderr.on('data', bytes => {
          protocol += bytes.toString('utf8');
          if (protocol.length > 65536) { protocol = ''; recordFailure('observer_lost'); return; }
          let index;
          while ((index = protocol.indexOf('\n')) >= 0) {
            const line = protocol.slice(0, index); protocol = protocol.slice(index + 1);
            try {
              const row = JSON.parse(line);
              if (row.type === 'result') {
                if (result) recordFailure('observer_lost');
                result = row;
              } else if (row.type !== 'spawn') recordFailure('observer_lost');
            } catch { recordFailure('observer_lost'); }
          }
        });
        child.stdout.on('data', bytes => {
          output += bytes.toString('utf8');
          if (output.length > 65536) { output = ''; recordFailure('observer_lost'); return; }
          let index;
          while ((index = output.indexOf('\n')) >= 0) {
            const line = output.slice(0, index); output = output.slice(index + 1);
            try {
              const row = JSON.parse(line);
              if (row.kind === 'evidence' && !evidence) { evidence = row.value; onEvidence(evidence); }
              else if (row.kind === 'failure') recordFailure(safeCode(new ConformanceError(row.code)));
              else recordFailure('observer_lost');
            } catch { recordFailure('observer_lost'); }
          }
        });
        child.stdout.on('error', () => recordFailure('observer_lost'));
        child.stderr.on('error', () => recordFailure('observer_lost'));
        child.stdio[3].on('error', () => { failure ??= 'observer_lost'; });
      });
    });
  const completed = awaitSupervisor(launched, config.durationMs + config.terminationMs + 5000, config.terminationMs)
    .then(exit => {
      const owner = verifyCleanup(result);
      requireCondition(!failure, failure ?? 'observer_lost');
      verifyWorkerExit(result, exit);
      requireCondition(evidence?.accepted === true && protocol.trim() === '' && output.trim() === '', 'observer_lost');
      return { evidence, owner };
    }).finally(() => launched.child.stdio[3]?.end());
  return { child: launched.child, completed };
}

export async function runConformance({ approvalFile, binary, out }) {
  privateDirectory(out);
  const previousMask = process.umask(0o077);
  let destination = out;
  const state = { runId: null, stage: 'initialization', scenario: null, executionAttempted: false };
  try {
    const approval = await preflight(approvalFile, binary);
    state.runId = approval.run_id;
    const selected = join(out, approval.run_id);
    mkdirSync(selected, { mode: 0o700 }); destination = selected;
    const results = [];
    for (const scenario of approval.scope.scenarios) {
      state.stage = 'scenario'; state.scenario = scenario;
      assertPins(approval.pins, binary);
      // Darwin's per-user tmpdir can exceed native Unix-socket path budgets.
      const root = realpathSync(mkdtempSync('/private/tmp/hd-cc-'));
      await prepareFixture(root);
      const cfg = { command: realpathSync(process.execPath),
        args: [fileURLToPath(import.meta.url), '--worker', approvalFile, binary, root, scenario],
        cwd: root, durationMs: approval.budgets.duration_ms,
        terminationMs: approval.budgets.termination_ms, termGraceMs: approval.budgets.term_grace_ms,
        rows: 40, columns: 120 };
      state.executionAttempted = true;
      const result = await startOwnedWorker(cfg).completed;
      assertPins(approval.pins, binary);
      results.push({ scenario, ...result });
      // Failed fixtures remain private; only verified disappearance permits removal.
      try { rmSync(root, { recursive: true }); }
      catch { throw new ConformanceError('cleanup_unverified'); }
    }
    state.stage = 'finalization'; state.scenario = null;
    assertPins(approval.pins, binary);
    const evidence = { schema_version: 1, run_id: approval.run_id, accepted: true,
      product: approval.product, version: approval.version, binary_sha256: approval.binary_sha256,
      runtime: approval.runtime, pins: approval.pins, results,
      endpoint: 'localhost_synthetic', authenticated: false, interactive_qualified: false,
      ordinary_qualified: false, complete_cost: false, egress_isolation_verified: false };
    writePrivateJson(join(destination, 'evidence.json'), evidence);
    return evidence;
  } catch (error) {
    const evidence = persistFailure(destination, state, error);
    throw new ConformanceError(evidence.code);
  } finally { process.umask(previousMask); }
}

export function parseArguments(argv) {
  requireCondition(argv.length === 6 && argv[0] === '--approval' && argv[2] === '--binary' &&
    argv[4] === '--out' && [argv[1], argv[3], argv[5]].every(p => typeof p === 'string' && isAbsolute(p)), 'approval_invalid');
  return { approvalFile: argv[1], binary: argv[3], out: argv[5] };
}
async function main(argv) {
  if (argv[0] === '--worker') {
    requireCondition(argv.length === 5 && ['normal', 'sigint'].includes(argv[4]), 'approval_invalid');
    const approval = await preflight(argv[1], argv[2]);
    const { runLocalhost } = await import('./claude-localhost.mjs');
    const value = await runLocalhost({ approvalFile: argv[1], binary: argv[2], root: argv[3], scenario: argv[4] });
    assertPins(approval.pins, argv[2]);
    process.stdout.write(JSON.stringify({ kind: 'evidence', value }) + '\n');
  } else {
    await runConformance(parseArguments(argv));
    process.stdout.write('conformance_passed\n');
  }
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2)).catch(error => {
    process.stdout.write(JSON.stringify({ kind: 'failure', code: safeCode(error) }) + '\n');
    process.exitCode = 1;
  });
}
