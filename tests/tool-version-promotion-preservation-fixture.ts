import { expect, vi } from 'vitest';
import * as profiles from '../src/core/tool-version-profiles.js';
const originalIdentity = profiles.toolVersionIdentity;
import { assignTask } from '../src/comparison/allocation.js';
import { confirmConfiguration } from '../src/comparison/config-confirmation-write.js';
import { createComparisonSnapshot } from '../src/comparison/reports/comparison-snapshot.js';
import { Lifecycle } from '../src/core/lifecycle.js';
import { putUsageWithEvidence } from '../src/core/runtime-history.js';
import type { Store } from '../src/store.js';
import { seedFlexibleComparison } from './helpers/flexible-store.js';

export const comparisonCutoff = '2026-11-06T02:00:00.000Z';
export function storedBytes(store: Store) {
  return store.all<{ name: string }>("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(({ name }) => ({
    table: name,
    rows: store
      .all(`SELECT * FROM "${name}"`)
      .map(row => JSON.stringify(row))
      .sort()
  }));
}

export function comparisonHistory(store: Store) {
  const f = seedFlexibleComparison(store);
  const event = f.events[0];
  const runtime = f.runtime[0];
  if (!event || !runtime) throw new Error('fixture_usage_missing');
  const zero = { status: 'observed', value: 0, reason: null } as const;
  const missing = {
    status: 'missing',
    value: null,
    reason: 'not_available'
  } as const;
  for (const kind of ['zero', 'missing'] as const) {
    const taskId = `comparison-${kind}`;
    const sessionId = `session-${kind}`;
    const assignment = assignTask(
      store,
      { ...f.input, task_id: taskId, logical_task_id: `logical-${kind}` },
      {
        clock: () => f.protocol.recruitment_start,
        shuffle: values => values
      }
    );
    confirmConfiguration(
      store,
      {
        schema_version: 1,
        id: `confirmation-${kind}`,
        task_id: taskId,
        evidence_method: 'self_attested',
        actual_variant_id: assignment.assigned_variant_id,
        product: 'synthetic',
        product_version: '1.0.0',
        model: null,
        reasoning_setting: null,
        environment_id: 'environment-1'
      },
      f.protocol.recruitment_start
    );
    new Lifecycle(store, () => f.protocol.recruitment_start).start(taskId);
    store.execute('INSERT INTO sessions(id,task_id,project_id,product,product_version) VALUES (?,?,?,?,?)', [
      sessionId,
      taskId,
      'project-1',
      'synthetic',
      '1.0.0'
    ]);
    const reading = kind === 'zero' ? zero : missing;
    putUsageWithEvidence(
      store,
      {
        ...event,
        id: kind,
        source_key: kind,
        task_id: taskId,
        session_id: sessionId,
        payload: {
          ...event.payload,
          runtime_evidence_id: `runtime-${kind}`,
          input_total: reading,
          cached_input: reading,
          output_total: reading,
          reasoning_output: reading,
          billing_components: event.payload.billing_components.map(component => ({ ...component, reading }))
        }
      },
      {
        ...runtime,
        id: `runtime-${kind}`,
        task_id: taskId,
        session_id: sessionId,
        request_id: kind
      }
    );
  }
  const request = {
    reportId: 'frozen-comparison',
    protocolId: f.protocol.id,
    cutoff: comparisonCutoff,
    revisionReason: 'initial' as const
  };
  const snapshot = createComparisonSnapshot(store, request, () => comparisonCutoff);
  expect(snapshot).toMatchObject({
    schema_version: 2,
    price_table: { id: f.priceTable.id },
    tasks: [
      {
        task_id: 'comparison-missing',
        cost: { partial_amount: null, complete_amount: null }
      },
      {
        task_id: 'comparison-zero',
        cost: { partial_amount: '0', complete_amount: null }
      }
    ]
  });
  return { request, snapshot };
}

export function syntheticIdentity() {
  vi.spyOn(profiles, 'toolVersionIdentity').mockImplementation(id =>
    id === 'synthetic-claude_code-image'
      ? {
          id,
          product: 'claude_code',
          version: '2.1.318',
          kind: 'native_image',
          sha256: 'e'.repeat(64)
        }
      : originalIdentity(id)
  );
}
