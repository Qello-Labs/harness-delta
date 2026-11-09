import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { issuePromotionBindingAuthority } from '../src/binding/session-binding-promotion.js';
import {
  installCodexConnectInstallation,
  previewCodexConnectInstallation,
  verifyCodexPromotedConnectContract
} from '../src/connect/codex-connect-installation.js';
import { Lifecycle } from '../src/core/lifecycle.js';
import * as profiles from '../src/core/tool-version-profiles.js';
import { projectToolVersionPromotions } from '../src/core/tool-version-promotion.js';
import { recordToolVersionPromotionDenial } from '../src/core/tool-version-promotion-store.js';
import { CodexSessionBindingProvider } from '../src/session-binding-codex.js';
import type { PromotionPendingReceipt } from '../src/session-binding-contract.js';
import { createSessionBindingService } from '../src/session-binding-service.js';
import { ExternalTaskSetupSchema, prepareExternalTask } from '../src/workflow/external-session-service.js';
import { localWebFixture } from './helpers/local-web-fixture.js';
import { appendPromotionDecision, promotionFixture } from './helpers/tool-version-promotion.js';

const originalProjection = { ...profiles.toolVersionPromotionProjection };
const originalDescriptors = [...profiles.promotedToolVersionDescriptors];
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  Object.assign(profiles.toolVersionPromotionProjection, originalProjection);
  Object.assign(profiles.promotedToolVersionDescriptors, { length: 0 }, originalDescriptors);
  vi.restoreAllMocks();
});

function fixture(installed = true) {
  const synthetic = promotionFixture('codex');
  for (const operation of ['collect', 'link', 'restart'] as const) {
    appendPromotionDecision(synthetic, {
      grants: ['admission', 'qualification'],
      scope: {
        target: { version: '0.169.0', commit: 'a'.repeat(40) },
        lane: {
          product: 'codex',
          route: 'codex_binding',
          profile_id: 'codex-binding-01690-direct-family-v1',
          operation,
          topology: 'root'
        },
        platform: 'darwin_arm64',
        runtime: Number(process.versions.node.split('.')[0]) === 24 ? 'node24' : 'node26'
      }
    });
  }
  Object.assign(profiles.toolVersionPromotionProjection, projectToolVersionPromotions(synthetic));
  Object.assign(profiles.promotedToolVersionDescriptors, { length: 0 }, synthetic.descriptors);
  const f = localWebFixture('codex-binding-01690-direct-family-v1', {
    product: 'codex',
    productVersion: '0.169.0'
  });
  cleanups.push(f.cleanup);
  let now = new Date(Date.now() - 1000).toISOString();
  const clock = () => now;
  const setup = ExternalTaskSetupSchema.parse({
    workflow: f.input,
    runtime: { model: 'gpt-6.1-sol', effort: 'high' },
    preparation: {
      schema_version: 1,
      common_artifacts: [],
      common_manifest_hash: null,
      allowed_preimage_hashes: []
    }
  });
  prepareExternalTask(f.store, setup, true, clock);
  const taskId = setup.workflow.assignment.task_id;
  const life = new Lifecycle(f.store, clock);
  expect(life.state(taskId)).toBe('registered');
  const installation = {
    bundleMode: 'promoted' as const,
    productVersion: '0.169.0',
    sourceRoots: [join(f.home, 'sessions')],
    promotedInUse: false,
    quiescentBoundaryConfirmed: true
  };
  const receipts = installed ? join(f.project, '.harness-delta/codex-promoted-receipts') : join(f.root, 'promoted-receipts');
  if (installed) {
    const preview = previewCodexConnectInstallation(f.project, installation);
    expect(preview.blockers).toEqual([]);
    installCodexConnectInstallation(f.project, {
      ...installation,
      expectedPackageHash: preview.packageHash,
      expectedInstalledHash: preview.installedHash
    });
  } else {
    mkdirSync(receipts, { mode: 0o700 });
  }
  const source = f.newRoot();
  writeFileSync(
    source.path,
    JSON.stringify({
      type: 'session_meta',
      payload: {
        id: source.id,
        session_id: source.id,
        cli_version: '0.169.0',
        cwd: f.project,
        source: 'cli'
      }
    }) + '\n'
  );
  now = new Date(Date.parse(now) + 1).toISOString();
  const pending: PromotionPendingReceipt = {
    schemaVersion: 3,
    kind: 'promotion_pending',
    producerContract: 'promoted-payload-v1',
    receipt: randomUUID(),
    product: 'codex',
    productVersion: '0.169.0',
    event: 'connect',
    nativeSessionId: source.id,
    nativeRootSessionId: source.id,
    agentId: null,
    sourceRef: source.path,
    cwd: f.project,
    processIdHint: 4242,
    recordedAt: now
  };
  writeFileSync(join(receipts, `${pending.receipt}.json`), JSON.stringify(pending), { mode: 0o600 });
  const authority = issuePromotionBindingAuthority(f.store, {
    taskId,
    product: 'codex',
    productVersion: '0.169.0',
    topology: 'root',
    bundleContract: 'codex-promoted-bundle-v1',
    ...(installed
      ? {
          assertProducerContract: () => {
            verifyCodexPromotedConnectContract(f.project, installation);
          }
        }
      : {})
  });
  const provider = new CodexSessionBindingProvider({
    receiptDirectory: receipts,
    sourceRoots: [join(f.home, 'sessions')],
    projectRoot: f.project,
    productVersion: '0.169.0',
    ordinaryFamilyAdmission: true,
    maxDepth: 0,
    maxFamilyMembers: 1,
    promotionAuthority: authority,
    clock
  });
  const service = createSessionBindingService({
    store: f.store,
    providers: [provider],
    setupFor: () => setup,
    clock
  });
  return {
    ...f,
    taskId,
    life,
    provider,
    service,
    pending,
    source,
    synthetic,
    authority,
    receipts,
    installation,
    clock,
    advance: () => {
      now = new Date(Date.parse(now) + 1).toISOString();
    }
  };
}

