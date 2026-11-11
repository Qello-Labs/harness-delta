export function qualifyWindowEvidence(out: string): Promise<{
  readonly origin: 'local_nonvendor';
  readonly scope: 'evidence_quota_and_measured_guard_overhead';
  readonly evidence_quota_bytes: 67108864;
  readonly overhead_limit_bytes: 134217728;
  readonly passed: boolean;
  readonly failure: string | null;
  readonly actual_target_qualified: false;
}>;
