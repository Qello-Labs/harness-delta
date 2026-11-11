export function qualifyWindowStartupLoss(out: string): Promise<{
  readonly origin: 'local_nonvendor';
  readonly scope: 'coordinator_loss_startup_phases';
  readonly passed: boolean;
  readonly failure: string | null;
  readonly actual_target_qualified: false;
  readonly cases: readonly unknown[];
}>;
