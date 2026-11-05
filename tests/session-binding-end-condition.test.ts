import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { codexWorkflowFixture } from './helpers/codex-workflow-fixture.js';
import { CodexSessionBindingProvider } from '../src/session-binding-codex.js';
import { issueCodexHumanPilotScope, codexHumanPilotProfileId } from '../src/session-binding-human-pilot.js';
import { ExternalTaskSetupSchema, prepareExternalTask, externalTaskResult, recordExternalTaskOutcome } from '../src/external-session-service.js';
import {
  externalContract,
  bindingCollectionControl,
  registerBindingCollectionControl,
  revokeBindingCollectionControl
} from '../src/external-session-contract.js';
import { createSessionBindingService } from '../src/session-binding-service.js';
import type { BindingUsageRecord, VerifiedSessionIdentity } from '../src/session-binding-contract.js';
import { Store } from '../src/store.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function fixture(untilExplicitStop = true) {
  const f = codexWorkflowFixture(codexHumanPilotProfileId, 'functional_pilot');
  cleanups.push(f.cleanup);
  const setup = ExternalTaskSetupSchema.parse({
    workflow: f.input,
    runtime: { model: null, effort: null },
    preparation: { schema_version: 1, common_artifacts: [], common_manifest_hash: null, allowed_preimage_hashes: [] }
  });
  prepareExternalTask(f.store, setup, true);
  const directory = join(f.root, 'receipts');
  mkdirSync(directory, { mode: 0o700 });
  const provider = new CodexSessionBindingProvider({
    receiptDirectory: directory,
    sourceRoots: [join(f.home, 'sessions')],
    projectRoot: f.project,
    maxDepth: 1,
    maxFamilyMembers: 3
  });
  const id = f.input.assignment.task_id;
  const scope = issueCodexHumanPilotScope(f.store, id, provider, { untilExplicitStop });
  let now = new Date(Date.now() + 100).toISOString();
  const source = f.newRoot();
  const identity: VerifiedSessionIdentity = {
    product: 'codex',
    productVersion: '0.160.0',
    sessionId: source.id,
    sourceRef: source.path,
    sourceIdentity: randomUUID(),
    cwd: f.project,
    identityEvidenceId: randomUUID(),
    parentSessionId: null,
    createdAt: now
  };
  const records: BindingUsageRecord[] = [];
  vi.spyOn(provider, 'resolveCurrent').mockResolvedValue(identity);
  vi.spyOn(provider, 'assertRootReceipt').mockImplementation(() => {});
  vi.spyOn(provider, 'discoverChildren').mockResolvedValue({ children: [], gaps: [] });
  const read = vi
    .spyOn(provider, 'readUsage')
    .mockImplementation((_identity, cursor) =>
      Promise.resolve({ records: records.slice(cursor === null ? 0 : Number(cursor)), cursor: String(records.length), gaps: [] })
    );
  const serviceFor = (store = f.store) =>
    createSessionBindingService({
      store,
      providers: [provider],
      setupFor: () => setup,
      humanPilot: store === f.store ? scope : issueCodexHumanPilotScope(store, id, provider),
      clock: () => now
    });
  const service = serviceFor();
  const usage = () => {
    now = new Date(Date.parse(now) + 100).toISOString();
    const observed = (value: number) => ({ status: 'observed' as const, value, reason: null });
    records.push({
      requestId: randomUUID(),
      sessionId: source.id,
      occurredAt: now,
      turnId: randomUUID(),
      effort: 'high',
      payload: {
        schema_version: 2,
        kind: 'usage',
        product: 'codex',
        product_version: '0.160.0',
        model: 'gpt-6.1-sol',
        epoch: 'epoch',
        attribution: 'verified',
        input_total: observed(10),
        cached_input: observed(2),
        output_total: observed(3),
        reasoning_output: observed(1),
        billing_components: [
          { kind: 'ordinary_input', reading: observed(8) },
          { kind: 'cache_read', reading: observed(2) },
          { kind: 'output', reading: observed(3) }
        ]
      }
    });
  };
  return {
    ...f,
    id,
    setup,
    provider,
    scope,
    service,
    serviceFor,
    read,
    usage,
    now: () => now,
    setTime: (value: string) => {
      now = value;
    }
  };
}

