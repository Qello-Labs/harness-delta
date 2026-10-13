CREATE TABLE instrumented_codex_runs (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  root_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  task_generation INTEGER NOT NULL CHECK(task_generation >= 0),
  producer_instance_id TEXT NOT NULL UNIQUE,
  control TEXT NOT NULL,
  profile TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('prepared','open','closing','sealed','revoked')),
  producer_sequence INTEGER NOT NULL DEFAULT 0 CHECK(producer_sequence >= 0),
  producer_hash TEXT,
  control_sequence INTEGER NOT NULL DEFAULT 0 CHECK(control_sequence >= 0),
  reason_codes TEXT NOT NULL DEFAULT '[]'
);
CREATE UNIQUE INDEX instrumented_codex_live_task
ON instrumented_codex_runs(task_id) WHERE state IN ('prepared','open','closing');

CREATE TABLE instrumented_codex_build_identities (
  id TEXT PRIMARY KEY NOT NULL,
  profile_id TEXT NOT NULL,
  binary_sha256 TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  qualification_kind TEXT NOT NULL CHECK(qualification_kind='instrumented_localhost'),
  qualification_hash TEXT NOT NULL,
  qualified_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE(binary_sha256,manifest_hash),
  CHECK(json_extract(payload,'$.id')=id),
  CHECK(json_extract(payload,'$.profile.profile_id')=profile_id),
  CHECK(json_extract(payload,'$.profile.binary_sha256')=binary_sha256),
  CHECK(json_extract(payload,'$.profile.build_manifest_digest')=manifest_hash),
  CHECK(json_extract(payload,'$.qualification_kind')=qualification_kind),
  CHECK(json_extract(payload,'$.qualification_hash')=qualification_hash),
  CHECK(json_extract(payload,'$.qualified_at')=qualified_at)
);
CREATE TRIGGER immutable_instrumented_codex_build
BEFORE UPDATE ON instrumented_codex_build_identities
BEGIN SELECT RAISE(ABORT,'immutable_instrumented_build'); END;
CREATE TRIGGER retained_instrumented_codex_build
BEFORE DELETE ON instrumented_codex_build_identities
BEGIN SELECT RAISE(ABORT,'retained_instrumented_build'); END;

CREATE TABLE instrumented_codex_launch_receipts (
  run_id TEXT PRIMARY KEY NOT NULL REFERENCES instrumented_codex_runs(id) ON DELETE CASCADE,
  receipt_id TEXT NOT NULL UNIQUE,
  binary_sha256 TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  process_id INTEGER NOT NULL CHECK(process_id > 0),
  started_at TEXT NOT NULL,
  start_kind TEXT NOT NULL CHECK(start_kind IN ('task_start','work_window')),
  payload TEXT NOT NULL,
  CHECK(json_extract(payload,'$.run_id')=run_id),
  CHECK(json_extract(payload,'$.receipt_id')=receipt_id),
  CHECK(json_extract(payload,'$.binary_sha256')=binary_sha256),
  CHECK(json_extract(payload,'$.manifest_hash')=manifest_hash),
  CHECK(json_extract(payload,'$.process_id')=process_id),
  CHECK(json_extract(payload,'$.started_at')=started_at),
  CHECK(json_extract(payload,'$.start_kind')=start_kind)
);
CREATE TRIGGER ordered_instrumented_codex_launch
BEFORE INSERT ON instrumented_codex_launch_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM instrumented_codex_runs
  WHERE id=NEW.run_id AND state='prepared' AND producer_sequence=0
)
BEGIN SELECT RAISE(ABORT,'late_instrumented_launch'); END;
CREATE TRIGGER immutable_instrumented_codex_launch
BEFORE UPDATE ON instrumented_codex_launch_receipts
BEGIN SELECT RAISE(ABORT,'immutable_instrumented_launch'); END;
CREATE TRIGGER retained_instrumented_codex_launch
BEFORE DELETE ON instrumented_codex_launch_receipts
WHEN EXISTS (SELECT 1 FROM instrumented_codex_runs WHERE id=OLD.run_id)
BEGIN SELECT RAISE(ABORT,'immutable_instrumented_launch'); END;

