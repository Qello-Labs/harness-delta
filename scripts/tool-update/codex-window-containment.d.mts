export const windowVolumeBytes: 4294967296;
export const windowGuardOverheadBytes: 134217728;
export function buildWindowSandboxProfile(input: unknown): { readonly bytes: string; readonly sha256: string };
export interface WindowToolOptions {
  readonly root?: string;
  readonly timeoutMs?: number;
  readonly input?: string;
  readonly signal?: AbortSignal;
  readonly opensslConf?: string;
}
export interface WindowToolResult { readonly code: number | null; readonly stdout: string; }
export type WindowTool = (command: string, args: readonly string[], options?: WindowToolOptions) => Promise<WindowToolResult>;
export interface WindowImageIdentity {
  readonly root_dev: number;
  readonly root_ino: number;
  readonly image_dev: number;
  readonly image_ino: number;
}
export function windowImageIdentity(root: string): WindowImageIdentity;
export function detachOwnedWindowImage(root: string, identity: WindowImageIdentity, options?: {
  readonly run?: WindowTool;
  readonly inspect?: () => Promise<{ readonly mounted: boolean; readonly owned: boolean; readonly capacityBytes: number }>;
  readonly deadline?: number;
}): Promise<{ readonly detached: true }>;
export function runWindowTool(command: string, args: readonly string[], options?: WindowToolOptions): Promise<WindowToolResult>;
export function createOwnedWindowImage(root: string, options?: {
  readonly run?: WindowTool;
  readonly inspect?: () => Promise<{ readonly mounted: boolean; readonly owned: boolean; readonly capacityBytes: number }>;
  readonly signal?: AbortSignal;
  readonly onCreated?: (identity: WindowImageIdentity) => Promise<void>;
}): Promise<{
  readonly imagePath: string;
  readonly mountPath: string;
  close(): Promise<void>;
  summary(): { readonly detached: boolean; readonly quota_bytes: number; readonly loss_observed: boolean };
}>;
