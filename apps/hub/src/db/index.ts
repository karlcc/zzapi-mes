import Database from "better-sqlite3";
import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";

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
  const resolvedPath = path ?? DB_PATH();
  const dir = dirname(resolve(resolvedPath));
  if (!existsSync(dir)) {
    throw new Error(`Database directory does not exist: ${dir}`);
  }
  const db = new Database(resolvedPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");  // NORMAL is safe in WAL mode; power failure may
  // lose the last few transactions but not corrupt the DB. This trades a
  // small durability gap for major write throughput gains vs FULL.
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  // Explicitly set WAL auto-checkpoint to 1000 pages (SQLite default, but
  // pinning it prevents the WAL file from growing unbounded under write-heavy
  // load if the default ever changes or if the binary is compiled differently).
  db.pragma("wal_autocheckpoint = 1000");
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
      rate_limit_per_min  INTEGER CHECK (rate_limit_per_min IS NULL OR rate_limit_per_min > 0),
      created_at          INTEGER NOT NULL,
      revoked_at          INTEGER
    );

    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key        TEXT NOT NULL,
      key_id     TEXT NOT NULL,
      path       TEXT NOT NULL,
      status     INTEGER NOT NULL CHECK (status >= 0),
      body_hash  TEXT NOT NULL CHECK (body_hash <> ''),
      created_at INTEGER NOT NULL,
      PRIMARY KEY (key, key_id)
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
  //
  // Downgrade safety: opening a database that has run migrations beyond what
  // this code knows about is not supported. The _migrations table will contain
  // versions this code won't re-apply (they're already in _migrations), so the
  // schema may include columns/indexes/constraints that this code doesn't create.
  // This is generally safe for read operations but may cause issues if the newer
  // schema is incompatible with this code's queries.
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

  // v5: retention index on audit_log.created_at for efficient pruning
  if (v < 5) {
    migrate(5, `
      CREATE INDEX IF NOT EXISTS idx_audit_log_created_at_retention ON audit_log(created_at);
    `);
  }

  // v6: drop redundant idx_audit_log_created_at — v1 and v5 both index the
  // same column; the v5 retention index is the canonical one.
  if (v < 6) {
    migrate(6, `
      DROP INDEX IF EXISTS idx_audit_log_created_at;
    `);
  }

  // v7: CHECK constraints added to CREATE TABLE for new databases.
  // SQLite does not support ALTER TABLE ADD CHECK, so existing databases
  // rely on application-level validation (admin CLI enforces positive
  // rate_limit_per_min; idempotency status is set by code).
  if (v < 7) {
    migrate(7, `SELECT 1`);
  }

  // v8: idempotency_keys PK changed from (key) to (key, key_id) so that
  // different API keys can use the same Idempotency-Key without collision.
  // SQLite does not support ALTER TABLE DROP PK / ADD PK, so we recreate.
  if (v < 8) {
    migrate(8, `
      ALTER TABLE idempotency_keys RENAME TO _idempotency_keys_v7;
      CREATE TABLE idempotency_keys (
        key        TEXT NOT NULL,
        key_id     TEXT NOT NULL,
        path       TEXT NOT NULL,
        status     INTEGER NOT NULL CHECK (status >= 0),
        body_hash  TEXT NOT NULL CHECK (body_hash <> ''),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (key, key_id)
      );
      INSERT OR IGNORE INTO idempotency_keys (key, key_id, path, status, body_hash, created_at)
        SELECT key, key_id, path, status, body_hash, created_at FROM _idempotency_keys_v7;
      DROP TABLE _idempotency_keys_v7;
      CREATE INDEX IF NOT EXISTS idx_idempotency_created_at ON idempotency_keys(created_at);
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
  // Application-level validation for rate_limit_per_min: SQLite v7 migration
  // is a no-op (ALTER TABLE ADD CHECK unsupported), so existing DBs lack the
  // CHECK constraint. Enforce here as a safety net.
  if (record.rate_limit_per_min !== null && record.rate_limit_per_min <= 0) {
    throw new Error(`rate_limit_per_min must be positive, got ${record.rate_limit_per_min}`);
  }
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
  SELECT key, status, body_hash FROM idempotency_keys WHERE key = ? AND key_id = ?`;

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
  const existing = db.prepare(IDEMP_FIND).get(key, keyId) as IdempotencyRecord | undefined;
  if (existing) return existing;

  try {
    db.prepare(IDEMP_INSERT).run(key, keyId, path, status, bodyHash, Math.floor(Date.now() / 1000));
    return null;
  } catch (err: unknown) {
    // Race: another request inserted the same key — read it back
    if (err instanceof Error && err.message.includes("UNIQUE constraint")) {
      return db.prepare(IDEMP_FIND).get(key, keyId) as IdempotencyRecord | null;
    }
    throw err;
  }
}

const IDEMP_UPDATE_STATUS = `
  UPDATE idempotency_keys SET status = ? WHERE key = ? AND key_id = ?`;

/** Update the stored status after the handler completes. */
export function updateIdempotencyStatus(db: Database.Database, key: string, keyId: string, status: number): void {
  db.prepare(IDEMP_UPDATE_STATUS).run(status, key, keyId);
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
    // Find the last valid JSON boundary before the truncation point
    // to avoid producing invalid JSON that can't be parsed later.
    const cut = body.slice(0, AUDIT_BODY_MAX);
    const lastBrace = cut.lastIndexOf("}");
    const lastBracket = cut.lastIndexOf("]");
    const lastStruct = Math.max(lastBrace, lastBracket);
    if (lastStruct > 0) {
      body = cut.slice(0, lastStruct + 1) + `...[truncated from ${record.body!.length}]`;
    } else {
      // No closing brace/bracket — we're inside a long string value.
      // Fall back to the last comma (key-value boundary) to avoid
      // mid-value cuts that produce unparseable fragments.
      const lastComma = cut.lastIndexOf(",");
      if (lastComma > 0) {
        body = cut.slice(0, lastComma + 1) + `...[truncated from ${record.body!.length}]`;
      } else {
        body = cut + `...[truncated from ${record.body!.length}]`;
      }
    }
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

// ---------------------------------------------------------------------------
// Audit log retention — prune rows older than N days
// ---------------------------------------------------------------------------

const AUDIT_DELETE_OLD = `
  DELETE FROM audit_log WHERE created_at < ?`;

/** Prune audit_log rows older than `maxAgeDays`. Returns number of deleted rows. */
export function pruneAuditLog(db: Database.Database, maxAgeDays: number): number {
  const cutoff = Math.floor(Date.now() / 1000) - maxAgeDays * 86_400;
  // Batch-delete in chunks so SQLite doesn't hold a long write lock when
  // the table is large. 10 000 rows per batch keeps each transaction short.
  const BATCH = 10_000;
  const batchDelete = db.prepare(
    `DELETE FROM audit_log WHERE rowid IN (
      SELECT rowid FROM audit_log WHERE created_at < ? LIMIT ?
    )`,
  );
  let total = 0;
  let deleted: number;
  do {
    deleted = batchDelete.run(cutoff, BATCH).changes;
    total += deleted;
  } while (deleted === BATCH);
  return total;
}
