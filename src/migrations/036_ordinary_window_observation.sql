-- Store runs this rebuild inside its migration transaction with foreign keys on.
-- Remove references before the swap; deletion must not create forget receipts.
DROP TRIGGER ordinary_selected_root_scope;
DROP TRIGGER binding_segment_scope;
DROP TRIGGER immutable_binding_segment_owner;
DROP TRIGGER forget_deleted_observation_segment;

CREATE TABLE next_binding_root_segments (
  root_session_id TEXT PRIMARY KEY NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES ordinary_tasks(task_id) ON DELETE CASCADE,
  product TEXT NOT NULL CHECK(product IN ('codex','claude_code')),
  native_root_id TEXT NOT NULL,
  project_root TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('acquiring','observing','paused','stopping','closed')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
  observer_identity TEXT,
  opened_at TEXT NOT NULL,
  baseline_at TEXT,
  closed_at TEXT
);
INSERT INTO next_binding_root_segments(
  root_session_id,task_id,product,native_root_id,project_root,state,revision,
  observer_identity,opened_at,baseline_at,closed_at
)
SELECT root_session_id,task_id,product,native_root_id,project_root,state,revision,
  observer_identity,opened_at,baseline_at,closed_at FROM binding_root_segments;
DROP TABLE binding_root_segments;
ALTER TABLE next_binding_root_segments RENAME TO binding_root_segments;

CREATE UNIQUE INDEX binding_segment_task_owner ON binding_root_segments(task_id) WHERE state!='closed';
CREATE UNIQUE INDEX binding_segment_native_owner ON binding_root_segments(product,native_root_id) WHERE state!='closed';

CREATE TRIGGER binding_segment_scope
BEFORE INSERT ON binding_root_segments
WHEN NOT EXISTS(SELECT 1 FROM sessions WHERE id=NEW.root_session_id AND task_id=NEW.task_id AND parent_id IS NULL)
BEGIN SELECT RAISE(ABORT,'binding_scope_mismatch'); END;

CREATE TABLE ordinary_window_selections (
  task_id TEXT PRIMARY KEY NOT NULL REFERENCES ordinary_tasks(task_id) ON DELETE CASCADE,
  selection TEXT NOT NULL CHECK(json_valid(selection)),
  selection_hash TEXT NOT NULL CHECK(length(selection_hash)=64)
);
CREATE TRIGGER immutable_ordinary_window_selection
BEFORE UPDATE ON ordinary_window_selections
BEGIN SELECT RAISE(ABORT,'ordinary_configuration_changed'); END;

CREATE TABLE ordinary_window_segments (
  root_session_id TEXT PRIMARY KEY NOT NULL REFERENCES binding_root_segments(root_session_id) ON DELETE CASCADE,
  selection_hash TEXT NOT NULL CHECK(length(selection_hash)=64),
  proof TEXT NOT NULL CHECK(json_valid(proof)),
  coverage TEXT NOT NULL CHECK(json_valid(coverage))
);
CREATE TRIGGER immutable_ordinary_window_proof
BEFORE UPDATE OF root_session_id,selection_hash,proof ON ordinary_window_segments
BEGIN SELECT RAISE(ABORT,'binding_identity_mismatch'); END;

CREATE TABLE ordinary_window_activations (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  product TEXT NOT NULL CHECK(product IN ('codex','claude_code')),
  source TEXT NOT NULL CHECK(source IN ('codex_binding','claude_binding')),
  policy_id TEXT NOT NULL,
  policy_revision TEXT NOT NULL,
  policy_digest TEXT NOT NULL CHECK(length(policy_digest)=64),
  evidence_mode TEXT NOT NULL CHECK(evidence_mode IN ('source_only','publisher_verified_local_pin')),
  accepted_risks TEXT NOT NULL CHECK(json_valid(accepted_risks)),
  implementation_revision TEXT NOT NULL,
  evidence_ref TEXT NOT NULL,
  review_ref TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY(project_id,product,source,policy_id,policy_revision,policy_digest,evidence_mode)
);
CREATE TRIGGER immutable_ordinary_window_activation
BEFORE UPDATE OF project_id,product,source,policy_id,policy_revision,policy_digest,evidence_mode,
  accepted_risks,implementation_revision,evidence_ref,review_ref,decided_at ON ordinary_window_activations
