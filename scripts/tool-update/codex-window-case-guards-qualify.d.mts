import type { SyntheticWindowCaseGuardsResult } from './codex-window-case-guards.mjs';
import type { WindowOwnedPid, WindowWatchResult } from './codex-window-watch.mjs';

export function qualifySyntheticWindowCaseGuards(options: {
  readonly root: string;
  readonly prerequisitesReady: true;
}): Promise<{
  readonly origin: 'local_nonvendor';
  readonly actual_qualification: false;
  readonly execution_enabled: false;
  readonly vendor_execs: 0;
  readonly runtime: string;
  readonly result: SyntheticWindowCaseGuardsResult | null;
  readonly batch_clock_identities: readonly WindowOwnedPid[];
  readonly batch_clock_result: WindowWatchResult | null;
  readonly passed: boolean;
  readonly failure: string | null;
  readonly physical_cleanup: boolean;
  readonly limitations: readonly string[];
}>;
