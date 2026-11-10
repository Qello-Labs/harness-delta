import { comparisonCutoff, comparisonHistory, storedBytes, syntheticIdentity } from './tool-version-promotion-preservation-fixture.js';
import Database from 'better-sqlite3';
import { Store } from '../src/store.js';
import { afterEach, expect, test, vi } from 'vitest';
import { issuePromotionBindingAuthority } from '../src/binding/session-binding-promotion.js';
import { createComparisonSnapshot, readComparisonSnapshot } from '../src/comparison/reports/comparison-snapshot.js';
import { assertOrdinaryWindowAuthority, ordinaryWindowCompatibility } from '../src/core/ordinary-window-store.js';
import * as profiles from '../src/core/tool-version-profiles.js';
import { projectToolVersionPromotions } from '../src/core/tool-version-promotion.js';
import { ordinaryProjectSettings, ordinaryTaskSettings } from '../src/ordinary-observation.js';
import { readOrdinaryWindowBatch } from '../src/ordinary-window-binding.js';
import { aggregateOrdinaryWindowMetrics } from '../src/pricing/metrics-ordinary-window.js';
import { effectiveSourceCompatibility, resolveSourceCompatibility } from '../src/source-compatibility.js';
import { createCodexProjectSetupManager } from '../src/web/local-web-codex.js';
import { ordinaryProjectDto } from '../src/web/local-web-ordinary.js';
import { ordinaryBindingFixture } from './helpers/ordinary-session-binding-fixture.js';
import { ordinaryWindowFixture } from './helpers/ordinary-window-fixture.js';
import { appendPromotionDecision, type PromotionFixture, promotionFixture } from './helpers/tool-version-promotion.js';

const originalProjection = { ...profiles.toolVersionPromotionProjection };
const originalDescriptors = [...profiles.promotedToolVersionDescriptors];
const cleanups: (() => void | Promise<void>)[] = [];
const windowCutoff = '2026-11-06T01:10:00.000Z';
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
  Object.assign(profiles.toolVersionPromotionProjection, originalProjection);
  Object.assign(profiles.promotedToolVersionDescriptors, { length: 0 }, originalDescriptors);
});

function publish(input: PromotionFixture) {
  Object.assign(profiles.toolVersionPromotionProjection, projectToolVersionPromotions(input));
  Object.assign(profiles.promotedToolVersionDescriptors, { length: 0 }, input.descriptors);
}

