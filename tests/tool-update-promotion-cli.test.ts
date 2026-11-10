import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { z } from 'zod';
import { assessCandidate } from '../scripts/tool-update/assessment.mjs';
import { judgeDifferences, judgmentEngineDigest } from '../scripts/tool-update/difference-judgment.mjs';
import { consumedContracts, mapRevision, requiredFacets } from '../scripts/tool-update/difference-contracts.mjs';
import { canonical, digest, loadRecord } from '../scripts/tool-update/manifest.mjs';
import { runToolUpdate } from '../scripts/tool-update.mjs';
import { reconcilePromotion } from '../scripts/tool-update/promotion.mjs';
import { promotionEvidenceClasses, promotionGateIds, promotionProposalSchema } from '../scripts/tool-update/promotion-records.mjs';
import {
  previewToolVersionPromotion,
  projectToolVersionPromotions,
  promotionDescriptorDigest,
  promotionProjectionDigest,
  promotionRegistryDigest
} from '../src/core/tool-version-promotion.js';
import { promotionFixture } from './helpers/tool-version-promotion.js';
import { auditedCli, cliFixture, judgmentFor, projectRoot, publishJudgment, scratch, tree } from './helpers/tool-update-difference-cli-fixture.js';
import type { CurrentIdentities } from '../scripts/tool-update/difference-judgment.mjs';
import type { DifferenceJudgment } from '../scripts/tool-update/difference-records.mjs';
import type { PromotionProposal } from '../scripts/tool-update/promotion-records.mjs';
import { mutationCli, populateOfflineStore } from './helpers/tool-update-promotion-offline-cli.js';

const roots: string[] = [];
let identities: CurrentIdentities;
afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
beforeAll(async () => {
  const root = await scratch();
  roots.push(root);
  const engine = await judgmentEngineDigest(projectRoot);
  const seed = await cliFixture(root, {
    source_digest: 'a'.repeat(64),
    engine_digest: engine,
    map_revision: mapRevision
  });
  const assessment = await assessCandidate({ ...seed, root: projectRoot });
  identities = {
    source_digest: assessment.source_digest,
    engine_digest: engine,
    map_revision: mapRevision
  };
}, 60_000);

async function reference(root: string, value: unknown) {
  const id = digest(value);
  const path = join(root, `${id}.json`);
  await writeFile(path, canonical(value));
  return { id, path };
}
async function preparation(affected = false) {
  const root = await scratch();
  roots.push(root);
  const input = await cliFixture(root, identities);
  const judgment = await publishJudgment(input, judgmentFor(input, affected));
  const assessment = await assessCandidate({
    ...input,
    judgments: [{ job: input.job, judgment: judgment.record }],
    root: projectRoot
  });
  const fixture = promotionFixture();
  const original = fixture.descriptors[0];
  if (!original) throw new Error('synthetic_descriptor_required');
  const descriptor = {
    ...original,
    version: input.job.target.version,
    sourceRef: input.job.target.commit,
    profileId: 'codex-binding-01650-direct-family-v1'
  };
  fixture.descriptors = [descriptor];
  const scope = {
    target: input.job.target,
    lane: { ...input.job.lane, profile_id: descriptor.profileId },
    platform: 'darwin_arm64',
    runtime: 'node24'
  } as const;
  const registry = [descriptor];
  const registryDigest = promotionRegistryDigest(registry);
  const before = projectToolVersionPromotions({ ...fixture, registryDigest });
  const decision = {
    schema_version: 1,
    kind: 'promotion_decision',
    authority: 'none',
    proposal_id: '1'.repeat(64),
    scope,
    proposed_scope: scope,
    requested_grants: ['admission'],
    grants: ['admission'],
    accepted_validation_ids: ['2'.repeat(64)],
    descriptor_digest: promotionDescriptorDigest(descriptor),
    implementation_digest: fixture.implementationDigest,
    implementation_scheme: 'promotion-implementation-v1',
    predecessor: null,
    sequence: 1,
    decision: 'approve',
    reason: 'scoped_approval',
    prior_deny_ids: [],
    independent_review_ids: ['3'.repeat(64)],
    authorization_reference_ids: ['4'.repeat(64)]
  } as const;
  const mapping = {
    schema_version: 1,
    kind: 'promotion_coverage_mapping',
    original_lane: input.job.lane,
    scope,
    descriptor_digest: promotionDescriptorDigest(descriptor),
    review_reference: '5'.repeat(64),
    contracts: judgment.record.groups.map(group => group.contract_id).sort(),
    facets: [...new Set(judgment.record.groups.flatMap(group => group.facets.map(facet => facet.facet)))].sort()
  };
  const gateMatrix = promotionGateIds.map(gate_id => ({
    gate_id,
    required_classes: [],
    evidence: promotionEvidenceClasses
      .flatMap(evidence_class => [
        {
          evidence_id: digest({ gate_id, evidence_class }),
          evidence_class,
          scope_digest: digest(scope),
          result: 'pass',
          freshness: 'current',
          contract_id: null,
          facet: null
        },
        ...(gate_id === 'G03' ? judgment.record.groups : []).flatMap(group =>
          group.facets.map(facet => ({
            evidence_id: digest({
              gate_id,
              evidence_class,
              contract: group.contract_id,
              facet: facet.facet
            }),
            evidence_class,
            scope_digest: digest(scope),
            result: 'pass',
            freshness: 'current',
            contract_id: group.contract_id,
            facet: facet.facet
          }))
        )
      ])
      .sort((a, b) => a.evidence_id.localeCompare(b.evidence_id, 'en'))
  }));
  const packet = {
    schema_version: 1,
    kind: 'promotion_preparation',
    selection_reason: 'release_candidate',
    selection_reference: '6'.repeat(64),
    scope,
    requested_grants: ['admission'],
    candidate: await reference(root, input.candidate),
    observation: await reference(root, input.observation),
    assessments: [await reference(root, assessment)],
    jobs: [await reference(root, input.job)],
    judgments: [await reference(root, judgment.record)],
    descriptor: await reference(root, descriptor),
    registry: await reference(root, registry),
    ledger: await reference(root, fixture.ledger),
    decision_payload: await reference(root, decision),
    mappings: [await reference(root, mapping)],
    predecessor_proposals: [],
    gate_matrix: gateMatrix,
    required_validation: []
  };
  const path = join(root, 'prepare.json');
  await writeFile(path, canonical(packet));
  return {
    root,
    path,
    packet,
    input,
    decision,
    descriptor,
    before,
    fixture,
    mapping
  };
}
async function prepare(input: Awaited<ReturnType<typeof preparation>>) {
  return runToolUpdate(['prepare-promotion', '--input', input.path, '--out', input.root]);
}
async function proposal(root: string, id: string | undefined) {
  if (!id) throw new Error('proposal_id_required');
  return loadRecord(join(root, 'promotion-proposals', `${id}.json`), promotionProposalSchema);
}
test('prepare publishes a non-authorizing proposal using the P3a projection identities', async () => {
  const input = await preparation();
  const result = await prepare(input);
  expect(result.exitCode, JSON.stringify(result.output)).toBe(0);
  const record = await proposal(input.root, result.output.proposal_id);
  expect(record).toMatchObject({
    authority: 'none',
    state: 'ready_for_decision',
    descriptor_digest: promotionDescriptorDigest(input.descriptor),
    registry_before_digest: promotionProjectionDigest(input.before),
    proposed_projection_digest: promotionProjectionDigest(previewToolVersionPromotion(input.before, input.descriptor, input.decision)),
    original_lanes: [input.input.job.lane]
  });
  expect(record.coverage.baseline_digest).toBe(input.input.job.baseline_digest);
  expect(record.identities.source_digest).toBe(identities.source_digest);
  expect(await prepare(input)).toEqual(result);
});
test.each(['affected', 'actual_pending', 'static_missing'] as const)('prepare derives %s gates rather than trusting a supplied state', async scenario => {
  const input = await preparation(scenario === 'affected');
  const gate_matrix = input.packet.gate_matrix.map(row => ({
    ...row,
    evidence: row.evidence.filter(proof =>
      scenario === 'actual_pending'
        ? !['actual_target_binary_conformance', 'native_trial', 'real_session'].includes(proof.evidence_class)
        : scenario !== 'static_missing' || proof.evidence_class !== 'static'
    )
  }));
  await writeFile(input.path, canonical({ ...input.packet, gate_matrix }));
  const result = await prepare(input);
  expect(result.exitCode, JSON.stringify(result.output)).toBe(0);
  expect((await proposal(input.root, result.output.proposal_id)).state).toBe(scenario === 'actual_pending' ? 'pending_pre_release' : 'blocked');
});
test.each(['invented', 'private', 'revision', 'wrong_id', 'cross_lane'] as const)('prepare refuses %s inputs before publication', async scenario => {
  const input = await preparation();
  const packet = {
    ...input.packet,
    ...(scenario === 'invented' ? { state: 'ready_for_decision' } : {}),
    ...(scenario === 'private' ? { prompt: 'synthetic_private_field' } : {}),
    ...(scenario === 'revision' ? { schema_version: 2 } : {}),
    ...(scenario === 'wrong_id' ? { candidate: { ...input.packet.candidate, id: '0'.repeat(64) } } : {}),
    ...(scenario === 'cross_lane'
      ? {
          gate_matrix: input.packet.gate_matrix.map(row => ({
            ...row,
            evidence: row.evidence.map(proof => ({
              ...proof,
              scope_digest: '0'.repeat(64)
            }))
          }))
        }
      : {})
  };
  await writeFile(input.path, canonical(packet));
  expect((await prepare(input)).exitCode).toBe(2);
  expect(await readdir(input.root)).not.toContain('promotion-proposals');
});
test('prepare CLI denies network and private runtime access while preserving every supplied input byte', async () => {
  const input = await preparation();
  const before = await tree(input.root);
  const result = await auditedCli(input.root, join(projectRoot, 'scripts/tool-update.mjs'), ['prepare-promotion', '--input', input.path, '--out', input.root]);
  expect(result.exitCode, JSON.stringify(result.output)).toBe(0);
  expect(result.ledger).toMatchObject({
    network: 0,
    processes: 0,
    modules: 0,
    privateReads: 0
  });
  const after = await tree(input.root);
  expect(after.filter(([path]) => !path.startsWith('promotion-proposals/') && before.some(([old]) => old === path))).toEqual(before);
  expect(await readdir(input.root)).not.toContain('promotion-decisions');
});
test('reconcile reports the declared inventory even when it has no matching grant', async () => {
  const root = await scratch();
  roots.push(root);
  const input = await cliFixture(root, identities);
  const judgment = await publishJudgment(input);
  const path = join(root, 'reconcile.json');
  await writeFile(
    path,
    canonical({
      schema_version: 1,
      kind: 'promotion_reconciliation',
      judgments: [{ id: judgment.id, path: judgment.path }],
      proposals: [],
      decisions: [],
      descriptors: [],
      mappings: [],
      successors: []
    })
  );
  const result = await runToolUpdate(['reconcile-promotion', '--input', path, '--out', root]);
  expect(result).toEqual({
    exitCode: 0,
    output: {
      status: 'promotion_reconciled',
      proposal_ids: [],
      input_ids: [judgment.id],
      unused_ids: [judgment.id]
    }
  });
});

