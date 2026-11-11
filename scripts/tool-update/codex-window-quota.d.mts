import type { Stats } from 'node:fs';
import type { WindowImageIdentity, WindowTool } from './codex-window-containment.mjs';

export const windowCaseQuotaBytes: 67108864;
export interface WindowQuotaFileSystem {
  lstatSync(path: string): Stats;
  realpathSync(path: string): string;
  existsSync(path: string): boolean;
  mkdirSync(path: string, options: { readonly mode: number }): unknown;
  chmodSync(path: string, mode: number): void;
  unlinkSync(path: string): void;
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
}): Promise<{
  readonly imagePath: string;
  readonly caseRoot: string;
  verifyWritablePaths(paths: readonly string[]): Promise<WindowQuotaEvidence>;
  close(): Promise<{ readonly detached: true; readonly ownedImageDeleted: true; readonly identity: WindowImageIdentity }>;
}>;
