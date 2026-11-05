import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync
} from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { IdSchema } from '../contracts.js';
import { Lifecycle } from '../lifecycle.js';
import { Store } from '../store.js';
import { prepareClaudeProbeSupervisor } from '../claude-probe-supervisor.js';
import { claudeProbeProductVersion } from '../claude-workflow-versions.js';
import { implementationExtension, implementationPath } from '../package-paths.js';

const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
function implementationDigest(): string {
  const names = [
    'qualification/claude-minimal-run',
    'claude-probe-supervisor',
    'claude-native-probe',
    'qualification/claude-probe-coordinator',
    'qualification/claude-probe-gateway',
    'qualification/claude-probe-hook-mediator',
    'claude-trace-candidate',
    'claude-workflow-versions',
    'nested-candidate',
    'sources/otel-projection',
    'sources/otel-launch-settings',
    'runtime-history',
    'contracts',
    'flexible-contracts',
    'lifecycle',
    'store',
    'package-paths',
    'core/tool-version-profiles'
  ];
  const files = names.map(name => ({ name, sha256: digest(readFileSync(implementationPath(name + implementationExtension))) }));
  for (const name of ['core/tool-version-profiles.json', 'core/tool-version-recipes.json', 'core/tool-version-identities.json'])
    files.push({ name, sha256: digest(readFileSync(implementationPath(name))) });
  for (const name of readdirSync(implementationPath('migrations'))
    .filter(n => n.endsWith('.sql'))
    .sort())
    files.push({ name, sha256: digest(readFileSync(implementationPath('migrations', name))) });
  return digest(JSON.stringify(files));
}
const binarySchema = z.strictObject({
  path: z.string().startsWith('/'),
  version: z.literal(claudeProbeProductVersion),
  sha256: z.string().regex(/^[a-f0-9]{64}$/)
});
const intentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  directory: z.string(),
  cwd: z.string(),
  workspace: z.string(),
  database: z.string(),
  implementationDigest: z.string().regex(/^[a-f0-9]{64}$/),
  mediatorSha256: z.string().regex(/^[a-f0-9]{64}$/),
  nodePath: z.string(),
  nodeSha256: z.string().regex(/^[a-f0-9]{64}$/),
  mediatorPath: z.string(),
  binary: binarySchema,
  projectId: IdSchema,
  taskId: IdSchema,
  rootSessionId: z.uuid(),
  nativeSessionId: z.uuid(),
  processId: z.uuid(),
  childSessionId: z.uuid(),
  generation: z.literal(1),
  productVersion: z.literal(claudeProbeProductVersion),
  model: z.literal('claude-sonnet-5-5'),
  effort: z.literal('high'),
  durationMs: z.literal(120000),
  plannedRequests: z.literal(3),
  estimatedBudgetUsd: z.literal('0.10'),
  hardBillingBound: z.null(),
  existingLoginOnly: z.literal(true),
  providerAvailabilityVerified: z.literal(false),
  actualExecutionApproved: z.literal(false),
  productGateDelta: z.literal(false)
});
const consentSchema = z.strictObject({
  intent_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  approval_reference: IdSchema,
  actual_model_run: z.literal(true),
  transient_trace_log_hooks: z.literal(true)
});