CREATE TABLE instrumented_codex_retirements (
  run_id TEXT PRIMARY KEY NOT NULL REFERENCES instrumented_codex_runs(id) ON DELETE CASCADE,
  launch_receipt_id TEXT NOT NULL REFERENCES instrumented_codex_launch_receipts(receipt_id) ON DELETE CASCADE,
  process_id INTEGER NOT NULL CHECK(process_id > 0),
  exit_code INTEGER NOT NULL CHECK(exit_code=0),
  retired_at TEXT NOT NULL,
  final_producer_sequence INTEGER NOT NULL CHECK(final_producer_sequence > 0),
  payload TEXT NOT NULL,
  CHECK(json_extract(payload,'$.run_id')=run_id),
  CHECK(json_extract(payload,'$.launch_receipt_id')=launch_receipt_id),
  CHECK(json_extract(payload,'$.process_id')=process_id),
  CHECK(json_extract(payload,'$.exit_code')=exit_code),
  CHECK(json_extract(payload,'$.retired_at')=retired_at),
  CHECK(json_extract(payload,'$.final_producer_sequence')=final_producer_sequence)
);
CREATE TRIGGER ordered_instrumented_codex_retirement
BEFORE INSERT ON instrumented_codex_retirements
WHEN NOT EXISTS (
  SELECT 1 FROM instrumented_codex_runs r JOIN instrumented_codex_launch_receipts l ON l.run_id=r.id
  WHERE r.id=NEW.run_id AND r.state='sealed' AND r.producer_sequence=NEW.final_producer_sequence
    AND l.receipt_id=NEW.launch_receipt_id AND l.process_id=NEW.process_id
)
BEGIN SELECT RAISE(ABORT,'invalid_instrumented_retirement'); END;
CREATE TRIGGER immutable_instrumented_codex_retirement
BEFORE UPDATE ON instrumented_codex_retirements
BEGIN SELECT RAISE(ABORT,'immutable_instrumented_retirement'); END;

