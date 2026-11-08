import { afterEach, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  parsePromotionDecision,
  parsePromotionProposal,
  parsePromotionValidation,
  promotionDecisionSchema,
  promotionEngineDigest,
  promotionEngineFiles,
  promotionEvidenceClasses,
  promotionProposalSchema,
  promotionValidationSchema
} from '../scripts/tool-update/promotion-records.mjs';
import { consumedContracts, requiredFacets } from '../scripts/tool-update/difference-contracts.mjs';
import { requiredDifferenceCoverage } from '../scripts/tool-update/difference-records.mjs';
import { canonical, digest, loadRecord, maxRecordBytes, publishRecord } from '../scripts/tool-update/manifest.mjs';
import { differenceJob } from './helpers/tool-update-difference-fixture.js';

const id = '1'.repeat(64);
const roots: string[] = [];
async function temporaryRoot() {
  const root = await mkdtemp(join(realpathSync(tmpdir()), 'promotion-records-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
function proposal() {
  const job = differenceJob();
  return {
    schema_version: 1,
    kind: 'promotion_proposal',
    authority: 'none',
    state: 'blocked',
    selection_reason: 'release_candidate',
    selection_reference: id,
    scope: {
      target: job.target,
      lane: job.lane,
      platform: 'darwin_arm64',
      runtime: 'node24'
    },
    original_lanes: [job.lane],
    coverage_mapping_ids: [],
    requested_grants: ['admission'],
    candidate_id: job.candidate_id,
    observation_id: job.observation_id,
    assessment_ids: [id],
    job_ids: [id],
    judgment_ids: [id],
    descriptor_digest: id,
    variant_digest: null,
    registry_before_digest: id,
    proposed_projection_digest: id,
    identities: {
      source_digest: id,
      judgment_engine_digest: id,
      promotion_engine_digest: id,
      promotion_engine_revision: 'promotion-engine-v1',
      policy_revision: 'closed-windows-v1',
      map_revision: 'difference-map-v2',
      contract_revision: 'consumed-v1',
      implementation_scheme: 'promotion-implementation-v1',
      evidence_revision: 'promotion-evidence-v1'
    },
    coverage: {
      baseline_status: 'present',
      baseline_digest: job.baseline_digest,
      baseline_ref: job.baseline_row?.ref,
      parser_base: { version: '0.163.0', commit: '1'.repeat(40) },
      releases: job.inventory.releases,
      complete: true,
      comparisons: requiredDifferenceCoverage(job).comparisons
    },
    contracts: consumedContracts.map(contract_id => ({
      contract_id,
      facets: requiredFacets(contract_id, job.lane).map(facet => ({
        facet,
        result: 'unknown',
        required_classes: []
      }))
    })),
    gate_matrix: Array.from({ length: 12 }, (_, index) => ({
      gate_id: `G${String(index + 1).padStart(2, '0')}`,
      required_classes: [],
      evidence: []
    })),
    required_validation: ['actual_target_binary_conformance'],
    reasons: ['evidence_missing'],
    reconciliation: null
  };
}
function validation() {
  const pins = Object.fromEntries(['image', 'component', 'build', 'instrument', 'implementation', 'runtime', 'model'].map(key => [key, null]));
  return {
    schema_version: 1,
    kind: 'promotion_validation',
    authority: 'none',
    proposal_id: id,
    scope: proposal().scope,
    descriptor_digest: id,
    evidence_revision: 'promotion-evidence-v1',
    evidence_class: 'synthetic',
    evidence_origin: 'synthetic',
    result: 'pass',
    accepted_result_ids: [id],
    pins,
    implementation_scheme: 'promotion-implementation-v1',
    scenario: 'normal',
    outcomes: [{ metric: 'event_count', status: 'observed', value: 0 }],
    limitations: ['synthetic_only'],
    reviewer_reference: null,
    unresolved_requirements: []
  };
}
function decision() {
  return {
    schema_version: 1,
    kind: 'promotion_decision',
    authority: 'none',
    proposal_id: id,
    scope: proposal().scope,
    proposed_scope: proposal().scope,
    requested_grants: ['admission', 'qualification'],
    grants: ['admission'],
    accepted_validation_ids: [id],
    descriptor_digest: id,
    implementation_digest: id,
    implementation_scheme: 'promotion-implementation-v1',
    registry_before_digest: id,
    effective_projection_digest: id,
    predecessor: null,
    sequence: 1,
    decision: 'approve',
    reason: 'scoped_approval',
    prior_deny_ids: [],
    independent_review_ids: [id],
    authorization_reference_ids: [id]
  };
}
const records = () => [
  {
    record: proposal(),
    parse: parsePromotionProposal,
    schema: promotionProposalSchema,
    folder: 'promotion-proposals'
  },
  {
    record: validation(),
    parse: parsePromotionValidation,
    schema: promotionValidationSchema,
    folder: 'promotion-validations'
  },
  {
    record: decision(),
    parse: parsePromotionDecision,
    schema: promotionDecisionSchema,
    folder: 'promotion-decisions'
  }
];
function injectObjects(value: unknown, key: string): unknown[] {
  if (Array.isArray(value))
    return value.flatMap((child: unknown, index) =>
      injectObjects(child, key).map(replacement => value.map((item: unknown, i) => (i === index ? replacement : item)))
    );
  if (value === null || typeof value !== 'object') return [];
  return [
    { ...value, [key]: 'synthetic-private' },
    ...Object.entries(value).flatMap(([field, child]) => injectObjects(child, key).map(replacement => ({ ...value, [field]: replacement })))
  ];
}
test('all three revision-1 kinds replay canonical bytes and publish idempotently without replacing conflicts', async () => {
  const root = await temporaryRoot();
  for (const { record, parse, schema, folder } of records()) {
    const parsed = parse(record);
    const bytes = canonical(record);
    const expectedId = createHash('sha256').update(bytes).digest('hex');
    expect(parse(bytes)).toEqual(parsed);
    expect(await publishRecord(root, parsed, schema)).toBe(expectedId);
    const path = join(root, folder, `${expectedId}.json`);
    expect(await readFile(path, 'utf8')).toBe(bytes);
    expect(await publishRecord(root, parsed, schema)).toBe(expectedId);
    expect(await loadRecord<unknown>(path, schema)).toEqual(parsed);
    await writeFile(path, 'synthetic-conflict');
    await expect(publishRecord(root, parsed, schema)).rejects.toMatchObject({ code: 'record_conflict' });
    expect(await readFile(path, 'utf8')).toBe('synthetic-conflict');
    expect(await readdir(join(root, folder))).toEqual([`${expectedId}.json`]);
  }
});
test.each(['prompt', 'response', 'source_text', 'url', 'local_path', 'command', 'user_name', 'approved'])(
  'recursive boundaries reject private or authority field %s',
  key => {
    for (const { record, parse } of records()) {
      for (const input of injectObjects(record, key)) expect(() => parse(input)).toThrow('invalid_record');
    }
  }
);
test('revision, byte, reference, enum and canonical-input boundaries fail closed', () => {
  for (const { record, parse } of records()) {
    expect(() => parse({ ...record, schema_version: 2 })).toThrow('invalid_record');
    expect(() => parse({ ...record, payload: 'x'.repeat(maxRecordBytes) })).toThrow('record_too_large');
    expect(() => parse(JSON.stringify(record))).toThrow('non_canonical_record');
    expect(() =>
      parse({
        ...record,
        scope: { ...record.scope, platform: '/synthetic/path' }
      })
    ).toThrow('invalid_record');
  }
  for (const assessment_ids of [[id, id], ['2'.repeat(64), id], Array.from({ length: 257 }, (_, n) => n.toString(16).padStart(64, '0'))]) {
    expect(() => parsePromotionProposal({ ...proposal(), assessment_ids })).toThrow('invalid_record');
  }
});
test('synthetic results cannot be relabeled as native and numeric unknown is not observed zero', () => {
  const record = validation();
  expect(() => parsePromotionValidation({ ...record, evidence_class: 'native_trial' })).toThrow('invalid_record');
  expect(() =>
    parsePromotionValidation({
      ...record,
      outcomes: [{ metric: 'event_count', status: 'missing', value: 0 }]
    })
  ).toThrow('invalid_record');
  expect(
    parsePromotionValidation({
      ...record,
      outcomes: [
        {
          metric: 'event_count',
          status: 'missing',
          value: null
        }
      ]
    }).outcomes[0]?.value
  ).toBeNull();
});
test('actual-class records require complete execution pins, result identities and reviewer references', () => {
  const record = {
    ...validation(),
    evidence_class: 'native_trial',
    evidence_origin: 'actual',
    limitations: [],
    pins: { image: id, component: id, build: id, instrument: id, implementation: id, runtime: id, model: id },
    reviewer_reference: id
  };
  expect(parsePromotionValidation(record).evidence_class).toBe('native_trial');
  for (const key of Object.keys(record.pins))
    expect(() => parsePromotionValidation({ ...record, pins: { ...record.pins, [key]: null } })).toThrow('invalid_record');
  expect(() => parsePromotionValidation({ ...record, reviewer_reference: null })).toThrow('invalid_record');
  expect(() => parsePromotionValidation({ ...record, accepted_result_ids: [] })).toThrow('invalid_record');
});
test.each(['actual_target_binary_conformance', 'native_trial', 'real_session'] as const)(
  'passing %s validation rejects a synthetic-only limitation',
  evidence_class => {
    const record = {
      ...validation(),
      evidence_class,
      evidence_origin: 'actual',
      limitations: ['synthetic_only'],
      pins: { image: id, component: id, build: id, instrument: id, implementation: id, runtime: id, model: id },
      reviewer_reference: id
    };
    expect(() => parsePromotionValidation(record)).toThrow('invalid_record');
    expect(parsePromotionValidation({ ...record, limitations: [] }).result).toBe('pass');
  }
);
test.each([
  ['demote', 'qualification_withdrawn'],
  ['retire', 'maintenance_ended'],
  ['revoke', 'authority_withdrawn'],
  ['invalidate', 'confirmed_incompatibility'],
  ['delete', 'authority_deleted']
])('negative %s decisions append an explicit predecessor rather than mutating a grant', (action, reason) => {
  const record = { ...decision(), decision: action, reason, predecessor: { id, sequence: 1, decision: 'approve' }, sequence: 2 };
  expect(parsePromotionDecision(record).sequence).toBe(2);
  expect(() => parsePromotionDecision({ ...record, predecessor: null })).toThrow('invalid_record');
});
test('a different original lane requires an explicit reviewed coverage mapping', () => {
  const record = proposal();
  const original_lanes = [{ ...record.scope.lane, operation: 'restart' }];
  expect(() => parsePromotionProposal({ ...record, original_lanes })).toThrow('invalid_record');
  expect(parsePromotionProposal({ ...record, original_lanes, coverage_mapping_ids: [id] }).original_lanes).toEqual(original_lanes);
});
test('portable proposals cannot claim a state that bypasses the pure gate reduction', () => {
  const record = proposal();
  for (const state of ['ready_for_decision', 'pending_pre_release']) expect(() => parsePromotionProposal({ ...record, state })).toThrow('invalid_record');
  const gate_matrix = record.gate_matrix.map(row => ({
    ...row,
    evidence: promotionEvidenceClasses
      .map(evidence_class => ({
        evidence_id: digest({ gate_id: row.gate_id, evidence_class }),
        evidence_class,
        scope_digest: digest(record.scope),
        result: 'pass',
        freshness: 'current',
        contract_id: null,
        facet: null
      }))
      .sort((a, b) => a.evidence_id.localeCompare(b.evidence_id, 'en'))
  }));
  const contracts = record.contracts.map(group => ({ ...group, facets: group.facets.map(row => ({ ...row, result: 'unaffected' })) }));
  expect(parsePromotionProposal({ ...record, gate_matrix, contracts, state: 'ready_for_decision' }).state).toBe('ready_for_decision');
});
test.each(['proposal', 'unused_gate'] as const)('required validation on %s constrains proposal readiness even outside requested grants', source => {
  const record = proposal();
  const gate_matrix = record.gate_matrix.map(row => ({
    ...row,
    required_classes: source === 'unused_gate' && row.gate_id === 'G08' ? ['native_trial'] : [],
    evidence: promotionEvidenceClasses
      .filter(evidence_class => evidence_class !== 'native_trial')
      .map(evidence_class => ({
        evidence_id: digest({ gate_id: row.gate_id, evidence_class }),
        evidence_class,
        scope_digest: digest(record.scope),
        result: 'pass',
        freshness: 'current',
        contract_id: null,
        facet: null
      }))
      .sort((a, b) => a.evidence_id.localeCompare(b.evidence_id, 'en'))
  }));
  const contracts = record.contracts.map(group => ({ ...group, facets: group.facets.map(row => ({ ...row, result: 'unaffected' })) }));
  const required_validation = source === 'proposal' ? ['native_trial'] : [];
  const packet = { ...record, contracts, gate_matrix, required_validation, state: 'ready_for_decision' };
  expect(() => parsePromotionProposal(packet)).toThrow('invalid_record');
  expect(parsePromotionProposal({ ...packet, state: 'pending_pre_release' }).state).toBe('pending_pre_release');
  const cleared = gate_matrix.map(row => ({ ...row, required_classes: [] }));
  expect(parsePromotionProposal({ ...packet, gate_matrix: cleared, required_validation: [] }).state).toBe('ready_for_decision');
});
test('decisions cannot expand a grant, retarget a proposal, clear a deny or follow terminal deletion', () => {
  const record = decision();
  for (const change of [
    { grants: ['admission', 'children'] },
    {
      scope: {
        ...record.scope,
        lane: { ...record.scope.lane, operation: 'resume' }
      }
    },
    { prior_deny_ids: [id] },
    {
      predecessor: { id, sequence: 1, decision: 'revoke' },
      sequence: 2
    },
    {
      predecessor: { id, sequence: 1, decision: 'delete' },
      sequence: 2
    },
    { sequence: 2 }
  ]) {
    expect(() => parsePromotionDecision({ ...record, ...change })).toThrow('invalid_record');
  }
});
test('review-needed successors require predecessor, grant, mapping, descriptor and unresolved provenance', () => {
  const record = proposal();
  const reconciliation = {
    predecessor_proposal_ids: [id],
    originating_grant_ids: [id],
    current_grant_ids: [id],
    coverage_mapping_ids: [id],
    descriptor_lineage_ids: [id],
    matched_scope: record.scope,
    matched_contracts: ['fields_types_enums'],
    matched_facets: ['serialized_shape'],
    triggering_judgment_ids: [id],
    unresolved_findings: [
      {
        finding_id: id,
        judgment_id: id,
        proposal_id: id,
        reason: 'affected_contract'
      }
    ]
  };
  expect(
    parsePromotionProposal({
      ...record,
      state: 'review_needed',
      reconciliation
    }).state
  ).toBe('review_needed');
  expect(() => parsePromotionProposal({ ...record, state: 'review_needed' })).toThrow('invalid_record');
  for (const key of Object.keys(reconciliation)) {
    expect(() =>
      parsePromotionProposal({
        ...record,
        state: 'review_needed',
        reconciliation: { ...reconciliation, [key]: undefined }
      })
    ).toThrow('invalid_record');
  }
});
test('promotion engine identity covers every explicit dependency but ignores unrelated neighbours', async () => {
  const root = await temporaryRoot();
  for (const path of promotionEngineFiles) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), 'synthetic-engine-input');
  }
  const before = await promotionEngineDigest(root);
  for (const path of promotionEngineFiles) {
    await writeFile(join(root, path), 'synthetic-changed-input');
    expect(await promotionEngineDigest(root), path).not.toBe(before);
    await writeFile(join(root, path), 'synthetic-engine-input');
  }
  await writeFile(join(root, 'unrelated'), 'synthetic-neighbour');
  expect(await promotionEngineDigest(root)).toBe(before);
  expect(before).not.toBe(digest({}));
});
