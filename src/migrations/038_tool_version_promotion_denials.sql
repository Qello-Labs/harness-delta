CREATE TABLE tool_version_promotion_generation (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  generation INTEGER NOT NULL CHECK(generation>=0 AND generation<=9007199254740991)
);
INSERT INTO tool_version_promotion_generation(singleton,generation) VALUES (1,0);

CREATE TABLE tool_version_promotion_denials (
  denial_id TEXT PRIMARY KEY NOT NULL,
  scope_key TEXT NOT NULL,
  key_json TEXT NOT NULL CHECK(json_valid(key_json)),
  reason TEXT NOT NULL CHECK(reason IN ('revoke','retire','invalidate','delete')),
  recorded_at TEXT NOT NULL
);
CREATE INDEX tool_version_promotion_denial_scope ON tool_version_promotion_denials(scope_key);

CREATE TRIGGER immutable_tool_version_promotion_denial_update
BEFORE UPDATE ON tool_version_promotion_denials
BEGIN SELECT RAISE(ABORT,'promotion_denial_immutable'); END;
CREATE TRIGGER immutable_tool_version_promotion_denial_delete
BEFORE DELETE ON tool_version_promotion_denials
BEGIN SELECT RAISE(ABORT,'promotion_denial_immutable'); END;
CREATE TRIGGER monotonic_tool_version_promotion_generation
BEFORE UPDATE ON tool_version_promotion_generation
WHEN NEW.singleton!=OLD.singleton OR NEW.generation!=OLD.generation+1
BEGIN SELECT RAISE(ABORT,'promotion_generation_invalid'); END;
CREATE TRIGGER advance_tool_version_promotion_generation
AFTER INSERT ON tool_version_promotion_denials
BEGIN
  UPDATE tool_version_promotion_generation SET generation=generation+1 WHERE singleton=1;
  SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'promotion_generation_missing') END;
END;
