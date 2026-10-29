export function runLocalhost(input: { readonly approvalFile: string; readonly binary: string;
  readonly root: string; readonly scenario: 'normal' | 'sigint' }): Promise<unknown>;
export function gateClient(endpoint: string): Promise<void>;
export function startGate(onGate: () => Promise<void>): Promise<{
  readonly endpoint: string; readonly assertHealthy: () => void; readonly close: () => Promise<void>;
}>;
