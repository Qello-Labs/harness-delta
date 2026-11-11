import type { EventEmitter } from 'node:events';
import type { WindowImageIdentity, WindowTool } from './codex-window-containment.mjs';
import type { WindowQuotaEvidence, WindowQuotaFileSystem, WindowEvidenceWrite, WindowOverheadEvidence } from './codex-window-quota.mjs';
import type { WindowStartupJournalSummary } from './codex-window-startup-journal.mjs';
import type { WindowQuotaRecovery } from './codex-window-quota-recovery.mjs';

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
  readonly onPhase?: (phase: string, identity: WindowImageIdentity | null) => Promise<void>;
  readonly waitForRegistration?: boolean;
}): Promise<{ readonly cleanup: QuotaCleanup | null; readonly failure: string | null }>;
export function createWindowQuotaGuardian(root: string, options?: {
  readonly launch?: (root: string) => WindowQuotaOwnerPort;
  readonly onOwner?: (pid: number) => Promise<void>;
  readonly onCreated?: (imagePath: string, identity: WindowImageIdentity) => Promise<void>;
  readonly onMounted?: (evidence: WindowQuotaEvidence) => Promise<void>;
  readonly onLoss?: (code: string) => void;
  readonly run?: WindowTool;
  readonly fs?: WindowQuotaFileSystem;
  readonly recover?: (root: string, options: { readonly run?: WindowTool; readonly fs?: WindowQuotaFileSystem }) => Promise<WindowQuotaRecovery>;
}): {
  readonly owner: WindowQuotaOwnerPort | undefined;
  readonly closed: Promise<{
    readonly cleanup: QuotaCleanup | null;
    readonly failure: string | null;
    readonly startupJournal?: WindowStartupJournalSummary | null;
    readonly recovery?: WindowQuotaRecovery | { readonly recovered: false; readonly code: string };
  }>;
  start(): Promise<{
    readonly imagePath: string;
    readonly caseRoot: string;
    readonly evidenceRoot: string;
    readonly startupJournal: WindowStartupJournalSummary;
    verifyWritablePaths(paths: readonly string[]): Promise<WindowQuotaEvidence>;
    writeEvidence(name: string, bytes: Buffer): Promise<WindowEvidenceWrite>;
    measureOverhead(guardRoots?: readonly string[]): Promise<WindowOverheadEvidence>;
    close(): Promise<QuotaCleanup>;
  }>;
  close(): Promise<QuotaCleanup | null>;
};