async function reconciliation() {
  const input = await preparation();
  const result = await prepare(input);
  const origin = await proposal(input.root, result.output.proposal_id);
  const originRef = await reference(input.root, origin);
  const decision = {
    ...input.decision,
    proposal_id: originRef.id,
    registry_before_digest: origin.registry_before_digest,
    effective_projection_digest: origin.proposed_projection_digest
  };
  const decisionRef = await reference(input.root, decision);
  const judgment = judgmentFor(input.input, true);
  const packet = {
    schema_version: 1,
    kind: 'promotion_reconciliation',
    judgments: [await reference(input.root, judgment)],
    proposals: [originRef],
    decisions: [decisionRef],
    descriptors: [input.packet.descriptor],
    mappings: input.packet.mappings,
    successors: [] as { id: string; path: string }[]
  };
  const path = join(input.root, 'reconcile.json');
  return {
    ...input,
    origin,
    originRef,
    decision,
    decisionRef,
    judgment,
    packet,
    path
  };
}
async function reconcile(input: Awaited<ReturnType<typeof reconciliation>>) {
  await writeFile(input.path, canonical(input.packet));
  return runToolUpdate(['reconcile-promotion', '--input', input.path, '--out', input.root]);
}
async function successors(input: Awaited<ReturnType<typeof reconciliation>>) {
  const result = await reconcile(input);
  expect(result.exitCode, JSON.stringify(result.output)).toBe(0);
  return Promise.all((result.output.proposal_ids ?? []).map(id => proposal(input.root, id)));
}
test('reconcile maps an affected window judgment to an exact root without issuing authority', async () => {
  const input = await reconciliation();
  const rows = await successors(input);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    authority: 'none',
    state: 'review_needed',
    scope: input.origin.scope,
    original_lanes: [input.input.job.lane],
    reconciliation: {
      predecessor_proposal_ids: [input.originRef.id],
      originating_grant_ids: [input.decisionRef.id],
      current_grant_ids: [input.decisionRef.id],
      coverage_mapping_ids: input.packet.mappings.map(row => row.id),
      triggering_judgment_ids: [digest(input.judgment)]
    }
  });
  expect(rows[0]?.reconciliation?.unresolved_findings.some(row => row.reason === 'affected_contract')).toBe(true);
  expect(await reconcile(input)).toEqual(await reconcile(input));
  expect(await readdir(input.root)).not.toContain('promotion-decisions');
});
test.each(['unknown', 'stale', 'unaffected'] as const)('reconcile retains earlier affected findings after %s input', async scenario => {
  const input = await reconciliation();
  const first = (await successors(input))[0];
  if (!first?.reconciliation) {
    throw new Error('review_successor_required');
  }
  input.packet.proposals.push(await reference(input.root, first));
  const later: DifferenceJudgment =
    scenario === 'unknown'
      ? { ...judgmentFor(input.input), source_digest: '9'.repeat(64) }
      : scenario === 'stale'
        ? { ...input.judgment, engine_digest: '9'.repeat(64) }
        : judgmentFor(input.input);
  input.packet.judgments = [await reference(input.root, later)];
  const rows = await successors(input);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.state).toBe('review_needed');
  expect(rows[0]?.reconciliation?.predecessor_proposal_ids).toEqual([digest(first)]);
  expect(rows[0]?.reconciliation?.unresolved_findings).toEqual(expect.arrayContaining([...first.reconciliation.unresolved_findings]));
});
test('prepare retains unresolved findings from an explicit review-needed predecessor', async () => {
  const input = await reconciliation();
  const previous = (await successors(input))[0];
  if (!previous) throw new Error('review_successor_required');
  const preparationInput = await preparation();
  await writeFile(
    preparationInput.path,
    canonical({
      ...preparationInput.packet,
      predecessor_proposals: [await reference(preparationInput.root, previous)]
    })
  );
  const result = await prepare(preparationInput);
  expect(result.exitCode, JSON.stringify(result.output)).toBe(0);
  expect((await proposal(preparationInput.root, result.output.proposal_id)).state).toBe('review_needed');
});
test.each(['version', 'source', 'lane', 'no_mapping'] as const)('reconcile leaves %s judgments explicitly unused', async scenario => {
  const input = await reconciliation();
  if (scenario === 'no_mapping') {
    const origin: PromotionProposal = {
      ...input.origin,
      original_lanes: [input.origin.scope.lane],
      coverage_mapping_ids: []
    };
    const originRef = await reference(input.root, origin);
    input.packet.proposals = [originRef];
    input.packet.decisions = [
      await reference(input.root, {
        ...input.decision,
        proposal_id: originRef.id
      })
    ];
    input.packet.mappings = [];
  } else {
    const other = {
      ...input.judgment,
      ...(scenario === 'version'
        ? {
            target: {
              ...input.judgment.target,
              version: '0.166.0'
            }
          }
        : {}),
      ...(scenario === 'source'
        ? {
            target: {
              ...input.judgment.target,
              commit: '8'.repeat(40)
            }
          }
        : {}),
      ...(scenario === 'lane' ? { lane: { ...input.judgment.lane, operation: 'restart' } } : {})
    };
    if (scenario === 'version' || scenario === 'source') {
      other.inventory = {
        ...other.inventory,
        releases: other.inventory.releases.map(ref => (ref.version === input.judgment.target.version ? other.target : ref))
      };
      other.comparisons = other.comparisons.map(row => ({
        ...row,
        to: row.to.version === input.judgment.target.version ? other.target : row.to
      }));
      other.comparison = other.comparison ? { ...other.comparison, to: other.target } : null;
    }
    if (scenario === 'lane' && other.baseline_row) {
      other.baseline_row = {
        ...other.baseline_row,
        operation: 'restart'
      };
    }
    input.packet.judgments = [await reference(input.root, other)];
  }
  const result = await reconcile(input);
  expect(result.exitCode, JSON.stringify(result.output)).toBe(0);
  expect(result.output.proposal_ids).toEqual([]);
  expect(result.output.unused_ids).toEqual(expect.arrayContaining(input.packet.judgments.map(row => row.id)));
});
test.each([256, 257])('reconcile enforces the %i explicit-reference boundary before publishing', async count => {
  const root = await scratch();
  roots.push(root);
  const input = await cliFixture(root, identities);
  const judgment = await publishJudgment(input);
  const path = join(root, 'bounds.json');
  await writeFile(
    path,
    canonical({
      schema_version: 1,
      kind: 'promotion_reconciliation',
      judgments: Array.from({ length: count }, () => ({ id: judgment.id, path: judgment.path })),
      proposals: [],
      decisions: [],
      descriptors: [],
      mappings: [],
      successors: []
    })
  );
  const result = await runToolUpdate(['reconcile-promotion', '--input', path, '--out', root]);
  expect(result.exitCode).toBe(count === 256 ? 0 : 2);
  expect(await readdir(root)).not.toContain('promotion-proposals');
});

