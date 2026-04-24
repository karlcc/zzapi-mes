#!/usr/bin/env node
/**
 * Idempotent DB migration for zzapi-mes hub.
 * Run: node dist/scripts/migrate.js
 */
import { openDb, runMigrations } from "../db/index.js";

try {
  const db = openDb();
  try {
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
