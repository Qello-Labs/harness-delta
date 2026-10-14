CREATE TABLE ordinary_project_settings (
  project_id TEXT PRIMARY KEY NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  settings TEXT NOT NULL,
  settings_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE ordinary_tasks (
  task_id TEXT PRIMARY KEY NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  settings TEXT NOT NULL,
  settings_hash TEXT NOT NULL,
  price_table_id TEXT NOT NULL REFERENCES price_tables(id),
  prepared_at TEXT NOT NULL,
  selected_root_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  revoked_at TEXT
);

CREATE TABLE binding_baseline_exclusions (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  source_identity TEXT NOT NULL,
  request_key TEXT NOT NULL,
  PRIMARY KEY (session_id, source_identity, request_key)
);