test('reconcile rejects two independent approval roots for one scope before publication', async () => {
  const input = await reconciliation();
  input.packet.decisions.push(
    await reference(input.root, {
      ...input.decision,
      authorization_reference_ids: ['7'.repeat(64)]
    })
  );
  const before = await readdir(join(input.root, 'promotion-proposals'));
  expect((await reconcile(input)).exitCode).toBe(2);
  expect(await readdir(join(input.root, 'promotion-proposals'))).toEqual(before);
});
test.each(['prepare-promotion', 'reconcile-promotion'] as const)('%s rejects a record over 256 KiB without publication', async command => {
  const input = await reconciliation();
  const path = join(input.root, 'oversized.json');
  await writeFile(path, canonical({ ...input.judgment, extra: 'x'.repeat(256 * 1024) }));
  if (command === 'prepare-promotion') {
    const prep = await preparation();
    await writeFile(
      prep.path,
      canonical({
        ...prep.packet,
        judgments: [{ id: digest(input.judgment), path }]
      })
    );
    expect((await prepare(prep)).exitCode).toBe(2);
    expect(await readdir(prep.root)).not.toContain('promotion-proposals');
  } else {
    input.packet.judgments = [{ id: digest(input.judgment), path }];
    const before = await readdir(join(input.root, 'promotion-proposals'));
    expect((await reconcile(input)).exitCode).toBe(2);
    expect(await readdir(join(input.root, 'promotion-proposals'))).toEqual(before);
  }
});
test.each(['prepare-promotion', 'reconcile-promotion'] as const)(
  '%s preserves repository registry, ledger, Store, baselines and generated output bytes',
  async command => {
    const input = await reconciliation();
    const store = join(input.root, 'synthetic.db');
    await writeFile(store, 'synthetic_store_sentinel');
    const files = [
      'src/core/tool-version-profiles.json',
      'src/core/tool-version-promotions.json',
      'src/core/tool-version-promotion-result.json',
      'src/codex-admissions.json'
    ];
    const beforeFiles = await Promise.all(files.map(path => readFile(join(projectRoot, path))));
    const beforeGenerated = await tree(join(projectRoot, 'scripts/generated'));
    const beforeBuilt = await tree(join(projectRoot, 'dist/assets'));
    const beforeLocal = await tree(input.root);
    if (command === 'prepare-promotion') {
      const prep = await preparation();
      expect((await prepare(prep)).exitCode).toBe(0);
    } else expect((await reconcile(input)).exitCode).toBe(0);
    expect(await Promise.all(files.map(path => readFile(join(projectRoot, path))))).toEqual(beforeFiles);
    expect(await tree(join(projectRoot, 'scripts/generated'))).toEqual(beforeGenerated);
    expect(await tree(join(projectRoot, 'dist/assets'))).toEqual(beforeBuilt);
    const afterLocal = new Map(await tree(input.root));
    expect(beforeLocal.every(([path, hash]) => afterLocal.get(path) === hash)).toBe(true);
  }
);
test.each(['mapping_conflict', 'missing_predecessor', 'unknown_revision'] as const)('reconcile rejects %s without publishing any successor', async scenario => {
  const input = await reconciliation();
  if (scenario === 'mapping_conflict') {
    input.packet.mappings.push(
      await reference(input.root, {
        ...input.mapping,
        review_reference: '7'.repeat(64)
      })
    );
  } else if (scenario === 'missing_predecessor') {
    input.packet.decisions = [
      await reference(input.root, {
        ...input.decision,
        sequence: 2,
        predecessor: {
          id: '0'.repeat(64),
          sequence: 1,
          decision: 'approve'
        }
      })
    ];
  } else {
    input.packet.judgments = [
      await reference(input.root, {
        ...input.judgment,
        engine_revision: 'unknown-revision'
      })
    ];
  }
  const before = await readdir(join(input.root, 'promotion-proposals'));
  expect((await reconcile(input)).exitCode).toBe(2);
  expect(await readdir(join(input.root, 'promotion-proposals'))).toEqual(before);
});

