import Database from "better-sqlite3";
import { resolve } from "node:path";

export interface ApiKeyRecord {
  id: string;
  hash: string;
  label: string | null;
  scopes: string;
  rate_limit_per_min: number | null;
  created_at: number;
  revoked_at: number | null;
}

const DB_PATH = () => process.env.HUB_DB_PATH ?? "/var/lib/zzapi-mes-hub/hub.db";

export function openDb(path?: string): Database.Database {
  const db = new Database(path ?? DB_PATH());
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  return db;
}

export function runMigrations(db: Database.Database): void {
  db.exec(`
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
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      req_id      TEXT NOT NULL,
      key_id      TEXT NOT NULL,
      method      TEXT NOT NULL,
      path        TEXT NOT NULL,
      body        TEXT,
      sap_status  INTEGER,
      created_at  INTEGER NOT NULL
    );
  `);

  // Apply versioned migrations — each in its own transaction so a partial
  // failure (e.g. ALTER TABLE on an already-existing column) cannot advance
  // _migrations and block a re-run.
  const currentVersion = db.prepare("SELECT MAX(version) AS v FROM _migrations").get() as { v: number | null };
  const v = currentVersion?.v ?? 0;

  const migrate = db.transaction((version: number, sql: string) => {
    db.exec(sql);
    db.prepare("INSERT INTO _migrations (version, applied_at) VALUES (?, ?)").run(version, Math.floor(Date.now() / 1000));
  });

  if (v < 1) {
    migrate(1, `
      CREATE INDEX IF NOT EXISTS idx_idempotency_created_at ON idempotency_keys(created_at);
      CREATE INDEX IF NOT EXISTS idx_audit_log_key_id ON audit_log(key_id);
      CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);
    `);
  }

  if (v < 2) {
    migrate(2, `
      ALTER TABLE audit_log ADD COLUMN sap_duration_ms INTEGER;
    `);
  }

  if (v < 3) {
    migrate(3, `
      CREATE INDEX IF NOT EXISTS idx_audit_log_path ON audit_log(path);
    `);
  }

  if (v < 4) {
    migrate(4, `
      CREATE INDEX IF NOT EXISTS idx_audit_log_key_created ON audit_log(key_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_idempotency_key_id ON idempotency_keys(key_id);
    `);
  }
}

const FIND_BY_ID = `
  SELECT id, hash, label, scopes, rate_limit_per_min, created_at, revoked_at
  FROM api_keys WHERE id = ?`;

const INSERT_KEY = `
  INSERT INTO api_keys (id, hash, label, scopes, rate_limit_per_min, created_at)
  VALUES (?, ?, ?, ?, ?, ?)`;

const LIST_KEYS = `
  SELECT id, hash, label, scopes, rate_limit_per_min, created_at, revoked_at
  FROM api_keys ORDER BY created_at DESC`;

const REVOKE_KEY = `
  UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`;

export function findById(db: Database.Database, id: string): ApiKeyRecord | undefined {
  return db.prepare(FIND_BY_ID).get(id) as ApiKeyRecord | undefined;
}

export function insertKey(
  db: Database.Database,
  record: Omit<ApiKeyRecord, "revoked_at">,
): void {
  try {
    db.prepare(INSERT_KEY).run(
      record.id,
      record.hash,
      record.label,
      record.scopes,
      record.rate_limit_per_min,
      record.created_at,
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("UNIQUE constraint")) {
      throw new Error(`Key '${record.id}' already exists`);
    }
    throw new Error(`Failed to insert key: ${msg}`);
  }
}

export function listKeys(db: Database.Database): ApiKeyRecord[] {
  return db.prepare(LIST_KEYS).all() as ApiKeyRecord[];
}

export function revokeKey(db: Database.Database, id: string): boolean {
  try {
    const result = db.prepare(REVOKE_KEY).run(Math.floor(Date.now() / 1000), id);
    return result.changes > 0;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to revoke key '${id}': ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Idempotency (write-back dedup)
// ---------------------------------------------------------------------------

const IDEMP_INSERT = `
  INSERT INTO idempotency_keys (key, key_id, path, status, body_hash, created_at)
  VALUES (?, ?, ?, ?, ?, ?)`;

const IDEMP_FIND = `
  SELECT key, status, body_hash FROM idempotency_keys WHERE key = ?`;

const IDEMP_EVICT = `
  DELETE FROM idempotency_keys WHERE created_at < ?`;

export interface IdempotencyRecord {
  key: string;
  status: number;
  body_hash: string;
}

/** Check or register an idempotency key. Returns existing record if found. */
export function checkIdempotency(
  db: Database.Database,
  key: string,
  keyId: string,
  path: string,
  status: number,
  bodyHash: string,
): IdempotencyRecord | null {
  const existing = db.prepare(IDEMP_FIND).get(key) as IdempotencyRecord | undefined;
  if (existing) return existing;

  try {
    db.prepare(IDEMP_INSERT).run(key, keyId, path, status, bodyHash, Math.floor(Date.now() / 1000));
    return null;
  } catch (err: unknown) {
    // Race: another request inserted the same key — read it back
    if (err instanceof Error && err.message.includes("UNIQUE constraint")) {
      return db.prepare(IDEMP_FIND).get(key) as IdempotencyRecord | null;
    }
    throw err;
  }
}

const IDEMP_UPDATE_STATUS = `
  UPDATE idempotency_keys SET status = ? WHERE key = ?`;

/** Update the stored status after the handler completes. */
export function updateIdempotencyStatus(db: Database.Database, key: string, status: number): void {
  db.prepare(IDEMP_UPDATE_STATUS).run(status, key);
}

/** Evict idempotency keys older than the given age in seconds. */
export function evictIdempotencyKeys(db: Database.Database, maxAgeSeconds: number): number {
  const cutoff = Math.floor(Date.now() / 1000) - maxAgeSeconds;
  return db.prepare(IDEMP_EVICT).run(cutoff).changes;
}

// ---------------------------------------------------------------------------
// Audit log (write-back trail)
// ---------------------------------------------------------------------------

const AUDIT_INSERT = `
  INSERT INTO audit_log (req_id, key_id, method, path, body, sap_status, sap_duration_ms, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

// Cap audit body size to keep the SQLite DB from bloating with full MES payloads.
// Write-back requests can approach the 1 MB request limit; truncate to a fixed
// prefix so we retain enough context for forensics without unbounded growth.
const AUDIT_BODY_MAX = 4096;

export function writeAudit(
  db: Database.Database,
  record: {
    req_id: string;
    key_id: string;
    method: string;
    path: string;
    body?: string;
    sap_status?: number;
    sap_duration_ms?: number;
  },
): void {
  let body = record.body ?? null;
  if (body && body.length > AUDIT_BODY_MAX) {
    body = body.slice(0, AUDIT_BODY_MAX) + `...[truncated ${body.length - AUDIT_BODY_MAX}]`;
  }
  db.prepare(AUDIT_INSERT).run(
    record.req_id,
    record.key_id,
    record.method,
    record.path,
    body,
    record.sap_status ?? null,
    record.sap_duration_ms ?? null,
    Math.floor(Date.now() / 1000),
  );
}
