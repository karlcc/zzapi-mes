import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { openDb, runMigrations } from "../db/index.js";

describe("migrate.ts — CLI entry point", () => {
  it("openDb creates a writable database with WAL mode", () => {
    const db = openDb(":memory:");
    try {
      const mode = db.pragma("journal_mode", { simple: true }) as string;
      // In-memory databases report "memory" not "wal"
      assert.ok(mode === "wal" || mode === "memory", `expected wal or memory, got ${mode}`);
      // writable — insert a row
      db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
      db.exec("INSERT INTO t VALUES (1)");
      const row = db.prepare("SELECT id FROM t").get() as { id: number } | undefined;
      assert.equal(row?.id, 1);
    } finally {
      db.close();
    }
  });

  it("runMigrations on fresh DB creates all tables and reaches v6", () => {
    const db = new Database(":memory:");
    try {
      runMigrations(db);
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
      const names = tables.map(t => t.name);
      assert.ok(names.includes("_migrations"));
      assert.ok(names.includes("api_keys"));
      assert.ok(names.includes("idempotency_keys"));
      assert.ok(names.includes("audit_log"));

      const row = db.prepare("SELECT MAX(version) AS v FROM _migrations").get() as { v: number | null };
      assert.equal(row?.v, 6, "should reach migration v6");
    } finally {
      db.close();
    }
  });

  it("runMigrations is idempotent — re-running does not add duplicate versions", () => {
    const db = new Database(":memory:");
    try {
      runMigrations(db);
      const countBefore = (db.prepare("SELECT COUNT(*) AS cnt FROM _migrations").get() as { cnt: number }).cnt;
      runMigrations(db);
      const countAfter = (db.prepare("SELECT COUNT(*) AS cnt FROM _migrations").get() as { cnt: number }).cnt;
      assert.equal(countAfter, countBefore, "re-running migrations should not add duplicate version rows");
    } finally {
      db.close();
    }
  });

  it("openDb sets busy_timeout to 5000ms", () => {
    const db = openDb(":memory:");
    try {
      const timeout = db.pragma("busy_timeout", { simple: true }) as number;
      assert.equal(timeout, 5000);
    } finally {
      db.close();
    }
  });

  it("openDb sets synchronous=NORMAL", () => {
    const db = openDb(":memory:");
    try {
      const mode = db.pragma("synchronous", { simple: true }) as number;
      assert.equal(mode, 1, "NORMAL = 1 in SQLite pragma values");
    } finally {
      db.close();
    }
  });
});
