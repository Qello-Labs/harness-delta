import type { WindowImageIdentity } from './codex-window-containment.mjs';

export interface WindowStartupJournalSummary {
  readonly path: string;
  readonly head: string;
  readonly entries: number;
}
export interface WindowStartupJournal {
  readonly path: string;
  append(phase: string, identity?: WindowImageIdentity | null): WindowStartupJournalSummary;
  summary(): WindowStartupJournalSummary;
  close(): void;
}
export function createWindowStartupJournal(root: string): WindowStartupJournal;
export interface WindowStartupJournalRead extends WindowStartupJournalSummary {
  readonly last_phase: string | null;
  readonly identity: WindowImageIdentity | null;
}
export function readWindowStartupJournal(root: string): WindowStartupJournalRead;
