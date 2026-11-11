import type { WindowCaseId, createWindowBudget } from './codex-window-conformance.mjs';
import type { WindowRegistryReference } from './codex-window-registry.mjs';
import type { WindowEvidenceExport } from './codex-window-evidence-export.mjs';
import type { WindowOwnedPid, WindowSignalResult, WindowWatchResult } from './codex-window-watch.mjs';

export interface SyntheticWindowCaseGuardsOptions {
  readonly root: string;
  readonly nativePath: string;
  readonly caseId: Extract<WindowCaseId, 'normal'>;
  readonly batchStartedMs: number;
  readonly priorExecs: number;
  readonly budget: ReturnType<typeof createWindowBudget>;
  readonly auditClock: {
    clock(): Promise<bigint>;
    readonly result: Promise<{ readonly failed: boolean }>;
  };
  readonly guardRoots?: readonly string[];
  readonly evidenceExportRoot?: string;
}
export interface SyntheticWindowCaseGuardsResult {
  readonly origin: 'synthetic';
  readonly execution_enabled: false;
  readonly actual_qualification: false;
  readonly failed: boolean;
  readonly stop_batch: boolean;
  readonly reason: string | null;
  readonly cleanup_verified: boolean;
  readonly closure: { readonly closedResources: number; readonly caseId: string } | null;
  readonly registry: WindowRegistryReference | null;
  readonly batch_started_continuous_ms: number;
  readonly stop_origin_ns: string;
  readonly watch: WindowWatchResult | null;
  readonly observed_overshoot: object | null;
  readonly evidence_export: WindowEvidenceExport | null;
  readonly fallback_signals: readonly {
    readonly identity: WindowOwnedPid;
    readonly signal: 'TERM' | 'KILL';
    readonly receipt: WindowSignalResult;
    readonly latency_ms: number;
  }[];
  readonly collection: {
    readonly event_count: number;
    readonly trial_tokens_consumed: number;
  } | null;
  readonly errors: readonly string[];
  readonly unqualified: readonly string[];
}
export function createSyntheticWindowCaseGuards(options: SyntheticWindowCaseGuardsOptions): {
  prepare(): Promise<{
    readonly caseRoot: string;
    readonly evidenceRoot: string;
    readonly registryRoot: string;
    readonly actual_qualification: false;
    readonly execution_enabled: false;
  }>;
  run(input: {
    readonly capability: object;
    readonly observedPins: Readonly<Record<string, string>>;
    readonly scenario: string;
  }): Promise<SyntheticWindowCaseGuardsResult>;
  stop(reason?: string): Promise<SyntheticWindowCaseGuardsResult>;
  readonly result: Promise<SyntheticWindowCaseGuardsResult>;
};
