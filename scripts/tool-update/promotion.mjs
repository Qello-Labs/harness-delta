import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { boundedParse, canonical, digest, fail, loadRecord, publishRecord, shaSchema } from './manifest.mjs';
import { candidateSchema, observationSchema } from './discovery.mjs';
import { assessmentSchema } from './assessment.mjs';
import { laneKey, laneSchema } from './lanes.mjs';
import { consumedContracts, facets, mapRevision, requiredFacets } from './difference-contracts.mjs';
import { differenceJobSchema, differenceJudgmentSchema, requiredDifferenceCoverage } from './difference-records.mjs';
import { judgmentEngineDigest } from './difference-judgment.mjs';
import { withSourceSnapshot } from './source-snapshot.mjs';
import {
  promotionDecisionSchema,
  promotionEngineDigest,
  promotionEngineRevision,
  promotionGateInputSchema,
  promotionProposalSchema,
  promotionScopeSchema
} from './promotion-records.mjs';
import { reducePromotionGates } from './promotion-gates.mjs';
import {
  parseToolVersionPromotionDescriptor,
  previewToolVersionPromotion,
  projectToolVersionPromotions,
  promotionDescriptorDigest,
  promotionProjectionDigest,
  promotionRegistryDigest,
  ToolVersionPromotionError
} from '../../src/core/tool-version-promotion.ts';

const unique = values => [...new Set(values)].sort();
const same = (a, b) => canonical(a) === canonical(b);
const list = schema => z.array(schema).max(256);
const referenceSchema = z.strictObject({
  id: shaSchema,
  path: z.string().min(1).max(4096)
});
const referencesSchema = list(referenceSchema);
const finiteList = values =>
  z
    .array(z.enum(values))
    .min(1)
    .max(values.length)
    .refine(rows => same(rows, unique(rows)));
export const promotionCoverageMappingSchema = z
  .strictObject({
    schema_version: z.literal(1),
    kind: z.literal('promotion_coverage_mapping'),
    original_lane: laneSchema,
    scope: promotionScopeSchema,
    descriptor_digest: shaSchema,
    review_reference: shaSchema,
    contracts: finiteList(consumedContracts),
    facets: finiteList(facets)
  })
  .refine(
    row =>
      row.original_lane.product === row.scope.lane.product &&
      row.original_lane.route === row.scope.lane.route &&
      row.original_lane.operation === row.scope.lane.operation &&
      row.original_lane.topology === row.scope.lane.topology
  );
