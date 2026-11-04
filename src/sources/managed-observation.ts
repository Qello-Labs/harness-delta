import { z } from 'zod';
import type { CoverageEvidence, CoverageMetric } from '../coverage.js';
import { utcNow, type Clock } from '../lifecycle.js';
import type { Store } from '../store.js';
import { assertScope, beginRun, interruptRun, lockTask, managedNow, patchFacts, putUsage, runEvidence, runRow } from '../managed-journal.js';
import {
  batchSchema,
  isOpen,
  ManagedFailure,
  producerIdentitySchema,
  runInputSchema,
  type ManagedLimits,
  type ManagedProducer,
  type RunInput,
  type RunRow,
  type StopReason
} from './managed-protocol.js';
export { recoverManagedRuns, taskManagedEvidence } from '../managed-journal.js';

/** Internal synthetic controller. The owner drives poll(), including deadline checks.
 * No product process, timer, telemetry, CLI or background collection is started here.
 */
export class ManagedObservation {
  private input: RunInput | undefined;
  private identity: string | undefined;
  private producer: ManagedProducer | undefined;
  private drainDeadline: number | undefined;
  private stopped = false;
  private busy = false;
  private failed = false;
  private readonly limits: ManagedLimits;

  constructor(
    private readonly store: Store,
    private readonly clock: Clock = utcNow,
    limits: ManagedLimits
  ) {
    const positive = z.number().int().positive().max(86400000);
    const parsed = z.strictObject({ runTimeoutMs: positive, drainTimeoutMs: positive }).safeParse(limits);
    if (!parsed.success) throw new Error('managed_invalid_limits');
    this.limits = parsed.data;
  }

  async prepare(input: RunInput, producer: ManagedProducer): Promise<void> {
    if (this.input) throw new Error('managed_already_bound');
    const parsed = runInputSchema.safeParse(input);
    if (!parsed.success) throw new Error('managed_invalid_input');
    const identity = producerIdentitySchema.safeParse(producer.identity);
    if (!identity.success || identity.data.sessionId !== parsed.data.sessionId) throw new ManagedFailure('scope_revoked');
    try {
      beginRun(this.store, parsed.data, managedNow(this.clock), identity.data.model);
    } catch (error) {
      throw error instanceof ManagedFailure ? error : new Error('managed_storage_error');
    }
    this.input = parsed.data;
    this.producer = producer;
    this.identity = JSON.stringify(identity.data);
    try {
      await producer.prepare();
      this.transact(row => {
        this.authorize(row);
        const now = this.checkedTime(row);
        patchFacts(this.store, row, { readyBeforeFirstRequest: 'verified' });
        this.store.execute("UPDATE observation_runs SET state='ready',updated_at=? WHERE id=?", [now, row.id]);
      });
    } catch (error) {
      const reason = error instanceof ManagedFailure ? error.reason : 'transport_error';
      this.fail(reason);
      throw new ManagedFailure(reason);
    }
  }

  submit(): void {
    if (this.busy) throw new Error('managed_busy');
    const row = this.current();
    if (!row || row.state !== 'ready' || this.failed) throw new Error('managed_not_ready');
    try {
      // Commit intent BEFORE the side effect. A crash here is uncertain, never retried.
      this.transact(current => {
        this.authorize(current);
        const now = this.checkedTime(current);
        this.store.execute("UPDATE observation_runs SET state='running',submitted_at=?,updated_at=? WHERE id=?", [now, now, current.id]);
      });
      // A separate writer lock fences competing finalize/delete/recovery through release.
      // The transport contract forbids content reads and reentrant lifecycle calls here.
      this.transact(current => {
        this.authorize(current);
        this.checkedTime(current);
        try {
          this.producer!.release();
        } catch {
          throw new ManagedFailure('transport_error');
        }
      });
    } catch (error) {
      this.handle(error);
    }
  }

