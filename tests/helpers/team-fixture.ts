import { Store } from '../../src/store.js';
import { Lifecycle } from '../../src/lifecycle.js';
import { registerVariant, registerProtocol, freezeProtocol } from '../../src/comparison.js';
import { assignTask } from '../../src/allocation.js';
import { confirmConfiguration, bindConfigurationToSession } from '../../src/config-confirmation.js';
import { createComparisonSnapshot } from '../../src/reports/comparison-snapshot.js';
import { buildExchangePackage } from './legacy-exchange.js';
import { registerExchangeSource } from '../../src/exchange/source.js';
import { registerExchangeMapping } from '../../src/exchange/mapping.js';
import { protocolDigest } from '../../src/exchange/contracts.js';
import { protocol, variantA, variantB, assignmentInput, beforeRecruitment } from './comparison-fixture.js';
import { sharedProjectId, namespaceId } from './exchange-fixture.js';
export const teamNamespaces = [namespaceId, '66666666-6666-4666-8666-666666666666'];
export const teamProtocol = {
  ...protocol,
  strata: [1, 2].map(i => ({ id: `stratum-${i}`, assignees: [`user-${i}`], types: ['feature'], sizes: ['small'], allocator_id: `allocator-${i}` }))
};
const at = (minute: number) => `2026-01-01T00:${String(minute).padStart(2, '0')}:00.000Z`;
const observed = (value: number) => ({ status: 'observed' as const, value, reason: null });
const missing = { status: 'missing' as const, value: null, reason: 'not_available' as const };
const excluded = { status: 'excluded' as const, value: null, reason: 'paused' as const };
/** Synthetic session linkage is deliberately test-only. No file collector, process or network is used. */
export function teamFixture(sourcePaths = [':memory:', ':memory:'], destinationPath = ':memory:', cutoff = '2026-01-03T00:00:00.000Z') {
  const sources = sourcePaths.map((path, index) => {
    const n = index + 1;
    const store = new Store(path, () => '2026-01-02T00:00:00.000Z');
    store.execute('INSERT INTO projects(id) VALUES (?)', ['project-1']);
    registerVariant(store, variantA);
    registerVariant(store, variantB);
    registerProtocol(store, teamProtocol);
    freezeProtocol(store, protocol.id, beforeRecruitment);
    registerExchangeSource(store, {
      schema_version: 1,
      namespace_id: teamNamespaces[index],
      local_project_id: 'project-1',
      shared_project_id: sharedProjectId,
      protocol_id: protocol.id,
      owned_strata: [`stratum-${n}`]
    });
    for (let j = 0; j < 4; j++) {
      const k = index * 4 + j + 1;
      const taskId = `task-${k}`;
      const a = assignTask(
        store,
        {
          ...assignmentInput,
          task_id: taskId,
          logical_task_id: `logical-${k}`,
          metadata: { ...assignmentInput.metadata, assignee: `user-${n}` },
          environment_id: `environment-${n}`,
          allocator_id: `allocator-${n}`
        },
        { clock: () => at(0), shuffle: values => [values[0]!, values[2]!, values[1]!, values[3]!] }
      );
      if (k === 3) continue;
      confirmConfiguration(
        store,
        {
          schema_version: 1,
          id: `confirmation-${k}`,
          task_id: taskId,
          evidence_method: 'self_attested',
          actual_variant_id: a.assigned_variant_id,
          product: 'synthetic',
          product_version: '1.0.0',
          model: 'synthetic-model',
          reasoning_setting: 'none',
          environment_id: `environment-${n}`
        },
        at(1)
      );
      new Lifecycle(store, () => at(2)).start(taskId);
      const sessionId = `PRIVATE_SESSION_${k}`;
      store.execute('INSERT INTO sessions(id,project_id,task_id,source_path,product,product_version) VALUES (?,?,?,?,?,?)', [
        sessionId,
        'project-1',
        taskId,
        null,
        'synthetic',
        '1.0.0'
      ]);
      bindConfigurationToSession(store, `confirmation-${k}`, sessionId);
      if (k !== 7) {
        const [input, output, cache, reason] =
          k === 1
            ? [observed(7), observed(3), observed(2), observed(1)]
            : k === 2
              ? [observed(0), observed(0), observed(0), observed(0)]
              : k === 4
                ? [observed(5), missing, missing, missing]
                : k === 5
                  ? [observed(2), observed(2), missing, missing]
                  : k === 6
                    ? [excluded, excluded, excluded, excluded]
                    : [observed(1), observed(1), missing, missing];
        store.putEvent({
          id: `PRIVATE_EVENT_${k}`,
          project_id: 'project-1',
          task_id: taskId,
          session_id: sessionId,
          source_key: `PRIVATE_SOURCE_${k}`,
          occurred_at: at(3),
          payload: {
            kind: 'usage',
            input_total: input,
            output_total: output,
            cached_input: cache,
            reasoning_output: reason,
            product: 'synthetic',
            product_version: '1.0.0',
            model: 'synthetic-model',
            epoch: 'PRIVATE_EPOCH_SENTINEL'
          }
        });
      }
      if (k === 4) continue;
      new Lifecycle(store, () => at(4)).declareFirst(taskId);
      new Lifecycle(store, () => at(5)).assessFirst(taskId, [1, 5, 7].includes(k));
      if (k === 8) new Lifecycle(store, () => at(6)).rework(taskId);
      const outcome = [1, 5, 7].includes(k) ? 'success' : k === 6 ? 'aborted' : 'failed';
      new Lifecycle(store, () => at(7)).finalize(taskId, outcome, outcome === 'success' ? ['criterion-1'] : []);
    }
    createComparisonSnapshot(
      store,
      { reportId: 'source-snapshot', protocolId: protocol.id, cutoff, revisionReason: 'initial' },
      () => '2026-01-04T00:00:00.000Z'
    );
    return store;
  });
  const packages = sources.map((store, index) => {
    const pkg = buildExchangePackage(
      store,
      {
        kind: 'assignment_metadata',
        protocolId: protocol.id,
        snapshotId: 'source-snapshot',
        packageId: index === 0 ? '77777777-7777-4777-8777-777777777777' : '88888888-8888-4888-8888-888888888888'
      },
      () => '2026-01-04T01:00:00.000Z'
    );
    if (pkg.kind !== 'assignment_metadata') throw new Error('wrong_kind');
    return pkg;
  });
  const dest = new Store(destinationPath);
  dest.execute('INSERT INTO projects(id) VALUES (?)', ['destination']);
  const mapping = {
    schema_version: 1,
    local_project_id: 'destination',
    shared_project_id: sharedProjectId,
    protocol_id: protocol.id,
    protocol_digest: protocolDigest(packages[0]!),
    writers: teamNamespaces.map((namespace, index) => ({ namespace_id: namespace, stratum_id: `stratum-${index + 1}`, allocator_id: `allocator-${index + 1}` }))
  };
  registerExchangeMapping(dest, mapping);
  const request = {
    schema_version: 1,
    snapshot_id: 'team-snapshot',
    local_project_id: 'destination',
    shared_project_id: sharedProjectId,
    protocol_id: protocol.id,
    cutoff,
    as_of: '2026-01-05T00:00:00.000Z',
    required_namespaces: teamNamespaces
  };
  return {
    sources,
    packages,
    dest,
    mapping,
    request,
    close: () => {
      sources.forEach(s => s.close());
      dest.close();
    }
  };
}
