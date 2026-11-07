import type { ChildDiscovery } from '../session-binding-contract.js';

export interface PendingChildStart {
  receiptId: string;
  agentId: string;
  recordedAt: string;
}
/** Internal selected-pilot metadata. Never included in measurement, HTTP or exports. */
export interface ChildReadinessObservation {
  phase: 'hold_entered' | 'rebaseline_complete';
  attemptId: string;
  taskId: string;
  rootSessionId: string;
  generation: number;
  starts: readonly Readonly<PendingChildStart>[];
  elapsedMs: number;
  deadline: string;
  boundary: string | null;
}
// Copying a discovery or supplying JSON cannot create pending provenance.
// Receipt metadata is retained only for the lifetime of this discovery/attempt.
const pending = new WeakMap<ChildDiscovery, { deadline: number; starts: readonly Readonly<PendingChildStart>[] }>();
export function pendingChildReadiness(discovery: ChildDiscovery, deadline: number, starts: PendingChildStart[] = []): ChildDiscovery {
  if (Number.isFinite(deadline)) pending.set(discovery, { deadline, starts: Object.freeze(starts.map(start => Object.freeze({ ...start }))) });
  return discovery;
}
export function childReadinessDeadline(discovery: ChildDiscovery): number | undefined {
  return pending.get(discovery)?.deadline;
}
export function childReadinessStarts(discovery: ChildDiscovery): readonly Readonly<PendingChildStart>[] {
  return pending.get(discovery)?.starts ?? [];
}