test('explicit-stop collection survives the frozen comparison deadline and retains its history', async () => {
  const f = fixture();
  await f.service.connect(f.id, 'codex', { receipt: randomUUID() });
  const original = externalContract(f.store, f.id)!;
  const assignment = f.store.get('SELECT * FROM comparison_assignments WHERE task_id=?', [f.id]);
  f.setTime(new Date(Date.parse(original.ends_at!) + 100).toISOString());
  f.usage();
  await expect(f.service.tick(f.id)).resolves.toMatchObject({ requests: 1 });
  expect(externalContract(f.store, f.id)).toEqual(original);
  expect(f.store.get('SELECT * FROM comparison_assignments WHERE task_id=?', [f.id])).toEqual(assignment);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(Date.parse(f.now()) + 1));
  expect(externalTaskResult(f.store, f.id, new Date(Date.parse(f.now()) + 1).toISOString()).cost).toMatchObject({ event_count: 1 });
});

test('legacy collection remains bounded when no explicit-stop authorization was registered', async () => {
  const f = fixture(false);
  await f.service.connect(f.id, 'codex', { receipt: randomUUID() });
  f.setTime(new Date(Date.parse(externalContract(f.store, f.id)!.ends_at!) + 100).toISOString());
  const reads = f.read.mock.calls.length;
  await expect(f.service.tick(f.id)).rejects.toThrow('external_window_closed');
  expect(f.read.mock.calls.length).toBe(reads);
});

test('explicit-stop restart resumes from a fresh baseline and excludes paused usage', async () => {
  const f = fixture();
  await f.service.connect(f.id, 'codex', { receipt: randomUUID() });
  f.usage();
  await f.service.tick(f.id);
  f.service.pause(f.id);
  const original = externalContract(f.store, f.id);
  f.setTime(new Date(Date.parse(original!.ends_at!) + 100).toISOString());
  f.usage();
  const restarted = new Store(f.database);
  cleanups.push(() => restarted.close());
  const service = f.serviceFor(restarted);
  await service.resume(f.id);
  expect(restarted.eventCount()).toBe(1);
  f.usage();
  await service.tick(f.id);
  await service.tick(f.id);
  expect(restarted.eventCount()).toBe(2);
  expect(externalContract(restarted, f.id)).toEqual(original);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(Date.parse(f.now()) + 1));
  service.pause(f.id);
  recordExternalTaskOutcome(restarted, f.id, 'success', f.input.assignment.metadata.criterion_ids, f.now);
  const reads = f.read.mock.calls.length;
  f.usage();
  await service.tick(f.id);
  expect(f.read.mock.calls.length).toBe(reads);
  expect(restarted.eventCount()).toBe(2);
  await expect(service.resume(f.id)).rejects.toThrow();
});

test('revocation is durable and fences source reads, including after restart', async () => {
  const f = fixture();
  await f.service.connect(f.id, 'codex', { receipt: randomUUID() });
  const reads = f.read.mock.calls.length;
  revokeBindingCollectionControl(f.store, f.id, f.now);
  f.usage();
  await expect(f.service.tick(f.id)).rejects.toThrow('binding_scope_revoked');
  expect(f.read.mock.calls.length).toBe(reads);
  f.service.pause(f.id);
  const restarted = new Store(f.database);
  cleanups.push(() => restarted.close());
  await expect(f.serviceFor(restarted).resume(f.id)).rejects.toThrow('binding_scope_revoked');
  expect(f.read.mock.calls.length).toBe(reads);
  expect(() => registerBindingCollectionControl(restarted, f.id)).toThrow('binding_scope_revoked');
  expect(bindingCollectionControl(restarted, f.id)?.revoked_at).not.toBeNull();
});

test('an existing opaque pilot scope cannot silently gain a changed collection policy', async () => {
  const f = fixture(false);
  registerBindingCollectionControl(f.store, f.id);
  await expect(f.service.connect(f.id, 'codex', { receipt: randomUUID() })).rejects.toThrow('binding_pilot_scope_invalid');
  expect(f.read).not.toHaveBeenCalled();
});

test('explicit-stop rework past comparison deadline preserves assignment and observed history', async () => {
  const f = fixture();
  await f.service.connect(f.id, 'codex', { receipt: randomUUID() });
  f.usage();
  await f.service.tick(f.id);
  f.service.pause(f.id);
  const original = externalContract(f.store, f.id)!;
  const assignment = f.store.get('SELECT * FROM comparison_assignments WHERE task_id=?', [f.id]);
  f.setTime(new Date(Date.parse(original.ends_at!) + 100).toISOString());
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(Date.parse(f.now()) + 1));
  expect(() => recordExternalTaskOutcome(f.store, f.id, 'rework', [], f.now)).not.toThrow();
  expect(f.store.eventCount()).toBe(1);
  expect(externalContract(f.store, f.id)).toEqual(original);
  expect(f.store.get('SELECT * FROM comparison_assignments WHERE task_id=?', [f.id])).toEqual(assignment);
  await f.service.resume(f.id);
  expect(f.store.eventCount()).toBe(1);
});
