import type { Stats } from 'node:fs';
import type { WindowImageIdentity, WindowTool } from './codex-window-containment.mjs';

export const windowCaseQuotaBytes: 67108864;
export const windowOverheadBytes: 134217728;
export interface WindowOverheadEvidence {
  readonly limitBytes: 134217728;
  readonly chargedBytes: number;
  readonly guardBytes: number;
  readonly imageAllocatedBytes: number;
  readonly mountMetadataBytes: number;
  readonly accounting: 'allocated_guard_and_whole_image_upper_bound';
}
export interface WindowQuotaCleanup {
  readonly detached: true;
  readonly ownedImageDeleted: true;
  readonly identity: WindowImageIdentity;
}
export interface WindowEvidenceWrite {
  readonly quotaBytes: 67108864;
  readonly bytes: number;
  readonly overhead: WindowOverheadEvidence;
}
export interface WindowQuotaFileSystem {
  lstatSync(path: string): Stats;
  realpathSync(path: string): string;
  existsSync(path: string): boolean;
  mkdirSync(path: string, options: { readonly mode: number }): unknown;
  chmodSync(path: string, mode: number): void;
  unlinkSync(path: string): void;
  readdirSync(path: string): string[];
  openSync(path: string, flags: number, mode: number): number;
  closeSync(fd: number): void;
  writeFileSync(fd: number, bytes: Uint8Array): void;
}
export interface WindowQuotaEvidence {
  readonly quotaBytes: number;
  readonly capacityBytes: number;
  readonly identity: WindowImageIdentity;
  readonly caseIdentity: { readonly dev: number; readonly ino: number; readonly uid: number; readonly mode: number };
  readonly container: {
    readonly APFSContainerUUID: string;
    readonly CapacityCeiling: number;
    readonly Volumes: readonly {
      readonly Name: string;
      readonly APFSVolumeUUID: string;
      readonly CapacityQuota: number;
      readonly DeviceIdentifier: string;
    }[];
  };
  readonly entities: readonly { readonly 'dev-entry': string; readonly 'mount-point'?: string }[];
  readonly writablePaths: readonly string[];
}
export function createOwnedWindowQuota(root: string, options?: {
  readonly run?: WindowTool;
  readonly fs?: WindowQuotaFileSystem;
  readonly onCreated?: (identity: WindowImageIdentity) => Promise<void>;
  readonly onPhase?: (phase: string, identity: WindowImageIdentity | null) => Promise<void>;
  readonly onCleanup?: (cleanup: WindowQuotaCleanup) => Promise<void>;
}): Promise<{
  readonly imagePath: string;
  readonly caseRoot: string;
  readonly evidenceRoot: string;
  verifyWritablePaths(paths: readonly string[]): Promise<WindowQuotaEvidence>;
  writeEvidence(name: string, bytes: Buffer): Promise<WindowEvidenceWrite>;
  measureOverhead(guardRoots?: readonly string[]): Promise<WindowOverheadEvidence>;
  close(): Promise<WindowQuotaCleanup>;
}>;