CREATE TABLE instrumented_codex_members (
  run_id TEXT NOT NULL REFERENCES instrumented_codex_runs(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
  native_session_id TEXT NOT NULL UNIQUE,
  parent_id TEXT,
  child_reservation_id TEXT,
  ready_receipt_id TEXT NOT NULL,
  close_receipt_id TEXT,
  final_record_sequence INTEGER,
  final_record_hash TEXT,
  PRIMARY KEY(run_id,id),
  FOREIGN KEY(run_id,parent_id) REFERENCES instrumented_codex_members(run_id,id) ON DELETE CASCADE
);
CREATE TABLE instrumented_codex_child_reservations (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES instrumented_codex_runs(id) ON DELETE CASCADE,
  parent_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('reserved','admitted','cancelled')),
  FOREIGN KEY(run_id,parent_id) REFERENCES instrumented_codex_members(run_id,id) ON DELETE CASCADE
);
CREATE TABLE instrumented_codex_operations (
  id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES instrumented_codex_runs(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('open','closed')),
  PRIMARY KEY(run_id,id),
  FOREIGN KEY(run_id,member_id) REFERENCES instrumented_codex_members(run_id,id) ON DELETE CASCADE
);
CREATE TABLE instrumented_codex_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES instrumented_codex_runs(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  retry_parent_id TEXT REFERENCES instrumented_codex_attempts(id),
  reservation_receipt_id TEXT NOT NULL,
  dispatch_receipt_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('reserved','dispatched','not_dispatched','terminal')),
  terminal_sequence INTEGER,
  FOREIGN KEY(run_id,operation_id) REFERENCES instrumented_codex_operations(run_id,id) ON DELETE CASCADE,
  FOREIGN KEY(run_id,member_id) REFERENCES instrumented_codex_members(run_id,id) ON DELETE CASCADE
);
CREATE TABLE instrumented_codex_records (
  run_id TEXT NOT NULL REFERENCES instrumented_codex_runs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  record_hash TEXT NOT NULL,
  member_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  receipt TEXT NOT NULL,
  PRIMARY KEY(run_id,sequence)
);
CREATE TABLE instrumented_codex_receipts (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES instrumented_codex_runs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  payload TEXT NOT NULL,
  UNIQUE(run_id,sequence)
);
CREATE TABLE instrumented_codex_seals (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL UNIQUE REFERENCES instrumented_codex_runs(id) ON DELETE CASCADE,
  sealed_at TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE TABLE instrumented_codex_cost_snapshots (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES instrumented_codex_runs(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  cutoff TEXT NOT NULL,
  payload TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL
);
CREATE TABLE instrumented_codex_valuations (
  id TEXT PRIMARY KEY NOT NULL,
  snapshot_id TEXT NOT NULL REFERENCES instrumented_codex_cost_snapshots(id) ON DELETE CASCADE,
  target_table_id TEXT NOT NULL REFERENCES price_tables(id),
  payload TEXT NOT NULL
);
CREATE TABLE instrumented_codex_cost_tombstones (
  kind TEXT NOT NULL CHECK(kind IN ('snapshot','valuation')),
  id TEXT NOT NULL,
  PRIMARY KEY(kind,id)
);
CREATE TRIGGER immutable_instrumented_codex_snapshot
BEFORE UPDATE ON instrumented_codex_cost_snapshots
BEGIN SELECT RAISE(ABORT,'immutable_instrumented_snapshot'); END;
CREATE TRIGGER immutable_instrumented_codex_valuation
BEFORE UPDATE ON instrumented_codex_valuations
BEGIN SELECT RAISE(ABORT,'immutable_instrumented_valuation'); END;
CREATE TRIGGER deleted_instrumented_codex_snapshot
BEFORE DELETE ON instrumented_codex_cost_snapshots
BEGIN INSERT OR IGNORE INTO instrumented_codex_cost_tombstones(kind,id) VALUES ('snapshot',OLD.id); END;
CREATE TRIGGER deleted_instrumented_codex_valuation
BEFORE DELETE ON instrumented_codex_valuations
BEGIN INSERT OR IGNORE INTO instrumented_codex_cost_tombstones(kind,id) VALUES ('valuation',OLD.id); END;
CREATE TRIGGER immutable_instrumented_codex_record
BEFORE UPDATE ON instrumented_codex_records
BEGIN SELECT RAISE(ABORT,'immutable_instrumented_record'); END;
CREATE TRIGGER immutable_instrumented_codex_receipt
BEFORE UPDATE ON instrumented_codex_receipts
BEGIN SELECT RAISE(ABORT,'immutable_instrumented_receipt'); END;
CREATE TRIGGER immutable_instrumented_codex_seal
BEFORE UPDATE ON instrumented_codex_seals
BEGIN SELECT RAISE(ABORT,'immutable_instrumented_seal'); END;
CREATE TRIGGER revoke_instrumented_codex_generation
AFTER UPDATE OF generation ON tasks
WHEN NEW.generation != OLD.generation
BEGIN
  UPDATE instrumented_codex_runs SET state='revoked'
  WHERE task_id=NEW.id AND state IN ('prepared','open','closing');
END;
CREATE TRIGGER revoke_instrumented_codex_member_deletion
BEFORE DELETE ON sessions
BEGIN
  UPDATE instrumented_codex_runs SET state='revoked'
  WHERE id IN (SELECT run_id FROM instrumented_codex_members WHERE session_id=OLD.id);
  DELETE FROM instrumented_codex_seals
  WHERE run_id IN (SELECT run_id FROM instrumented_codex_members WHERE session_id=OLD.id);
  DELETE FROM instrumented_codex_cost_snapshots
  WHERE run_id IN (SELECT run_id FROM instrumented_codex_members WHERE session_id=OLD.id);
  DELETE FROM instrumented_codex_records
  WHERE run_id IN (SELECT run_id FROM instrumented_codex_members WHERE session_id=OLD.id);
  DELETE FROM instrumented_codex_receipts
  WHERE run_id IN (SELECT run_id FROM instrumented_codex_members WHERE session_id=OLD.id);
END;