function durableFile(path: string, value: unknown): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const parent = openSync(dirname(path), constants.O_RDONLY);
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}
function readIntent(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || (before.mode & 0o777) !== 0o600 || before.size < 1 || before.size > 16384) throw new Error('invalid');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const n = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!n) throw new Error('invalid');
      offset += n;
    }
    const after = fstatSync(fd);
    if (before.size !== after.size || before.ctimeMs !== after.ctimeMs || before.mtimeMs !== after.mtimeMs) throw new Error('invalid');
    const intent = intentSchema.parse(JSON.parse(bytes.toString('utf8')) as unknown);
    if (
      intent.implementationDigest !== implementationDigest() ||
      intent.mediatorSha256 !== digest(readFileSync(intent.mediatorPath)) ||
      intent.nodePath !== realpathSync(process.execPath) ||
      intent.nodeSha256 !== digest(readFileSync(intent.nodePath))
    )
      throw new Error('changed');
    if (
      realpathSync(dirname(path)) !== intent.directory ||
      realpathSync(path) !== join(intent.directory, 'execution-intent.json') ||
      intent.cwd !== join(intent.directory, 'fixture') ||
      intent.workspace !== join(intent.directory, 'probe') ||
      intent.database !== join(intent.directory, 'measurement.sqlite') ||
      realpathSync(intent.cwd) !== intent.cwd ||
      lstatSync(intent.database).isSymbolicLink() ||
      !lstatSync(intent.database).isFile()
    )
      throw new Error('invalid');
    return { intent, sha256: digest(bytes) };
  } catch {
    throw new Error('claude_minimal_invalid_intent');
  } finally {
    closeSync(fd);
  }
}
/** Private prepare only: no gateway, telemetry activation, product or auth call. */
export function createClaudeMinimalIntent(directory: string, binaryInput: unknown, mediatorPath: string) {
  const binary = binarySchema.parse(binaryInput);
  if (
    realpathSync(binary.path) !== binary.path ||
    !lstatSync(binary.path).isFile() ||
    realpathSync(mediatorPath) !== mediatorPath ||
    !lstatSync(mediatorPath).isFile()
  )
    throw new Error('claude_minimal_invalid_binary');
  mkdirSync(directory, { mode: 0o700 });
  const canonical = realpathSync(directory);
  const cwd = join(canonical, 'fixture');
  const workspace = join(canonical, 'probe');
  const database = join(canonical, 'measurement.sqlite');
  mkdirSync(cwd, { mode: 0o700 });
  mkdirSync(workspace, { mode: 0o700 });
  closeSync(openSync(database, 'wx', 0o600));
  const intent = intentSchema.parse({
    schemaVersion: 1,
    directory: canonical,
    cwd,
    workspace,
    database,
    mediatorPath,
    binary,
    implementationDigest: implementationDigest(),
    mediatorSha256: digest(readFileSync(mediatorPath)),
    nodePath: realpathSync(process.execPath),
    nodeSha256: digest(readFileSync(process.execPath)),
    projectId: `project-${randomUUID()}`,
    taskId: `task-${randomUUID()}`,
    rootSessionId: randomUUID(),
    nativeSessionId: randomUUID(),
    processId: randomUUID(),
    childSessionId: randomUUID(),
    generation: 1,
    productVersion: claudeProbeProductVersion,
    model: 'claude-sonnet-5-5',
    effort: 'high',
    durationMs: 120000,
    plannedRequests: 3,
    estimatedBudgetUsd: '0.10',
    hardBillingBound: null,
    existingLoginOnly: true,
    providerAvailabilityVerified: false,
    actualExecutionApproved: false,
    productGateDelta: false
  });
  const store = new Store(database);
  try {
    const life = new Lifecycle(store);
    life.registerProject(intent.projectId, cwd);
    life.createTask(intent.projectId, intent.taskId, {
      type: 'feature',
      expected_size: 'small',
      assignee: 'qualification-user',
      product: 'claude_code',
      model: intent.model,
      criterion_ids: ['observed-topology']
    });
    life.start(intent.taskId);
    store.execute('INSERT INTO sessions(id,project_id,task_id,product,product_version) VALUES (?,?,?,?,?)', [
      intent.rootSessionId,
      intent.projectId,
      intent.taskId,
      'claude_code',
      intent.productVersion
    ]);
  } finally {
    store.close();
  }
  const intentPath = join(canonical, 'execution-intent.json');
  durableFile(intentPath, intent);
  return { intentPath, sha256: digest(JSON.stringify(intent)), intent };
}
/** EXACT ACTUAL-MODEL BOUNDARY. Trusted caller must first obtain actual user
 * consent, then provide its reference and both scopes bound to this intent SHA.
 * A file/boolean alone is not independent proof of user permission or provider.
 */
export async function executeClaudeMinimalIntent(intentPath: string, consentInput: unknown) {
  const { intent, sha256 } = readIntent(intentPath);
  const parsed = consentSchema.safeParse(consentInput);
  if (!parsed.success || parsed.data.intent_sha256 !== sha256) throw new Error('claude_minimal_consent_required');
  try {
    durableFile(join(intent.directory, 'execution-request.reserved'), { schemaVersion: 1, ...parsed.data });
  } catch {
    throw new Error('claude_minimal_already_reserved');
  }
  const store = new Store(intent.database);
  let invocationCalls = 0;
  let probe: Awaited<ReturnType<typeof prepareClaudeProbeSupervisor>> | undefined;
  try {
    probe = await prepareClaudeProbeSupervisor({
      store,
      workspace: intent.workspace,
      cwd: intent.cwd,
      binary: intent.binary,
      mediatorPath: intent.mediatorPath,
      generation: intent.generation,
      child: { sessionId: intent.childSessionId, sourceId: `source-${intent.childSessionId}`, agentType: 'qualification-child' },
      // Claude request identity is agent_id/request_id, not a Codex turn. This
      // unused schema slot is opaque local metadata, never native turn evidence.
      rootScope: {
        projectId: intent.projectId,
        taskId: intent.taskId,
        allowedRootTurnIds: ['claude-probe-scope'],
        sessions: [
          {
            sessionId: intent.rootSessionId,
            rootSessionId: intent.rootSessionId,
            parentSessionId: null,
            sourceId: `source-${intent.rootSessionId}`,
            product: 'claude_code',
            nativeSessionId: intent.nativeSessionId,
            processId: intent.processId,
            agentId: null
          }
        ]
      },
      durationMs: intent.durationMs
    });
    invocationCalls = 1;
    const result = { ...(await probe.run()), invocationCalls, productGateDelta: false as const, intent_sha256: sha256 };
    durableFile(join(intent.directory, 'execution-result.json'), result);
    return result;
  } catch {
    const result = {
      status: 'failed' as const,
      reason: 'claude_minimal_execution_failed',
      invocationCalls,
      nativeSchemaQualified: false,
      productGateDelta: false as const,
      completeCost: null,
      hardBillingBound: null,
      intent_sha256: sha256
    };
    if (!lstatResult(join(intent.directory, 'execution-result.json'))) durableFile(join(intent.directory, 'execution-result.json'), result);
    return result;
  } finally {
    await probe?.dispose();
    store.close();
  }
}
function lstatResult(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}
