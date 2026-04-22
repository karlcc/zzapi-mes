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
  return db;
}

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id                  TEXT PRIMARY KEY,
      hash                TEXT NOT NULL,
      label               TEXT,
      scopes              TEXT NOT NULL,
      rate_limit_per_min  INTEGER,
      created_at          INTEGER NOT NULL,
      revoked_at          INTEGER
    );
  `);
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
  db.prepare(INSERT_KEY).run(
    record.id,
    record.hash,
    record.label,
    record.scopes,
    record.rate_limit_per_min,
    record.created_at,
  );
}

export function listKeys(db: Database.Database): ApiKeyRecord[] {
  return db.prepare(LIST_KEYS).all() as ApiKeyRecord[];
}

export function revokeKey(db: Database.Database, id: string): boolean {
  const result = db.prepare(REVOKE_KEY).run(Math.floor(Date.now() / 1000), id);
  return result.changes > 0;
}
