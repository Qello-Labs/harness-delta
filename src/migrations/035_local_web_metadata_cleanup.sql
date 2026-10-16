CREATE TABLE local_web_metadata_files (
  path TEXT PRIMARY KEY,
  file_identity TEXT NOT NULL
);
CREATE TABLE local_web_metadata_cleanup (
  metadata_path TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('task','project')),
  scope_id TEXT NOT NULL,
  project_id TEXT,
  PRIMARY KEY(metadata_path,scope_kind,scope_id)
);