async function reviewedDescriptorSuccessor(input: Awaited<ReturnType<typeof reconciliation>>) {
  const descriptor = {
    ...input.descriptor,
    qualificationClaims: {
      ...input.descriptor.qualificationClaims,
      semanticsDigest: '7'.repeat(64)
    }
  };
  const descriptorRef = await reference(input.root, descriptor);
  const mappingRef = await reference(input.root, {
    ...input.mapping,
    descriptor_digest: descriptorRef.id
  });
  const nextRef = await reference(input.root, {
    ...input.origin,
    descriptor_digest: descriptorRef.id,
    coverage_mapping_ids: [mappingRef.id]
  });
  const successor = {
    schema_version: 1,
    kind: 'promotion_descriptor_successor',
    predecessor_descriptor_digest: input.origin.descriptor_digest,
    successor_descriptor_digest: descriptorRef.id,
    predecessor_proposal_id: input.originRef.id,
    successor_proposal_id: nextRef.id,
    coverage_mapping_ids: [mappingRef.id],
    review_reference: '8'.repeat(64)
  };
  input.packet.descriptors.push(descriptorRef);
  input.packet.proposals.push(nextRef);
  input.packet.mappings.push(mappingRef);
  input.packet.successors.push(await reference(input.root, successor));
  return { nextRef, successor, descriptorRef, mappingRef };
}
test('reconcile follows a reviewed same-target descriptor successor and retains original grant identity', async () => {
  const input = await reconciliation();
  const next = await reviewedDescriptorSuccessor(input);
  const rows = await successors(input);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    descriptor_digest: next.descriptorRef.id,
    state: 'review_needed',
    reconciliation: {
      predecessor_proposal_ids: [next.nextRef.id],
      originating_grant_ids: [input.decisionRef.id],
      coverage_mapping_ids: [next.mappingRef.id]
    }
  });
  expect(rows[0]?.reconciliation?.descriptor_lineage_ids).toEqual(expect.arrayContaining([input.origin.descriptor_digest, next.descriptorRef.id]));
});
test.each(['unreviewed', 'cycle', 'missing', 'other_target'] as const)('reconcile refuses %s descriptor successors before publishing', async scenario => {
  const input = await reconciliation();
  const next = await reviewedDescriptorSuccessor(input);
  if (scenario === 'unreviewed') {
    input.packet.successors = [
      await reference(input.root, {
        ...next.successor,
        review_reference: null
      })
    ];
  } else if (scenario === 'cycle') {
    input.packet.successors.push(
      await reference(input.root, {
        ...next.successor,
        predecessor_descriptor_digest: next.descriptorRef.id,
        successor_descriptor_digest: input.origin.descriptor_digest,
        predecessor_proposal_id: next.nextRef.id,
        successor_proposal_id: input.originRef.id,
        coverage_mapping_ids: input.origin.coverage_mapping_ids
      })
    );
  } else if (scenario === 'missing') {
    input.packet.successors = [
      await reference(input.root, {
        ...next.successor,
        predecessor_proposal_id: '0'.repeat(64)
      })
    ];
  } else {
    input.packet.successors = [
      await reference(input.root, {
        ...next.successor,
        successor_descriptor_digest: '0'.repeat(64)
      })
    ];
  }
  const before = await readdir(join(input.root, 'promotion-proposals'));
  expect((await reconcile(input)).exitCode).toBe(2);
  expect(await readdir(join(input.root, 'promotion-proposals'))).toEqual(before);
});
test('reconcile reports only mapped collect facets and leaves restart and child scopes unused', async () => {
  const input = await reconciliation();
  const mappingRef = await reference(input.root, {
    ...input.mapping,
    contracts: ['fields_types_enums'],
    facets: ['serialized_shape']
  });
  const origin = { ...input.origin, coverage_mapping_ids: [mappingRef.id] };
  const originRef = await reference(input.root, origin);
  input.packet.mappings = [mappingRef];
  input.packet.proposals = [originRef];
  input.packet.decisions = [
    await reference(input.root, {
      ...input.decision,
      proposal_id: originRef.id
    })
  ];
  const unrelated: string[] = [];
  for (const lane of [
    { ...origin.scope.lane, operation: 'restart' as const },
    { ...origin.scope.lane, topology: 'bounded_family' as const }
  ]) {
    const scope = { ...origin.scope, lane };
    const other = {
      ...origin,
      scope,
      original_lanes: [lane],
      coverage_mapping_ids: [],
      contracts: consumedContracts.map(contract_id => ({
        contract_id,
        facets: requiredFacets(contract_id, lane).map(facet => ({
          facet,
          result: 'unaffected',
          required_classes: []
        }))
      })),
      gate_matrix: origin.gate_matrix.map(row => ({
        ...row,
        evidence: row.evidence.map(proof => ({
          ...proof,
          scope_digest: digest(scope)
        }))
      }))
    };
    const otherRef = await reference(input.root, other);
    input.packet.proposals.push(otherRef);
    input.packet.decisions.push(
      await reference(input.root, {
        ...input.decision,
        scope,
        proposed_scope: scope,
        proposal_id: otherRef.id
      })
    );
    unrelated.push(otherRef.id);
  }
  const result = await reconcile(input);
  expect(result.exitCode, JSON.stringify(result.output)).toBe(0);
  expect(result.output.proposal_ids).toHaveLength(1);
  const record = await proposal(input.root, result.output.proposal_ids?.[0]);
  expect(record.reconciliation).toMatchObject({
    matched_scope: input.origin.scope,
    matched_contracts: ['fields_types_enums'],
    matched_facets: ['serialized_shape']
  });
  expect(result.output.unused_ids).toEqual(expect.arrayContaining(unrelated));
});
test('reconcile retains withdrawn grants and their current negative decision', async () => {
  const input = await reconciliation();
  const negativeRef = await reference(input.root, {
    ...input.decision,
    decision: 'revoke',
    reason: 'authority_withdrawn',
    grants: [],
    sequence: 2,
    predecessor: {
      id: input.decisionRef.id,
      sequence: 1,
      decision: 'approve'
    }
  });
  input.packet.decisions.push(negativeRef);
  const rows = await successors(input);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.reconciliation).toMatchObject({
    originating_grant_ids: [input.decisionRef.id],
    current_grant_ids: [negativeRef.id]
  });
});
test('reconcile retains findings from every predecessor of a merged proposal lineage', async () => {
  const input = await reconciliation();
  const first = (await successors(input))[0];
  if (!first?.reconciliation) throw new Error('review_successor_required');
  const extraFinding = {
    finding_id: digest('synthetic-second-finding'),
    judgment_id: digest(input.judgment),
    proposal_id: input.originRef.id,
    reason: 'affected_contract' as const
  };
  const left = await reference(input.root, first);
  const right = await reference(input.root, {
    ...first,
    selection_reference: digest('synthetic-right'),
    reconciliation: {
      ...first.reconciliation,
      unresolved_findings: [...first.reconciliation.unresolved_findings, extraFinding].sort((a, b) => a.finding_id.localeCompare(b.finding_id, 'en'))
    }
  });
  const merged = await reference(input.root, {
    ...first,
    selection_reference: digest('synthetic-merge'),
    reconciliation: {
      ...first.reconciliation,
      predecessor_proposal_ids: [left.id, right.id].sort()
    }
  });
  input.packet.proposals.push(left, right, merged);
  const rows = await successors(input);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.reconciliation?.unresolved_findings).toEqual(expect.arrayContaining([extraFinding]));
});
test('reconcile refuses cycles spanning proposal and descriptor predecessor edges', async () => {
  const input = await reconciliation();
  const first = (await successors(input))[0];
  if (!first) throw new Error('review_successor_required');
  const firstRef = await reference(input.root, first);
  input.packet.proposals.push(firstRef);
  input.packet.successors.push(
    await reference(input.root, {
      schema_version: 1,
      kind: 'promotion_descriptor_successor',
      predecessor_descriptor_digest: input.origin.descriptor_digest,
      successor_descriptor_digest: input.origin.descriptor_digest,
      predecessor_proposal_id: firstRef.id,
      successor_proposal_id: input.originRef.id,
      coverage_mapping_ids: input.origin.coverage_mapping_ids,
      review_reference: '7'.repeat(64)
    })
  );
  const before = await readdir(join(input.root, 'promotion-proposals'));
  expect((await reconcile(input)).exitCode).toBe(2);
  expect(await readdir(join(input.root, 'promotion-proposals'))).toEqual(before);
});
test('reconcile CLI proves zero network, runtime imports and private reads and preserves all decision bytes', async () => {
  const input = await reconciliation();
  await writeFile(input.path, canonical(input.packet));
  const before = await tree(input.root);
  const result = await auditedCli(input.root, join(projectRoot, 'scripts/tool-update.mjs'), [
    'reconcile-promotion',
    '--input',
    input.path,
    '--out',
    input.root
  ]);
  expect(result.exitCode, JSON.stringify(result.output)).toBe(0);
  expect(result.ledger).toMatchObject({
    network: 0,
    processes: 0,
    modules: 0,
    privateReads: 0
  });
  const after = new Map(await tree(input.root));
  expect(before.every(([path, hash]) => after.get(path) === hash)).toBe(true);
});
test.each([256, 257])('reconcile enforces %i lineage edges independently of its record budget', async count => {
  const input = await reconciliation();
  const first = (await successors(input))[0];
  if (!first?.reconciliation) {
    throw new Error('review_successor_required');
  }
  const leaves = [];
  for (let index = 0; index < 128; index++) {
    leaves.push(
      await reference(input.root, {
        ...first,
        selection_reference: digest(index)
      })
    );
  }
  const parents = [];
  for (let index = 0; index < 2; index++) {
    const predecessorIds = leaves
      .slice(0, index === 1 && count === 257 ? 65 : 64)
      .map(row => row.id)
      .sort();
    parents.push(
      await reference(input.root, {
        ...first,
        selection_reference: digest({ index }),
        reconciliation: {
          ...first.reconciliation,
          predecessor_proposal_ids: predecessorIds
        }
      })
    );
  }
  input.packet.proposals.push(...leaves, ...parents);
  input.packet.judgments = [];
  const result = await reconcile(input);
  expect(result.exitCode, JSON.stringify(result.output)).toBe(count === 256 ? 0 : 2);
});

