import { Store } from '../../src/store.js';
import { registerVariant, registerProtocol, freezeProtocol } from '../../src/comparison.js';
import { makeFlexibleFixture } from './flexible-fixture.js';
import { assignmentInput, beforeRecruitment, seedProject } from './comparison-fixture.js';
export function seedFlexibleComparison(store: Store) {
  const f = makeFlexibleFixture();
  seedProject(store);
  store.execute('INSERT INTO price_tables(id,payload) VALUES (?,?)', [f.priceTable.id, JSON.stringify(f.priceTable)]);
  f.variants.forEach(v => registerVariant(store, v));
  registerProtocol(store, f.protocol);
  freezeProtocol(store, f.protocol.id, beforeRecruitment);
  return { ...f, input: { ...assignmentInput, schema_version: 2, metadata: f.metadata } };
}