export const promotionDescriptorSuccessorSchema = z.strictObject({
  schema_version: z.literal(1),
  kind: z.literal('promotion_descriptor_successor'),
  predecessor_descriptor_digest: shaSchema,
  successor_descriptor_digest: shaSchema,
  predecessor_proposal_id: shaSchema,
  successor_proposal_id: shaSchema,
  coverage_mapping_ids: list(shaSchema)
    .min(1)
    .refine(rows => same(rows, unique(rows))),
  review_reference: shaSchema
});
const preparationSchema = z.strictObject({
  schema_version: z.literal(1),
  kind: z.literal('promotion_preparation'),
  selection_reason: promotionProposalSchema.shape.selection_reason,
  selection_reference: shaSchema,
  scope: promotionScopeSchema,
  requested_grants: promotionGateInputSchema.shape.requested_grants,
  candidate: referenceSchema,
  observation: referenceSchema,
  assessments: referencesSchema.min(1),
  jobs: referencesSchema.min(1),
  judgments: referencesSchema,
  descriptor: referenceSchema,
  registry: referenceSchema,
  ledger: referenceSchema,
  decision_payload: referenceSchema,
  mappings: referencesSchema,
  predecessor_proposals: referencesSchema,
  gate_matrix: promotionGateInputSchema.shape.gate_matrix,
  required_validation: promotionGateInputSchema.shape.required_validation
});
const reconciliationSchema = z.strictObject({
  schema_version: z.literal(1),
  kind: z.literal('promotion_reconciliation'),
  judgments: referencesSchema,
  proposals: referencesSchema,
  decisions: referencesSchema,
  descriptors: referencesSchema,
  mappings: referencesSchema,
  successors: referencesSchema
});
function checkReferenceBudget(packet) {
  const references = Object.values(packet).flatMap(value =>
    Array.isArray(value)
      ? value.filter(row => row && typeof row === 'object' && 'path' in row)
      : value && typeof value === 'object' && 'path' in value
        ? [value]
        : []
  );
  if (references.length > 256) fail('invalid_record');
}
async function readReference(reference, schema, base) {
  const record = await loadRecord(resolve(base, reference.path), schema);
  if (digest(record) !== reference.id) fail('promotion_identity_mismatch');
  return record;
}
async function readReferences(references, schema, base) {
  const records = new Map();
  for (const reference of references) {
    records.set(reference.id, await readReference(reference, schema, base));
  }
  return records;
}
function parseDescriptor(value) {
  try {
    return parseToolVersionPromotionDescriptor(value);
  } catch (error) {
    if (error instanceof ToolVersionPromotionError) {
      return fail('invalid_record');
    }
    throw error;
  }
}
async function currentIdentities(root) {
  const snapshot = await withSourceSnapshot(root, () => null);
  return {
    source_digest: snapshot.source_digest,
    judgment_engine_digest: await judgmentEngineDigest(root),
    promotion_engine_digest: await promotionEngineDigest(root),
    promotion_engine_revision: promotionEngineRevision,
    policy_revision: 'closed-windows-v1',
    map_revision: mapRevision,
    contract_revision: 'consumed-v1',
    implementation_scheme: 'promotion-implementation-v1',
    evidence_revision: 'promotion-evidence-v1'
  };
}
function stale(record, identities) {
  return (
    record.source_digest !== identities.source_digest ||
    record.engine_digest !== identities.judgment_engine_digest ||
    record.engine_revision !== 'difference-engine-v1' ||
    record.map_revision !== identities.map_revision ||
    record.evidence_snapshot.policy_revision !== identities.policy_revision ||
    record.coverage_reasons?.some(reason => reason.startsWith('stale_'))
  );
}
function mappingFor(lane, scope, descriptorDigest, mappings) {
  return [...mappings].filter(
    ([, row]) => laneKey(row.original_lane) === laneKey(lane) && same(row.scope, scope) && row.descriptor_digest === descriptorDigest
  );
}
function validateMappings(mappings) {
  const seen = new Map();
  for (const [id, row] of mappings) {
    const key = canonical([row.original_lane, row.scope, row.descriptor_digest]);
    if (seen.has(key) && seen.get(key) !== id) {
      fail('promotion_mapping_conflict');
    }
    seen.set(key, id);
  }
}
function validatePreparationRecords(packet, candidate, observation, assessments, jobs, judgments, mappings) {
  const candidateId = digest(candidate);
  const observationId = digest(observation);
  if (
    candidate.product !== packet.scope.lane.product ||
    candidate.target !== packet.scope.target.version ||
    candidate.commit !== packet.scope.target.commit ||
    observation.candidate_id !== candidateId ||
    observation.product !== candidate.product ||
    observation.result !== 'metadata_reconciled'
  ) {
    fail('promotion_identity_mismatch');
  }
  const releases = observation.releases.map(({ version, commit }) => ({
    version,
    commit
  }));
  if (!same(releases.at(-1), packet.scope.target)) {
    fail('promotion_identity_mismatch');
  }
  for (const job of jobs.values()) {
    if (
      job.candidate_id !== candidateId ||
      job.observation_id !== observationId ||
      !same(job.target, packet.scope.target) ||
      !same(job.inventory.releases, releases) ||
      job.inventory.inventory_id !== digest(releases)
    ) {
      fail('promotion_identity_mismatch');
    }
    if (laneKey(job.lane) !== laneKey(packet.scope.lane) && mappingFor(job.lane, packet.scope, packet.descriptor.id, mappings).length !== 1) {
      fail('promotion_identity_mismatch');
    }
    if (
      ![...assessments.values()].some(
        assessment =>
          assessment.candidate_id === candidateId &&
          assessment.observation_id === observationId &&
          assessment.baseline_digest === job.baseline_digest &&
          assessment.lanes.some(lane => laneKey(lane) === laneKey(job.lane))
      )
    ) {
      fail('promotion_identity_mismatch');
    }
  }
  for (const judgment of judgments.values()) {
    const job = jobs.get(judgment.job_id);
    const mutable = ['schema_version', 'kind', 'source_digest', 'engine_digest', 'engine_revision', 'map_revision'];
    if (!job || Object.keys(job).some(key => !mutable.includes(key) && !same(job[key], judgment[key]))) {
      fail('promotion_identity_mismatch');
    }
  }
  for (const assessment of assessments.values()) {
    if (
      assessment.candidate_id !== candidateId ||
      assessment.observation_id !== observationId ||
      ![...jobs.values()].some(job => assessment.lanes.some(lane => laneKey(lane) === laneKey(job.lane)))
    ) {
      fail('promotion_identity_mismatch');
    }
  }
}
function prepareContracts(scope, judgments, mappings, descriptorDigest, identities) {
  return consumedContracts.map(contract_id => ({
    contract_id,
    facets: requiredFacets(contract_id, scope.lane).map(facet => {
      const results = [...judgments.values()].flatMap(judgment => {
        const direct = laneKey(judgment.lane) === laneKey(scope.lane);
        const mapped = mappingFor(judgment.lane, scope, descriptorDigest, mappings).some(
          ([, row]) => row.contracts.includes(contract_id) && row.facets.includes(facet)
        );
        if (!direct && !mapped) return [];
        const row = judgment.groups.find(group => group.contract_id === contract_id)?.facets.find(row => row.facet === facet);
        return [stale(judgment, identities) ? 'unknown' : (row?.result ?? 'unknown')];
      });
      return {
        facet,
        result: results.includes('affected') ? 'affected' : !results.length || results.includes('unknown') ? 'unknown' : 'unaffected',
        required_classes: []
      };
    })
  }));
}
function proposalInput(proposal, unresolvedIds = []) {
  return {
    scope: proposal.scope,
    requested_grants: proposal.requested_grants,
    required_validation: proposal.required_validation,
    coverage: proposal.coverage,
    contracts: proposal.contracts,
    gate_matrix: proposal.gate_matrix,
    unresolved_finding_ids: unique(unresolvedIds)
  };
}
function preview(packet, registry, ledger, descriptor, decision) {
  try {
    const descriptors = registry.filter(row => row.kind === 'promoted_descriptor').map(parseDescriptor);
    if (
      !descriptors.some(row => promotionDescriptorDigest(row) === promotionDescriptorDigest(descriptor)) ||
      !same(packet.scope, decision.scope) ||
      !same(packet.requested_grants, decision.requested_grants)
    ) {
      fail('promotion_identity_mismatch');
    }
    const before = projectToolVersionPromotions({
      descriptors,
      ledger,
      registryDigest: promotionRegistryDigest(registry),
      implementationDigest: decision.implementation_digest
    });
    const after = previewToolVersionPromotion(before, descriptor, decision);
    return {
      registry_before_digest: promotionProjectionDigest(before),
      proposed_projection_digest: promotionProjectionDigest(after)
    };
  } catch (error) {
    if (error instanceof ToolVersionPromotionError || error instanceof z.ZodError) return fail('invalid_record');
    throw error;
  }
}
export async function preparePromotion(path, root) {
  const packet = await loadRecord(path, preparationSchema);
  checkReferenceBudget(packet);
  const base = dirname(resolve(path));
  const read = (reference, schema) => readReference(reference, schema, base);
  const assessments = await readReferences(packet.assessments, assessmentSchema, base);
  const jobs = await readReferences(packet.jobs, differenceJobSchema, base);
  const judgments = await readReferences(packet.judgments, differenceJudgmentSchema, base);
  const descriptor = parseDescriptor(await read(packet.descriptor, z.unknown()));
  const registry = await read(packet.registry, z.array(z.record(z.string(), z.unknown())).max(256));
  const ledger = await read(packet.ledger, z.unknown());
  const payloadShape = { ...promotionDecisionSchema.shape };
  delete payloadShape.registry_before_digest;
  delete payloadShape.effective_projection_digest;
  const decision = await read(packet.decision_payload, z.strictObject(payloadShape));
  const mappings = await readReferences(packet.mappings, promotionCoverageMappingSchema, base);
  const previous = await readReferences(packet.predecessor_proposals, promotionProposalSchema, base);
  validateMappings(mappings);
  validatePreparationRecords(
    packet,
    await read(packet.candidate, candidateSchema),
    await read(packet.observation, observationSchema),
    assessments,
    jobs,
    judgments,
    mappings
  );
  const identities = await currentIdentities(root);
  const first = jobs.values().next().value;
  const coverage = requiredDifferenceCoverage(first);
  if (
    [...jobs.values()].some(
      job =>
        !same(requiredDifferenceCoverage(job), coverage) ||
        job.baseline_digest !== first.baseline_digest ||
        !same(job.baseline_row?.ref ?? null, first.baseline_row?.ref ?? null)
    )
  ) {
    fail('promotion_identity_mismatch');
  }
  const reconciliation = retainedReconciliation(packet, previous);
  const draft = {
    schema_version: 1,
    kind: 'promotion_proposal',
    authority: 'none',
    selection_reason: packet.selection_reason,
    selection_reference: packet.selection_reference,
    scope: packet.scope,
    original_lanes: [...new Map([...jobs.values()].map(job => [laneKey(job.lane), job.lane])).values()].sort((a, b) =>
      laneKey(a).localeCompare(laneKey(b), 'en')
    ),
    coverage_mapping_ids: unique([...mappings.keys()]),
    requested_grants: packet.requested_grants,
    candidate_id: packet.candidate.id,
    observation_id: packet.observation.id,
    assessment_ids: unique([...assessments.keys()]),
    job_ids: unique([...jobs.keys()]),
    judgment_ids: unique([...judgments.keys()]),
    descriptor_digest: promotionDescriptorDigest(descriptor),
    variant_digest: digest(descriptor.variants),
    ...preview(packet, registry, ledger, descriptor, decision),
    identities,
    coverage: {
      baseline_status: first.baseline_row ? 'present' : 'missing',
      baseline_digest: first.baseline_digest,
      baseline_ref: first.baseline_row?.ref ?? null,
      parser_base: first.parser_base
        ? {
            version: first.parser_base.version,
            commit: first.parser_base.commit
          }
        : null,
      releases: first.inventory.releases,
      complete:
        [...jobs.values()].every(job => job.inventory.coverage === 'complete') && [...judgments.values()].every(row => row.coverage_reasons.length === 0),
      comparisons: coverage.comparisons
    },
    contracts: prepareContracts(packet.scope, judgments, mappings, packet.descriptor.id, identities),
    gate_matrix: packet.gate_matrix,
    required_validation: packet.required_validation,
    reconciliation
  };
  if (
    [...assessments.values()].some(row => row.source_digest !== identities.source_digest) ||
    [...jobs.values(), ...judgments.values()].some(row => stale(row, identities))
  ) {
    draft.gate_matrix = draft.gate_matrix.map(row => ({
      ...row,
      evidence: row.evidence.map(proof => ({
        ...proof,
        freshness: 'stale'
      }))
    }));
  }
  const result = reducePromotionGates(
    proposalInput(
      draft,
      reconciliation?.unresolved_findings.map(row => row.finding_id)
    )
  );
  return boundedParse(
    {
      ...draft,
      state: result.state,
      reasons: result.reasons
    },
    promotionProposalSchema
  );
}
function retainedReconciliation(packet, previous) {
  if (previous.size === 0) return null;
  const findings = new Map();
  const rows = [...previous.values()];
  for (const proposal of rows) {
    if (!same(proposal.scope, packet.scope) || proposal.descriptor_digest !== packet.descriptor.id || !proposal.reconciliation) {
      fail('promotion_lineage_invalid');
    }
    for (const finding of proposal.reconciliation.unresolved_findings) {
      findings.set(finding.finding_id, finding);
    }
  }
  return {
    ...rows[0].reconciliation,
    predecessor_proposal_ids: unique([...previous.keys()]),
    unresolved_findings: [...findings.values()].sort((a, b) => a.finding_id.localeCompare(b.finding_id, 'en'))
  };
}