  poll(): void {
    if (this.busy) throw new Error('managed_busy');
    const row = this.current();
    if (!row || !isOpen(row) || this.failed) {
      this.stopProducer();
      return;
    }
    try {
      const now = managedNow(this.clock, row);
      if (row.state !== 'draining' && Date.parse(now) >= Date.parse(row.started_at) + this.limits.runTimeoutMs) this.stop('timeout');
      const next = this.current();
      if (!next || !isOpen(next)) return;
      if (next.state === 'preparing' || next.state === 'ready') return;
      if (this.drainDeadline !== undefined && Date.parse(now) >= this.drainDeadline) {
        this.fail(next.stop_reason ?? 'incomplete');
        return;
      }
      let count = 0;
      this.transact(current => {
        this.authorize(current);
        let cutoff = this.checkedTime(current);
        let raw: unknown;
        try {
          raw = this.producer!.read();
        } catch {
          throw new ManagedFailure('transport_error');
        }
        cutoff = this.checkedTime({ ...current, updated_at: cutoff });
        // Scope is checked again before decoding even the synthetic metadata envelope.
        this.authorize(runRow(this.store, current.id)!);
        const parsed = batchSchema.safeParse(raw);
        if (!parsed.success) throw new ManagedFailure('invalid_envelope');
        let terminal = current.terminal_sequence;
        let ended = current.channel_ended === 1;
        let draining = current.state === 'draining';
        for (const envelope of parsed.data) {
          if (ended) throw new ManagedFailure('invalid_envelope');
          if (envelope.kind === 'usage') {
            if (terminal !== null && envelope.sequence > terminal) throw new ManagedFailure('identity_conflict');
            putUsage(this.store, current, envelope, cutoff);
          } else if (envelope.kind === 'terminal') {
            if (terminal !== null && terminal !== envelope.final_sequence) throw new ManagedFailure('identity_conflict');
            terminal = envelope.final_sequence;
            draining = true;
          } else if (envelope.kind === 'exit') {
            draining = true;
          } else {
            ended = true;
          }
        }
        const observed = this.store.get<{ count: number; maximum: number }>(
          'SELECT count(*) AS count,COALESCE(max(sequence),0) AS maximum FROM observation_records WHERE run_id=?',
          [current.id]
        )!;
        if (terminal !== null && observed.maximum > terminal) throw new ManagedFailure('identity_conflict');
        cutoff = this.checkedTime({ ...current, updated_at: cutoff });
        this.store.execute('UPDATE observation_runs SET state=?,terminal_sequence=?,channel_ended=?,updated_at=? WHERE id=?', [
          draining ? 'draining' : current.state,
          terminal,
          ended ? 1 : 0,
          cutoff,
          current.id
        ]);
        const updated = runRow(this.store, current.id)!;
        if (ended) {
          if (terminal === null || observed.count !== terminal || observed.maximum !== terminal) {
            interruptRun(this.store, updated, 'incomplete', cutoff);
          } else {
            patchFacts(this.store, updated, { terminalAccounting: 'verified', durableFlush: 'verified' });
            this.store.execute("UPDATE observation_runs SET state='sealed',ended_at=? WHERE id=?", [cutoff, current.id]);
          }
        }
        count = parsed.data.length;
      });
      // Transport data is removed only AFTER a successful SQLite commit. Ack failure
      // is replay-safe: persisted identities survive, and the owner stops conservatively.
      if (count) {
        try {
          this.producer!.acknowledge(count);
        } catch {
          throw new ManagedFailure('transport_error');
        }
      }
      const updated = this.current()!;
      if (updated.state === 'draining' && this.drainDeadline === undefined) this.drainDeadline = Date.parse(now) + this.limits.drainTimeoutMs;
      if (!isOpen(updated)) this.stopProducer();
    } catch (error) {
      this.handle(error);
    }
  }

  stop(reason: 'cancel' | 'timeout' | 'crash'): void {
    if (this.busy) throw new Error('managed_busy');
    const row = this.current();
    if (!row || !isOpen(row) || this.failed) {
      this.stopProducer();
      return;
    }
    try {
      this.transact(current => {
        this.authorize(current);
        const now = managedNow(this.clock, current);
        if (!current.submitted_at) {
          interruptRun(this.store, current, reason, now);
          return;
        }
        patchFacts(this.store, current, { continuousObservation: 'violated' });
        this.store.execute("UPDATE observation_runs SET state='draining',stop_reason=COALESCE(stop_reason,?),updated_at=? WHERE id=?", [
          reason,
          now,
          current.id
        ]);
      });
      if (this.drainDeadline === undefined) this.drainDeadline = Date.parse(managedNow(this.clock)) + this.limits.drainTimeoutMs;
      this.stopProducer();
    } catch (error) {
      this.handle(error);
    }
  }

  evidence(metric: CoverageMetric): CoverageEvidence {
    const row = this.current();
    if (!row || (metric !== 'input_total' && metric !== 'output_total')) throw new Error('managed_missing_evidence');
    return runEvidence(this.store, row, metric);
  }

  private checkedTime(row: RunRow): string {
    const now = managedNow(this.clock, row);
    const deadline = row.state === 'draining' && this.drainDeadline !== undefined ? this.drainDeadline : Date.parse(row.started_at) + this.limits.runTimeoutMs;
    if (Date.parse(now) >= deadline) throw new ManagedFailure('timeout');
    return now;
  }
  private authorize(row: RunRow): void {
    assertScope(this.store, row);
    const identity = producerIdentitySchema.safeParse(this.producer?.identity);
    if (!identity.success || JSON.stringify(identity.data) !== this.identity) throw new ManagedFailure('scope_revoked');
  }
  private current(): RunRow | undefined {
    if (!this.input) return undefined;
    const row = runRow(this.store, this.input.runId);
    return row?.task_id === this.input.taskId && row.session_id === this.input.sessionId ? row : undefined;
  }
  private transact<T>(action: (row: RunRow) => T): T {
    if (this.busy) throw new Error('managed_busy');
    this.busy = true;
    try {
      return this.store.transaction(() => {
        if (!this.input) throw new ManagedFailure('scope_revoked');
        lockTask(this.store, this.input.taskId);
        const row = this.current();
        if (!row) throw new ManagedFailure('scope_revoked');
        return action(row);
      });
    } finally {
      this.busy = false;
    }
  }
  private stopProducer(): void {
    if (this.stopped || !this.producer) return;
    this.stopped = true;
    try {
      this.producer.stop();
    } catch {
      /* No raw producer diagnostics escape. */
    }
  }
  private fail(reason: StopReason): void {
    this.failed = true;
    try {
      this.transact(row => {
        // If persistence itself failed, retain at least the existing unresolved run.
        // Restart fencing will interrupt it; this controller can never seal it again.
        let now = row.updated_at;
        try {
          now = managedNow(this.clock, row);
        } catch {
          /* Keep the last valid clock. */
        }
        interruptRun(this.store, row, reason, now);
      });
    } catch {
      /* Revoked/deleted or unavailable store: no further read or release. */
    }
    this.stopProducer();
  }
  private handle(error: unknown): never {
    const reason = error instanceof ManagedFailure ? error.reason : 'storage_error';
    this.fail(reason);
    throw new ManagedFailure(reason);
  }
}
