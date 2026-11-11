export function qualifyWindowQuotaRecovery(out: string): Promise<{
  readonly origin: 'local_nonvendor';
  readonly scope: 'guardian_loss_recovery_from_journal';
  readonly passed: boolean;
  readonly failure: string | null;
  readonly cases: readonly unknown[];
  readonly actual_target_qualified: false;
}>;