test('qualified promoted Codex connects through production admission and observes only prospective usage', async () => {
  const f = fixture(false);
  const { taskId, life, provider, service, pending, source } = f;
  const usage = () => {
    f.advance();
    const timestamp = f.clock();
    const turn = randomUUID();
    const response = randomUUID();
    appendFileSync(
      source.path,
      [
        {
          type: 'turn_context',
          timestamp,
          payload: {
            cwd: f.project,
            turn_id: turn,
            model: 'gpt-6.1-sol',
            effort: 'high'
          }
        },
        {
          type: 'token_usage_record',
          timestamp,
          payload: {
            thread_id: source.id,
            session_id: source.id,
            turn_id: turn,
            root_turn_id: turn,
            response_id: response,
            usage: {
              input_tokens: 100,
              cached_input_tokens: 10,
              output_tokens: 20,
              reasoning_output_tokens: 5,
              total_tokens: 120
            }
          }
        }
      ]
        .map(row => JSON.stringify(row) + '\n')
        .join('')
    );
    return response;
  };
  usage();
  f.advance();
  expect(service.sourceSupported(taskId, 'codex')).toBe(true);
  expect(provider.capabilities().productionSupported).toBe(true);

  const connected = await service.connect(taskId, 'codex', {
    receipt: pending.receipt
  });

  expect(connected).toMatchObject({
    status: 'connected',
    state: 'observing',
    roots: 1,
    children: 0,
    session_id: pending.nativeSessionId,
    automatic_children: false
  });
  expect(life.state(taskId)).toBe('active');
  const binding = f.store.get<{ state: string; cursor: string | null }>('SELECT state,cursor FROM session_bindings WHERE session_id=?', [
    pending.nativeSessionId
  ]);
  expect(binding?.state).toBe('observing');
  expect(typeof binding?.cursor).toBe('string');
  expect(f.store.eventCount()).toBe(0);
  expect(await service.tick(taskId)).toMatchObject({
    state: 'observing',
    roots: 1,
    requests: 0
  });
  expect(f.store.all('SELECT * FROM runtime_evidence')).toEqual([]);
  expect(f.store.all('SELECT * FROM binding_requests')).toEqual([]);
  const prospectiveRequest = usage();
  f.advance();
  expect(await service.tick(taskId)).toMatchObject({
    state: 'observing',
    roots: 1,
    requests: 1
  });
  expect(f.store.eventCount()).toBe(1);
  expect(f.store.all("SELECT json_extract(payload,'$.request_id') AS request_id FROM runtime_evidence")).toEqual([
    {
      request_id: prospectiveRequest
    }
  ]);
  expect(await service.connect(taskId, 'codex', { receipt: pending.receipt })).toMatchObject({
    status: 'already_connected',
    state: 'observing',
    session_id: pending.nativeSessionId,
    requests: 1
  });
  expect(await service.tick(taskId)).toMatchObject({
    state: 'observing',
    roots: 1,
    requests: 1
  });
  expect(f.store.eventCount()).toBe(1);
});

