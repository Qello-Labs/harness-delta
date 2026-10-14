ALTER TABLE source_compatibility_blocks RENAME TO previous_source_compatibility_blocks;
CREATE TABLE source_compatibility_blocks (
  product TEXT NOT NULL CHECK(product IN ('codex','claude_code')),
  product_version TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('file','codex_workflow','claude_workflow','codex_binding','claude_binding')),
  reason TEXT NOT NULL CHECK(reason IN ('contract_failed','semantic_incompatibility')),
  PRIMARY KEY(product, product_version, source)
);
INSERT INTO source_compatibility_blocks
SELECT product, product_version, source, reason FROM previous_source_compatibility_blocks;
DROP TABLE previous_source_compatibility_blocks;

CREATE TABLE binding_root_segments (
  root_session_id TEXT PRIMARY KEY NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES ordinary_tasks(task_id) ON DELETE CASCADE,
  product TEXT NOT NULL CHECK(product='claude_code'),
  native_root_id TEXT NOT NULL,
  project_root TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('acquiring','observing','paused','stopping','closed')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
  observer_identity TEXT,
  opened_at TEXT NOT NULL,
  baseline_at TEXT,
  closed_at TEXT
);
CREATE UNIQUE INDEX binding_segment_task_owner ON binding_root_segments(task_id) WHERE state!='closed';
CREATE UNIQUE INDEX binding_segment_native_owner ON binding_root_segments(product,native_root_id) WHERE state!='closed';
CREATE UNIQUE INDEX binding_segment_native_member ON session_bindings(
  root_id,json_extract(identity,'$.product'),json_extract(identity,'$.sessionId')
);

CREATE TRIGGER binding_segment_scope
BEFORE INSERT ON binding_root_segments
WHEN NOT EXISTS(SELECT 1 FROM sessions WHERE id=NEW.root_session_id AND task_id=NEW.task_id AND parent_id IS NULL)
BEGIN SELECT RAISE(ABORT,'binding_scope_mismatch'); END;

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

CREATE TRIGGER immutable_ordinary_session_owner
BEFORE UPDATE OF id,project_id,task_id,parent_id ON sessions
WHEN EXISTS(SELECT 1 FROM ordinary_tasks WHERE task_id=OLD.task_id)
BEGIN SELECT RAISE(ABORT,'binding_identity_mismatch'); END;

CREATE TRIGGER immutable_ordinary_binding_identity
BEFORE UPDATE OF session_id,task_id,root_id,identity,relation_evidence_id ON session_bindings
WHEN EXISTS(SELECT 1 FROM ordinary_tasks WHERE task_id=OLD.task_id)
BEGIN SELECT RAISE(ABORT,'binding_identity_mismatch'); END;
