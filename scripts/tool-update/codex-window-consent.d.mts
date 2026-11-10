export interface WindowConsentContext {
  readonly intentSha256: string;
  readonly caseRoot: string;
  readonly caseId: string;
  readonly pins: Readonly<Record<string, string>>;
  readonly now: number;
}
export function verifyWindowConsent(input: unknown, context: WindowConsentContext): {
  readonly intent_sha256: string;
  readonly case_root: string;
  readonly case_id: string;
  readonly consent_id: string;
  readonly expires_at: number;
  readonly pins: Readonly<Record<string, string>>;
};
export function snapshotWindowExecutorPins(intent: {
  readonly plan: { readonly inputs?: Readonly<Record<string, string>> };
  readonly case_root: string;
  readonly case_id: string;
}): Readonly<Record<string, string>>;
export function reserveWindowConsent(options: {
  readonly intentFile: string;
  readonly consentFile: string;
  readonly now?: number;
  readonly observedPins?: Readonly<Record<string, string>>;
}): object;
export function revalidateWindowConsent(capability: object, observedPins?: Readonly<Record<string, string>>): {
  readonly caseRoot: string;
  readonly expiresAt: number;
  readonly origin: 'synthetic' | 'local_verified_inputs';
  readonly authority: 'none';
};
export function writeConsentedWindowEmission(capability: object, observedPins?: Readonly<Record<string, string>>): {
  readonly authority: 'none';
  readonly origin: 'synthetic' | 'local_verified_inputs';
  readonly actual_qualification: false;
  check(): void;
  close(): void;
};