test('ordinary review-needed successors cannot replace approval-bound coverage mappings', async () => {
  const input = await reconciliation();
  const first = (await successors(input))[0];
  if (!first?.reconciliation) throw new Error('review_successor_required');
  const lane = {
    ...input.judgment.lane,
    profile_id: 'codex-binding-01640-direct-family-v1'
  };
  const mapping = await reference(input.root, {
    ...input.mapping,
    original_lane: lane
  });
  const judgment = {
    ...input.judgment,
    lane,
    baseline_row: { ...input.judgment.baseline_row, ...lane },
    parser_base: {
      ...input.judgment.parser_base,
      profile_id: lane.profile_id
    }
  };
  input.packet.judgments = [await reference(input.root, judgment)];
  input.packet.mappings.push(mapping);
  input.packet.proposals.push(
    await reference(input.root, {
      ...first,
      coverage_mapping_ids: [mapping.id],
      reconciliation: {
        ...first.reconciliation,
        coverage_mapping_ids: [mapping.id]
      }
    })
  );
  const before = await tree(join(input.root, 'promotion-proposals'));
  expect(await reconcile(input)).toEqual({
    exitCode: 2,
    output: { status: 'promotion_lineage_invalid' }
  });
  expect(await tree(join(input.root, 'promotion-proposals'))).toEqual(before);
});
test('ordinary review-needed successors retain the approved mapping and original lane match', async () => {
  const input = await reconciliation();
  const first = (await successors(input))[0];
  if (!first) throw new Error('review_successor_required');
  input.packet.proposals.push(await reference(input.root, first));
  const result = await reconcile(input);
  expect(result.exitCode, JSON.stringify(result.output)).toBe(0);
  expect(result.output.proposal_ids).toHaveLength(1);
  const next = await proposal(input.root, result.output.proposal_ids?.[0]);
  expect(next.coverage_mapping_ids).toEqual(input.origin.coverage_mapping_ids);
  expect(next.reconciliation).toMatchObject({
    coverage_mapping_ids: input.origin.coverage_mapping_ids,
    triggering_judgment_ids: [digest(input.judgment)]
  });
  expect(result.output.unused_ids).not.toContain(input.origin.coverage_mapping_ids[0]);
});
test('an explicit reviewed lineage can change coverage mappings for the same descriptor', async () => {
  const input = await reconciliation();
  const lane = {
    ...input.judgment.lane,
    profile_id: 'codex-binding-01640-direct-family-v1'
  };
  const mapping = await reference(input.root, {
    ...input.mapping,
    original_lane: lane
  });
  const next = await reference(input.root, {
    ...input.origin,
    original_lanes: [lane],
    coverage_mapping_ids: [mapping.id]
  });
  input.packet.proposals.push(next);
  input.packet.mappings.push(mapping);
  input.packet.successors.push(
    await reference(input.root, {
      schema_version: 1,
      kind: 'promotion_descriptor_successor',
      predecessor_descriptor_digest: input.origin.descriptor_digest,
      successor_descriptor_digest: input.origin.descriptor_digest,
      predecessor_proposal_id: input.originRef.id,
      successor_proposal_id: next.id,
      coverage_mapping_ids: [mapping.id],
      review_reference: digest('synthetic_mapping_review')
    })
  );
  const judgment = {
    ...input.judgment,
    lane,
    baseline_row: { ...input.judgment.baseline_row, ...lane },
    parser_base: {
      ...input.judgment.parser_base,
      profile_id: lane.profile_id
    }
  };
  input.packet.judgments = [await reference(input.root, judgment)];
  const rows = await successors(input);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.coverage_mapping_ids).toEqual([mapping.id]);
  expect(rows[0]?.reconciliation?.triggering_judgment_ids).toEqual([digest(judgment)]);
});
test('reviewed lineage cannot smuggle a coverage mapping outside its explicit reviewed set', async () => {
  const input = await reconciliation();
  const reviewed = await reviewedDescriptorSuccessor(input);
  const next = await loadRecord(reviewed.nextRef.path, promotionProposalSchema);
  const extra = await reference(input.root, {
    ...input.mapping,
    descriptor_digest: reviewed.descriptorRef.id,
    original_lane: {
      ...input.mapping.original_lane,
      profile_id: 'codex-binding-01640-direct-family-v1'
    }
  });
  const replaced = await reference(input.root, {
    ...next,
    coverage_mapping_ids: [...next.coverage_mapping_ids, extra.id].sort()
  });
  input.packet.mappings.push(extra);
  input.packet.proposals = input.packet.proposals.map(row => (row.id === reviewed.nextRef.id ? replaced : row));
  input.packet.successors = [
    await reference(input.root, {
      ...reviewed.successor,
      successor_proposal_id: replaced.id
    })
  ];
  const before = await tree(join(input.root, 'promotion-proposals'));
  expect(await reconcile(input)).toEqual({
    exitCode: 2,
    output: { status: 'promotion_lineage_invalid' }
  });
  expect(await tree(join(input.root, 'promotion-proposals'))).toEqual(before);
});
test.each(['different_record', 'noncanonical_record'])('reconcile preflights every output before publishing with a later %s conflict', async scenario => {
  const input = await reconciliation();
  for (const label of ['left', 'right']) {
    const sibling = await reference(input.root, {
      ...input.origin,
      selection_reference: digest({ label })
    });
    input.packet.proposals.push(sibling);
    input.packet.successors.push(
      await reference(input.root, {
        schema_version: 1,
        kind: 'promotion_descriptor_successor',
        predecessor_descriptor_digest: input.origin.descriptor_digest,
        successor_descriptor_digest: input.origin.descriptor_digest,
        predecessor_proposal_id: input.originRef.id,
        successor_proposal_id: sibling.id,
        coverage_mapping_ids: input.origin.coverage_mapping_ids,
        review_reference: digest({ reviewed: label })
      })
    );
  }
  await writeFile(input.path, canonical(input.packet));
  const preview = await reconcilePromotion(input.path, projectRoot);
  expect(preview.proposals).toHaveLength(2);
  const second = preview.proposals[1];
  if (!second) throw new Error('second_proposal_required');
  const destination = join(input.root, 'promotion-proposals', `${digest(second)}.json`);
  const conflictingBytes = scenario === 'different_record' ? canonical({ synthetic_conflict: true }) : JSON.stringify(second);
  await writeFile(destination, conflictingBytes);
  const before = await tree(join(input.root, 'promotion-proposals'));
  expect(await reconcile(input)).toEqual({
    exitCode: 2,
    output: { status: 'record_conflict' }
  });
  expect(await tree(join(input.root, 'promotion-proposals'))).toEqual(before);
  expect(await readFile(destination, 'utf8')).toBe(conflictingBytes);
});

