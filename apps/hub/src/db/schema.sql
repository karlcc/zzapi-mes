-- Canonical schema for zzapi-mes-hub SQLite database.
-- Auto-generated from runMigrations() in db/index.ts.
-- DO NOT EDIT — update runMigrations() instead and re-dump.

CREATE TABLE IF NOT EXISTS _migrations (
  version     INTEGER PRIMARY KEY,
  applied_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id                  TEXT PRIMARY KEY,
  hash                TEXT NOT NULL,
  label               TEXT,
  scopes              TEXT NOT NULL,
  rate_limit_per_min  INTEGER,
  created_at          INTEGER NOT NULL,
  revoked_at          INTEGER
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key        TEXT PRIMARY KEY,
  key_id     TEXT NOT NULL,
  path       TEXT NOT NULL,
  status     INTEGER NOT NULL,
  body_hash  TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  req_id           TEXT NOT NULL,
  key_id           TEXT NOT NULL,
  method           TEXT NOT NULL,
  path             TEXT NOT NULL,
  body             TEXT,
  sap_status       INTEGER,
  sap_duration_ms  INTEGER,
  created_at       INTEGER NOT NULL
);

-- Indexes (applied via versioned migrations):

-- v1
CREATE INDEX IF NOT EXISTS idx_idempotency_created_at ON idempotency_keys(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_key_id ON audit_log(key_id);

-- v3
CREATE INDEX IF NOT EXISTS idx_audit_log_path ON audit_log(path);

-- v4
CREATE INDEX IF NOT EXISTS idx_audit_log_key_created ON audit_log(key_id, created_at);
CREATE INDEX IF NOT EXISTS idx_idempotency_key_id ON idempotency_keys(key_id);

-- v5 (retention index for efficient pruning)
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at_retention ON audit_log(created_at);

-- v6: dropped redundant idx_audit_log_created_at (v1 and v5 both indexed
--      the same column; the v5 retention index is canonical).
