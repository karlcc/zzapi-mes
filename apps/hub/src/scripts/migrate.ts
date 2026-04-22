#!/usr/bin/env node
/**
 * Idempotent DB migration for zzapi-mes hub.
 * Run: node dist/scripts/migrate.js
 */
import { openDb, runMigrations } from "../db/index.js";

const db = openDb();
runMigrations(db);
db.close();
console.log("Migration complete.");
