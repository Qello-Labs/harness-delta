import type { DifferenceEvidence, DifferenceJob } from './difference-records.mjs';

export interface SyntheticRequest {
  readonly request: number;
  readonly message: number;
  readonly owner: 'root' | 'child_1' | 'child_2';
  readonly terminal: boolean;
  readonly excluded: boolean;
  readonly counters: {
    readonly input: number | null;
    readonly output: number | null;
    readonly cached: number | null;
    readonly cache_write: number | null;
    readonly reasoning: number | null;
  };
}
export interface SyntheticReplay {
  readonly fixture_id: 'parser_provider_v1' | 'field_shapes_v1' | 'counter_ledger_v1' | 'lifecycle_v1';
  readonly scenario_id: 'unchanged' | 'shape_change' | 'counter_change' | 'replay_conflict' | 'missing_usage' | 'interrupted';
  readonly test_hash: string;
  readonly harness_hash: string;
  readonly input_hash: string;
  readonly expected: readonly SyntheticRequest[];
  readonly actual: readonly SyntheticRequest[];
}
export interface SyntheticSummary {
  readonly requests: readonly SyntheticRequest[];
  readonly terminal: number;
  readonly retained: number;
  readonly owners: readonly number[];
  readonly missing: number;
  readonly totals: {
    readonly input: number | null;
    readonly output: number | null;
    readonly cached: number | null;
    readonly cache_write: number | null;
    readonly reasoning: number | null;
  };
  readonly conflict: boolean;
}
export function projectSyntheticReplay(
  job: DifferenceJob,
  run: SyntheticReplay
): {
  readonly matched: boolean;
  readonly expected: SyntheticSummary;
  readonly actual: SyntheticSummary;
  readonly evidence: readonly DifferenceEvidence[];
};
