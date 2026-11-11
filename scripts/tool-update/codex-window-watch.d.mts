import type { Readable, Writable } from "node:stream";
import type { EventEmitter } from "node:events";

export interface WindowOwnedPid {
  readonly pid: number;
  readonly parent: number;
  readonly pgid: number;
  readonly uid: number;
  readonly start_sec: number;
  readonly start_usec: number;
}
export interface WindowWatchCounts {
  readonly execs: number;
  readonly live: number;
  readonly receipts: number;
  readonly lower_bound: true;
}
export interface WindowWatchResult extends WindowWatchCounts {
  readonly unaccounted: number;
  readonly failed: boolean;
  readonly stop_batch: boolean;
  readonly cleanup_verified: boolean;
  readonly term_ms: number | null;
  readonly kill_ms: number | null;
  readonly disappearance_ms: number | null;
}
export interface WindowSignalResult {
  readonly kind: "signal";
  readonly id: number;
  readonly seq: number;
  readonly outcome: "sent" | "absent";
  readonly now_ns: string;
}
export type WindowWatchRecord = { readonly seq: number } & (
  | { readonly kind: "ready"; readonly mode: "watch" | "clock"; readonly now_ns: string; readonly owner?: WindowOwnedPid }
  | { readonly kind: "clock"; readonly id: number; readonly now_ns: string }
  | { readonly kind: "process"; readonly id: number; readonly now_ns: string; readonly identity: WindowOwnedPid | null }
  | WindowSignalResult
  | { readonly kind: "identity"; readonly identity: WindowOwnedPid }
  | { readonly kind: "phase"; readonly phase: "root-suspended" | "running" }
  | ({ readonly kind: "count"; readonly exec_overshoot: number; readonly live_overshoot: number; readonly receipt_overshoot: number } & WindowWatchCounts)
  | { readonly kind: "dispatch"; readonly signal: "TERM" | "KILL"; readonly latency_ms: number }
  | { readonly kind: "loss"; readonly code: "guard_loss" | "overrun" | "deadline" | "coordinator_lost" | "protocol" | "unaccounted" }
  | ({ readonly kind: "final" } & WindowWatchResult)
);
export interface WindowWatchTransport extends EventEmitter {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly targetStdio?: readonly (Readable | Writable | null)[];
}
export interface WindowClockOptions {
  readonly nativePath: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly onRecord?: (record: WindowWatchRecord) => void;
  readonly onOwnerResource?: (identity: WindowOwnedPid) => void | Promise<void>;
  readonly onResource?: (identity: WindowOwnedPid) => void | Promise<void>;
  readonly transport?: (file: string, args: readonly string[], options: WindowClockOptions) => WindowWatchTransport;
}
export interface WindowWatchOptions extends WindowClockOptions {
  readonly receiptControl?: {
    readonly dev: number;
    readonly ino: number;
    readonly uid: number;
    readonly birthSec: number;
    readonly birthNsec: number;
  };
  readonly receiptDirectory: string;
  readonly executable: string;
  readonly args?: readonly string[];
  readonly priorExecs: number;
  readonly deadlineNs: string;
  readonly targetStdio?: readonly [number | "pipe", number | "pipe", number | "pipe"];
  readonly onResource: (identity: WindowOwnedPid) => void | Promise<void>;
}
export interface WindowWatch {
  readonly ready: Promise<{ readonly kind: "ready"; readonly mode: "watch" | "clock"; readonly now_ns: string; readonly seq: number; readonly owner?: WindowOwnedPid }>;
  readonly result: Promise<WindowWatchResult>;
  readonly targetStdio: readonly (Readable | Writable | null)[] | undefined;
  launch(): Promise<void>;
  stop(originNs?: bigint): Promise<WindowWatchResult>;
  clock(): Promise<bigint>;
  inspect(pid: number): Promise<WindowOwnedPid | null>;
  signal(identity: WindowOwnedPid, signalName: "TERM" | "KILL"): Promise<WindowSignalResult>;
  shortenDeadline(deadlineNs: string): Promise<void>;
}
export class WindowWatchError extends Error {
  readonly code: string;
  constructor(code: string);
}
export function createWindowWatch(options: WindowWatchOptions): WindowWatch;
export function createWindowNativeService(mode: "clock", options: WindowClockOptions): WindowWatch;
export function createWindowNativeService(mode: "watch", options: WindowWatchOptions): WindowWatch;
export function windowNativeTransport(file: string, args: readonly string[], options: WindowClockOptions): WindowWatchTransport;
