import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson } from './reports/comparison-snapshot.js';
import {
  InstrumentedGateReceiptSchema, InstrumentedProducerProfileSchema,
  InstrumentedProducerRecordSchema, InstrumentedRunControlSchema, InstrumentedWindowSealSchema,
  type InstrumentedGateReceipt, type InstrumentedProducerProfile, type InstrumentedProducerRecord,
  type InstrumentedReason, type InstrumentedRunControl, type InstrumentedWindowSeal,
} from './instrumented-codex-contracts.js';
import { TimestampSchema } from './contracts.js';
import type { Store } from './store.js';
import { readPriceTable } from './pricing.js';
import { readPriceBasis } from './price-catalog-store.js';
import { ChildProcess } from 'node:child_process';
import { resolveInstrumentedBuildIdentity } from './instrumented-codex-build-identity.js';
import { InstrumentedLaunchReceiptSchema, InstrumentedRetirementReceiptSchema } from './instrumented-codex-contracts.js';
import { Lifecycle } from './lifecycle.js';
import { parseProtocol } from './flexible-contracts.js';

type PreparationInput = {
  readonly control: InstrumentedRunControl;
  readonly profile: InstrumentedProducerProfile;
  readonly producerInstanceId: string;
};

type RunRow = {
  id: string; task_id: string; project_id: string; root_session_id: string;
  task_generation: number; producer_instance_id: string; control: string; profile: string;
  state: InstrumentedRunControl['state']; producer_sequence: number;
  producer_hash: string | null; control_sequence: number; reason_codes: string;
};
type MemberRow = {
  id: string; session_id: string; native_session_id: string; parent_id: string | null;
  ready_receipt_id: string; close_receipt_id: string | null;
  final_record_sequence: number | null; final_record_hash: string | null;
};
type AttemptRow = {
  id: string; member_id: string; operation_id: string;
  state: 'reserved' | 'dispatched' | 'not_dispatched' | 'terminal';
};
type SourceErrorCode = 'invalid_record' | 'inactive_scope' | 'invalid_control' |
  'unowned_record' | 'record_gap' | 'record_conflict' | 'unknown_member' |
  'topology_mismatch' | 'invalid_operation' | 'invalid_attempt' | 'missing_member_close' |
  'durability_unavailable' | 'price_conflict';

export class InstrumentedAccountingError extends Error {
  readonly name = 'InstrumentedAccountingError';
  constructor(readonly code: SourceErrorCode) { super(code); }
}

export function instrumentedMetadataHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** The receiver owns permits; the native producer cannot erase an outstanding dispatch. */
export class InstrumentedAccounting {
  private freshTaskStart = false;

