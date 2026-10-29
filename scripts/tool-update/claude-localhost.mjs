import { randomUUID, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPins, assertSupervisedWorker, bounded, closeListener, fixtureEnvironment, observedProcess, privateDirectory, privateRead,
  repository, requireCondition, ConformanceError } from './fixtures.mjs';
import { projectTranscript, reconcileCollector, reconcileOracle } from './claude-oracle.mjs';
import { startStub } from './claude-stub.mjs';
import { preflight } from './conformance.mjs';

const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

/** Normal completion pauses in a synthetic Stop hook while the real image is live.
 * The shipped provider deliberately rejects post-exit process proofs. */
export async function startGate(onGate) {
  const token = randomBytes(32).toString('hex'), sockets = new Set();
  let failure = null, opened = false;
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== `/${token}` || opened) {
      res.writeHead(403).end(); failure = new ConformanceError('stream_invalid'); return;
    }
    opened = true;
    try { await onGate(); res.writeHead(204).end(); }
    catch { failure = new ConformanceError('collector_mismatch'); res.writeHead(500).end(); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  const listening = once(server, 'listening'); server.listen(0, '127.0.0.1'); await listening;
  return { endpoint: `http://127.0.0.1:${server.address().port}/${token}`,
    assertHealthy: () => { if (failure) throw failure; requireCondition(opened, 'collector_mismatch'); },
    close: () => closeListener(server, sockets) };
}

export async function gateClient(endpoint) {
  requireCondition(/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/[a-f0-9]{64}$/.test(endpoint), 'stream_invalid');
  const req = request(endpoint, { method: 'POST' });
  const response = once(req, 'response');
  req.end();
  try {
    const [res] = await bounded(response, 10000);
    res.resume();
    requireCondition(res.statusCode === 204, 'collector_mismatch');
  } finally { req.destroy(); }
}

async function loopbackPort() {
  const reservation = createServer();
  const listening = once(reservation, 'listening');
  reservation.listen(0, '127.0.0.1'); await listening;
  const port = reservation.address().port, closed = once(reservation, 'close');
  reservation.close(); await closed;
  // A competing bind fails the run; there is no retry or inferred readiness.
  return port;
}

