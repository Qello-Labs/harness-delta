import type { ChildProcess } from 'node:child_process';
import type { Server } from 'node:http';
import type { Socket } from 'node:net';
export const repository: string;
export const failureCodes: readonly string[];
export class ConformanceError extends Error {
  constructor(code: string);
}
export function requireCondition(condition: unknown, code: string): asserts condition;
export function safeCode(error: unknown): string;
export function sha256(bytes: string | Uint8Array): string;
export function hashFile(path: string): string;
export function treeDigest(path: string): string;
export function snapshotPins(binary: string): Record<string, string>;
export function assertPins(before: Readonly<Record<string, string>>, binary: string): void;
export interface WindowPinSelection {
  readonly product: 'codex' | 'claude_code';
  readonly executionMode: 'source' | 'built';
}
export interface WindowPins {
  readonly runtime: string;
  readonly source: string;
  readonly build: string;
  readonly instrument: string;
  readonly skill: string;
  readonly producer: string;
  readonly built_skill: string;
  readonly built_producer: string;
  readonly lockfile: string;
  readonly package: string;
}
export function snapshotWindowPins(selection: WindowPinSelection): WindowPins;
export function assertWindowPins(before: WindowPins, selection: WindowPinSelection): void;
export interface PromotedInputMap {
  readonly bundleRevision: 'codex-promoted-bundle-v1' | 'claude-promoted-bundle-v1';
  readonly skill: string;
  readonly builtSkill: string;
  readonly template: string | null;
  readonly producer: string;
  readonly builtProducer: string;
  readonly members: readonly string[];
  readonly consumedInputs: readonly string[];
  readonly historicalSkill: {
    readonly skill: string;
    readonly builtSkill: string;
    readonly members: readonly string[];
  };
  readonly historicalProducer: readonly [string, string] | null;
}
export const promotedInputs: Readonly<Record<'codex' | 'claude_code', PromotedInputMap>>;
export interface PromotionPinSelection {
  readonly product: 'codex' | 'claude_code';
  readonly executionMode: 'source' | 'built';
  readonly pinSchemeRevision: 'promotion-execution-v1';
  readonly bundleRevision: 'codex-promoted-bundle-v1' | 'claude-promoted-bundle-v1';
}
export interface PromotionPinOptions {
  /** Trusted repository root, not packet-controlled input. */
  readonly repositoryRoot?: string;
}
export interface PromotionPins {
  readonly runtime: string;
  readonly source: string;
  readonly build: string;
  readonly instrument: string;
  readonly skill: string;
  readonly producer: string;
  readonly built_skill: string;
  readonly built_producer: string;
  readonly lockfile: string;
  readonly package: string;
}
export function snapshotPromotionPins(selection: PromotionPinSelection, options?: PromotionPinOptions): PromotionPins;
export function assertPromotionPins(before: PromotionPins, selection: PromotionPinSelection, options?: PromotionPinOptions): void;
export function privateDirectory(path: string): string;
export function privateRead(path: string, root: string, active?: () => boolean, limit?: number): string;
export function writePrivateJson(path: string, value: unknown): void;
export function observedProcess(
  command: string,
  args: readonly string[],
  options?: {
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly stdio?: 'ignore' | readonly (string | number)[];
  },
  attach?: (child: ChildProcess) => void
): {
  readonly child: ChildProcess;
  readonly closed: Promise<readonly [number | null, NodeJS.Signals | null]>;
};
export function verifySystemPs(): void;
export function fixtureEnvironment(root: string, endpoint: string): Record<string, string>;
export function prepareFixture(root: string): Promise<{ readonly root: string; readonly project: string; readonly env: Record<string, string> }>;
export function bounded<T>(promise: Promise<T>, milliseconds: number, code?: string): Promise<T>;
export function awaitSupervisor(
  launched: {
    readonly child: ChildProcess;
    readonly closed: Promise<readonly [number | null, NodeJS.Signals | null]>;
  },
  milliseconds: number,
  terminationMs: number
): Promise<readonly [number | null, NodeJS.Signals | null]>;
export function closeListener(server: Server, sockets: ReadonlySet<Socket>): Promise<void>;
export function assertSupervisedWorker(): void;
