import type { ChildProcess } from 'node:child_process';
import type { Server } from 'node:http';
import type { Socket } from 'node:net';
export const repository: string;
export const failureCodes: readonly string[];
export class ConformanceError extends Error { constructor(code: string); }
export function requireCondition(condition: unknown, code: string): asserts condition;
export function safeCode(error: unknown): string;
export function sha256(bytes: string | Uint8Array): string;
export function hashFile(path: string): string;
export function treeDigest(path: string): string;
export function snapshotPins(binary: string): Record<string, string>;
export function assertPins(before: Readonly<Record<string, string>>, binary: string): void;
export function privateDirectory(path: string): string;
export function privateRead(path: string, root: string, active?: () => boolean, limit?: number): string;
export function writePrivateJson(path: string, value: unknown): void;
export function observedProcess(command: string, args: readonly string[], options?: {
  readonly cwd?: string; readonly env?: Readonly<Record<string, string | undefined>>;
  readonly stdio?: 'ignore' | readonly string[];
}, attach?: (child: ChildProcess) => void): {
  readonly child: ChildProcess; readonly closed: Promise<readonly [number | null, NodeJS.Signals | null]>;
};
export function verifySystemPs(): void;
export function fixtureEnvironment(root: string, endpoint: string): Record<string, string>;
export function prepareFixture(root: string): Promise<{ readonly root: string; readonly project: string; readonly env: Record<string, string> }>;
export function bounded<T>(promise: Promise<T>, milliseconds: number, code?: string): Promise<T>;
export function awaitSupervisor(launched: {
  readonly child: ChildProcess;
  readonly closed: Promise<readonly [number | null, NodeJS.Signals | null]>;
}, milliseconds: number, terminationMs: number): Promise<readonly [number | null, NodeJS.Signals | null]>;
export function closeListener(server: Server, sockets: ReadonlySet<Socket>): Promise<void>;
export function assertSupervisedWorker(): void;