  constructor(
    private readonly store: Store,
    readonly runId: string,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  static prepare(store: Store, input: PreparationInput,
    clock: () => string = () => new Date().toISOString()): InstrumentedAccounting {
    this.requireDurability(store);
    return this.prepareRows(store, input, clock);
  }

  static prepareFreshTask(store: Store, input: PreparationInput,
    clock: () => string = () => new Date().toISOString()): InstrumentedAccounting {
    this.requireDurability(store);
    return store.immediateTransaction(() => {
      const lifecycle = new Lifecycle(store, clock);
      const task = lifecycle.task(input.control.task_id);
      if (task.state !== 'registered' || task.generation !== 0 ||
          input.control.task_generation !== 0 ||
          store.get('SELECT id FROM sessions WHERE task_id=? AND id!=?',
            [task.id, input.control.root_session_id]) ||
          store.get('SELECT id FROM active_intervals WHERE task_id=?', [task.id]) ||
          store.get('SELECT id FROM events WHERE task_id=?', [task.id]) ||
          store.get('SELECT id FROM instrumented_codex_runs WHERE task_id=?', [task.id]) ||
          store.get('SELECT id FROM observation_gaps WHERE task_id=?', [task.id])) {
        throw new InstrumentedAccountingError('inactive_scope');
      }
      lifecycle.start(task.id);
      const accounting = this.prepareRows(store, {
        ...input, control: { ...input.control, task_generation: lifecycle.task(task.id).generation },
      }, clock);
      accounting.freshTaskStart = true;
      return accounting;
    });
  }

  private static requireDurability(store: Store): void {
    // FULL plus fullfsync gives the macOS receiver acknowledgment its own durability boundary.
    store.execute('PRAGMA synchronous=FULL', []);
    store.execute('PRAGMA fullfsync=ON', []);
    if (store.get<{ synchronous: number }>('PRAGMA synchronous')?.synchronous !== 2 ||
        store.get<{ fullfsync: number }>('PRAGMA fullfsync')?.fullfsync !== 1) {
      throw new InstrumentedAccountingError('durability_unavailable');
    }
  }

  private static prepareRows(store: Store, input: PreparationInput,
    clock: () => string): InstrumentedAccounting {
    const control = InstrumentedRunControlSchema.parse(input.control);
    const profile = InstrumentedProducerProfileSchema.parse(input.profile);
    if (control.state !== 'prepared' || control.control_sequence !== 0 ||
        control.opened_at !== null || control.closed_at !== null ||
        control.profile_id !== profile.profile_id ||
        control.producer_manifest_hash !== profile.build_manifest_digest) {
      throw new InstrumentedAccountingError('invalid_control');
    }
    store.immediateTransaction(() => {
      const scope = store.get<{ generation: number; product: string | null; product_version: string | null }>(
        "SELECT t.generation,s.product,s.product_version FROM tasks t JOIN sessions s ON s.task_id=t.id AND s.project_id=t.project_id WHERE t.id=? AND t.project_id=? AND t.state='active' AND s.id=? AND NOT EXISTS (SELECT 1 FROM tombstones x WHERE (x.kind='task' AND x.id=t.id) OR (x.kind='project' AND x.id=t.project_id) OR (x.kind='session' AND x.id=s.id))",
        [control.task_id, control.project_id, control.root_session_id]);
      if (!scope || scope.generation !== control.task_generation || scope.product !== 'codex' ||
          scope.product_version !== profile.product_version) {
        throw new InstrumentedAccountingError('inactive_scope');
      }
      const assigned = store.get<{ settings: string }>(
        'SELECT p.settings FROM comparison_assignments a JOIN comparison_protocols p ON p.id=a.protocol_id WHERE a.task_id=?',
        [control.task_id]);
      const protocol = assigned ? parseProtocol(JSON.parse(assigned.settings) as unknown) : null;
      if (protocol?.schema_version === 2 && protocol.price_table_id !== control.price_table_id) {
        throw new InstrumentedAccountingError('price_conflict');
      }
      if (instrumentedMetadataHash(readPriceTable(store, control.price_table_id)) !== control.price_table_hash ||
          control.price_basis_hash !== null && readPriceBasis(store, control.price_table_id).basis_hash !== control.price_basis_hash) {
        throw new InstrumentedAccountingError('price_conflict');
      }
      store.execute('INSERT INTO instrumented_codex_runs(id,task_id,project_id,root_session_id,task_generation,producer_instance_id,control,profile,state) VALUES (?,?,?,?,?,?,?,?,?)',
        [control.run_id, control.task_id, control.project_id, control.root_session_id, control.task_generation,
          input.producerInstanceId, JSON.stringify(control), JSON.stringify(profile), 'prepared']);
    });
    return new InstrumentedAccounting(store, control.run_id, clock);
  }

  control(): InstrumentedRunControl {
    const run = this.run();
    return { ...InstrumentedRunControlSchema.parse(JSON.parse(run.control)), state: run.state };
  }

  producerInstanceId(): string { return this.run().producer_instance_id; }

  recordTransportFailure(reason: InstrumentedReason): void {
    const run = this.store.get<{ state: string }>(
      'SELECT state FROM instrumented_codex_runs WHERE id=?', [this.runId]);
    if (run && run.state !== 'sealed' && run.state !== 'revoked') this.addReason(reason);
  }

  recordLaunch(binaryPath: string, child: ChildProcess) {
    return this.store.immediateTransaction(() => {
      this.assertActive();
      const run = this.run();
      const profile = this.profile();
      const control = this.control();
      if (!(child instanceof ChildProcess) || child.pid === undefined ||
          child.spawnfile !== binaryPath || child.exitCode !== null || child.signalCode !== null) {
        throw new InstrumentedAccountingError('invalid_control');
      }
      const identity = resolveInstrumentedBuildIdentity(this.store, binaryPath, profile);
      const receipt = InstrumentedLaunchReceiptSchema.parse({
        schema_version: 1, receipt_id: randomUUID(), run_id: run.id,
        binary_sha256: identity.profile.binary_sha256, manifest_hash: identity.profile.build_manifest_digest,
        process_id: child.pid, started_at: this.clock(),
        start_kind: this.freshTaskStart ? 'task_start' : 'work_window',
        configuration_receipt_hash: instrumentedMetadataHash([control.configuration_receipt_id, identity.profile]),
        authorization_receipt_hash: instrumentedMetadataHash([
          control.task_id, control.task_generation, control.authorization_receipt_id,
        ]),
      });
      this.store.execute(
        'INSERT INTO instrumented_codex_launch_receipts(run_id,receipt_id,binary_sha256,manifest_hash,process_id,started_at,start_kind,payload) VALUES (?,?,?,?,?,?,?,?)',
        [receipt.run_id, receipt.receipt_id, receipt.binary_sha256, receipt.manifest_hash,
          receipt.process_id, receipt.started_at, receipt.start_kind, JSON.stringify(receipt)]);
      return receipt;
    });
  }

  recordRetirement(child: ChildProcess) {
    return this.store.immediateTransaction(() => {
      const run = this.run();
      const launch = this.store.get<{ receipt_id: string; process_id: number }>(
        'SELECT receipt_id,process_id FROM instrumented_codex_launch_receipts WHERE run_id=?', [run.id]);
      if (!(child instanceof ChildProcess) || child.exitCode !== 0 || child.signalCode !== null ||
          !launch || launch.process_id !== child.pid || run.state !== 'sealed') {
        throw new InstrumentedAccountingError('invalid_control');
      }
      const receipt = InstrumentedRetirementReceiptSchema.parse({
        schema_version: 1, run_id: run.id, launch_receipt_id: launch.receipt_id,
        process_id: child.pid, exit_code: child.exitCode, retired_at: this.clock(),
        final_producer_sequence: run.producer_sequence,
      });
      this.store.execute(
        'INSERT INTO instrumented_codex_retirements(run_id,launch_receipt_id,process_id,exit_code,retired_at,final_producer_sequence,payload) VALUES (?,?,?,?,?,?,?)',
        [receipt.run_id, receipt.launch_receipt_id, receipt.process_id, receipt.exit_code,
          receipt.retired_at, receipt.final_producer_sequence, JSON.stringify(receipt)]);
      return receipt;
    });
  }

  /** Check before decoding a frame: generation revocation also forbids late metadata access. */
  assertActive(): void {
    const run = this.run();
    const task = this.store.get<{ state: string; generation: number }>(
      'SELECT state,generation FROM tasks WHERE id=?', [run.task_id]);
    if (!task || task.state !== 'active' || task.generation !== run.task_generation ||
        run.state === 'revoked' || run.state === 'sealed') {
      throw new InstrumentedAccountingError('inactive_scope');
    }
  }

  receive(input: unknown): InstrumentedGateReceipt {
    this.assertActive();
    const parsed = InstrumentedProducerRecordSchema.safeParse(input);
    if (!parsed.success) {
      this.addReason('record_conflict');
      throw new InstrumentedAccountingError('invalid_record');
    }
    const record = parsed.data;
    const hash = instrumentedMetadataHash(record);
    const run = this.run();
    if (record.run_id !== run.id || record.producer_instance_id !== run.producer_instance_id ||
        record.task_generation !== run.task_generation) {
      this.addReason('record_conflict');
      throw new InstrumentedAccountingError('unowned_record');
    }
    const previous = this.store.get<{ record_hash: string; receipt: string }>(
      'SELECT record_hash,receipt FROM instrumented_codex_records WHERE run_id=? AND sequence=?',
      [run.id, record.sequence]);
    if (previous) {
      if (previous.record_hash !== hash) {
        this.addReason('record_conflict');
        throw new InstrumentedAccountingError('record_conflict');
      }
      return InstrumentedGateReceiptSchema.parse(JSON.parse(previous.receipt));
    }
    if (record.sequence !== run.producer_sequence + 1 || record.previous_record_hash !== run.producer_hash) {
      this.addReason('record_gap');
      throw new InstrumentedAccountingError('record_gap');
    }
    try { return this.store.immediateTransaction(() => {
      this.assertActive();
      const now = TimestampSchema.parse(this.clock());
      const receiptId = randomUUID();
      const body = this.applyRecord(record, receiptId, now);
      const receipt = InstrumentedGateReceiptSchema.parse({
        schema_version: 1, receipt_id: receiptId, run_id: run.id,
        control_sequence: run.control_sequence + 1, recorded_at: now,
        body: body ?? { kind: 'record_committed', producer_sequence: record.sequence, producer_record_hash: hash },
      });
      this.store.execute('INSERT INTO instrumented_codex_receipts(id,run_id,sequence,payload) VALUES (?,?,?,?)',
        [receipt.receipt_id, run.id, receipt.control_sequence, JSON.stringify(receipt)]);
      this.store.execute('INSERT INTO instrumented_codex_records(run_id,sequence,record_hash,member_id,received_at,payload,receipt) VALUES (?,?,?,?,?,?,?)',
        [run.id, record.sequence, hash, record.member_id, now, JSON.stringify(record), JSON.stringify(receipt)]);
      this.store.execute('UPDATE instrumented_codex_runs SET producer_sequence=?,producer_hash=?,control_sequence=? WHERE id=?',
        [record.sequence, hash, receipt.control_sequence, run.id]);
      const current = this.control();
      this.store.execute('UPDATE instrumented_codex_runs SET control=? WHERE id=?',
        [JSON.stringify({ ...current, control_sequence: receipt.control_sequence }), run.id]);
      return receipt;
    }); } catch (error) {
      if (error instanceof InstrumentedAccountingError) {
        if (error.code === 'topology_mismatch') this.addReason('topology_mismatch');
        else if (error.code !== 'inactive_scope') this.addReason('record_conflict');
      } else this.addReason('record_conflict');
      throw error;
    }
  }

  private applyRecord(record: InstrumentedProducerRecord, receiptId: string, now: string): InstrumentedGateReceipt['body'] | null {
    const run = this.run();
    const body = record.body;
    if (body.kind === 'unsupported_operation') {
      this.addReason(body.reason);
      return null;
    }
    if (body.kind === 'member_ready') {
      if (run.state !== 'prepared' && run.state !== 'open') throw new InstrumentedAccountingError('invalid_control');
      if (body.configuration_receipt_id !== this.control().configuration_receipt_id) {
        throw new InstrumentedAccountingError('invalid_control');
      }
      let sessionId = run.root_session_id;
      if (body.parent_member_id === null) {
        if (record.member_id !== run.root_session_id || body.child_reservation_id !== null ||
            this.store.get('SELECT id FROM instrumented_codex_members WHERE run_id=?', [run.id])) {
          throw new InstrumentedAccountingError('topology_mismatch');
        }
      } else {
        const reservation = this.store.get<{ state: string; parent_id: string }>(
          'SELECT state,parent_id FROM instrumented_codex_child_reservations WHERE id=? AND run_id=?',
          [body.child_reservation_id, run.id]);
        const parent = this.member(body.parent_member_id);
        if (!reservation || reservation.state !== 'reserved' || reservation.parent_id !== parent.id ||
            parent.parent_id !== null) throw new InstrumentedAccountingError('topology_mismatch');
        sessionId = randomUUID();
        this.store.execute('INSERT INTO sessions(id,project_id,task_id,parent_id,product,product_version) VALUES (?,?,?,?,?,?)',
          [sessionId, run.project_id, run.task_id, parent.session_id, 'codex', this.profile().product_version]);
        this.store.execute("UPDATE instrumented_codex_child_reservations SET state='admitted' WHERE id=?",
          [body.child_reservation_id]);
      }
      this.store.execute('INSERT INTO instrumented_codex_members(run_id,id,session_id,native_session_id,parent_id,child_reservation_id,ready_receipt_id) VALUES (?,?,?,?,?,?,?)',
        [run.id, record.member_id, sessionId, body.native_session_id, body.parent_member_id, body.child_reservation_id, receiptId]);
      if (run.state === 'prepared') {
        const control = this.control();
        this.store.execute("UPDATE instrumented_codex_runs SET state='open',control=? WHERE id=?",
          [JSON.stringify({ ...control, state: 'open', opened_at: now }), run.id]);
      }
      return { kind: 'member_admitted', member_id: record.member_id, session_id: sessionId };
    }
    const member = this.member(record.member_id);
    if (member.close_receipt_id !== null) throw new InstrumentedAccountingError('unknown_member');
    switch (body.kind) {
      case 'child_reserve': {
        const reservations = this.store.get<{ count: number }>(
          'SELECT count(*) AS count FROM instrumented_codex_child_reservations WHERE run_id=?', [run.id]);
        if (run.state !== 'open' || body.parent_member_id !== member.id ||
            member.parent_id !== null || (reservations?.count ?? 0) >= 2) {
          throw new InstrumentedAccountingError('topology_mismatch');
        }
        const id = randomUUID();
        this.store.execute("INSERT INTO instrumented_codex_child_reservations(id,run_id,parent_id,state) VALUES (?,?,?,'reserved')",
          [id, run.id, member.id]);
        return { kind: 'child_reserved', child_reservation_id: id, parent_member_id: member.id };
      }
      case 'child_cancel': {
        const reservation = this.store.get<{ parent_id: string; state: string }>(
          'SELECT parent_id,state FROM instrumented_codex_child_reservations WHERE id=? AND run_id=?',
          [body.child_reservation_id, run.id]);
        if (!reservation || reservation.parent_id !== member.id || reservation.state !== 'reserved') {
          throw new InstrumentedAccountingError('topology_mismatch');
        }
        this.store.execute("UPDATE instrumented_codex_child_reservations SET state='cancelled' WHERE id=?",
          [body.child_reservation_id]);
        return { kind: 'child_cancelled', child_reservation_id: body.child_reservation_id };
      }
      case 'operation_open':
        if (run.state !== 'open' || body.configuration_revision !== this.control().configuration_receipt_id ||
            this.store.get('SELECT id FROM instrumented_codex_operations WHERE run_id=? AND id=?', [run.id, body.operation_id])) {
          throw new InstrumentedAccountingError('invalid_operation');
        }
        if (body.operation_class !== 'generation' || body.transport_class !== 'http_responses') {
          this.addReason('unsupported_operation');
        }
        this.store.execute("INSERT INTO instrumented_codex_operations(id,run_id,member_id,payload,state) VALUES (?,?,?,?,'open')",
          [body.operation_id, run.id, member.id, JSON.stringify(body)]);
        return null;
      case 'attempt_reserve': {
        const operation = this.store.get<{ member_id: string; state: string }>(
          'SELECT member_id,state FROM instrumented_codex_operations WHERE id=? AND run_id=?', [body.operation_id, run.id]);
        if (run.state !== 'open' || !operation || operation.member_id !== member.id || operation.state !== 'open') {
          throw new InstrumentedAccountingError('invalid_operation');
        }
        if (body.retry_parent_attempt_id !== null) {
          const parent = this.attempt(body.retry_parent_attempt_id, member.id);
          if (parent.operation_id !== body.operation_id) throw new InstrumentedAccountingError('invalid_attempt');
        }
        const id = randomUUID();
        this.store.execute("INSERT INTO instrumented_codex_attempts(id,run_id,operation_id,member_id,retry_parent_id,reservation_receipt_id,state) VALUES (?,?,?,?,?,?,'reserved')",
          [id, run.id, body.operation_id, member.id, body.retry_parent_attempt_id, receiptId]);
        return { kind: 'attempt_reserved', attempt_id: id, operation_id: body.operation_id,
          member_id: member.id, retry_parent_attempt_id: body.retry_parent_attempt_id };
      }
      case 'dispatch_commit': {
        const attempt = this.attempt(body.attempt_id, member.id);
        if (run.state !== 'open' || attempt.state !== 'reserved') throw new InstrumentedAccountingError('invalid_attempt');
        this.store.execute("UPDATE instrumented_codex_attempts SET state='dispatched',dispatch_receipt_id=? WHERE id=?",
          [receiptId, attempt.id]);
        return { kind: 'dispatch_committed', attempt_id: attempt.id };
      }
      case 'not_dispatched': {
        const attempt = this.attempt(body.attempt_id, member.id);
        if (attempt.state !== 'reserved') throw new InstrumentedAccountingError('invalid_attempt');
        this.store.execute("UPDATE instrumented_codex_attempts SET state='not_dispatched' WHERE id=?", [attempt.id]);
        return { kind: 'not_dispatched', attempt_id: attempt.id };
      }
      case 'attempt_terminal': {
        const attempt = this.attempt(body.attempt_id, member.id);
        if (attempt.state !== 'dispatched') throw new InstrumentedAccountingError('invalid_attempt');
        this.store.execute("UPDATE instrumented_codex_attempts SET state='terminal',terminal_sequence=? WHERE id=?",
          [record.sequence, attempt.id]);
        return null;
      }
      case 'operation_close': {
        const operation = this.store.get<{ member_id: string; state: string }>(
          'SELECT member_id,state FROM instrumented_codex_operations WHERE id=? AND run_id=?', [body.operation_id, run.id]);
        if (!operation || operation.member_id !== member.id || operation.state !== 'open') {
          throw new InstrumentedAccountingError('invalid_operation');
        }
        this.store.execute("UPDATE instrumented_codex_operations SET state='closed' WHERE run_id=? AND id=?", [run.id, body.operation_id]);
        return null;
      }
      case 'close_request': {
        if (run.state !== 'open' || member.parent_id !== null) throw new InstrumentedAccountingError('invalid_control');
        const control = this.control();
        this.store.execute("UPDATE instrumented_codex_runs SET state='closing',control=? WHERE id=?",
          [JSON.stringify({ ...control, state: 'closing', closed_at: now }), run.id]);
        return { kind: 'close_fence', close_fence_id: receiptId };
      }
      case 'member_close': {
        const fence = this.store.get<{ payload: string }>('SELECT payload FROM instrumented_codex_receipts WHERE id=? AND run_id=?',
          [body.close_fence_id, run.id]);
        if (run.state !== 'closing' || !fence ||
            InstrumentedGateReceiptSchema.parse(JSON.parse(fence.payload)).body.kind !== 'close_fence' ||
            body.final_record_sequence !== record.sequence - 1 ||
            body.final_record_hash !== record.previous_record_hash) {
          throw new InstrumentedAccountingError('invalid_control');
        }
        this.store.execute('UPDATE instrumented_codex_members SET close_receipt_id=?,final_record_sequence=?,final_record_hash=? WHERE run_id=? AND id=?',
          [receiptId, record.sequence, instrumentedMetadataHash(record), run.id, member.id]);
        return null;
      }
      default: {
        const unreachable: never = body;
        return unreachable;
      }
    }
  }

  seal(): InstrumentedWindowSeal {
    return this.store.immediateTransaction(() => {
      this.assertActive();
      const run = this.run();
      const control = this.control();
      const members = this.store.all<MemberRow>(
        'SELECT * FROM instrumented_codex_members WHERE run_id=? ORDER BY id', [run.id]);
      if (run.state !== 'closing' || !control.opened_at || !control.closed_at ||
          members.length === 0 || members.some(member => !member.close_receipt_id ||
            member.final_record_sequence === null || member.final_record_hash === null)) {
        throw new InstrumentedAccountingError('missing_member_close');
      }
      const attempts = this.store.all<AttemptRow>(
        'SELECT * FROM instrumented_codex_attempts WHERE run_id=? ORDER BY id', [run.id]);
      const unresolved = attempts.filter(attempt => attempt.state === 'reserved' || attempt.state === 'dispatched');
      if (unresolved.length > 0) this.addReason('unresolved_attempt');
      if (this.store.get("SELECT id FROM instrumented_codex_operations WHERE run_id=? AND state='open'", [run.id]) ||
          this.store.get("SELECT id FROM instrumented_codex_child_reservations WHERE run_id=? AND state='reserved'", [run.id])) {
        this.addReason('missing_member_close');
      }
      const records = this.store.all<{ payload: string }>(
        'SELECT payload FROM instrumented_codex_records WHERE run_id=? ORDER BY sequence', [run.id]);
      const fence = this.store.get<{ sequence: number }>(
        "SELECT sequence FROM instrumented_codex_receipts WHERE run_id=? AND json_extract(payload,'$.body.kind')='close_fence'",
        [run.id]);
      if (!fence) throw new InstrumentedAccountingError('invalid_control');
      const now = TimestampSchema.parse(this.clock());
      const opened = this.store.get<{ sequence: number }>(
        "SELECT sequence FROM instrumented_codex_receipts WHERE run_id=? AND json_extract(payload,'$.body.kind')='member_admitted' AND json_extract(payload,'$.body.member_id')=?",
        [run.id, run.root_session_id]);
      if (!opened) throw new InstrumentedAccountingError('invalid_control');
      const seal = InstrumentedWindowSealSchema.parse({
        schema_version: 1, seal_id: randomUUID(), run_id: run.id,
        task_generation: run.task_generation, profile_id: control.profile_id,
        producer_manifest_hash: control.producer_manifest_hash,
        open_control_sequence: opened.sequence, close_control_sequence: fence.sequence,
        opened_at: control.opened_at, closed_at: control.closed_at, sealed_at: now,
        members: members.map(member => ({
          member_id: member.id, session_id: member.session_id, identity_receipt_hash: instrumentedMetadataHash([
            member.native_session_id, member.session_id, member.parent_id, member.ready_receipt_id,
          ]),
          final_record_sequence: member.final_record_sequence, final_record_hash: member.final_record_hash,
          close_receipt_id: member.close_receipt_id,
        })),
        attempt_ledger_hash: instrumentedMetadataHash(attempts),
        terminal_records_hash: instrumentedMetadataHash(records.map(row => JSON.parse(row.payload) as unknown)),
        lifecycle_evidence_hash: instrumentedMetadataHash([run.task_id, run.task_generation, control.authorization_receipt_id]),
        configuration_evidence_hash: instrumentedMetadataHash([control.configuration_receipt_id, this.profile()]),
        counts: {
          reserved: attempts.length,
          dispatch_committed: attempts.filter(attempt => attempt.state === 'dispatched' || attempt.state === 'terminal').length,
          not_dispatched: attempts.filter(attempt => attempt.state === 'not_dispatched').length,
          terminal: attempts.filter(attempt => attempt.state === 'terminal').length, unresolved: unresolved.length,
        },
        unresolved_attempt_ids: unresolved.map(attempt => attempt.id),
        reason_codes: JSON.parse(this.run().reason_codes) as unknown,
      });
      this.store.execute('INSERT INTO instrumented_codex_seals(id,run_id,sealed_at,payload) VALUES (?,?,?,?)',
        [seal.seal_id, run.id, now, JSON.stringify(seal)]);
      this.store.execute("UPDATE instrumented_codex_runs SET state='sealed',control=? WHERE id=?",
        [JSON.stringify({ ...control, state: 'sealed' }), run.id]);
      return seal;
    });
  }

  private run(): RunRow {
    const run = this.store.get<RunRow>('SELECT * FROM instrumented_codex_runs WHERE id=?', [this.runId]);
    if (!run) throw new InstrumentedAccountingError('inactive_scope');
    return run;
  }
  private profile(): InstrumentedProducerProfile {
    return InstrumentedProducerProfileSchema.parse(JSON.parse(this.run().profile));
  }
  private member(id: string): MemberRow {
    const member = this.store.get<MemberRow>(
      'SELECT * FROM instrumented_codex_members WHERE run_id=? AND id=?', [this.runId, id]);
    if (!member) throw new InstrumentedAccountingError('unknown_member');
    return member;
  }
  private attempt(id: string, memberId: string): AttemptRow {
    const attempt = this.store.get<AttemptRow>(
      'SELECT * FROM instrumented_codex_attempts WHERE id=? AND run_id=? AND member_id=?',
      [id, this.runId, memberId]);
    if (!attempt) throw new InstrumentedAccountingError('invalid_attempt');
    return attempt;
  }
  private addReason(reason: InstrumentedReason): void {
    const reasons = InstrumentedWindowSealSchema.shape.reason_codes.parse(JSON.parse(this.run().reason_codes));
    if (!reasons.includes(reason)) {
      this.store.execute('UPDATE instrumented_codex_runs SET reason_codes=? WHERE id=?',
        [JSON.stringify([...reasons, reason].sort()), this.runId]);
    }
  }
}
