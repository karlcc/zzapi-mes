#!/usr/bin/env node
/**
 * Idempotent DB migration for zzapi-mes hub.
 * Run: node dist/scripts/migrate.js
 *
 * Uses an application-level advisory lock to prevent two processes from
 * running migrations concurrently. SQLite doesn't have advisory locks,
 * so we use a dedicated _migration_lock table with a single row.
 * If the lock is held by another process, we wait and retry.
 */
import { openDb, runMigrations } from "../db/index.js";
import { copyFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";

const LOCK_TABLE = `_migration_lock`;
const LOCK_TIMEOUT_MS = 30_000;
const LOCK_RETRY_MS = 500;

/** Acquire the migration advisory lock. Throws if lock cannot be acquired
 *  within LOCK_TIMEOUT_MS. */
async function acquireLock(db: import("better-sqlite3").Database): Promise<void> {
  db.exec(`CREATE TABLE IF NOT EXISTS ${LOCK_TABLE} (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    locked_at  INTEGER NOT NULL
  )`);
  const acquired = db.transaction(() => {
    const row = db.prepare(`SELECT locked_at FROM ${LOCK_TABLE} WHERE id = 1`).get() as { locked_at: number | null } | undefined;
    if (!row) {
      // No lock row — insert one to claim the lock
      db.prepare(`INSERT INTO ${LOCK_TABLE} (id, locked_at) VALUES (1, ?)`).run(Math.floor(Date.now() / 1000));
      return true;
    }
    return false;
  })();

  if (acquired) return;

  // Lock is held — wait and retry
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const waitMs = Math.min(LOCK_RETRY_MS, deadline - Date.now());
    await new Promise((r) => setTimeout(r, waitMs));
    // Try to steal the lock if it's been held for too long (> 60s = stale)
    const stole = db.transaction(() => {
      const row = db.prepare(`SELECT locked_at FROM ${LOCK_TABLE} WHERE id = 1`).get() as { locked_at: number } | undefined;
      if (!row) {
        db.prepare(`INSERT INTO ${LOCK_TABLE} (id, locked_at) VALUES (1, ?)`).run(Math.floor(Date.now() / 1000));
        return true;
      }
      const age = Date.now() / 1000 - row.locked_at;
      if (age > 60) {
        // Stale lock — previous migrate process likely crashed
        db.prepare(`UPDATE ${LOCK_TABLE} SET locked_at = ? WHERE id = 1`).run(Math.floor(Date.now() / 1000));
        return true;
      }
      return false;
    })();
    if (stole) return;
  }
  throw new Error(`Could not acquire migration lock within ${LOCK_TIMEOUT_MS / 1000}s — another process may be running migrate`);
}

/** Release the migration advisory lock. */
function releaseLock(db: import("better-sqlite3").Database): void {
  try {
    db.prepare(`DELETE FROM ${LOCK_TABLE} WHERE id = 1`).run();
  } catch { /* table may not exist if openDb failed */ }
}

async function main() {
  let db: import("better-sqlite3").Database;
  try {
    db = openDb();
  } catch (err) {
    console.error(`Failed to open database: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  try {
    await acquireLock(db);
  } catch (err) {
    console.error(`Migration lock error: ${err instanceof Error ? err.message : err}`);
    try { db.close(); } catch { /* ignore */ }
    process.exit(1);
  }

  try {
    // Back up the DB file before running migrations so a failed migration
    // can be rolled back manually. Only backs up file-backed databases
    // (in-memory DBs have no file to copy).
    const dbPath = resolve(process.env.HUB_DB_PATH ?? "/var/lib/zzapi-mes-hub/hub.db");
    if (existsSync(dbPath)) {
      const backupPath = dbPath + ".pre-migrate";
      try {
        copyFileSync(dbPath, backupPath);
        console.log(`Backup: ${backupPath}`);
      } catch (backupErr) {
        console.error(`Warning: could not back up DB: ${backupErr instanceof Error ? backupErr.message : backupErr}`);
      }
    }
    runMigrations(db);
  } catch (err) {
    console.error(`Migration failed: ${err instanceof Error ? err.message : err}`);
    releaseLock(db);
    try { db.close(); } catch { /* ignore */ }
    process.exit(1);
  }

  releaseLock(db);
  db.close();
  console.log("Migration complete.");
}

main().catch((err) => {
  console.error(`Unexpected error: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