export async function runLocalhost({ approvalFile, binary, root, scenario }) {
  const approval = await preflight(approvalFile, binary);
  assertSupervisedWorker();
  process.umask(0o077);
  privateDirectory(root);
  requireCondition(approval.scope.scenarios.includes(scenario), 'approval_invalid');
  const { Store } = await import(join(repository, 'dist/store.js'));
  const { Lifecycle } = await import(join(repository, 'dist/lifecycle.js'));
  const { assertOrdinaryTaskPrepared, revokeOrdinaryObservation } = await import(join(repository, 'dist/ordinary-observation.js'));
  const { createLocalWebDomain } = await import(join(repository, 'dist/local-web-domain.js'));
  const { createLocalWebServer } = await import(join(repository, 'dist/local-web-server.js'));
  const { ClaudeSessionBindingProvider } = await import(join(repository, 'dist/session-binding-claude.js'));
  const { readClaudeProcessBinary } = await import(join(repository, 'dist/claude-process-binary.js'));
  const project = join(root, 'project'), config = join(root, 'config');
  const session = randomUUID(), projectId = `synthetic-${approval.run_id}`;
  const receipts = join(project, '.harness-delta/claude-connect/receipts');
  const source = join(config, 'projects', project.replace(/[^A-Za-z0-9]/g, '-'), `${session}.jsonl`);
  const store = new Store(join(root, 'store.sqlite')), life = new Lifecycle(store);
  let taskId, native, launched, app, stub, gate, provider, rootIdentity, baseline = [], batches = [],
    failure = null, active = true, interrupted = false, initialized = false, result = false, streamTail = '';
  const members = new Map();
  const scopeActive = () => active && taskId !== undefined && life.state(taskId) === 'active' &&
    !!assertOrdinaryTaskPrepared(store, taskId);
  const readJson = path => JSON.parse(privateRead(path, root, scopeActive, 16384));
  const receipt = (value, kind, agent) => {
    requireCondition(value.schema_version === 1 && value.kind === kind && value.session_id === session &&
      value.agent_id === agent && value.cwd === project && value.uid === process.getuid() &&
      value.claude_pid === native?.pid && (value.transcript_path === source || (agent !== null &&
        value.transcript_path === join(dirname(source), session, 'subagents', `agent-${agent}.jsonl`))) &&
      Number.isFinite(Date.parse(value.recorded_at)) && Date.parse(value.recorded_at) <= Date.now(), 'receipt_invalid');
    requireCondition(readClaudeProcessBinary(native.pid).sha256 === approval.binary_sha256, 'binary_mismatch');
    return value;
  };
  const rootReceipt = () => {
    const dir = join(receipts, 'connect'), names = readdirSync(dir).filter(n => /^[a-f0-9-]{36}\.json$/.test(n));
    requireCondition(names.length === 1, 'receipt_invalid');
    return receipt(readJson(join(dir, names[0])), 'connect', null);
  };
  const memberReceipts = () => {
    const dir = join(receipts, 'sessions', session, 'agents');
    for (const name of readdirSync(dir).filter(n => n.endsWith('.subagent_start.json'))) {
      const agent = name.slice(0, -'.subagent_start.json'.length);
      requireCondition(/^[A-Za-z0-9_-]{1,91}$/.test(agent), 'receipt_invalid');
      members.set(agent, receipt(readJson(join(dir, name)), 'subagent_start', agent));
    }
    requireCondition(members.size <= 2, 'ownership_invalid');
  };
  const sourceAuthority = metadata => {
    requireCondition(scopeActive() && metadata.nativeSessionId === session, 'scope_inactive');
    rootReceipt();
    if (metadata.agentId === null) requireCondition(metadata.sourceRef === source, 'source_invalid');
    else {
      memberReceipts();
      requireCondition(members.has(metadata.agentId) && metadata.sourceRef ===
        join(dirname(source), session, 'subagents', `agent-${metadata.agentId}.jsonl`), 'source_invalid');
    }
  };
  const domain = createLocalWebDomain({ store, metadataFile: join(root, 'ui.sqlite'),
    bindingProviderFactory: (_task, projectRoot, callbacks) => {
      requireCondition(projectRoot === project, 'scope_inactive');
      return [new ClaudeSessionBindingProvider({ receiptDir: receipts, claudeProjectsDir: join(config, 'projects'),
        projectRoot, ordinaryAdmission: true, productVersion: approval.version, maxFamilyMembers: 3,
        authorizeSource: metadata => { sourceAuthority(metadata); callbacks.authorizeSource(metadata); },
        memberEligible: metadata => { sourceAuthority(metadata); return callbacks.memberEligible(metadata); } })];
    } });
  const abort = code => { failure ??= code; native?.kill('SIGTERM'); };
  const collect = async () => {
    requireCondition(rootIdentity && baseline.length === 1 && initialized, 'collector_mismatch');
    rootReceipt(); memberReceipts(); requireCondition(members.size === 2, 'receipt_invalid');
    const children = await provider.discoverChildren(rootIdentity);
    requireCondition(children.children.length === 2 && children.gaps.length === 0, 'collector_mismatch');
    const identities = [rootIdentity, ...children.children.map(child => child.identity)];
    const scope = { projectId, taskId, allowedRootTurnIds: ['binding-observation'],
      sessions: identities.map(identity => ({ sessionId: identity.sessionId, rootSessionId: session,
        parentSessionId: identity.parentSessionId, sourceId: identity.sessionId, product: 'claude_code',
        nativeSessionId: session, processId: rootIdentity.nativeMapping.processId, agentId: identity.nativeMapping.agentId })) };
    batches = [];
    for (const identity of identities) batches.push(await provider.readUsage(identity, null, scope,
      { baseline: false, baselineLedger: { has: id => identity === rootIdentity && baseline.includes(id), add: () => {} } }));
  };
  try {
    life.registerProject(projectId, project);
    await domain.ordinaryProjectAction(projectId, { operation: 'configure', product_version: approval.version,
      claude_projects_directory: join(config, 'projects') });
    const preview = await domain.ordinaryProjectAction(projectId, { operation: 'preview-install' });
    const installed = await domain.ordinaryProjectAction(projectId, { operation: 'install',
      expected_package_hash: preview.installation.packageHash, expected_installed_hash: preview.installation.installedHash });
    requireCondition(installed.installation.state === 'installed', 'fixture_failed');
    const task = await domain.createTask({ mode: 'ordinary', name: 'Synthetic conformance',
      project_id: projectId, criterion_ids: ['accepted'] });
    taskId = task.id; life.start(taskId);
    requireCondition(domain.task(taskId).id === taskId && scopeActive(), 'fixture_failed');
    provider = new ClaudeSessionBindingProvider({ receiptDir: receipts, claudeProjectsDir: join(config, 'projects'),
      projectRoot: project, ordinaryAdmission: true, productVersion: approval.version, maxFamilyMembers: 3,
      authorizeSource: sourceAuthority, memberEligible: metadata => { sourceAuthority(metadata); return true; } });
    const port = await loopbackPort(), origin = `http://127.0.0.1:${port}`;
    app = createLocalWebServer({ domain, origin, metadataFile: join(root, 'http.sqlite') });
    const listening = once(app.server, 'listening');
    const addressPromise = app.listen({ host: '127.0.0.1', port });
    await listening;
    await addressPromise;
    gate = await startGate(collect);
    const command = `node .claude/skills/harness-connect/scripts/connect.mjs connect --origin ${origin} --product claude_code --project ${projectId} --task ${taskId}`;
    stub = await startStub(command, scenario === 'sigint', {
      subscribe: events => events.once('contract_failure', () => abort('stub_contract')),
      baseline: async () => {
        try {
          const proof = rootReceipt();
          rootIdentity = await provider.resolveCurrent({ receipt: proof.receipt_id });
          baseline = [...projectTranscript(privateRead(source, root, scopeActive), session).keys()];
          requireCondition(baseline.length === 1 && store.get(
            'SELECT identity FROM session_bindings WHERE task_id=? AND root_id=session_id', [taskId]), 'collector_mismatch');
          const scope = { projectId, taskId, allowedRootTurnIds: ['binding-observation'],
            sessions: [{ sessionId: session, rootSessionId: session, parentSessionId: null, sourceId: session,
              product: 'claude_code', nativeSessionId: session, processId: rootIdentity.nativeMapping.processId, agentId: null }] };
          const excluded = new Set();
          const batch = await provider.readUsage(rootIdentity, null, scope, { baseline: true,
            baselineLedger: { has: id => excluded.has(id), add: id => excluded.add(id) } });
          requireCondition(batch.records.length === 0 && excluded.size === 1 && excluded.has(baseline[0]), 'collector_mismatch');
        } catch { abort('collector_mismatch'); throw new ConformanceError('collector_mismatch'); }
      },
      member: () => memberReceipts(),
      partial: async () => {
        try { await collect(); interrupted = native.kill('SIGINT'); requireCondition(interrupted, 'native_failed'); }
        catch { abort('collector_mismatch'); }
      },
    });
    // Stop runs only after the normal terminal row; SIGINT is driven by partial SSE.
    const hook = `${quote(realpathSync(process.execPath))} ${quote(fileURLToPath(import.meta.url))} --gate ${quote(gate.endpoint)}`;
    const args = ['--model', approval.scope.model, '--permission-prompts', 'none', '--setting-sources', 'project',
      '--agents', JSON.stringify({ 'qualification-child': { description: 'Synthetic metadata child',
        prompt: 'Acknowledge only. Use no tools or nested agents.', tools: [], model: 'sonnet' } }),
      ...(scenario === 'normal' ? ['--settings', JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: hook, timeout: 10 }] }] } })] : []),
      '-p', '--input-format', 'text', '--output-format', 'stream-json', '--verbose', '--session-id', session,
      '--max-turns', '8', '--permission-mode', 'default', '--strict-mcp-config', '--mcp-config', join(config, 'mcp.json'),
      '--tools', 'Bash,Agent', '--allowedTools',
      'Bash(node .claude/skills/harness-connect/scripts/connect.mjs connect:*)', 'Agent', '--',
      `/harness-connect Connect this synthetic session to ${projectId} task ${taskId} at ${origin}.`];
    assertPins(approval.pins, binary);
    launched = observedProcess(binary, args, { cwd: project,
      env: { ...fixtureEnvironment(root, stub.endpoint), HARNESS_DELTA_CLAUDE_RECEIPT_DIR: receipts } }, child => {
      child.once('spawn', () => {
        child.stdout.on('data', bytes => {
          streamTail += bytes.toString('utf8');
          if (streamTail.length > 8 * 1048576) { streamTail = ''; abort('stream_invalid'); return; }
          let index;
          while ((index = streamTail.indexOf('\n')) >= 0) {
            const line = streamTail.slice(0, index); streamTail = streamTail.slice(index + 1);
            try {
              const row = JSON.parse(line);
              if (row.type === 'system' && row.subtype === 'init') initialized =
                row.slash_commands?.includes('harness-connect') && row.mcp_servers?.length === 0;
              if (row.type === 'result') result = row.subtype === 'success' && row.is_error === false;
            } catch { abort('stream_invalid'); }
          }
        });
        child.stderr.resume();
      });
    });
    native = launched.child;
    const exit = await bounded(launched.closed, approval.budgets.duration_ms - 5000);
    requireCondition(!failure && initialized && streamTail.trim() === '' &&
      (scenario === 'normal' ? exit[0] === 0 && result : interrupted), failure ?? 'native_failed');
    stub.assertHealthy();
    if (scenario === 'normal') gate.assertHealthy();
    // No process-image claim is made after close. The receipts were verified live.
    requireCondition(members.size === 2 && baseline.length === 1 && batches.length === 3, 'receipt_invalid');
    const sources = [projectTranscript(privateRead(source, root, scopeActive), session, null, baseline)];
    for (const agent of members.keys()) sources.push(projectTranscript(privateRead(
      join(dirname(source), session, 'subagents', `agent-${agent}.jsonl`), root, scopeActive), session, agent));
    const oracle = reconcileOracle(scenario, stub.ledger, sources);
    const collector = reconcileCollector(oracle, batches, sources);
    assertPins(approval.pins, binary);
    return { accepted: true, scenario, oracle, collector, root_receipt_verified: true, member_start_receipts: 2,
      endpoint: 'localhost_synthetic', authenticated: false, interactive_qualified: false,
      ordinary_qualified: false, complete_cost: false, egress_isolation_verified: false };
  } finally {
    active = false;
    let observerClosed = true;
    if (taskId) {
      try { await domain.taskAction(taskId, 'stop-observation', {}); }
      catch { observerClosed = false; }
    }
    if (taskId) revokeOrdinaryObservation(store, taskId);
    if (native && native.exitCode === null && native.signalCode === null) native.kill('SIGTERM');
    app?.server.closeAllConnections();
    const cleanup = await Promise.allSettled([stub?.close(), gate?.close(), app ? app.close() : domain.close()]);
    store.close();
    requireCondition(observerClosed && cleanup.every(item => item.status === 'fulfilled'), 'cleanup_unverified');
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    requireCondition(process.argv.length === 4 && process.argv[2] === '--gate', 'stream_invalid');
    process.stdin.resume();
    await gateClient(process.argv[3]);
  } catch { process.exitCode = 1; }
}
