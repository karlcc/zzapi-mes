import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import { runMigrations, findById, writeAudit, pruneAuditLog, evictIdempotencyKeys } from "../db/index.js";

const CLI = "dist/admin/cli.js";

let dbDir: string;
let dbPath: string;

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), "zzapi-test-"));
  dbPath = join(dbDir, "test.db");
  // Initialize DB schema so the CLI can write to it
  const db = new Database(dbPath);
  runMigrations(db);
  db.close();
});

afterEach(() => {
  rmSync(dbDir, { recursive: true, force: true });
});

function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const child = spawn("node", [CLI, ...args], {
      env: { ...process.env, HUB_DB_PATH: dbPath },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code }));
  });
}

function openDb(): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  return db;
}

describe("admin CLI", () => {
  it("keys create prints plaintext and inserts key into DB", async () => {
    const { stdout, exitCode } = await runCli(["keys", "create", "--label", "test-key", "--scopes", "ping,po"]);
    assert.equal(exitCode, 0);
    assert.match(stdout.trim(), /^[0-9a-f]{12}\./);
    const keyId = stdout.trim().split(".")[0]!;
    const db = openDb();
    try {
      const record = findById(db, keyId);
      assert.ok(record, "key should exist in DB");
      assert.equal(record!.label, "test-key");
      assert.equal(record!.scopes, "ping,po");
    } finally {
      db.close();
    }
  });

  it("keys create defaults scopes to ping,po", async () => {
    const { stdout, exitCode } = await runCli(["keys", "create", "--label", "default-scopes"]);
    assert.equal(exitCode, 0);
    const keyId = stdout.trim().split(".")[0]!;
    const db = openDb();
    try {
      const record = findById(db, keyId);
      assert.ok(record);
      assert.equal(record!.scopes, "ping,po");
    } finally {
      db.close();
    }
  });

  it("keys create rejects invalid scopes", async () => {
    const { stderr, exitCode } = await runCli(["keys", "create", "--label", "bad", "--scopes", "ping,bogus"]);
    assert.notEqual(exitCode, 0);
    assert.match(stderr, /Unknown scope.*bogus/);
  });

  it("keys create with --rate-limit sets rate_limit_per_min", async () => {
    const { stdout, exitCode } = await runCli(["keys", "create", "--label", "limited", "--rate-limit", "10"]);
    assert.equal(exitCode, 0);
    const keyId = stdout.trim().split(".")[0]!;
    const db = openDb();
    try {
      const record = findById(db, keyId);
      assert.ok(record);
      assert.equal(record!.rate_limit_per_min, 10);
    } finally {
      db.close();
    }
  });

  it("keys list outputs key info", async () => {
    const { stdout: createOut } = await runCli(["keys", "create", "--label", "list-test", "--scopes", "ping"]);
    const keyId = createOut.trim().split(".")[0]!;

    const { stdout, exitCode } = await runCli(["keys", "list"]);
    assert.equal(exitCode, 0);
    assert.match(stdout, new RegExp(keyId));
    assert.match(stdout, /list-test/);
    assert.match(stdout, /ACTIVE/);
  });

  it("keys revoke marks key as revoked", async () => {
    const { stdout: createOut } = await runCli(["keys", "create", "--label", "revoke-me", "--scopes", "ping"]);
    const keyId = createOut.trim().split(".")[0]!;

    const { stdout, exitCode } = await runCli(["keys", "revoke", keyId]);
    assert.equal(exitCode, 0);
    assert.match(stdout, /revoked/);

    const db = openDb();
    try {
      const record = findById(db, keyId);
      assert.ok(record);
      assert.notEqual(record!.revoked_at, null);
    } finally {
      db.close();
    }
  });

  it("keys revoke with unknown id prints error", async () => {
    const { stderr, exitCode } = await runCli(["keys", "revoke", "nonexistent"]);
    assert.notEqual(exitCode, 0);
    assert.match(stderr, /not found or already revoked/);
  });

  it("exits with usage for unknown command", async () => {
    const { exitCode } = await runCli(["bogus"]);
    assert.notEqual(exitCode, 0);
  });

  it("keys revoke already-revoked key prints error", async () => {
    const { stdout: createOut } = await runCli(["keys", "create", "--label", "dbl-revoke", "--scopes", "ping"]);
    const keyId = createOut.trim().split(".")[0]!;

    // First revoke succeeds
    const { exitCode: firstCode } = await runCli(["keys", "revoke", keyId]);
    assert.equal(firstCode, 0);

    // Second revoke fails
    const { stderr, exitCode } = await runCli(["keys", "revoke", keyId]);
    assert.notEqual(exitCode, 0);
    assert.match(stderr, /not found or already revoked/);
  });

  it("keys list on empty DB outputs nothing", async () => {
    const { stdout, exitCode } = await runCli(["keys", "list"]);
    assert.equal(exitCode, 0);
    assert.equal(stdout.trim(), "");
  });

  it("keys create requires --label", async () => {
    const { stderr, exitCode } = await runCli(["keys", "create", "--scopes", "ping"]);
    assert.notEqual(exitCode, 0);
    assert.match(stderr, /--label/);
  });

  it("audit prune removes old rows via CLI", async () => {
    const db = openDb();
    try {
      // Insert an old audit row (31 days ago) directly
      const oldTs = Math.floor(Date.now() / 1000) - 31 * 86400;
      db.prepare("INSERT INTO audit_log (req_id, key_id, method, path, body, sap_status, sap_duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run("old-req", "-", "GET", "/ping", null, 200, 50, oldTs);
      // Insert a recent row via the normal function
      writeAudit(db, { req_id: "new-req", key_id: "-", method: "GET", path: "/ping", body: "", sap_status: 200, sap_duration_ms: 50 });
    } finally {
      db.close();
    }

    const { stdout, exitCode } = await runCli(["audit", "prune", "--days", "30"]);
    assert.equal(exitCode, 0);
    assert.match(stdout, /Pruned 1/);

    const db2 = openDb();
    try {
      const remaining = db2.prepare("SELECT count(*) AS c FROM audit_log").get() as { c: number };
      assert.equal(remaining.c, 1, "recent row should remain");
    } finally {
      db2.close();
    }
  });

  it("audit prune requires --days", async () => {
    const { stderr, exitCode } = await runCli(["audit", "prune"]);
    assert.notEqual(exitCode, 0);
    assert.match(stderr, /--days/);
  });

  it("idempotency evict removes stale keys via CLI", async () => {
    const db = openDb();
    try {
      // Insert a stale idempotency key (600s ago)
      const staleTs = Math.floor(Date.now() / 1000) - 600;
      db.prepare("INSERT INTO idempotency_keys (key, key_id, path, status, body_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run("stale-key", "test-key", "/confirmation", 201, "stale-body-hash", staleTs);
      // Insert a fresh key
      const freshTs = Math.floor(Date.now() / 1000);
      db.prepare("INSERT INTO idempotency_keys (key, key_id, path, status, body_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run("fresh-key", "test-key", "/confirmation", 0, "fresh-body-hash", freshTs);
    } finally {
      db.close();
    }

    const { stdout, exitCode } = await runCli(["idempotency", "evict", "--max-age-seconds", "300"]);
    assert.equal(exitCode, 0);
    assert.match(stdout, /Evicted 1/);

    const db2 = openDb();
    try {
      const remaining = db2.prepare("SELECT count(*) AS c FROM idempotency_keys").get() as { c: number };
      assert.equal(remaining.c, 1, "fresh key should remain");
    } finally {
      db2.close();
    }
  });

  it("idempotency evict requires --max-age-seconds", async () => {
    const { stderr, exitCode } = await runCli(["idempotency", "evict"]);
    assert.notEqual(exitCode, 0);
    assert.match(stderr, /--max-age-seconds/);
  });
});
