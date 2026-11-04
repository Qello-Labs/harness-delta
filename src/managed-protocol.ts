import { z } from 'zod';
import { IdSchema, TimestampSchema, UsageSchema } from './contracts.js';
import type { CoverageEvidence } from './coverage.js';

/** Internal offline transport. prepare must install an observer without reading or releasing work.
 * read is bounded, synchronous and NON-DESTRUCTIVE; acknowledge removes only committed envelopes.
 * release is synchronous, non-reentrant and must not read content. No real producer implements this yet.
 */
export const producerIdentitySchema = z.strictObject({ sessionId: IdSchema, product: z.literal('synthetic'), version: z.literal('1.0.0'), model: z.string() });
export interface ManagedProducer {
  readonly identity: { sessionId: string; product: string; version: string; model: string };
  prepare(): Promise<void>;
  release(): void;
  read(): unknown;
  acknowledge(count: number): void;
  stop(): void;
}
export interface ManagedLimits {
  runTimeoutMs: number;
  drainTimeoutMs: number;
}
export const runInputSchema = z.strictObject({ runId: IdSchema, taskId: IdSchema, sessionId: IdSchema });
export type RunInput = z.infer<typeof runInputSchema>;
export type Facts = CoverageEvidence['facts'];
export type StopReason =
  | 'cancel'
  | 'timeout'
  | 'crash'
  | 'pause'
  | 'finalize'
  | 'restart'
  | 'scope_revoked'
  | 'identity_conflict'
  | 'invalid_envelope'
  | 'transport_error'
  | 'storage_error'
  | 'clock_regressed'
  | 'incomplete';
export interface RunRow {
  id: string;
  project_id: string;
  task_id: string;
  session_id: string;
  generation: number;
  profile_id: 'synthetic-managed-v1';
  state: 'preparing' | 'ready' | 'running' | 'draining' | 'sealed' | 'interrupted';
  started_at: string;
  updated_at: string;
  ended_at: string | null;
  submitted_at: string | null;
  stop_reason: StopReason | null;
  terminal_sequence: number | null;
  channel_ended: number;
  input_facts: string;
  output_facts: string;
}
const sequenceSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const envelopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('usage'), sequence: sequenceSchema, request_id: IdSchema, occurred_at: TimestampSchema, payload: UsageSchema }),
  z.strictObject({ kind: z.literal('terminal'), final_sequence: sequenceSchema.or(z.literal(0)) }),
  z.strictObject({ kind: z.literal('exit') }),
  z.strictObject({ kind: z.literal('end') })
]);
export const batchSchema = z.array(envelopeSchema).max(256);
export type Envelope = z.infer<typeof envelopeSchema>;
export type UsageEnvelope = Extract<Envelope, { kind: 'usage' }>;
export function initialFacts(): Facts {
  return {
    scopeBeforeAccess: 'verified',
    freshSession: 'verified',
    readyBeforeFirstRequest: 'unknown',
    continuousObservation: 'verified',
    fixedModel: 'unknown',
    boundedTopology: 'unknown',
    requestUniverse: 'unknown',
    terminalAccounting: 'unknown',
    immutableIdentity: 'verified',
    durableFlush: 'unknown',
    counterSemantics: 'unknown'
  };
}
export function isOpen(row: RunRow): boolean {
  return row.state !== 'sealed' && row.state !== 'interrupted';
}
export class ManagedFailure extends Error {
  constructor(readonly reason: StopReason) {
    super(`managed_${reason}`);
  }
}