const reconciliationOutput = z.object({
  status: z.literal('promotion_reconciled'),
  proposal_ids: z.array(z.string()),
  input_ids: z.array(z.string()),
  unused_ids: z.array(z.string())
});
const negativeDecisions = {
  demote: 'qualification_withdrawn',
  retire: 'maintenance_ended',
  revoke: 'authority_withdrawn',
  invalidate: 'confirmed_incompatibility',
  delete: 'authority_deleted'
} as const;

let seed: Awaited<ReturnType<typeof reconciliation>>;
let databaseTemplate: Buffer;
beforeAll(async () => {
  seed = await reconciliation();
  populateOfflineStore(seed.root);
  databaseTemplate = await readFile(join(seed.root, 'synthetic.db'));
  // Only case-local copies belong in the repeatedly hashed input inventories.
  await rm(join(seed.root, 'synthetic.db'));
  roots.splice(roots.indexOf(seed.root), 1);
});
afterAll(async () => {
  await rm(seed.root, { recursive: true, force: true });
});

async function isolatedInput() {
  const root = await scratch();
  roots.push(root);
  await writeFile(join(root, 'synthetic.db'), databaseTemplate);
  return {
    ...structuredClone(seed),
    root,
    path: join(root, 'reconcile.json')
  };
}

async function commandInput(command: 'prepare-promotion' | 'reconcile-promotion' | 'assess') {
  const input = await isolatedInput();
  await writeFile(input.path, canonical(input.packet));
  const args =
    command === 'assess'
      ? ['assess', ...seed.input.inputArgs, '--out', input.root]
      : [command, '--input', command === 'prepare-promotion' ? join(seed.root, 'prepare.json') : input.path, '--out', input.root];
  return { ...input, args };
}

test.each(['prepare-promotion', 'reconcile-promotion', 'assess'] as const)(
  'real %s CLI has zero database native private and network effects',
  async command => {
    const input = await commandInput(command);
    const before = await tree(input.root);
    const seedBefore = await tree(seed.root);
    const result = await auditedCli(input.root, join(projectRoot, 'scripts/tool-update.mjs'), input.args);
    expect(result.exitCode, JSON.stringify(result.output)).toBe(0);
    expect(result.ledger).toMatchObject({
      network: 0,
      processes: 0,
      modules: 0,
      privateReads: 0
    });
    expect(result.output).toMatchObject({
      status: command === 'assess' ? 'assessment_created' : command === 'prepare-promotion' ? 'promotion_prepared' : 'promotion_reconciled'
    });
    const after = new Map(await tree(input.root));
    for (const [path, bytes] of before) {
      expect(after.get(path), path).toBe(bytes);
    }
    expect(await tree(seed.root)).toEqual(seedBefore);
    expect(await readdir(input.root)).not.toContain('promotion-decisions');
  },
  20000
);

test.each(
  (['prepare-promotion', 'reconcile-promotion', 'assess'] as const).flatMap(command =>
    (['database', 'native', 'private', 'network'] as const).map(access => ({ command, access }))
  )
)(
  'real $command CLI trips the calibrated $access access mutation',
  async ({ command, access }) => {
    const input = await commandInput(command);
    const result = await mutationCli(input.root, input.args, access);
    expect(result.exitCode, JSON.stringify(result.output)).toBe(2);
    expect(result.output).toEqual({ status: 'internal_error' });
    expect(result.ledger).toMatchObject({
      network: access === 'network' ? 1 : 0,
      processes: access === 'native' ? 1 : 0,
      modules: access === 'database' ? 1 : 0,
      privateReads: access === 'private' ? 1 : 0
    });
    const published = await readdir(input.root);
    expect(published).not.toContain('promotion-proposals');
    expect(published).not.toContain('assessments');
    expect(published).not.toContain('promotion-decisions');
  },
  20000
);

test.each(
  (['prepare-promotion', 'reconcile-promotion', 'assess'] as const).flatMap(command =>
    (['callbackReadFile', 'callbackReaddir', 'callbackOpen'] as const).map(access => ({ command, access }))
  )
)(
  'real $command CLI trips the calibrated $access private access mutation',
  async ({ command, access }) => {
    const input = await commandInput(command);

    const result = await mutationCli(input.root, input.args, access);

    expect(result.exitCode, JSON.stringify(result.output)).toBe(2);
    expect(result.output).toEqual({ status: 'internal_error' });
    expect(result.ledger).toMatchObject({
      network: 0,
      processes: 0,
      modules: 0,
      privateReads: 1
    });
    const published = await readdir(input.root);
    expect(published).not.toContain('promotion-proposals');
    expect(published).not.toContain('assessments');
    expect(published).not.toContain('promotion-decisions');
  },
  20000
);

