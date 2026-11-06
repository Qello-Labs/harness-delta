ALTER TABLE ordinary_window_activations ADD COLUMN decision_ref TEXT;
ALTER TABLE ordinary_window_activations ADD COLUMN decision_kind TEXT CHECK(decision_kind IN ('product','trial'));
ALTER TABLE ordinary_window_activations ADD COLUMN trial_task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE;
ALTER TABLE ordinary_window_activations ADD COLUMN trial_native_root_id TEXT;
ALTER TABLE ordinary_window_activations ADD COLUMN trial_project_root TEXT;
ALTER TABLE ordinary_window_activations ADD COLUMN trial_expires_at TEXT;
ALTER TABLE ordinary_window_activations ADD COLUMN trial_token_limit INTEGER;
ALTER TABLE ordinary_window_activations ADD COLUMN trial_tokens_consumed INTEGER NOT NULL DEFAULT 0 CHECK(trial_tokens_consumed>=0);
ALTER TABLE ordinary_window_activations ADD COLUMN revocation_reason TEXT
  CHECK(revocation_reason IN ('operator_revoked','trial_completed','trial_failed','trial_expired','trial_budget_exhausted'));

CREATE TRIGGER immutable_ordinary_window_decision
BEFORE UPDATE OF decision_ref,decision_kind,trial_task_id,trial_native_root_id,
  trial_project_root,trial_expires_at,trial_token_limit ON ordinary_window_activations
BEGIN SELECT RAISE(ABORT,'ordinary_configuration_changed'); END;

CREATE TRIGGER ordinary_window_decision_scope
BEFORE INSERT ON ordinary_window_activations
WHEN NEW.decision_kind IS NOT NULL AND (
  NEW.decision_ref IS NULL OR
  (NEW.decision_kind='product' AND (NEW.trial_task_id IS NOT NULL OR
    NEW.trial_native_root_id IS NOT NULL OR NEW.trial_project_root IS NOT NULL OR
    NEW.trial_expires_at IS NOT NULL OR NEW.trial_token_limit IS NOT NULL OR NEW.trial_tokens_consumed!=0)) OR
  (NEW.decision_kind='trial' AND (NEW.trial_task_id IS NULL OR
    NEW.trial_native_root_id IS NULL OR NEW.trial_project_root IS NULL OR
    NEW.trial_expires_at IS NULL OR NEW.trial_expires_at<=NEW.decided_at OR
    NEW.trial_token_limit IS NULL OR NEW.trial_token_limit<=0 OR
    NEW.trial_token_limit>9007199254740991 OR NEW.trial_tokens_consumed>NEW.trial_token_limit OR
    NOT EXISTS(SELECT 1 FROM tasks t JOIN projects p ON p.id=t.project_id
      WHERE t.id=NEW.trial_task_id AND t.project_id=NEW.project_id AND p.local_root=NEW.trial_project_root)))
)
BEGIN SELECT RAISE(ABORT,'binding_scope_mismatch'); END;

CREATE TRIGGER ordinary_window_trial_budget
BEFORE UPDATE OF trial_tokens_consumed ON ordinary_window_activations
WHEN NEW.trial_tokens_consumed<OLD.trial_tokens_consumed OR
  NEW.trial_tokens_consumed>COALESCE(NEW.trial_token_limit,0) OR
  OLD.revoked_at IS NOT NULL
BEGIN SELECT RAISE(ABORT,'binding_window_trial_budget_exhausted'); END;

CREATE TRIGGER immutable_ordinary_window_revocation_reason
BEFORE UPDATE OF revocation_reason ON ordinary_window_activations
WHEN OLD.revocation_reason IS NOT NULL AND NEW.revocation_reason IS NOT OLD.revocation_reason
BEGIN SELECT RAISE(ABORT,'binding_scope_revoked'); END;
