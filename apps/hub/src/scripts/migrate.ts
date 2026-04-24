#!/usr/bin/env node
/**
 * Idempotent DB migration for zzapi-mes hub.
 * Run: node dist/scripts/migrate.js
 */
import { openDb, runMigrations } from "../db/index.js";
import { copyFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";

try {
  const db = openDb();
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
    try { db.close(); } catch { /* ignore */ }
    process.exit(1);
  }
  db.close();
  console.log("Migration complete.");
} catch (err) {
  console.error(`Failed to open database: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
