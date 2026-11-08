import type { DifferenceJob, DifferenceEvidence, DifferenceJudgment } from './difference-records.mjs';
export interface CurrentIdentities {
  readonly source_digest: string;
  readonly engine_digest: string;
  readonly map_revision: 'difference-map-v2';
}
export function judgmentEngineDigest(root: string): Promise<string>;
export function judgeDifferences(job: DifferenceJob, evidence: readonly DifferenceEvidence[], identities: CurrentIdentities): DifferenceJudgment;
