import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { localWebFixture } from './local-web-fixture.js';
import { comparisonProtocol, comparisonVariant, protocolRow } from '../../src/core/protocol-store.js';
import { readPriceTable } from '../../src/pricing/pricing.js';
import { registerHarness, generateComparison } from '../../src/harness/harness-config.js';
import { Store } from '../../src/store.js';
import { Lifecycle } from '../../src/core/lifecycle.js';
import { createLocalWebDomain } from '../../src/web/local-web-domain.js';

export function setupReviewFixture(registerProject = true) {
  const seed = localWebFixture();
  writeFileSync(join(seed.project, 'notes.md'), 'Synthetic selected harness\n');
  const protocol = comparisonProtocol(seed.store, protocolRow(seed.store, seed.profile.setup.workflow.assignment.protocol_id));
  if (protocol.schema_version !== 2) throw new Error('synthetic_fixture_invalid');
  const variants = protocol.variant_ids.map(id => comparisonVariant(seed.store, id));
  for (const [index, version] of ['baseline', 'modified'].entries()) {
    writeFileSync(join(seed.project, 'policy.md'), readFileSync(seed.input.artifacts[index]!.selected_artifacts[0]!.path));
    registerHarness(seed.project, {
      schema_version: 1,
      harness_id: 'synthetic',
      version,
      policy_version: variants[index]!.policy_version,
      readme_path: 'notes.md',
      artifacts: [{ artifact_id: 'instruction', role: 'instruction', source_path: 'policy.md', target_path: 'harness.md' }]
    });
  }
  generateComparison(seed.project, { schema_version: 1, id: 'synthetic-review', name: 'Synthetic reviewed pair', arm_a: 'baseline', arm_b: 'modified' });
  const store = new Store(join(seed.root, 'fresh-measurement.sqlite'));
  if (registerProject) new Lifecycle(store).registerProject('project-1', seed.project);
  const input = {
    comparison_path: join(seed.project, 'harness-config/comparisons/synthetic-review.json'),
    template_id: seed.profile.id,
    profile: seed.profile,
    variants,
    protocol,
    price_table: readPriceTable(seed.store, protocol.price_table_id),
    freeze_at: protocolRow(seed.store, protocol.id).frozen_at
  };
  const domain = createLocalWebDomain({ store, metadataFile: seed.metadataFile });
  return {
    ...seed,
    store,
    domain,
    input,
    cleanup: () => {
      store.close();
      seed.cleanup();
    }
  };
}
