import type { EventEmitter } from 'node:events';
import type { WindowImageIdentity, WindowTool } from './codex-window-containment.mjs';
import type { WindowQuotaEvidence, WindowQuotaFileSystem } from './codex-window-quota.mjs';

interface QuotaCleanup {
  readonly detached: true;
  readonly ownedImageDeleted: true;
  readonly identity: WindowImageIdentity;
}
export interface WindowQuotaOwnerPort extends EventEmitter {
  readonly connected: boolean;
  readonly pid?: number;
  send(input: unknown, callback?: (error: Error | null) => void): boolean;
  disconnect(): void;
}
export function ownWindowQuota(root: string, port?: WindowQuotaOwnerPort, options?: {
  readonly run?: WindowTool;
  readonly fs?: WindowQuotaFileSystem;
}): Promise<{ readonly cleanup: QuotaCleanup | null; readonly failure: string | null }>;
export function createWindowQuotaGuardian(root: string, options?: {
  readonly launch?: (root: string) => WindowQuotaOwnerPort;
}): {
  readonly owner: WindowQuotaOwnerPort | undefined;
  readonly closed: Promise<{ readonly cleanup: QuotaCleanup | null; readonly failure: string | null }>;
  start(): Promise<{
    readonly imagePath: string;
    readonly caseRoot: string;
    verifyWritablePaths(paths: readonly string[]): Promise<WindowQuotaEvidence>;
    close(): Promise<QuotaCleanup>;
  }>;
  close(): Promise<QuotaCleanup | null>;
};
