CREATE TABLE IF NOT EXISTS api_keys (
  id                  TEXT PRIMARY KEY,
  hash                TEXT NOT NULL,
  label               TEXT,
  scopes              TEXT NOT NULL,
  rate_limit_per_min  INTEGER,
  created_at          INTEGER NOT NULL,
  revoked_at          INTEGER
);