test.each([
  'original_window',
  'reviewed_successor',
  'unreviewed_successor',
  'successor_cycle',
  'missing_predecessor',
  'missing_mapping',
  'conflicting_mapping',
  'partial_overlap',
  'unrelated_version',
  'unrelated_source',
  'unrelated_lane',
  'unmapped_profile',
  'stale',
  'unknown',
  'later_unaffected',
  'demote',
  'retire',
  'revoke',
  'invalidate',
  'delete',
  'deterministic_replay'
] as const)(
  'real reconcile-promotion CLI preserves bounded lineage for %s',
  async scenario => {
    const input = await isolatedInput();
    let descriptorId = seed.origin.descriptor_digest;
    let mappingIds = [...seed.origin.coverage_mapping_ids];
    let predecessorId = seed.originRef.id;
    let currentGrantId = seed.decisionRef.id;
    let retained: NonNullable<PromotionProposal['reconciliation']>['unresolved_findings'] = [];
    if (['reviewed_successor', 'unreviewed_successor', 'successor_cycle', 'missing_predecessor'].includes(scenario)) {
      const next = await reviewedDescriptorSuccessor(input);
      descriptorId = next.descriptorRef.id;
      mappingIds = [next.mappingRef.id];
      predecessorId = next.nextRef.id;
      if (scenario === 'reviewed_successor') {
        const priorInput = await isolatedInput();
        const first = (await successors(priorInput))[0];
        if (!first?.reconciliation) {
          throw new Error('review_successor_required');
        }
        retained = first.reconciliation.unresolved_findings;
        const previous = await reference(input.root, first);
        input.packet.proposals.push(previous);
        input.packet.successors = [
          await reference(input.root, {
            ...next.successor,
            predecessor_proposal_id: previous.id
          })
        ];
      }
      if (scenario === 'unreviewed_successor') {
        input.packet.successors = [
          await reference(input.root, {
            ...next.successor,
            review_reference: null
          })
        ];
      } else if (scenario === 'missing_predecessor') {
        input.packet.proposals = input.packet.proposals.filter(row => row.id !== seed.originRef.id);
      } else if (scenario === 'successor_cycle') {
        input.packet.successors.push(
          await reference(input.root, {
            ...next.successor,
            predecessor_descriptor_digest: next.descriptorRef.id,
            successor_descriptor_digest: seed.origin.descriptor_digest,
            predecessor_proposal_id: next.nextRef.id,
            successor_proposal_id: seed.originRef.id,
            coverage_mapping_ids: seed.origin.coverage_mapping_ids
          })
        );
      }
    }
    if (scenario === 'missing_mapping') input.packet.mappings = [];
    if (scenario === 'deterministic_replay') {
      const lane = {
        ...input.judgment.lane,
        operation: 'restart' as const
      };
      input.packet.judgments.push(
        await reference(input.root, {
          ...input.judgment,
          lane,
          baseline_row: {
            ...input.judgment.baseline_row,
            ...lane
          }
        })
      );
    }
    if (scenario === 'conflicting_mapping') {
      input.packet.mappings.push(
        await reference(input.root, {
          ...input.mapping,
          review_reference: '7'.repeat(64)
        })
      );
    }
    if (scenario === 'partial_overlap') {
      const mapping = await reference(input.root, {
        ...input.mapping,
        contracts: ['fields_types_enums'],
        facets: ['serialized_shape']
      });
      const origin = await reference(input.root, {
        ...input.origin,
        coverage_mapping_ids: [mapping.id]
      });
      const decision = await reference(input.root, {
        ...input.decision,
        proposal_id: origin.id
      });
      input.packet.mappings = [mapping];
      input.packet.proposals = [origin];
      input.packet.decisions = [decision];
      mappingIds = [mapping.id];
      predecessorId = origin.id;
      currentGrantId = decision.id;
      await addUnmatchedScopes(input);
    }
    if (scenario.startsWith('unrelated_') || scenario === 'unmapped_profile') await setUnrelatedJudgment(input, scenario);
    if (scenario === 'stale' || scenario === 'unknown' || scenario === 'later_unaffected') {
      const first = (await successors(input))[0];
      if (!first?.reconciliation) {
        throw new Error('review_successor_required');
      }
      retained = first.reconciliation.unresolved_findings;
      const previous = await reference(input.root, first);
      predecessorId = previous.id;
      input.packet.proposals.push(previous);
      const later =
        scenario === 'unknown'
          ? judgeDifferences(input.input.job, [], identities)
          : {
              ...judgmentFor(input.input),
              ...(scenario === 'stale' ? { engine_digest: '9'.repeat(64) } : {})
            };
      input.packet.judgments = [await reference(input.root, later)];
    }
    if (scenario in negativeDecisions) {
      const decision = z.enum(['demote', 'retire', 'revoke', 'invalidate', 'delete']).parse(scenario);
      const negative = await reference(input.root, {
        ...input.decision,
        decision,
        reason: negativeDecisions[decision],
        grants: [],
        sequence: 2,
        predecessor: {
          id: seed.decisionRef.id,
          sequence: 1,
          decision: 'approve'
        }
      });
      input.packet.decisions.push(negative);
      currentGrantId = negative.id;
    }
    await assertCliReconciliation(input, {
      scenario,
      descriptorId,
      mappingIds,
      predecessorId,
      currentGrantId,
      retained
    });
  },
  20000
);

async function setUnrelatedJudgment(input: Awaited<ReturnType<typeof reconciliation>>, scenario: string) {
  const target = {
    ...input.judgment.target,
    ...(scenario === 'unrelated_version' ? { version: '0.166.0' } : {}),
    ...(scenario === 'unrelated_source' ? { commit: '8'.repeat(40) } : {})
  };
  const lane = {
    ...input.judgment.lane,
    ...(scenario === 'unrelated_lane' ? { operation: 'restart' as const } : {}),
    ...(scenario === 'unmapped_profile' ? { profile_id: 'codex-binding-01640-direct-family-v1' } : {})
  };
  input.packet.judgments = [
    await reference(input.root, {
      ...input.judgment,
      target,
      lane,
      baseline_row: {
        ...input.judgment.baseline_row,
        ...lane
      },
      parser_base: {
        ...input.judgment.parser_base,
        profile_id: lane.profile_id
      },
      inventory: {
        ...input.judgment.inventory,
        releases: input.judgment.inventory.releases.map(row => (row.version === input.judgment.target.version ? target : row))
      },
      comparisons: input.judgment.comparisons.map(row => ({
        ...row,
        to: row.to.version === input.judgment.target.version ? target : row.to
      })),
      comparison: input.judgment.comparison ? { ...input.judgment.comparison, to: target } : null
    })
  ];
}

