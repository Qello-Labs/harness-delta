export interface WindowRegistryReference {
  readonly schema_version: 1;
  readonly case_id: string;
  readonly case_root: string;
  readonly batch_started_continuous_ms: number;
  readonly registry_path: string;
  readonly identity: { readonly dev: number; readonly ino: number; readonly uid: number };
  readonly file_sha256: string;
  readonly head_sha256: string;
  readonly entries: number;
}
export function createWindowResourceRegistry(options: { readonly root: string; readonly caseId: string; readonly batchStartedMs: number }): {
  recordPid(input: { readonly pid: number; readonly uid: number; readonly started: string }): void;
  recordPath(path: string): void;
  recordImage(input: { readonly path: string; readonly devices: readonly string[] }): void;
  seal(): WindowRegistryReference;
  close(): void;
};
export function verifyWindowResourceRegistry(reference: WindowRegistryReference, options?: {
  readonly attachedImages?: () => Promise<readonly string[]>;
  readonly checkDeadline?: () => Promise<void>;
}): Promise<{ readonly closedResources: number; readonly caseId: string }>;
export function verifyWindowCleanup(options: {
  readonly batchRoot: string;
  readonly consentFile: string;
  readonly now?: () => number;
  readonly continuousNow: (nativeClock?: { readonly path: string; readonly sha256: string }) => number | Promise<number>;
}): Promise<{
  readonly status: 'cleanup_verified';
  readonly registries: number;
  readonly closed_resources: number;
  readonly execution_attempted: false;
  readonly actual_qualification: false;
}>;
export function cleanupWindowBatch(options: {
  readonly batchRoot: string;
  readonly consentFile: string;
}): ReturnType<typeof verifyWindowCleanup>;