export async function reconcilePromotion(path, root) {
  const packet = await loadRecord(path, reconciliationSchema);
  checkReferenceBudget(packet);
  const base = dirname(resolve(path));
  const inventory = {
    judgments: await readReferences(packet.judgments, differenceJudgmentSchema, base),
    proposals: await readReferences(packet.proposals, promotionProposalSchema, base),
    decisions: await readReferences(packet.decisions, promotionDecisionSchema, base),
    descriptors: await readReferences(packet.descriptors, z.unknown(), base),
    mappings: await readReferences(packet.mappings, promotionCoverageMappingSchema, base),
    successors: await readReferences(packet.successors, promotionDescriptorSuccessorSchema, base)
  };
  inventory.descriptors = new Map([...inventory.descriptors].map(([id, value]) => [id, parseDescriptor(value)]));
  validateMappings(inventory.mappings);
  validateLineage(inventory);
  const identities = await currentIdentities(root);
  const used = new Set();
  const proposals = new Map();
  for (const [id, grant] of inventory.decisions) {
    if (grant.decision !== 'approve') continue;
    for (const match of grantLineage(id, grant, inventory)) {
      const successor = reconcileScope(id, grant, match, inventory, identities, used);
      if (successor) proposals.set(digest(successor), successor);
    }
  }
  const inputIds = unique(Object.values(inventory).flatMap(records => [...records.keys()]));
  return {
    proposals: [...proposals].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([, row]) => row),
    input_ids: inputIds,
    unused_ids: inputIds.filter(id => !used.has(id))
  };
}
function requireEntry(records, id) {
  const record = records.get(id);
  if (!record) fail('promotion_lineage_invalid');
  return record;
}
function descriptorMatches(descriptor, proposal) {
  const scope = proposal.scope;
  return (
    descriptor.product === scope.lane.product &&
    descriptor.version === scope.target.version &&
    descriptor.sourceRef === scope.target.commit &&
    descriptor.route === scope.lane.route &&
    descriptor.profileId === scope.lane.profile_id &&
    descriptor.platforms.includes(scope.platform) &&
    descriptor.runtimes.includes(scope.runtime) &&
    descriptor.scopes.some(
      row =>
        row.operation === scope.lane.operation && row.topology === scope.lane.topology && proposal.requested_grants.every(grant => row.grants.includes(grant))
    )
  );
}
function validateLineage(inventory) {
  let edges = 0;
  for (const proposal of inventory.proposals.values()) {
    if (!descriptorMatches(requireEntry(inventory.descriptors, proposal.descriptor_digest), proposal)) fail('promotion_lineage_invalid');
    for (const id of proposal.coverage_mapping_ids) {
      requireEntry(inventory.mappings, id);
    }
    for (const id of proposal.reconciliation?.predecessor_proposal_ids ?? []) {
      requireEntry(inventory.proposals, id);
      edges++;
    }
    for (const id of unique([...(proposal.reconciliation?.originating_grant_ids ?? []), ...(proposal.reconciliation?.current_grant_ids ?? [])])) {
      requireEntry(inventory.decisions, id);
    }
  }
  edges += validateDecisionChains(inventory);
  edges += validateDescriptorSuccessors(inventory);
  if (edges > 256) fail('promotion_lineage_invalid');
  assertAcyclic(inventory.decisions, row => (row.predecessor ? [row.predecessor.id] : []));
  assertAcyclic(inventory.proposals, (proposal, id) => [
    ...(proposal.reconciliation?.predecessor_proposal_ids ?? []),
    ...[...inventory.successors.values()].filter(row => row.successor_proposal_id === id).map(row => row.predecessor_proposal_id)
  ]);
}
function validateDecisionChains(inventory) {
  let edges = 0;
  const tips = new Map();
  const roots = new Set();
  for (const [id, decision] of inventory.decisions) {
    const proposal = requireEntry(inventory.proposals, decision.proposal_id);
    if (
      !same(proposal.scope, decision.scope) ||
      proposal.descriptor_digest !== decision.descriptor_digest ||
      decision.grants.some(grant => !proposal.requested_grants.includes(grant))
    ) {
      fail('promotion_lineage_invalid');
    }
    if (decision.predecessor) {
      const predecessor = requireEntry(inventory.decisions, decision.predecessor.id);
      if (
        predecessor.sequence !== decision.predecessor.sequence ||
        predecessor.decision !== decision.predecessor.decision ||
        decision.sequence !== predecessor.sequence + 1 ||
        !same(predecessor.scope, decision.scope)
      ) {
        fail('promotion_lineage_invalid');
      }
      edges++;
      if (tips.has(decision.predecessor.id)) {
        fail('promotion_lineage_invalid');
      }
      tips.set(decision.predecessor.id, id);
    } else {
      const key = canonical(decision.scope);
      if (roots.has(key)) fail('promotion_lineage_invalid');
      roots.add(key);
    }
  }
  return edges;
}
function validateDescriptorSuccessors(inventory) {
  let edges = 0;
  for (const row of inventory.successors.values()) {
    const previous = requireEntry(inventory.proposals, row.predecessor_proposal_id);
    const next = requireEntry(inventory.proposals, row.successor_proposal_id);
    if (
      previous.descriptor_digest !== row.predecessor_descriptor_digest ||
      next.descriptor_digest !== row.successor_descriptor_digest ||
      !same(previous.scope.target, next.scope.target) ||
      previous.scope.lane.product !== next.scope.lane.product ||
      previous.scope.lane.route !== next.scope.lane.route ||
      previous.scope.lane.operation !== next.scope.lane.operation ||
      previous.scope.lane.topology !== next.scope.lane.topology ||
      previous.scope.platform !== next.scope.platform ||
      previous.scope.runtime !== next.scope.runtime
    ) {
      fail('promotion_lineage_invalid');
    }
    for (const id of row.coverage_mapping_ids) {
      const mapping = requireEntry(inventory.mappings, id);
      if (!next.coverage_mapping_ids.includes(id) || !same(mapping.scope, next.scope) || mapping.descriptor_digest !== next.descriptor_digest) {
        fail('promotion_lineage_invalid');
      }
    }
    edges++;
  }
  return edges;
}
function assertAcyclic(records, predecessors) {
  const active = new Set();
  const done = new Set();
  const visit = id => {
    if (active.has(id)) fail('promotion_lineage_invalid');
    if (done.has(id)) return;
    active.add(id);
    for (const predecessor of predecessors(requireEntry(records, id), id)) {
      visit(predecessor);
    }
    active.delete(id);
    done.add(id);
  };
  for (const id of records.keys()) visit(id);
}
function grantLineage(id, grant, inventory) {
  const origin = requireEntry(inventory.proposals, grant.proposal_id);
  const result = [
    {
      id: grant.proposal_id,
      proposal: origin,
      lineage: [origin.descriptor_digest],
      successorIds: [],
      proposalIds: [grant.proposal_id]
    }
  ];
  for (let index = 0; index < result.length; index++) {
    const parent = result[index];
    for (const [successorId, row] of inventory.successors) {
      if (row.predecessor_proposal_id !== parent.id) continue;
      if (result.some(item => item.id === row.successor_proposal_id)) {
        continue;
      }
      result.push({
        id: row.successor_proposal_id,
        proposal: requireEntry(inventory.proposals, row.successor_proposal_id),
        lineage: unique([...parent.lineage, row.successor_descriptor_digest, successorId]),
        successorIds: [...parent.successorIds, successorId],
        proposalIds: unique([...parent.proposalIds, row.successor_proposal_id])
      });
    }
    for (const [proposalId, proposal] of inventory.proposals) {
      if (!proposal.reconciliation?.predecessor_proposal_ids.includes(parent.id) || !proposal.reconciliation.originating_grant_ids.includes(id)) continue;
      if (!same(proposal.scope, parent.proposal.scope) || proposal.descriptor_digest !== parent.proposal.descriptor_digest) {
        fail('promotion_lineage_invalid');
      }
      if (!result.some(row => row.id === proposalId)) {
        result.push({
          ...parent,
          id: proposalId,
          proposal,
          proposalIds: unique([...parent.proposalIds, proposalId])
        });
      }
    }
  }
  const parents = new Set(
    result.flatMap(item => [
      ...(item.proposal.reconciliation?.predecessor_proposal_ids ?? []),
      ...[...inventory.successors.values()].filter(row => row.successor_proposal_id === item.id).map(row => row.predecessor_proposal_id)
    ])
  );
  return result
    .filter(item => !parents.has(item.id))
    .map(item => {
      const proposalIds = new Set();
      const visit = id => {
        if (proposalIds.has(id)) return;
        proposalIds.add(id);
        const proposal = requireEntry(inventory.proposals, id);
        for (const predecessor of proposal.reconciliation?.predecessor_proposal_ids ?? []) visit(predecessor);
        for (const row of inventory.successors.values()) {
          if (row.successor_proposal_id === id) {
            visit(row.predecessor_proposal_id);
          }
        }
      };
      visit(item.id);
      const successorIds = [...inventory.successors]
        .filter(([, row]) => proposalIds.has(row.predecessor_proposal_id) && proposalIds.has(row.successor_proposal_id))
        .map(([id]) => id);
      return {
        ...item,
        proposalIds: unique([...proposalIds]),
        successorIds,
        lineage: unique([...proposalIds].map(id => requireEntry(inventory.proposals, id).descriptor_digest).concat(successorIds))
      };
    });
}
function currentGrantIds(originId, inventory) {
  const result = [];
  let current = originId;
  for (;;) {
    result.push(current);
    const next = [...inventory.decisions].find(([, row]) => row.predecessor?.id === current);
    if (!next) return result;
    current = next[0];
  }
}
function reconcileScope(grantId, grant, match, inventory, identities, used) {
  const proposal = match.proposal;
  const findings = new Map();
  for (const proposalId of match.proposalIds) {
    const row = requireEntry(inventory.proposals, proposalId);
    if (row.reconciliation?.originating_grant_ids.includes(grantId)) {
      for (const finding of row.reconciliation.unresolved_findings) {
        findings.set(finding.finding_id, finding);
      }
    }
  }
  const triggers = [];
  const mappingsUsed = [];
  const contracts = [];
  const matchedFacets = [];
  for (const [judgmentId, judgment] of inventory.judgments) {
    if (!same(judgment.target, proposal.scope.target)) continue;
    const mappings = mappingFor(judgment.lane, proposal.scope, proposal.descriptor_digest, inventory.mappings).filter(([id]) =>
      proposal.coverage_mapping_ids.includes(id)
    );
    if (!mappings.length) continue;
    triggers.push(judgmentId);
    for (const [mappingId, mapping] of mappings) {
      mappingsUsed.push(mappingId);
      for (const group of judgment.groups.filter(row => mapping.contracts.includes(row.contract_id))) {
        for (const facet of group.facets.filter(row => mapping.facets.includes(row.facet))) {
          contracts.push(group.contract_id);
          matchedFacets.push(facet.facet);
          const reason = stale(judgment, identities)
            ? 'stale_evidence'
            : facet.result === 'affected'
              ? 'affected_contract'
              : facet.result === 'unknown'
                ? 'unknown_contract'
                : null;
          if (!reason) continue;
          const finding = {
            judgment_id: judgmentId,
            proposal_id: match.id,
            reason
          };
          const findingId = digest({
            ...finding,
            contract_id: group.contract_id,
            facet: facet.facet,
            scope: proposal.scope
          });
          findings.set(findingId, {
            finding_id: findingId,
            ...finding
          });
        }
      }
    }
  }
  if (!triggers.length || !findings.size || !contracts.length || !matchedFacets.length) return null;
  const grantIds = currentGrantIds(grantId, inventory);
  const reconciliation = {
    predecessor_proposal_ids: [match.id],
    originating_grant_ids: [grantId],
    current_grant_ids: [grantIds.at(-1)],
    coverage_mapping_ids: unique(mappingsUsed),
    descriptor_lineage_ids: unique(match.lineage),
    matched_scope: proposal.scope,
    matched_contracts: unique(contracts),
    matched_facets: unique(matchedFacets),
    triggering_judgment_ids: unique(triggers),
    unresolved_findings: [...findings.values()].sort((a, b) => a.finding_id.localeCompare(b.finding_id, 'en'))
  };
  const result = reducePromotionGates(proposalInput(proposal, [...findings.keys()]));
  const successor = boundedParse(
    {
      ...proposal,
      state: result.state,
      reasons: unique([...result.reasons, 'review_required']),
      judgment_ids: unique([...proposal.judgment_ids, ...triggers]),
      reconciliation
    },
    promotionProposalSchema
  );
  for (const id of [match.id, ...match.proposalIds, grant.proposal_id, ...grantIds, ...triggers, ...mappingsUsed, ...match.lineage, ...match.successorIds]) {
    used.add(id);
  }
  return successor;
}
export async function runPromotionCommand(name, flags, root) {
  if (name === 'prepare-promotion') {
    const proposal = await preparePromotion(flags.input, root);
    return {
      exitCode: 0,
      output: {
        status: 'promotion_prepared',
        proposal_id: await publishRecord(flags.out, proposal, promotionProposalSchema)
      }
    };
  }
  const result = await reconcilePromotion(flags.input, root);
  const ids = [];
  for (const proposal of result.proposals) {
    ids.push(await publishRecord(flags.out, proposal, promotionProposalSchema));
  }
  return {
    exitCode: 0,
    output: {
      status: 'promotion_reconciled',
      proposal_ids: unique(ids),
      input_ids: result.input_ids,
      unused_ids: result.unused_ids
    }
  };
}
