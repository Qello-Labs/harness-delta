import type { UsageBatch } from '../../src/session-binding-contract.js';
export interface Counters { readonly input_tokens: number; readonly output_tokens: number;
  readonly cache_read_input_tokens: number; readonly cache_creation_input_tokens: number }
export interface RequestProjection { readonly message: string; readonly sessionId: string; readonly counters: Counters;
  readonly ttl: readonly [number, number];
  readonly terminal: boolean; readonly excluded: boolean }
export interface ServedRequest { readonly requestId: string; readonly owner: string;
  readonly status: 'terminal' | 'partial'; readonly counters: Counters }
export interface OracleSummary { readonly served: number; readonly terminal: number; readonly baseline: number;
  readonly retained: readonly number[]; readonly input: number; readonly output: number; readonly incomplete: number;
  readonly interrupted_usage: { readonly status: 'missing'; readonly value: null } | null }
export const historical: Readonly<Record<'normal' | 'sigint', Omit<OracleSummary, 'interrupted_usage'>>>;
export function projectTranscript(text: string, session: string, agent?: string | null, excluded?: readonly string[]): Map<string, RequestProjection>;
export function reconcileOracle(scenario: 'normal' | 'sigint', ledger: readonly ServedRequest[],
  sources: readonly ReadonlyMap<string, RequestProjection>[]): OracleSummary;
export function reconcileCollector(summary: OracleSummary, batches: readonly UsageBatch[],
  sources: readonly ReadonlyMap<string, RequestProjection>[]): {
    readonly records: number; readonly input: number; readonly output: number;
    readonly partial_usage: true; readonly complete_cost: false;
};
