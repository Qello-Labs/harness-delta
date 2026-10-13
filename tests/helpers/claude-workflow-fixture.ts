import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { claudeWorkflowProfileId } from '../../src/claude-workflow-versions.js';
import { registerVariant, registerProtocol, freezeProtocol } from '../../src/comparison.js';
import { registerPriceTable } from '../../src/pricing.js';
import { Lifecycle } from '../../src/lifecycle.js';
import { Store } from '../../src/store.js';
import { makeFlexibleFixture } from './flexible-fixture.js';
import { assignmentInput } from './comparison-fixture.js';

export const claudeWorkflowProfile = { product: 'claude_code' as const, product_version: '2.1.296', profile_id: claudeWorkflowProfileId };
/** A frozen functional-pilot protocol with one Claude workflow profile, two registered variants,
 * a workflow input and a launch execution whose stand-in binary is this Node executable. */
export function claudeWorkflowFixture(sourceVersion = '2.1.296') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-admission-'))); const project = join(root, 'project'); mkdirSync(project);
  const store = new Store(join(root, 'measurement.sqlite')); const f = makeFlexibleFixture(); const now = Date.now();
  f.protocol.purpose = 'functional_pilot'; delete f.protocol.minimum_effect; delete f.protocol.quality_margin; delete f.protocol.confidence_level;
  f.protocol.source_profiles = [{ ...claudeWorkflowProfile, product_version: sourceVersion }]; f.metadata.product = 'claude_code';
  f.protocol.recruitment_start = new Date(now - 60000).toISOString(); f.protocol.recruitment_end = new Date(now + 3600000).toISOString();
  new Lifecycle(store).registerProject('project-1', project);
  const artifacts = f.variants.map((variant, index) => {
    const path = join(root, `${variant.id}.md`); const content = `SYNTHETIC_PRIVATE_HARNESS_${index}`; writeFileSync(path, content);
    variant.instruction_manifest_hash = createHash('sha256').update(JSON.stringify([{ artifact_id: 'instruction', sha256: createHash('sha256').update(content).digest('hex') }])).digest('hex');
    registerVariant(store, variant); return { variant_id: variant.id, selected_artifacts: [{ artifact_id: 'instruction', path }] };
  });
  registerPriceTable(store, f.priceTable); registerProtocol(store, f.protocol); freezeProtocol(store, f.protocol.id, new Date(now - 120000).toISOString());
  const input = { schema_version: 1, assignment: { ...assignmentInput, schema_version: 2, metadata: f.metadata }, product_version: sourceVersion, confirmation_id: 'confirmation-1', artifacts };
  const prompt = join(root, 'prompt.txt'); writeFileSync(prompt, 'SYNTHETIC_PRIVATE_TASK');
  // A stand-in executable: the registered SHA is checked before anything can launch.
  const binary = { path: realpathSync(process.execPath), version: sourceVersion, sha256: createHash('sha256').update(readFileSync(process.execPath)).digest('hex') };
  const execution = { operation: 'launch', run_id: 'claude-run', binary, workspace: join(root, 'workspace'), mediator_path: resolve('dist/claude-probe-hook-mediator.js'),
    prompt_file: prompt, permissions: 'workspace-edit', timeout_ms: 3600000, max_turns: 200, request_limit: 400 };
  return { store, input, execution, project, protocolId: f.protocol.id, cleanup: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}