async function addUnmatchedScopes(input: Awaited<ReturnType<typeof reconciliation>>) {
  for (const lane of [
    { ...input.origin.scope.lane, operation: 'restart' as const },
    { ...input.origin.scope.lane, topology: 'bounded_family' as const }
  ]) {
    const scope = { ...input.origin.scope, lane };
    const mapping = await reference(input.root, {
      ...input.mapping,
      original_lane: lane,
      scope
    });
    const origin = {
      ...input.origin,
      scope,
      original_lanes: [lane],
      coverage_mapping_ids: [mapping.id],
      contracts: consumedContracts.map(contract_id => ({
        contract_id,
        facets: requiredFacets(contract_id, lane).map(facet => ({
          facet,
          result: 'unaffected',
          required_classes: []
        }))
      })),
      gate_matrix: input.origin.gate_matrix.map(row => ({
        ...row,
        evidence: row.evidence.map(proof => ({
          ...proof,
          scope_digest: digest(scope)
        }))
      }))
    };
    const ref = await reference(input.root, origin);
    const decision = await reference(input.root, {
      ...input.decision,
      scope,
      proposed_scope: scope,
      proposal_id: ref.id
    });
    const job = {
      ...input.input.job,
      lane,
      baseline_row: input.input.job.baseline_row ? { ...input.input.job.baseline_row, ...lane } : null,
      parser_base: input.input.job.parser_base
        ? {
            ...input.input.job.parser_base,
            profile_id: lane.profile_id
          }
        : null
    };
    const judgment = await reference(input.root, judgeDifferences(job, [], identities));
    const previous = (
      await successors({
        ...input,
        packet: {
          ...input.packet,
          proposals: [ref],
          decisions: [decision],
          mappings: [mapping],
          judgments: [judgment]
        }
      })
    )[0];
    if (!previous?.reconciliation) {
      throw new Error('unmatched_review_successor_required');
    }
    input.packet.proposals.push(ref, await reference(input.root, previous));
    input.packet.decisions.push(decision);
    input.packet.mappings.push(mapping);
  }
}

async function assertCliReconciliation(
  input: Awaited<ReturnType<typeof reconciliation>>,
  expected: {
    readonly scenario: string;
    readonly descriptorId: string;
    readonly mappingIds: readonly string[];
    readonly predecessorId: string;
    readonly currentGrantId: string;
    readonly retained: NonNullable<PromotionProposal['reconciliation']>['unresolved_findings'];
  }
) {
  const packetBytes = canonical(input.packet);
  await writeFile(input.path, packetBytes);
  const before = await tree(input.root);
  const seedBefore = await tree(seed.root);
  const result = await auditedCli(input.root, join(projectRoot, 'scripts/tool-update.mjs'), [
    'reconcile-promotion',
    '--input',
    input.path,
    '--out',
    input.root
  ]);
  expect(result.ledger).toMatchObject({
    network: 0,
    processes: 0,
    modules: 0,
    privateReads: 0
  });
  const refused = ['unreviewed_successor', 'successor_cycle', 'missing_predecessor', 'missing_mapping', 'conflicting_mapping'].includes(expected.scenario);
  expect(result.exitCode, JSON.stringify(result.output)).toBe(refused ? 2 : 0);
  if (refused) {
    expect(result.output).toEqual({
      status:
        expected.scenario === 'conflicting_mapping'
          ? 'promotion_mapping_conflict'
          : expected.scenario === 'unreviewed_successor'
            ? 'invalid_record'
            : 'promotion_lineage_invalid'
    });
    expect(await readdir(input.root)).not.toContain('promotion-proposals');
  } else {
    const output = reconciliationOutput.parse(result.output);
    const inputIds = [...new Set(Object.values(input.packet).flatMap(value => (Array.isArray(value) ? value.map(row => row.id) : [])))].sort();
    expect(output.input_ids).toEqual(inputIds);
    const unrelated = expected.scenario.startsWith('unrelated_') || expected.scenario === 'unmapped_profile';
    if (unrelated) {
      expect(output.proposal_ids).toEqual([]);
      expect(output.unused_ids).toEqual(inputIds);
    } else {
      expect(output.proposal_ids).toHaveLength(1);
      const row = await proposal(input.root, output.proposal_ids[0]);
      expect(row).toMatchObject({
        authority: 'none',
        state: 'review_needed',
        scope: seed.origin.scope,
        descriptor_digest: expected.descriptorId,
        original_lanes: [seed.input.job.lane],
        reconciliation: {
          predecessor_proposal_ids: [expected.predecessorId],
          current_grant_ids: [expected.currentGrantId],
          coverage_mapping_ids: expected.mappingIds,
          triggering_judgment_ids: (expected.scenario === 'deterministic_replay' ? seed.packet.judgments : input.packet.judgments).map(ref => ref.id).sort()
        }
      });
      expect(row.reconciliation?.unresolved_findings).toEqual(expect.arrayContaining([...expected.retained]));
      if (expected.scenario === 'partial_overlap') {
        expect(row.reconciliation).toMatchObject({
          matched_contracts: ['fields_types_enums'],
          matched_facets: ['serialized_shape']
        });
        expect(row.reconciliation?.unresolved_findings.map(finding => finding.reason)).toEqual(['affected_contract']);
        expect(output.unused_ids).toEqual(
          [...input.packet.proposals.slice(1), ...input.packet.decisions.slice(1), ...input.packet.mappings.slice(1)].map(ref => ref.id).sort()
        );
      } else {
        expect(output.unused_ids).toEqual(
          expected.scenario === 'reviewed_successor'
            ? seed.origin.coverage_mapping_ids
            : expected.scenario === 'deterministic_replay'
              ? input.packet.judgments
                  .slice(1)
                  .map(ref => ref.id)
                  .sort()
              : []
        );
        expect(row.reconciliation?.originating_grant_ids).toEqual([seed.decisionRef.id]);
      }
      if (expected.scenario === 'stale' || expected.scenario === 'unknown') {
        expect(
          row.reconciliation?.unresolved_findings.some(
            finding =>
              finding.reason === (expected.scenario === 'stale' ? 'stale_evidence' : 'unknown_contract') &&
              finding.judgment_id === input.packet.judgments[0]?.id
          )
        ).toBe(true);
      }
      if (expected.scenario === 'reviewed_successor') {
        expect(row.reconciliation?.descriptor_lineage_ids).toEqual(
          [seed.origin.descriptor_digest, expected.descriptorId, ...input.packet.successors.map(ref => ref.id)].sort()
        );
      }
      if (expected.scenario === 'deterministic_replay') {
        const published = await tree(join(input.root, 'promotion-proposals'));
        for (const value of Object.values(input.packet)) {
          if (Array.isArray(value)) value.reverse();
        }
        input.packet.judgments.push(...input.packet.judgments);
        await writeFile(input.path, canonical(input.packet));
        const replay = await auditedCli(input.root, join(projectRoot, 'scripts/tool-update.mjs'), [
          'reconcile-promotion',
          '--input',
          input.path,
          '--out',
          input.root
        ]);
        expect(replay.exitCode).toBe(0);
        expect(replay.output).toEqual(output);
        expect(await tree(join(input.root, 'promotion-proposals'))).toEqual(published);
        await writeFile(input.path, packetBytes);
      }
    }
  }
  expect(await tree(seed.root)).toEqual(seedBefore);
  const after = new Map(await tree(input.root));
  for (const [path, bytes] of before) {
    expect(after.get(path), path).toBe(bytes);
  }
  expect(await readdir(input.root)).not.toContain('promotion-decisions');
}
