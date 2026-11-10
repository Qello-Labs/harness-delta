export class WindowConformanceError extends Error {
  readonly code: string;
  constructor(code: string);
}
export const planSchema: import('zod').ZodType;
export function windowRequire(condition: unknown, code: string): asserts condition;
export type WindowCaseId = 'version_probe' | 'normal' | 'sigint' | 'flush' | 'source_receipt_loading' | 'correlation' | 'termination' | 'replacement';
export interface WindowCaseBudget {
  readonly deadline: number;
  remaining(now: number): number;
  bindTrialExpiry(expiry: number): void;
  scheduleNegative(token: string, barrier: string, now: number): void;
  stop(now: number, reason?: 'normal' | 'scheduled'): void;
  loss(kind: 'observer' | 'owner' | 'guardian' | 'containment' | 'suspension', now: number): void;
  verifyCleanup(now: number, proof: {
    readonly identitiesGone: boolean;
    readonly resourcesClosed: boolean;
    readonly terminalRestored: boolean;
  }): void;
}
export function createWindowBudget(start: number): {
  reserve(caseId: WindowCaseId, now: number, consentExpiry: number): WindowCaseBudget;
  auditDeadline(now: number, cleanupConsentExpiry: number): number;
};
export function ownedWindowDirectory(path: string): string;
export function reserveSyntheticWindowEmission(options: {
  readonly root: string;
  readonly projectRoot: string;
  readonly consent: unknown;
}): object;
export function writeWindowEmissionControl(capability: object): {
  readonly authority: 'none';
  readonly origin: 'synthetic';
  check(): void;
  close(): void;
};
export function prepareWindowCase(options: {
  readonly planFile: string;
  readonly caseId: WindowCaseId;
  readonly out: string;
}): { readonly status: 'prepared_execution_disabled'; readonly authority: 'none'; readonly actual_qualification: false };
