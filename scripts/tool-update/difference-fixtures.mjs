import { z } from 'zod';
import { boundedParse, canonical, digest, fail, shaSchema } from './manifest.mjs';
import { consumedContracts, methods, requiredFacets } from './difference-contracts.mjs';
import { differenceJobId, parseDifferenceEvidence, parseDifferenceJob, requiredDifferenceCoverage } from './difference-records.mjs';

const number = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const counters = z.strictObject({
  input: number.nullable(),
  output: number.nullable(),
  cached: number.nullable(),
  cache_write: number.nullable(),
  reasoning: number.nullable()
});
const request = z.strictObject({
  request: number.min(1).max(256),
  message: number.min(1).max(256),
  owner: z.enum(['root', 'child_1', 'child_2']),
  terminal: z.boolean(),
  excluded: z.boolean(),
  counters
});
const runSchema = z.strictObject({
  fixture_id: z.enum(['parser_provider_v1', 'field_shapes_v1', 'counter_ledger_v1', 'lifecycle_v1']),
  scenario_id: z.enum(['unchanged', 'shape_change', 'counter_change', 'replay_conflict', 'missing_usage', 'interrupted']),
  test_hash: shaSchema,
  harness_hash: shaSchema,
  input_hash: shaSchema,
  expected: z
    .array(request)
    .min(1)
    .max(256)
    .refine(rows => new Set(rows.map(row => row.request)).size === rows.length),
  actual: z.array(request).max(1024)
});
function summarize(rows) {
  const requests = new Map();
  let conflict = false;
  for (const row of rows) {
    const old = requests.get(row.request);
    if (old && (old.owner !== row.owner || old.message !== row.message || old.excluded !== row.excluded)) {
      conflict = true;
      continue;
    }
    if (old?.terminal) {
      if (row.terminal && canonical(old.counters) !== canonical(row.counters)) conflict = true;
      continue;
    }
    requests.set(row.request, row);
  }
  const retained = [...requests.values()].filter(row => row.terminal && !row.excluded);
  const totals = Object.fromEntries(
    Object.keys(counters.shape).map(key => {
      const values = retained.map(row => row.counters[key]);
      const sum = values.includes(null) ? null : values.reduce((total, value) => total + value, 0);
      if (sum !== null && !Number.isSafeInteger(sum)) {
        fail('fixture_counter_invalid');
      }
      return [key, sum];
    })
  );
  return {
    requests: [...requests.values()].sort((a, b) => a.request - b.request),
    terminal: [...requests.values()].filter(row => row.terminal).length,
    retained: retained.length,
    owners: ['root', 'child_1', 'child_2'].map(owner => retained.filter(row => row.owner === owner).length),
    missing: [...requests.values()].filter(row => !row.terminal).length,
    totals,
    conflict
  };
}
export function projectSyntheticReplay(jobInput, runInput) {
  const job = parseDifferenceJob(jobInput);
  const run = boundedParse(runInput, runSchema);
  const expected = summarize(run.expected);
  const actual = summarize(run.actual);
  const matched = !actual.conflict && canonical(expected) === canonical(actual);
  const reason = matched ? 'synthetic_only' : 'conflicting_evidence';
  const findings = consumedContracts.flatMap(contractId =>
    requiredFacets(contractId, job.lane)
      .filter(facet => methods.synthetic_parser_provider_replay.facets.includes(facet))
      .map(facet => {
        const counter = contractId === 'counters_cache_reasoning_reset_overflow';
        const finality = contractId === 'finality_replay_conflict_stop_flush_sigint';
        const fact = value => ({ kind: 'number', value });
        return {
          contract_id: contractId,
          facet,
          result: 'unknown',
          reason,
          impact: 'undetermined',
          field_id: counter ? 'input_tokens' : finality ? 'terminal_id' : null,
          expected: counter ? fact(expected.totals.input) : finality ? fact(expected.terminal) : null,
          actual: counter ? fact(actual.totals.input) : finality ? fact(actual.terminal) : null
        };
      })
  );
  const evidence = requiredDifferenceCoverage(job).comparisons.map(comparison =>
    parseDifferenceEvidence({
      schema_version: 1,
      kind: 'difference_evidence',
      job_id: differenceJobId(job),
      source_digest: job.source_digest,
      engine_digest: job.engine_digest,
      map_revision: job.map_revision,
      engine_revision: job.engine_revision,
      contract_revision: job.contract_revision,
      policy_revision: job.evidence_snapshot.policy_revision,
      method: 'synthetic_parser_provider_replay',
      capability_revision: 'difference-capability-v1',
      comparison,
      material: {
        kind: 'synthetic',
        fixture_id: run.fixture_id,
        scenario_id: run.scenario_id,
        fixture_digest: digest({
          input_hash: run.input_hash,
          expected: run.expected,
          actual: run.actual
        }),
        harness_digest: digest({
          test_hash: run.test_hash,
          harness_hash: run.harness_hash
        })
      },
      from_content_hash: digest(expected),
      to_content_hash: digest(actual),
      availability: 'available',
      extraction_completeness: 'complete',
      findings,
      reasons: ['synthetic_only']
    })
  );
  return { matched, expected, actual, evidence };
}