BEGIN SELECT RAISE(ABORT,'ordinary_configuration_changed'); END;
CREATE TRIGGER no_ordinary_window_unrevoke
BEFORE UPDATE OF revoked_at ON ordinary_window_activations
WHEN OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at
BEGIN SELECT RAISE(ABORT,'binding_scope_revoked'); END;

CREATE TABLE ordinary_window_forget_fences (
  product TEXT NOT NULL,
  native_session_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  PRIMARY KEY(product,native_session_id,task_id)
);
CREATE TABLE binding_native_tombstones (
  product TEXT NOT NULL CHECK(product IN ('codex','claude_code')),
  native_session_id TEXT NOT NULL,
  PRIMARY KEY(product,native_session_id)
);
INSERT OR IGNORE INTO binding_native_tombstones(product,native_session_id)
SELECT product,native_session_id FROM session_binding_forgets;
-- Drained legacy deletions retain no reliable product/native-ID distinction.
INSERT OR IGNORE INTO binding_native_tombstones(product,native_session_id)
SELECT products.product,t.id FROM tombstones t
CROSS JOIN (SELECT 'codex' AS product UNION ALL SELECT 'claude_code') products
WHERE t.kind='session';
CREATE TRIGGER tombstone_deleted_binding_native_root
BEFORE DELETE ON binding_root_segments
BEGIN
  INSERT OR IGNORE INTO binding_native_tombstones(product,native_session_id)
  VALUES (OLD.product,OLD.native_root_id);
END;
CREATE TRIGGER remember_ordinary_window_owner
AFTER INSERT ON binding_root_segments
WHEN EXISTS(SELECT 1 FROM ordinary_window_selections WHERE task_id=NEW.task_id)
BEGIN
  INSERT OR IGNORE INTO ordinary_window_forget_fences(product,native_session_id,task_id)
  VALUES (NEW.product,NEW.native_root_id,NEW.task_id);
END;

CREATE TRIGGER immutable_binding_segment_owner
BEFORE UPDATE OF root_session_id,task_id,product,native_root_id,project_root,opened_at ON binding_root_segments
BEGIN SELECT RAISE(ABORT,'binding_identity_mismatch'); END;

CREATE TRIGGER forget_deleted_observation_segment
BEFORE DELETE ON binding_root_segments
BEGIN
  INSERT OR IGNORE INTO tombstones(kind,id,deleted_at)
  VALUES ('session',OLD.native_root_id,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
  INSERT OR IGNORE INTO session_binding_forgets(product,native_session_id,task_id,project_root)
  VALUES (OLD.product,OLD.native_root_id,OLD.task_id,OLD.project_root);
  UPDATE session_bindings SET state='stopped',cursor=NULL
  WHERE root_id IN(SELECT root_session_id FROM binding_root_segments
    WHERE product=OLD.product AND native_root_id=OLD.native_root_id AND state!='closed');
  UPDATE tasks SET state='paused',generation=generation+1,last_transition_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE state='active' AND id IN(SELECT task_id FROM binding_root_segments
    WHERE product=OLD.product AND native_root_id=OLD.native_root_id AND state!='closed');
  UPDATE active_intervals SET ended_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE ended_at IS NULL AND task_id IN(SELECT task_id FROM binding_root_segments
    WHERE product=OLD.product AND native_root_id=OLD.native_root_id AND state!='closed');
  UPDATE binding_root_segments SET state='paused',revision=revision+1,observer_identity=NULL
  WHERE product=OLD.product AND native_root_id=OLD.native_root_id AND state!='closed';
END;

CREATE TRIGGER ordinary_selected_root_scope
BEFORE UPDATE OF selected_root_id ON ordinary_tasks
WHEN NEW.selected_root_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM binding_root_segments WHERE root_session_id=NEW.selected_root_id
    AND task_id=NEW.task_id AND state!='closed'
)
BEGIN SELECT RAISE(ABORT,'binding_scope_mismatch'); END;
