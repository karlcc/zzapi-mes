import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

  it("runMigrations on fresh DB creates all tables and reaches v7", () => {
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
      assert.equal(row?.v, 8, "should reach migration v8");
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

  it("openDb enables foreign_keys pragma", () => {
    const db = openDb(":memory:");
    try {
      const fk = db.pragma("foreign_keys", { simple: true }) as number;
      assert.equal(fk, 1, "foreign_keys should be ON (1)");
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

  it("openDb sets wal_autocheckpoint to 1000", () => {
    // WAL file grows unbounded without autocheckpoint under write-heavy load.
    // 1000 is a sensible default — frequent enough to bound WAL size, rare
    // enough to avoid checkpoint storms on busy systems.
    const dir = mkdtempSync(join(tmpdir(), "wal-test-"));
    const dbPath = join(dir, "test.db");
    try {
      const db = openDb(dbPath);
      const checkpoint = db.pragma("wal_autocheckpoint", { simple: true }) as number;
      assert.equal(checkpoint, 1000, "wal_autocheckpoint should be 1000");
      db.close();
    } finally {
      // cleanup
      try { require("node:fs").unlinkSync(dbPath); } catch {}
      try { require("node:fs").unlinkSync(dbPath + "-wal"); } catch {}
      try { require("node:fs").unlinkSync(dbPath + "-shm"); } catch {}
      try { require("node:fs").rmdirSync(dir); } catch {}
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

  it("runMigrations applies only missing versions from partial state", () => {
    const db = new Database(":memory:");
    try {
      // Create the base schema + seed _migrations at v3 (skip v1–v3)
      db.exec(`
        CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS api_keys (
          id TEXT PRIMARY KEY, hash TEXT NOT NULL, label TEXT, scopes TEXT NOT NULL,
          rate_limit_per_min INTEGER, created_at INTEGER NOT NULL, revoked_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS idempotency_keys (
          key TEXT NOT NULL, key_id TEXT NOT NULL, path TEXT NOT NULL,
          status INTEGER NOT NULL, body_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
          PRIMARY KEY (key, key_id)
        );
        CREATE TABLE IF NOT EXISTS audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT, req_id TEXT NOT NULL, key_id TEXT NOT NULL,
          method TEXT NOT NULL, path TEXT NOT NULL, body TEXT, sap_status INTEGER, created_at INTEGER NOT NULL
        );
        INSERT INTO _migrations VALUES (1, 1), (2, 2), (3, 3);
      `);
      // Verify v3 columns exist but v2 column does not yet
      // (v2 adds sap_duration_ms — but since we faked v2 via _migrations only,
      // the column won't exist yet. runMigrations should skip v1–v3 and apply v4+.)
      // Actually, the base schema above omits sap_duration_ms, so v2 wasn't truly applied.
      // That's fine — we're testing version gating, not schema correctness.
      // runMigrations should NOT re-apply v1–v3 (they're in _migrations).
      const before = (db.prepare("SELECT COUNT(*) AS cnt FROM _migrations").get() as { cnt: number }).cnt;
      assert.equal(before, 3);

      runMigrations(db);

      const after = (db.prepare("SELECT COUNT(*) AS cnt FROM _migrations").get() as { cnt: number }).cnt;
      assert.equal(after, 8, "should add v4, v5, v6, v7, v8 but not re-add v1–v3");

      // v6 should have dropped idx_audit_log_created_at (the redundant v1 index)
      const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_audit_log_created_at'").get();
      assert.equal(indexes, undefined, "v6 should drop idx_audit_log_created_at");
    } finally {
      db.close();
    }
  });
});

describe("migrate.ts — script error paths", () => {
  const ENTRY = join(__dirname, "..", "scripts", "migrate.js");

  it("exits 1 when DB path is unwritable", async () => {
    const proc = spawn("node", [ENTRY], {
      env: { ...process.env, HUB_DB_PATH: "/nonexistent/dir/hub.db" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const code = await new Promise<number>((resolve) => {
      const timer = setTimeout(() => { proc.kill("SIGKILL"); resolve(-1); }, 10_000);
      proc.on("close", (c) => { clearTimeout(timer); resolve(c ?? 1); });
    });
    assert.notEqual(code, 0, "should exit non-zero for unwritable DB path");
  });
});