test.each(['pending', 'revoked', 'retired', 'stale-copy', 'legacy-registration'] as const)(
  'selected promoted root refuses %s through installed production authority before native receipt proof',
  async state => {
    const f = fixture();
    const receive = vi.spyOn(f.provider, 'receivePending');
    const assignments = f.store.all('SELECT * FROM comparison_assignments');
    const protocols = f.store.all('SELECT * FROM comparison_protocols');
    const sourceBytes = readFileSync(f.source.path);
    if (state === 'pending') {
      Object.assign(
        profiles.toolVersionPromotionProjection,
        projectToolVersionPromotions({
          ...f.synthetic,
          ledger: { schema_version: 1, records: [] }
        })
      );
    } else if (state === 'revoked') {
      recordToolVersionPromotionDenial(f.store, {
        key: f.authority.key,
        reason: 'revoke',
        recordedAt: f.clock()
      });
    } else if (state === 'retired') {
      const collect = f.synthetic.ledger.records.find(record => record.decision.scope.lane.operation === 'collect');
      if (!collect) throw new Error('synthetic_collect_grant_required');
      appendPromotionDecision(f.synthetic, {
        scope: collect.decision.scope,
        decision: 'retire',
        reason: 'maintenance_ended',
        grants: []
      });
      Object.assign(profiles.toolVersionPromotionProjection, projectToolVersionPromotions(f.synthetic));
    } else if (state === 'stale-copy') {
      writeFileSync(join(f.project, '.harness-delta/codex-connect/session-binding-codex-promoted-hook.mjs'), 'throw new Error("stale_producer");\n');
    } else {
      const hooksPath = join(f.project, '.codex/hooks.json');
      const hooks = z
        .object({
          hooks: z.record(z.string(), z.array(z.unknown()))
        })
        .passthrough()
        .parse(JSON.parse(readFileSync(hooksPath, 'utf8')));
      hooks.hooks.Stop ??= [];
      hooks.hooks.Stop.push({
        hooks: [
          {
            type: 'command',
            command: 'node .harness-delta/codex-connect/session-binding-codex-hook.mjs'
          }
        ]
      });
      writeFileSync(hooksPath, JSON.stringify(hooks));
    }

    await expect(
      f.service.connect(f.taskId, 'codex', {
        receipt: f.pending.receipt
      })
    ).rejects.toThrow();

    expect(receive).not.toHaveBeenCalled();
    expect(readFileSync(f.source.path)).toEqual(sourceBytes);
    expect(f.store.all('SELECT * FROM sessions')).toEqual([]);
    expect(f.store.all('SELECT * FROM binding_requests')).toEqual([]);
    expect(f.store.all('SELECT * FROM comparison_assignments')).toEqual(assignments);
    expect(f.store.all('SELECT * FROM comparison_protocols')).toEqual(protocols);
  }
);

test('an installed selected root grant cannot enroll or read a child without its own exact grant', async () => {
  const f = fixture();
  await f.service.connect(f.taskId, 'codex', { receipt: f.pending.receipt });
  const sessions = f.store.all('SELECT * FROM sessions');
  const child = {
    ...f.pending,
    receipt: randomUUID(),
    event: 'subagent_start' as const,
    nativeSessionId: 'synthetic-child',
    agentId: 'synthetic-child',
    sourceRef: join(f.home, 'sessions', 'unreadable-child.jsonl')
  };
  writeFileSync(join(f.receipts, `${child.receipt}.json`), JSON.stringify(child), { mode: 0o600 });

  await expect(f.provider.receivePending(child)).rejects.toThrow('binding_source_unqualified');

  expect(
    await f.provider.discoverChildren({
      product: 'codex',
      productVersion: f.pending.productVersion,
      sessionId: f.pending.nativeSessionId,
      parentSessionId: null,
      sourceRef: f.source.path,
      sourceIdentity: 'synthetic-root',
      cwd: f.project,
      identityEvidenceId: f.pending.receipt,
      createdAt: f.clock()
    })
  ).toEqual({ children: [], gaps: [] });
  expect(() =>
    issuePromotionBindingAuthority(f.store, {
      taskId: f.taskId,
      product: 'codex',
      productVersion: f.pending.productVersion,
      topology: 'bounded_family',
      bundleContract: 'codex-promoted-bundle-v1'
    })
  ).toThrow('promoted_provider_unavailable');
  expect(f.store.all('SELECT * FROM sessions')).toEqual(sessions);
});
