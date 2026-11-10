import type { EventEmitter } from 'node:events';
export function startWindowTui(): never;
export function verifyWindowSignalIdentity(expected: unknown, observed: unknown): void;
export function createSyntheticWindowTui(root: string): {
  readonly events: EventEmitter;
  readonly completed: Promise<{
    readonly origin: 'synthetic';
    readonly actual_qualification: false;
    readonly normal_quit: boolean;
    readonly signal_sent: boolean;
    readonly interruption_observed: boolean;
    readonly ownership_verified: true;
    readonly identities_gone: true;
    readonly termination_cause: string;
  }>;
  start(): void;
  releaseSyntheticBaseline(): void;
  releaseSyntheticSecondInput(): void;
  submit(): Promise<void>;
  quit(): Promise<void>;
  interrupt(): Promise<void>;
  stop(): void;
};
