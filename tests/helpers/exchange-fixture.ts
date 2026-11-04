import { Store } from '../../src/store.js';
import { registerVariant, registerProtocol, freezeProtocol } from '../../src/comparison.js';
import { assignTask } from '../../src/allocation.js';
import { createComparisonSnapshot } from '../../src/reports/comparison-snapshot.js';
import { buildExchangePackage } from './legacy-exchange.js';
import { registerExchangeSource } from '../../src/exchange/source.js';
import { protocol, variantA, variantB, assignmentInput, beforeRecruitment, seedProject } from './comparison-fixture.js';
export const namespaceId = '11111111-1111-4111-8111-111111111111';
export const sharedProjectId = '22222222-2222-4222-8222-222222222222';
export const packageId = '33333333-3333-4333-8333-333333333333';
export const exportTime = '2026-01-04T01:00:00.000Z';
export const sourceConfig = {
  schema_version: 1,
  namespace_id: namespaceId,
  local_project_id: 'project-1',
  shared_project_id: sharedProjectId,
  protocol_id: protocol.id,
  owned_strata: ['stratum-1']
};
export function freshSource(path = ':memory:'): Store {
  const store = new Store(path, () => '2026-01-02T00:00:00.000Z');
  seedProject(store);
  registerVariant(store, variantA);
  registerVariant(store, variantB);
  registerProtocol(store, protocol);
  freezeProtocol(store, protocol.id, beforeRecruitment);
  registerExchangeSource(store, sourceConfig);
  return store;
}
export function assignAndSnapshot(store: Store): void {
  assignTask(store, assignmentInput, { clock: () => protocol.recruitment_start, shuffle: a => a });
  createComparisonSnapshot(
    store,
    { reportId: 'report-1', protocolId: protocol.id, cutoff: '2026-01-03T00:00:00Z', revisionReason: 'initial' },
    () => '2026-01-04T00:00:00Z'
  );
}
export function dataPackage(store: Store, id = packageId) {
  return buildExchangePackage(store, { kind: 'assignment_metadata', protocolId: protocol.id, snapshotId: 'report-1', packageId: id }, () => exportTime);
}
