import type { EventEmitter } from 'node:events';
import type { WindowImageIdentity } from './codex-window-containment.mjs';
export interface WindowImageOwnerPort extends EventEmitter {
  readonly pid?: number;
  readonly connected: boolean;
  send(input: unknown): boolean;
  disconnect(): void;
  kill(signal?: 'SIGKILL'): boolean;
}
export function createWindowImageGuardian(root: string, options?: {
  readonly deadline?: number;
  readonly launch?: (root: string) => WindowImageOwnerPort;
  readonly recover?: (root: string, identity: WindowImageIdentity, deadline: number) => Promise<{ readonly detached: boolean }>;
}): {
  readonly events: EventEmitter;
  readonly closed: Promise<{ readonly detached: boolean; readonly code: string | null }>;
  readonly owner: WindowImageOwnerPort | undefined;
  start(): Promise<{ readonly imagePath: string; readonly mountPath: string }>;
  close(): Promise<void>;
  summary(): { readonly detached: boolean; readonly code: string | null };
};
export function qualifyWindowImageLoss(out: string): Promise<{
  readonly schema_version: number;
  readonly origin: string;
  readonly scope: string;
  readonly passed: boolean;
  readonly actual_target_qualified: false;
  readonly cases: readonly {
    readonly fault: string;
    readonly detached: boolean;
    readonly elapsed_ms: number;
    readonly within_cleanup_budget: boolean;
    readonly actual_target_qualified: false;
  }[];
}>;