test.each(['codex', 'claude_code'] as const)(
  '%s new root qualification and retirement/revocation preserve populated frozen windows and comparison snapshots',
  async product => {
    const input = promotionFixture(product);
    const descriptor = input.descriptors[0];
    if (!descriptor) throw new Error('fixture_descriptor_missing');
    syntheticIdentity();
    const f = ordinaryWindowFixture(product, descriptor.version);
    cleanups.push(() => f.store.close());
    f.activate();
    f.connect();
    const read = () =>
      readOrdinaryWindowBatch({
        store: f.store,
        taskId: f.taskId,
        rootSessionId: f.rootId,
        baseline: false,
        provider: () => f.provider,
        clock: f.clock
      });
    await read();
    const historical = ordinaryWindowCompatibility(f.store, f.taskId);
    expect(historical).toMatchObject({
      state: 'compatibility_unverified',
      profile_id: f.selection.policy.policyId
    });
    const report = aggregateOrdinaryWindowMetrics(f.store, f.taskId, windowCutoff);
    expect(report).toMatchObject({
      automatic_children: false,
      usage: {
        event_count: 1,
        verified: { partial_tokens: null },
        compatibility_unverified: {
          event_count: 1,
          partial_tokens: 15
        }
      }
    });
    const comparisonStore = new Store(':memory:', f.clock);
    cleanups.push(() => comparisonStore.close());
    const comparison = comparisonHistory(comparisonStore);
    const comparisonBytes = storedBytes(comparisonStore);
    const metadata = new Database(':memory:');
    cleanups.push(() => {
      metadata.close();
    });
    const defaults = createCodexProjectSetupManager(f.store, metadata);
    const defaultSelection = () => (product === 'codex' ? defaults.inspect('project').product_version : ordinaryProjectDto(f.store, 'project').product_version);
    expect(defaultSelection()).toBe(product === 'codex' ? '0.163.0' : '2.1.306');
    const before = storedBytes(f.store);

    appendPromotionDecision(input, {
      grants: ['admission', 'qualification']
    });
    publish(input);
    expect(resolveSourceCompatibility(product, descriptor.version, descriptor.route, descriptor.profileId)?.state).toBe('verified');
    for (const transition of ['approve', 'retire', 'revoke'] as const) {
      if (transition !== 'approve') {
        appendPromotionDecision(input, {
          decision: transition,
          reason: transition === 'retire' ? 'maintenance_ended' : 'authority_withdrawn',
          grants: []
        });
        publish(input);
        expect(resolveSourceCompatibility(product, descriptor.version, descriptor.route, descriptor.profileId)).toBeNull();
      }
      await read();
      expect(
        assertOrdinaryWindowAuthority(f.store, {
          taskId: f.taskId,
          rootSessionId: f.rootId,
          clock: f.clock
        })
      ).toEqual(f.selection);
      expect(effectiveSourceCompatibility(f.store, historical)).toEqual(historical);
      expect(aggregateOrdinaryWindowMetrics(f.store, f.taskId, windowCutoff)).toEqual(report);
      expect(readComparisonSnapshot(comparisonStore, comparison.request.reportId)).toEqual(comparison.snapshot);
      expect(createComparisonSnapshot(comparisonStore, comparison.request, () => comparisonCutoff)).toEqual(comparison.snapshot);
      expect(defaultSelection()).toBe(product === 'codex' ? '0.163.0' : '2.1.306');
      expect(storedBytes(f.store)).toEqual(before);
      expect(storedBytes(comparisonStore)).toEqual(comparisonBytes);
    }
    expect(f.calls).not.toContain('exact-read');
    expect(f.calls).not.toContain('discover');
    expect(f.store.all('SELECT * FROM tool_version_promotion_origins')).toEqual([]);
  }
);

test.each([
  ['retire', 'maintenance_ended'],
  ['revoke', 'authority_withdrawn']
] as const)('%s refuses the saved exact selection through the ordinary service without substituting the default', async (decision, reason) => {
  const input = promotionFixture('claude_code');
  const approval = appendPromotionDecision(input, {
    grants: ['admission', 'qualification']
  });
  appendPromotionDecision(input, {
    grants: ['admission', 'qualification'],
    scope: {
      ...approval.decision.scope,
      lane: { ...approval.decision.scope.lane, operation: 'link' }
    }
  });
  publish(input);
  syntheticIdentity();
  const f = ordinaryBindingFixture('2.1.318');
  cleanups.push(f.cleanup);
  const authority = issuePromotionBindingAuthority(f.store, {
    taskId: f.taskId,
    product: 'claude_code',
    productVersion: '2.1.318',
    topology: 'root',
    bundleContract: 'claude-promoted-bundle-v1'
  });
  Object.defineProperty(f.provider, 'promotionAuthority', {
    value: authority
  });
  await f.connect();
  const before = storedBytes(f.store);
  const settings = ordinaryProjectSettings(f.store, 'project');
  expect(settings?.product_version).toBe('2.1.318');
  const inspections = [...f.inspections];
  const reads = [...f.bodyReads];

  appendPromotionDecision(input, {
    decision,
    reason,
    grants: [],
    scope: approval.decision.scope
  });
  publish(input);

  await expect(f.connect()).rejects.toThrow('promotion_authority_denied');
  expect(ordinaryProjectSettings(f.store, 'project')).toEqual(settings);
  expect(ordinaryTaskSettings(f.store, f.taskId).product_version).toBe('2.1.318');
  expect(f.inspections).toEqual(inspections);
  expect(f.bodyReads).toEqual(reads);
  expect(storedBytes(f.store)).toEqual(before);
});
