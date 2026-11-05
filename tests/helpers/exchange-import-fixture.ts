import { Store } from '../../src/store.js';
import { registerExchangeMapping } from '../../src/comparison/exchange/mapping.js';
import { protocolDigest } from '../../src/comparison/exchange/contracts.js';
import { freshSource, assignAndSnapshot, dataPackage, sharedProjectId, namespaceId } from './exchange-fixture.js';
export const receivedAt = '2026-01-05T00:00:00.000Z';
export function paired(path = ':memory:') {
  const source = freshSource();
  assignAndSnapshot(source);
  const pkg = dataPackage(source);
  if (pkg.kind !== 'assignment_metadata') throw new Error('wrong_kind');
  const dest = new Store(path);
  dest.execute('INSERT INTO projects(id) VALUES (?)', ['destination']);
  const mapping = {
    schema_version: 1,
    shared_project_id: sharedProjectId,
    local_project_id: 'destination',
    protocol_id: pkg.protocol_id,
    protocol_digest: protocolDigest(pkg),
    writers: [{ namespace_id: namespaceId, stratum_id: 'stratum-1', allocator_id: 'allocator-1' }]
  };
  registerExchangeMapping(dest, mapping);
  return { source, dest, pkg, mapping };
}
