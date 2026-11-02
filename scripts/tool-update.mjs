import { Command } from 'commander';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { baselineSchema, loadRecord, parseBaseline, publishRecord, ToolUpdateError } from './tool-update/manifest.mjs';
import { discover, candidateSchema, observationSchema } from './tool-update/discovery.mjs';
import {
  assessCandidate, assessmentSchema, contractReviewSchema, validateBaselineForSource,
} from './tool-update/assessment.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const errorCodes = new Set([
  'invalid_arguments', 'invalid_record', 'invalid_baseline', 'baseline_ahead',
  'record_too_large', 'record_conflict', 'record_read_failed', 'record_write_failed',
  'unsafe_output', 'source_snapshot_unavailable', 'source_scope_changed', 'source_drift', 'observation_mismatch',
  'discovery_incomplete', 'metadata_conflict', 'release_mismatch',
  'invalid_review', 'review_conflict', 'review_commit_conflict',
]);
async function loadReview(path) {
  try { return await loadRecord(path, contractReviewSchema); }
  catch (error) {
    if (error instanceof ToolUpdateError && error.code === 'invalid_record') throw new ToolUpdateError('invalid_review');
    throw error;
  }
}
export async function runToolUpdate(argv, options = {}) {
  const command = new Command().name('tool-update').exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} });
  command.command('discover').requiredOption('--product <product>')
    .requiredOption('--out <directory>').option('--baseline <file>');
  command.command('assess').requiredOption('--manifest <file>')
    .requiredOption('--observation <file>').option('--baseline <file>').option('--out <directory>')
    .option('--review <file>', 'contract review record', (value, previous) => [...previous, value], []);
  command.command('record-review').requiredOption('--input <file>').requiredOption('--out <directory>');
  try {
    command.parse(argv, { from: 'user' });
    const selected = command.commands.find(row => row.name() === command.args[0]);
    if (!selected) return { exitCode: 2, output: { status: 'invalid_arguments' } };
    const flags = selected.opts();
    let baseline = null;
    if (flags.baseline) {
      try { baseline = parseBaseline(await loadRecord(flags.baseline, baselineSchema)); }
      catch (error) {
        if (error instanceof ToolUpdateError && error.code === 'invalid_record')
          throw new ToolUpdateError('invalid_baseline');
        throw error;
      }
    }
    const sourceRoot = options.root ?? root;
    if (selected.name() === 'discover') {
      if (!['codex', 'claude_code'].includes(flags.product))
        return { exitCode: 2, output: { status: 'invalid_arguments' } };
      if (baseline) await validateBaselineForSource(baseline, sourceRoot);
      const result = await discover(flags.product, {
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.now ? { now: options.now } : {}), baseline,
      });
      const candidateId = result.candidate
        ? await publishRecord(flags.out, result.candidate, candidateSchema) : null;
      const observationId = await publishRecord(flags.out, result.observation, observationSchema);
      return { exitCode: result.candidate ? 0 : 2, output: {
        status: result.observation.result, candidate_id: candidateId, observation_id: observationId,
        heads: result.observation.heads,
      } };
    }
    if (selected.name() === 'record-review') {
      const reviewId = await publishRecord(flags.out, await loadReview(flags.input), contractReviewSchema);
      return { exitCode: 0, output: { status: 'review_recorded', review_id: reviewId } };
    }
    const candidate = await loadRecord(flags.manifest, candidateSchema);
    const observation = await loadRecord(flags.observation, observationSchema);
    const reviews = [];
    for (const path of [...flags.review].sort()) reviews.push(await loadReview(path));
    const assessment = await assessCandidate({ candidate, observation, baseline, reviews, root: sourceRoot });
    const assessmentId = await publishRecord(
      flags.out ?? dirname(dirname(resolve(flags.manifest))), assessment, assessmentSchema);
    return { exitCode: 0, output: { status: 'assessment_created', assessment_id: assessmentId } };
  } catch (error) {
    const status = error instanceof ToolUpdateError && errorCodes.has(error.code) ? error.code
      : error instanceof Error && 'code' in error && typeof error.code === 'string' &&
        error.code.startsWith('commander.') ? 'invalid_arguments' : 'internal_error';
    return { exitCode: 2, output: { status } };
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await runToolUpdate(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result.output)}\n`);
  process.exitCode = result.exitCode;
}
