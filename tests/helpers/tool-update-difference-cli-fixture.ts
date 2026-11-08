import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessmentSchema, consumedContracts, contractReviewSchema } from '../../scripts/tool-update/assessment.mjs';
import type { ContractReview } from '../../scripts/tool-update/assessment.mjs';
import type { Candidate, Observation, Release } from '../../scripts/tool-update/discovery.mjs';
import { candidateSchema, observationSchema } from '../../scripts/tool-update/discovery.mjs';
import { judgeDifferences } from '../../scripts/tool-update/difference-judgment.mjs';
import type { CurrentIdentities } from '../../scripts/tool-update/difference-judgment.mjs';
import { differenceJobSchema, differenceJudgmentSchema } from '../../scripts/tool-update/difference-records.mjs';
import type { DifferenceJob, DifferenceJudgment } from '../../scripts/tool-update/difference-records.mjs';
import { canonical, digest, publishRecord } from '../../scripts/tool-update/manifest.mjs';
import type { Baseline } from '../../scripts/tool-update/manifest.mjs';
import { baseRef, differenceJob, middleRef, sourceEvidence, targetRef } from './tool-update-difference-fixture.js';

export const projectRoot = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
export const laneKey = differenceJob().lane;
export type BaselineMode = 'complete' | 'missing' | 'equal' | 'incomplete';
export async function scratch() {
  return mkdtemp(join(realpathSync(tmpdir()), 'difference-cli-'));
}
export async function cliFixture(root: string, identities: CurrentIdentities, mode: BaselineMode = 'complete', targetVersion = targetRef.version) {
  const target = { ...targetRef, version: targetVersion };
  const refs = mode === 'missing' ? [target] : mode === 'incomplete' ? [middleRef, target] : [baseRef, middleRef, target];
  const releases: Release[] = refs.map((ref, index) => ({
    ...ref,
    release_id: index + 1,
    tag: `rust-v${ref.version}`,
    npm_integrity: `sha512-${Buffer.alloc(64, index + 1).toString('base64')}`
  }));
  const last = releases.at(-1);
  if (!last) throw new Error('fixture_target_required');
  const { version, ...releaseIdentity } = last;
  const candidate: Candidate = {
    schema_version: 1,
    kind: 'candidate',
    product: 'codex',
    target: version,
    ...releaseIdentity
  };
  const observation: Observation = {
    schema_version: 1,
    kind: 'observation',
    product: 'codex',
    checked_at: '2026-11-07T00:00:00.000Z',
    result: 'metadata_reconciled',
    reasons: mode === 'missing' ? ['baseline_missing'] : [],
    heads: { github: version, npm_latest: version, npm_stable: version },
    checks: [],
    releases,
    candidate_id: digest(candidate)
  };
  const baselineRef = mode === 'equal' ? target : mode === 'incomplete' ? middleRef : baseRef;
  const baseline: Baseline | null =
    mode === 'missing'
      ? null
      : {
          schema_version: 1,
          kind: 'baseline',
          rows: [
            {
              ...laneKey,
              last_reviewed_version: baselineRef.version,
              contract_revision: 'consumed-v1',
              evidence_ids: ['f'.repeat(64)],
              source_digest: identities.source_digest
            }
          ]
        };
  await publishRecord(root, candidate, candidateSchema);
  await publishRecord(root, observation, observationSchema);
  const baselinePath = join(root, 'baseline.json');
  if (baseline) await writeFile(baselinePath, canonical(baseline));
  const job: DifferenceJob = {
    ...differenceJob(),
    ...identities,
    candidate_id: digest(candidate),
    observation_candidate_id: digest(candidate),
    observation_id: digest(observation),
    baseline_digest: baseline ? digest(baseline) : null,
    baseline_row: baseline
      ? {
          ...laneKey,
          ref: baselineRef,
          source_digest: identities.source_digest,
          evidence_ids: ['f'.repeat(64)]
        }
      : null,
    parser_base: mode === 'missing' || mode === 'incomplete' ? null : { ...baseRef, profile_id: laneKey.profile_id },
    target,
    comparison: baseline
      ? {
          comparison_kind: 'adjacent_release',
          from: baselineRef,
          to: target
        }
      : null,
    inventory: {
      inventory_id: digest(refs),
      scope: 'synthetic_review_range',
      coverage: mode === 'incomplete' || mode === 'missing' ? 'incomplete' : 'complete',
      releases: refs
    },
    reasons: mode === 'missing' ? ['baseline_missing'] : []
  };
  const jobId = await publishRecord(root, job, differenceJobSchema);
  const inputArgs = [
    '--manifest',
    join(root, 'candidates', `${digest(candidate)}.json`),
    '--observation',
    join(root, 'observations', `${digest(observation)}.json`),
    ...(baseline ? ['--baseline', baselinePath] : [])
  ];
  return {
    root,
    identities,
    candidate,
    observation,
    baseline,
    baselinePath,
    job,
    jobPath: join(root, 'difference-jobs', `${jobId}.json`),
    inputArgs
  };
}
export type CliFixture = Awaited<ReturnType<typeof cliFixture>>;
export function judgmentFor(input: CliFixture, affected = false): DifferenceJudgment {
  const evidence = input.job.parser_base
    ? sourceEvidence(input.job).map(record => ({
        ...record,
        source_digest: input.identities.source_digest,
        engine_digest: input.identities.engine_digest,
        map_revision: input.identities.map_revision,
        findings: record.findings.map(finding =>
          affected && finding.contract_id === 'fields_types_enums' && finding.facet === 'serialized_shape'
            ? {
                ...finding,
                result: 'affected' as const,
                reason: 'confirmed_contract_change' as const,
                impact: 'shape_changed' as const
              }
            : finding
        )
      }))
    : [];
  return judgeDifferences(input.job, evidence, input.identities);
}
export async function publishJudgment(input: CliFixture, record = judgmentFor(input)) {
  const id = await publishRecord(input.root, record, differenceJudgmentSchema);
  return {
    id,
    path: join(input.root, 'difference-judgments', `${id}.json`),
    record
  };
}
export async function publishReviews(input: CliFixture, judgment: 'unaffected' | 'affected' | 'unknown' = 'unaffected') {
  const refs = input.observation.releases;
  const records: ContractReview[] = refs.slice(1).map((to, index) => {
    const from = refs[index];
    if (!from) throw new Error('fixture_review_endpoint_required');
    return {
      schema_version: 1,
      kind: 'contract_review',
      ...laneKey,
      contract_revision: 'consumed-v1',
      from: { version: from.version, commit: from.commit },
      to: { version: to.version, commit: to.commit },
      contracts: consumedContracts.map(contract_id => ({
        contract_id,
        judgment
      })),
      evidence_ids: ['e'.repeat(64)],
      source_digest: input.identities.source_digest
    };
  });
  const ids = await Promise.all(records.map(record => publishRecord(input.root, record, contractReviewSchema)));
  return {
    records,
    ids: ids.sort(),
    args: ids.flatMap(id => ['--review', join(input.root, 'reviews', `${id}.json`)])
  };
}
export async function readAssessment(root: string, assessmentId: string | undefined) {
  if (!assessmentId) throw new Error('assessment_id_required');
  const bytes = await readFile(join(root, 'assessments', `${assessmentId}.json`), 'utf8');
  const raw: unknown = JSON.parse(bytes);
  return { bytes, record: assessmentSchema.parse(raw) };
}
export async function tree(root: string): Promise<readonly (readonly [string, string])[]> {
  const result: [string, string][] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      for (const [child, hash] of await tree(path)) {
        result.push([`${entry.name}/${child}`, hash]);
      }
    } else result.push([entry.name, digest(await readFile(path))]);
  }
  return result.sort(([a], [b]) => a.localeCompare(b));
}
export async function auditedCli(root: string, script: string, args: readonly string[]) {
  const home = join(root, 'home');
  const temporary = join(root, 'tmp');
  await mkdir(home, { recursive: true });
  await mkdir(temporary, { recursive: true });
  const loader = join(root, 'audit.mjs');
  const ledgerPath = join(root, 'ledger.json');
  await writeFile(
    loader,
    `import fs from 'node:fs';
import fsp from 'node:fs/promises';
import cp from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import {registerHooks,syncBuiltinESMExports} from 'node:module';
import {fileURLToPath} from 'node:url';
import {isAbsolute,relative,resolve} from 'node:path';
const root=${JSON.stringify(root)},home=${JSON.stringify(home)};
const ledger={network:0,processes:0,modules:0,privateReads:0,writes:[]};
const save=fs.writeFileSync;
const denied=key=>{ledger[key]++;throw new Error('forbidden_'+key);};
globalThis.fetch=()=>denied('network');
for(const object of [http,https]) for(const name of ['get','request']) object[name]=()=>denied('network');
for(const object of [net,tls]) for(const name of ['connect','createConnection']) if(name in object) object[name]=()=>denied('network');
for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) cp[name]=()=>denied('processes');
registerHooks({resolve(specifier,context,next){
 const result=next(specifier,context);
 if(/better-sqlite3|\\/(?:store|session-binding-(?:codex|claude|service)|ordinary-session-binding|conformance|claude-localhost)\\.(?:m?js|ts)$/.test(result.url)) denied('modules');
 return result;
}});
const pathOf=value=>value instanceof URL?fileURLToPath(value):typeof value==='string'?resolve(value):null;
const within=(base,path)=>{const rel=relative(base,path);return rel===''||!rel.startsWith('..')&&!isAbsolute(rel);};
for(const [object,names] of [[fsp,['readFile','readdir','open']],[fs,['readFileSync','readdirSync','openSync']]]){
 for(const name of names){const original=object[name];object[name]=function(path,...args){
  const target=pathOf(path);
  if(target&&(within(home,target)||/\\.(?:jsonl|sqlite|db)$/.test(target))) denied('privateReads');
  return original.call(this,path,...args);
 };}
}
for(const [object,names] of [[fsp,['writeFile','mkdir','mkdtemp','link','rename','symlink','rm','unlink','open']],[fs,['writeFileSync','mkdirSync','appendFileSync','renameSync','unlinkSync']]]){
 for(const name of names){const original=object[name];object[name]=function(path,...args){
  if(name==='open'||name==='openSync'){
   const flags=args[0];
   const writing=typeof flags==='number'?(flags&(fs.constants.O_WRONLY|fs.constants.O_RDWR|fs.constants.O_CREAT))!==0:/[wa+]/.test(String(flags));
   if(!writing)return original.call(this,path,...args);
  }
  const destination=['link','rename','symlink'].includes(name)?args[0]:path;
  const target=pathOf(destination);
  if(target&&name==='mkdir'&&fs.existsSync(target))return original.call(this,path,...args);
  if(target){ledger.writes.push(target);if(!within(root,target))throw new Error('write_outside_root');}
  return original.call(this,path,...args);
 };}
}
syncBuiltinESMExports();
process.on('exit',()=>save(${JSON.stringify(ledgerPath)},JSON.stringify(ledger)));
`
  );
  const { stdout, stderr, exitCode } = await new Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }>((resolve, reject) => {
    execFile(
      process.execPath,
      ['--import', loader, script, ...args],
      {
        cwd: projectRoot,
        timeout: 60_000,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          XDG_CONFIG_HOME: home,
          CODEX_HOME: home,
          CLAUDE_CONFIG_DIR: home,
          TMPDIR: temporary
        }
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ stdout, stderr, exitCode: 0 });
          return;
        }
        const exitCode = error.code;
        if (typeof exitCode === 'number') {
          resolve({ stdout, stderr, exitCode });
          return;
        }
        reject(error instanceof Error ? error : new Error('cli_execution_failed'));
      }
    );
  });
  const output: unknown = JSON.parse(stdout);
  const ledger: unknown = JSON.parse(await readFile(ledgerPath, 'utf8'));
  return { output, ledger, stdout, stderr, exitCode, home, temporary };
}
