import { Command } from 'commander';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { baselineSchema, digest, fail, loadRecord, parseBaseline, publishRecord, ToolUpdateError } from './tool-update/manifest.mjs';
import { candidateSchema, discover, observationSchema } from './tool-update/discovery.mjs';
import { assessCandidate, assessmentSchema, contractReviewSchema, validateBaselineForSource } from './tool-update/assessment.mjs';
import { laneKey } from './tool-update/lanes.mjs';
import { withSourceSnapshot } from './tool-update/source-snapshot.mjs';
import { differenceEvidenceSchema, differenceJobSchema, differenceJudgmentSchema, parseDifferenceJob } from './tool-update/difference-records.mjs';
import { judgeDifferences, judgmentEngineDigest } from './tool-update/difference-judgment.mjs';
import { contractRevision, engineRevision, mapRevision } from './tool-update/difference-contracts.mjs';
import { collectClaudeDocumentationEvidence, collectCodexSourceEvidence } from './tool-update/difference-source.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const errorCodes = new Set([
  'invalid_arguments',
  'invalid_record',
  'invalid_baseline',
  'baseline_ahead',
  'record_too_large',
  'record_conflict',
  'record_read_failed',
  'record_write_failed',
  'unsafe_output',
  'source_snapshot_unavailable',
  'source_scope_changed',
  'source_drift',
  'observation_mismatch',
  'discovery_incomplete',
  'metadata_conflict',
  'release_mismatch',
  'invalid_review',
  'review_conflict',
  'review_commit_conflict',
  'difference_job_mismatch',
  'difference_identity_mismatch',
  'difference_judgment_conflict',
  'promotion_identity_mismatch',
  'promotion_mapping_conflict',
  'promotion_lineage_invalid'
]);
const repeated = (value, previous) => [...previous, value];
async function createDifferenceJob(flags, baseline, sourceRoot) {
  const candidate = await loadRecord(flags.manifest, candidateSchema);
  const observation = await loadRecord(flags.observation, observationSchema);
  const assessment = await assessCandidate({
    candidate,
    observation,
    baseline,
    root: sourceRoot
  });
  const lane = {
    product: candidate.product,
    route: flags.route,
    profile_id: flags.profile,
    operation: flags.operation,
    topology: flags.topology
  };
  const projection = assessment.lanes.find(row => laneKey(row) === laneKey(lane));
  if (!projection) fail('difference_identity_mismatch');
  const ref = row => ({ version: row.version, commit: row.commit });
  const releases = observation.releases.map(ref);
  const baselineRow = baseline?.rows.find(row => laneKey(row) === laneKey(lane));
  const baselineRef = baselineRow && releases.find(row => row.version === baselineRow.last_reviewed_version);
  const parserRef = releases.find(row => row.version === projection.parser_base);
  const parserBase = parserRef && { ...parserRef, profile_id: lane.profile_id };
  const selectedBaseline = baselineRow && {
    ...lane,
    ref: baselineRef,
    source_digest: baselineRow.source_digest,
    evidence_ids: baselineRow.evidence_ids
  };
  const target = { version: candidate.target, commit: candidate.commit };
  const absentPin = { applicability: 'not_applicable', digest: null };
  const from = selectedBaseline?.ref ?? parserRef;
  const job = parseDifferenceJob({
    schema_version: 1,
    kind: 'difference_job',
    source_digest: assessment.source_digest,
    engine_digest: await judgmentEngineDigest(sourceRoot),
    engine_revision: engineRevision,
    contract_revision: contractRevision,
    map_revision: mapRevision,
    candidate_id: digest(candidate),
    observation_candidate_id: observation.candidate_id,
    observation_id: digest(observation),
    repository_id: candidate.product === 'codex' ? 'openai_codex' : 'anthropics_claude_code',
    lane,
    baseline_digest: selectedBaseline ? digest(baseline) : null,
    baseline_row: selectedBaseline ?? null,
    parser_base: parserBase ?? null,
    target,
    comparison: from
      ? {
          comparison_kind: selectedBaseline ? 'adjacent_release' : 'parser_base',
          from,
          to: target
        }
      : null,
    inventory: {
      inventory_id: digest(releases),
      scope: 'latest_and_npm_review_range',
      coverage: parserBase ? 'complete' : 'incomplete',
      releases
    },
    evidence_snapshot: {
      policy_revision: 'closed-windows-v1',
      windows: 'closed',
      actual_evidence: 'deferred_pre_release',
      evidence_mode: 'static',
      version_basis: 'pinned_release',
      lifecycle_policy: 'static',
      writer_ownership: 'unverified',
      root_ownership: 'unverified',
      native_image: 'not_required',
      publisher_proof: 'not_required',
      process_proof: 'not_required',
      mapped_image_proof: 'not_required'
    },
    pins: { build: absentPin, native_pin: absentPin, artifact: absentPin },
    reasons: [...(!selectedBaseline ? ['baseline_missing'] : []), ...(!parserBase ? ['parser_base_missing', 'release_coverage_incomplete'] : [])].sort()
  });
  return {
    exitCode: 0,
    output: {
      status: 'difference_job_created',
      job_id: await publishRecord(flags.out, job, differenceJobSchema)
    }
  };
}
async function runDifferenceCommand(name, flags, sourceRoot, options) {
  const job = await loadRecord(flags.job, differenceJobSchema);
  if (name === 'collect-difference-evidence') {
    const collect = job.lane.product === 'codex' ? collectCodexSourceEvidence : collectClaudeDocumentationEvidence;
    const result = await collect(job, {
      fetch: options.fetchImpl ?? globalThis.fetch
    });
    const ids = [];
    for (const evidence of result.evidence) {
      ids.push(await publishRecord(flags.out, evidence, differenceEvidenceSchema));
    }
    return {
      exitCode: result.failure ? 2 : 0,
      output: {
        status: 'difference_evidence_created',
        evidence_ids: [...new Set(ids)].sort(),
        failure: result.failure
      }
    };
  }
  const evidence = [];
  for (const path of [...flags.evidence].sort()) {
    evidence.push(await loadRecord(path, differenceEvidenceSchema));
  }
  const snapshot = await withSourceSnapshot(sourceRoot, () => null);
  const judgment = judgeDifferences(job, evidence, {
    source_digest: snapshot.source_digest,
    engine_digest: await judgmentEngineDigest(sourceRoot),
    map_revision: mapRevision
  });
  return {
    exitCode: 0,
    output: {
      status: 'difference_judgment_created',
      judgment_id: await publishRecord(flags.out, judgment, differenceJudgmentSchema)
    }
  };
}
async function loadReview(path) {
  try {
    return await loadRecord(path, contractReviewSchema);
  } catch (error) {
    if (error instanceof ToolUpdateError && error.code === 'invalid_record') throw new ToolUpdateError('invalid_review');
    throw error;
  }
}
export async function runToolUpdate(argv, options = {}) {
  const command = new Command()
    .name('tool-update')
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} });
  command.command('discover').requiredOption('--product <product>').requiredOption('--out <directory>').option('--baseline <file>');
  command
    .command('assess')
    .requiredOption('--manifest <file>')
    .requiredOption('--observation <file>')
    .option('--baseline <file>')
    .option('--out <directory>')
    .option('--review <file>', 'contract review record', repeated, [])
    .option('--judgment <file>', 'machine judgment record', repeated, []);
  command.command('record-review').requiredOption('--input <file>').requiredOption('--out <directory>');
  command
    .command('difference-job')
    .requiredOption('--manifest <file>')
    .requiredOption('--observation <file>')
    .requiredOption('--route <route>')
    .requiredOption('--profile <profile>')
    .requiredOption('--operation <operation>')
    .requiredOption('--topology <topology>')
    .requiredOption('--out <directory>')
    .option('--baseline <file>');
  command.command('collect-difference-evidence').requiredOption('--job <file>').requiredOption('--out <directory>');
  command
    .command('judge')
    .requiredOption('--job <file>')
    .requiredOption('--out <directory>')
    .option('--evidence <file>', 'difference evidence record', repeated, []);
  command.command('prepare-promotion').requiredOption('--input <file>').requiredOption('--out <directory>');
  command.command('reconcile-promotion').requiredOption('--input <file>').requiredOption('--out <directory>');
  try {
    command.parse(argv, { from: 'user' });
    const selected = command.commands.find(row => row.name() === command.args[0]);
    if (!selected) {
      return { exitCode: 2, output: { status: 'invalid_arguments' } };
    }
    const flags = selected.opts();
    let baseline = null;
    if (flags.baseline) {
      try {
        baseline = parseBaseline(await loadRecord(flags.baseline, baselineSchema));
      } catch (error) {
        if (error instanceof ToolUpdateError && error.code === 'invalid_record') {
          throw new ToolUpdateError('invalid_baseline');
        }
        throw error;
      }
    }
    const sourceRoot = options.root ?? root;
    if (['prepare-promotion', 'reconcile-promotion'].includes(selected.name())) {
      const { runPromotionCommand } = await import('./tool-update/promotion.mjs');
      return await runPromotionCommand(selected.name(), flags, sourceRoot);
    }
    if (selected.name() === 'discover') {
      if (!['codex', 'claude_code'].includes(flags.product)) {
        return { exitCode: 2, output: { status: 'invalid_arguments' } };
      }
      if (baseline) await validateBaselineForSource(baseline, sourceRoot);
      const result = await discover(flags.product, {
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.now ? { now: options.now } : {}),
        baseline
      });
      const candidateId = result.candidate ? await publishRecord(flags.out, result.candidate, candidateSchema) : null;
      const observationId = await publishRecord(flags.out, result.observation, observationSchema);
      return {
        exitCode: result.candidate ? 0 : 2,
        output: {
          status: result.observation.result,
          candidate_id: candidateId,
          observation_id: observationId,
          heads: result.observation.heads
        }
      };
    }
    if (selected.name() === 'record-review') {
      const reviewId = await publishRecord(flags.out, await loadReview(flags.input), contractReviewSchema);
      return {
        exitCode: 0,
        output: { status: 'review_recorded', review_id: reviewId }
      };
    }
    if (selected.name() === 'difference-job') {
      return await createDifferenceJob(flags, baseline, sourceRoot);
    }
    if (['collect-difference-evidence', 'judge'].includes(selected.name())) {
      return await runDifferenceCommand(selected.name(), flags, sourceRoot, options);
    }
    const candidate = await loadRecord(flags.manifest, candidateSchema);
    const observation = await loadRecord(flags.observation, observationSchema);
    const reviews = [];
    for (const path of [...flags.review].sort()) {
      reviews.push(await loadReview(path));
    }
    const judgments = [];
    for (const path of [...flags.judgment].sort()) {
      const judgment = await loadRecord(path, differenceJudgmentSchema);
      const job = await loadRecord(join(dirname(dirname(resolve(path))), 'difference-jobs', `${judgment.job_id}.json`), differenceJobSchema);
      judgments.push({ job, judgment });
    }
    const assessment = await assessCandidate({
      candidate,
      observation,
      baseline,
      reviews,
      judgments,
      root: sourceRoot
    });
    const assessmentId = await publishRecord(flags.out ?? dirname(dirname(resolve(flags.manifest))), assessment, assessmentSchema);
    return {
      exitCode: 0,
      output: {
        status: 'assessment_created',
        assessment_id: assessmentId
      }
    };
  } catch (error) {
    const status =
      error instanceof ToolUpdateError && errorCodes.has(error.code)
        ? error.code
        : error instanceof Error && 'code' in error && typeof error.code === 'string' && error.code.startsWith('commander.')
          ? 'invalid_arguments'
          : 'internal_error';
    return { exitCode: 2, output: { status } };
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await runToolUpdate(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result.output)}\n`);
  process.exitCode = result.exitCode;
}
