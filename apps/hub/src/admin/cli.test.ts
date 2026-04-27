import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import Database from "better-sqlite3";
import { runMigrations, insertKey, writeAudit, checkIdempotency } from "../db/index.js";
import argon2 from "argon2";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";

const CLI = join(__dirname, "..", "..", "dist", "admin", "cli.js");

let dbPath: string;
let tmpDir: string;

function run(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = execFile("node", [CLI, ...args], {
      env: { ...process.env, HUB_DB_PATH: dbPath },
      timeout: 5000,
    }, (err, stdout, stderr) => {
      resolve({
        stdout: stdout?.trim() ?? "",
        stderr: stderr?.trim() ?? "",
        code: err ? 1 : 0,
      });
    });
    proc.on("error", () => {});
  });
}

describe("Admin CLI", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "zzapi-cli-"));
    dbPath = join(tmpDir, "test.db");
    const db = new Database(dbPath);
    runMigrations(db);
    db.close();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("keys create", () => {
    it("creates a key and prints plaintext", async () => {
      const { stdout, code } = await run(["keys", "create", "--label", "test1"]);
      assert.equal(code, 0);
      // Format: keyId.secret (keyId is 12 hex, secret is base64url)
      assert.match(stdout, /^[0-9a-f]{12}\./);
    });

    it("rejects invalid scope", async () => {
      const { stderr, code } = await run(["keys", "create", "--label", "badscope", "--scopes", "bogus"]);
      assert.notEqual(code, 0);
      assert.ok(stderr.includes("Unknown scope"));
    });

    it("rejects non-positive --rate-limit", async () => {
      const { stderr, code } = await run(["keys", "create", "--label", "rl", "--rate-limit", "0"]);
      assert.notEqual(code, 0);
      assert.ok(stderr.includes("positive integer"));
    });

    it("rejects negative --rate-limit", async () => {
      const { stderr, code } = await run(["keys", "create", "--label", "rl", "--rate-limit", "-5"]);
      assert.notEqual(code, 0);
      assert.ok(stderr.includes("positive integer"));
    });

    it("rejects non-numeric --rate-limit", async () => {
      const { stderr, code } = await run(["keys", "create", "--label", "rl", "--rate-limit", "abc"]);
      assert.notEqual(code, 0);
      assert.ok(stderr.includes("positive integer"));
    });

    it("rejects --rate-limit exceeding upper bound (10000)", async () => {
      const { stderr, code } = await run(["keys", "create", "--label", "rl", "--rate-limit", "99999"]);
      assert.notEqual(code, 0);
      assert.ok(stderr.includes("10000"), `stderr should mention upper bound: ${stderr}`);
    });

    it("handles --key=value syntax correctly", async () => {
      const { stdout, code } = await run(["keys", "create", "--label=test-equals"]);
      assert.equal(code, 0);
      assert.match(stdout, /^[0-9a-f]{12}\./);
    });

    it("rejects bare -- with empty flag name", async () => {
      const { stderr, code } = await run(["keys", "create", "--", "label", "test-bare"]);
      assert.notEqual(code, 0);
      assert.ok(stderr.includes("Empty flag name") || stderr.includes("Usage"), `should reject bare --: ${stderr}`);
    });

    it("deduplicates --scopes values", async () => {
      const { stdout, code } = await run(["keys", "create", "--label", "dedup-test", "--scopes", "ping,ping,po"]);
      assert.equal(code, 0);
      const keyId = stdout.split(".")[0]!;
      // Verify in DB that scopes are deduplicated
      const db2 = new Database(dbPath);
      const row = db2.prepare("SELECT scopes FROM api_keys WHERE id = ?").get(keyId) as { scopes: string } | undefined;
      db2.close();
      assert.ok(row);
      assert.equal(row!.scopes, "ping,po", "duplicate scopes should be deduplicated");
    });

    it("handles --key=value for scopes", async () => {
      const { stdout, code } = await run(["keys", "create", "--label=test-scopes-eq", "--scopes=ping,po"]);
      assert.equal(code, 0);
      assert.match(stdout, /^[0-9a-f]{12}\./);
    });

    it("handles mixed --key value and --key=value syntax", async () => {
      const { stdout, code } = await run(["keys", "create", "--label", "mixed-test", "--scopes=ping"]);
      assert.equal(code, 0);
      assert.match(stdout, /^[0-9a-f]{12}\./);
    });

    it("rejects label exceeding 255 characters", async () => {
      const longLabel = "x".repeat(256);
      const { stderr, code } = await run(["keys", "create", "--label", longLabel]);
      assert.notEqual(code, 0);
      assert.ok(stderr.includes("255"), `should mention 255 char limit: ${stderr}`);
    });

    it("accepts label at exactly 255 characters", async () => {
      const maxLabel = "y".repeat(255);
      const { stdout, code } = await run(["keys", "create", "--label", maxLabel]);
      assert.equal(code, 0);
      assert.match(stdout, /^[0-9a-f]{12}\./);
    });

    it("rejects control characters in label", async () => {
      // Node's execFile rejects null bytes in args, so test with newline instead
      const { stderr, code } = await run(["keys", "create", "--label", "bad\nlabel"]);
      assert.notEqual(code, 0);
      assert.ok(stderr.includes("control character"), `should mention control characters: ${stderr}`);
    });

    it("warns on duplicate label but still creates key", async () => {
      await run(["keys", "create", "--label", "dup-label"]);
      const { stdout, stderr, code } = await run(["keys", "create", "--label", "dup-label"]);
      assert.equal(code, 0, "should succeed even with duplicate label");
      assert.match(stdout, /^[0-9a-f]{12}\./);
      assert.ok(stderr.includes("Warning"), `should warn about duplicate label: ${stderr}`);
    });
  });

  describe("keys list", () => {
    it("lists keys with header row", async () => {
      await run(["keys", "create", "--label", "listme"]);
      const { stdout, code } = await run(["keys", "list"]);
      assert.equal(code, 0);
      const lines = stdout.split("\n");
      // First line is a header row
      assert.ok(lines[0]!.startsWith("KEY_ID\t"), `first line should be header, got: ${lines[0]}`);
      assert.ok(stdout.includes("listme"));
      assert.ok(stdout.includes("ACTIVE"));
    });

    it("shows REVOKED status for revoked key", async () => {
      const { stdout: plaintext } = await run(["keys", "create", "--label", "revokedlist"]);
      const keyId = plaintext.split(".")[0]!;
      await run(["keys", "revoke", keyId]);
      const { stdout, code } = await run(["keys", "list"]);
      assert.equal(code, 0);
      assert.ok(stdout.includes("REVOKED"));
      assert.ok(stdout.includes("revokedlist"));
    });

    it("escapes tabs and newlines in label", async () => {
      // Tab in label is now rejected by control-character validation at CLI level
      const { stderr, code } = await run(["keys", "create", "--label", "lab\tel"]);
      assert.notEqual(code, 0, "tab in label should be rejected");
      assert.ok(stderr.includes("control character"), `should mention control characters: ${stderr}`);
    });

    it("supports --format json for structured output", async () => {
      await run(["keys", "create", "--label", "jsontest", "--scopes", "ping,po"]);
      const { stdout, code } = await run(["keys", "list", "--format", "json"]);
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      assert.ok(Array.isArray(parsed), "should be a JSON array");
      assert.ok(parsed.length > 0, "should have at least one key");
      const key = parsed[0]!;
      assert.ok("id" in key, "key object should have id");
      assert.ok("status" in key, "key object should have status");
      assert.ok("label" in key, "key object should have label");
      assert.ok("scopes" in key, "key object should have scopes");
      assert.equal(key.label, "jsontest");
    });
  });

  describe("keys revoke", () => {
    it("revokes a key", async () => {
      const { stdout: plaintext } = await run(["keys", "create", "--label", "revokeme"]);
      const keyId = plaintext.split(".")[0]!;
      const { stdout, code } = await run(["keys", "revoke", keyId]);
      assert.equal(code, 0);
      assert.ok(stdout.includes("revoked"));

      // Verify in DB
      const db = new Database(dbPath);
      const row = db.prepare("SELECT revoked_at FROM api_keys WHERE id = ?").get(keyId) as { revoked_at: number | null } | undefined;
      db.close();
      assert.ok(row?.revoked_at !== null);
    });

    it("reports failure for non-existent key", async () => {
      const { stderr, code } = await run(["keys", "revoke", "nonexistent"]);
      assert.notEqual(code, 0);
      assert.ok(stderr.includes("not found") || stderr.includes("already revoked"));
    });
  });

  describe("audit prune", () => {
    it("prunes old audit rows", async () => {
      // Insert stale audit row directly
      const db = new Database(dbPath);
      const now = Math.floor(Date.now() / 1000);
      insertKey(db, { id: "k-old", hash: "h", label: "t", scopes: "conf", rate_limit_per_min: null, created_at: now });
      insertKey(db, { id: "k-new", hash: "h", label: "t", scopes: "conf", rate_limit_per_min: null, created_at: now });
      db.prepare("INSERT INTO audit_log (req_id, key_id, method, path, body, sap_status, sap_duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run("r-old", "k-old", "POST", "/confirmation", null, 201, null, now - 31 * 86_400);
      writeAudit(db, { req_id: "r-new", key_id: "k-new", method: "POST", path: "/confirmation", sap_status: 201 });
      db.close();

      const { stdout, code } = await run(["audit", "prune", "--days", "30"]);
      assert.equal(code, 0);
      assert.ok(stdout.includes("Pruned"));

      // Verify only recent row remains
      const db2 = new Database(dbPath);
      const count = (db2.prepare("SELECT COUNT(*) AS c FROM audit_log").get() as { c: number }).c;
      db2.close();
      assert.equal(count, 1);
    });

    it("rejects non-positive days", async () => {
      const { stderr, code } = await run(["audit", "prune", "--days", "0"]);
      assert.notEqual(code, 0);
      assert.ok(stderr.includes("positive integer"));
    });

    it("rejects missing --days", async () => {
      const { code } = await run(["audit", "prune"]);
      assert.notEqual(code, 0);
    });

    it("rejects --days exceeding upper bound (3650)", async () => {
      const { stderr, code } = await run(["audit", "prune", "--days", "999999"]);
      assert.notEqual(code, 0);
      assert.ok(stderr.includes("3650"), `stderr should mention upper bound: ${stderr}`);
    });
  });

  describe("idempotency evict", () => {
    it("evicts stale idempotency keys", async () => {
      const db = new Database(dbPath);
      const now = Math.floor(Date.now() / 1000);
      insertKey(db, { id: "k1", hash: "h", label: "t", scopes: "conf", rate_limit_per_min: null, created_at: now });
      insertKey(db, { id: "k2", hash: "h", label: "t", scopes: "conf", rate_limit_per_min: null, created_at: now });
      checkIdempotency(db, "fresh-key-cli", "k1", "/confirmation", 201, "abc");
      db.prepare("INSERT INTO idempotency_keys (key, key_id, path, status, body_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run("stale-key-cli", "k2", "/confirmation", 201, "def", now - 600);
      db.close();

      const { stdout, code } = await run(["idempotency", "evict", "--max-age-seconds", "300"]);
      assert.equal(code, 0);
      assert.ok(stdout.includes("Evicted"));

      const db2 = new Database(dbPath);
      const fresh = db2.prepare("SELECT key FROM idempotency_keys WHERE key = 'fresh-key-cli'").get();
      const stale = db2.prepare("SELECT key FROM idempotency_keys WHERE key = 'stale-key-cli'").get();
      db2.close();
      assert.ok(fresh, "fresh key should survive");
      assert.equal(stale, undefined, "stale key should be evicted");
    });

    it("rejects non-positive max-age-seconds", async () => {
      const { stderr, code } = await run(["idempotency", "evict", "--max-age-seconds", "-1"]);
      assert.notEqual(code, 0);
      assert.ok(stderr.includes("positive integer"));
    });
  });

  describe("edge cases", () => {
    it("handles unknown command", async () => {
      const { stderr, code } = await run(["bogus"]);
      assert.notEqual(code, 0);
      assert.ok(stderr.includes("Usage"), `should show usage: ${stderr}`);
    });

    it("handles bare invocation (no args)", async () => {
      const { stderr, code } = await run([]);
      assert.notEqual(code, 0);
      assert.ok(stderr.includes("Usage"), `should show usage: ${stderr}`);
    });

    it("handles empty keys list", async () => {
      const { stdout, code } = await run(["keys", "list"]);
      assert.equal(code, 0);
      // Empty list still prints header row
      assert.equal(stdout, "KEY_ID\tSTATUS\tLABEL\tSCOPES\tRATE_LIMIT\tCREATED");
    });
  });
});
