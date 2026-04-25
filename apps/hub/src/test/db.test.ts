import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  runMigrations,
  insertKey,
  findById,
  listKeys,
  revokeKey,
  checkIdempotency,
  updateIdempotencyStatus,
  evictIdempotencyKeys,
  writeAudit,
  pruneAuditLog,
} from "../db/index.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
});

describe("DB layer — api_keys", () => {
  it("insertKey and findById round-trip", () => {
    insertKey(db, {
      id: "abc123",
      hash: "hashed",
      label: "test",
      scopes: "ping,po",
      rate_limit_per_min: null,
      created_at: 1000,
    });
    const record = findById(db, "abc123");
    assert.ok(record);
    assert.equal(record!.id, "abc123");
    assert.equal(record!.label, "test");
    assert.equal(record!.scopes, "ping,po");
    assert.equal(record!.revoked_at, null);
  });

  it("insertKey rejects non-positive rate_limit_per_min", () => {
    assert.throws(
      () => insertKey(db, {
        id: "bad-rate",
        hash: "h",
        label: "x",
        scopes: "ping",
        rate_limit_per_min: 0,
        created_at: 1000,
      }),
      (err: unknown) => err instanceof Error && err.message.includes("must be positive"),
    );
  });

  it("insertKey rejects negative rate_limit_per_min", () => {
    assert.throws(
      () => insertKey(db, {
        id: "neg-rate",
        hash: "h",
        label: "x",
        scopes: "ping",
        rate_limit_per_min: -5,
        created_at: 1000,
      }),
      (err: unknown) => err instanceof Error && err.message.includes("must be positive"),
    );
  });

  it("insertKey throws on duplicate id", () => {
    insertKey(db, {
      id: "dup",
      hash: "h1",
      label: "first",
      scopes: "ping",
      rate_limit_per_min: null,
      created_at: 1000,
    });
    assert.throws(
      () => insertKey(db, {
        id: "dup",
        hash: "h2",
        label: "second",
        scopes: "po",
        rate_limit_per_min: null,
        created_at: 2000,
      }),
      (err: unknown) => err instanceof Error && err.message.includes("already exists"),
    );
  });

  it("findById returns undefined for unknown id", () => {
    assert.equal(findById(db, "nope"), undefined);
  });

  it("listKeys returns all keys", () => {
    insertKey(db, { id: "k1", hash: "h1", label: "a", scopes: "ping", rate_limit_per_min: null, created_at: 1000 });
    insertKey(db, { id: "k2", hash: "h2", label: "b", scopes: "po", rate_limit_per_min: 5, created_at: 2000 });
    const keys = listKeys(db);
    assert.equal(keys.length, 2);
    // Most recent first
    assert.equal(keys[0]!.id, "k2");
    assert.equal(keys[1]!.id, "k1");
  });

  it("revokeKey sets revoked_at", () => {
    insertKey(db, { id: "rev1", hash: "h", label: "x", scopes: "ping", rate_limit_per_min: null, created_at: 1000 });
    const ok = revokeKey(db, "rev1");
    assert.equal(ok, true);
    const record = findById(db, "rev1");
    assert.ok(record);
    assert.notEqual(record!.revoked_at, null);
  });

  it("revokeKey returns false for unknown id", () => {
    const ok = revokeKey(db, "nope");
    assert.equal(ok, false);
  });

  it("revokeKey returns false for already-revoked key", () => {
    insertKey(db, { id: "rev2", hash: "h", label: "x", scopes: "ping", rate_limit_per_min: null, created_at: 1000 });
    revokeKey(db, "rev2");
    const ok = revokeKey(db, "rev2");
    assert.equal(ok, false);
  });
});

describe("DB layer — idempotency_keys", () => {
  it("checkIdempotency returns null on first insert", () => {
    insertKey(db, { id: "kid1", hash: "h", label: "t", scopes: "ping", rate_limit_per_min: null, created_at: 1000 });
    const result = checkIdempotency(db, "key-1", "kid1", "/conf", 201, "hash1");
    assert.equal(result, null);
  });

  it("checkIdempotency returns existing record on duplicate (same key_id)", () => {
    insertKey(db, { id: "kid1", hash: "h", label: "t", scopes: "ping", rate_limit_per_min: null, created_at: 1000 });
    checkIdempotency(db, "key-1", "kid1", "/conf", 201, "hash1");
    const result = checkIdempotency(db, "key-1", "kid1", "/conf", 201, "hash1");
    assert.ok(result);
    assert.equal(result!.key, "key-1");
    assert.equal(result!.status, 201);
    assert.equal(result!.body_hash, "hash1");
  });

  it("checkIdempotency does NOT return record for different key_id (scoped namespace)", () => {
    insertKey(db, { id: "kid1", hash: "h", label: "t", scopes: "ping", rate_limit_per_min: null, created_at: 1000 });
    insertKey(db, { id: "kid2", hash: "h", label: "t", scopes: "ping", rate_limit_per_min: null, created_at: 1000 });
    checkIdempotency(db, "key-1", "kid1", "/conf", 201, "hash1");
    const result = checkIdempotency(db, "key-1", "kid2", "/conf", 201, "hash1");
    assert.equal(result, null, "different key_id should not see kid1's record");
  });

  it("updateIdempotencyStatus changes stored status", () => {
    insertKey(db, { id: "kid1", hash: "h", label: "t", scopes: "ping", rate_limit_per_min: null, created_at: 1000 });
    checkIdempotency(db, "key-2", "kid1", "/gr", 201, "hash2");
    updateIdempotencyStatus(db, "key-2", "kid1", 500);
    const result = checkIdempotency(db, "key-2", "kid1", "/gr", 201, "hash2");
    assert.ok(result);
    assert.equal(result!.status, 500);
  });

  it("evictIdempotencyKeys removes old entries", () => {
    insertKey(db, { id: "kid1", hash: "h", label: "t", scopes: "ping", rate_limit_per_min: null, created_at: 1000 });
    // Insert with current timestamp (will be too recent to evict)
    checkIdempotency(db, "fresh", "kid1", "/conf", 201, "h1");
    // Manually insert an old entry
    const cutoff = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
    db.prepare("INSERT INTO idempotency_keys (key, key_id, path, status, body_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("old", "kid1", "/conf", 201, "h2", cutoff);

    const evicted = evictIdempotencyKeys(db, 1800); // evict > 30 min
    assert.equal(evicted, 1);
    // Fresh key should still be there
    const result = checkIdempotency(db, "fresh", "kid1", "/conf", 201, "h1");
    assert.ok(result);
    assert.equal(result!.key, "fresh");
    // Old key should be gone — checkIdempotency will re-insert
    const oldResult = checkIdempotency(db, "old", "kid1", "/conf", 201, "h2");
    assert.equal(oldResult, null);
  });
});

describe("DB layer — audit_log", () => {
  it("writeAudit inserts a row", () => {
    insertKey(db, { id: "kid1", hash: "h", label: "t", scopes: "ping", rate_limit_per_min: null, created_at: 1000 });
    writeAudit(db, {
      req_id: "req-1",
      key_id: "kid1",
      method: "POST",
      path: "/confirmation",
      body: '{"orderid":"1000000"}',
      sap_status: 201,
      sap_duration_ms: 123,
    });
    const row = db.prepare("SELECT * FROM audit_log WHERE req_id = ?").get("req-1") as Record<string, unknown> | undefined;
    assert.ok(row);
    assert.equal(row!.method, "POST");
    assert.equal(row!.path, "/confirmation");
    assert.equal(row!.sap_status, 201);
    assert.equal(row!.key_id, "kid1");
    assert.equal(row!.sap_duration_ms, 123);
  });

  it("writeAudit with optional fields null", () => {
    insertKey(db, { id: "kid2", hash: "h", label: "t", scopes: "ping", rate_limit_per_min: null, created_at: 1000 });
    writeAudit(db, {
      req_id: "req-2",
      key_id: "kid2",
      method: "GET",
      path: "/ping",
    });
    const row = db.prepare("SELECT * FROM audit_log WHERE req_id = ?").get("req-2") as Record<string, unknown> | undefined;
    assert.ok(row);
    assert.equal(row!.body, null);
    assert.equal(row!.sap_status, null);
    assert.equal(row!.sap_duration_ms, null);
  });

  it("writeAudit does not truncate body at exactly 4096 characters", () => {
    insertKey(db, { id: "kid1", hash: "h", label: "t", scopes: "ping", rate_limit_per_min: null, created_at: 1000 });
    const body4096 = "x".repeat(4096);
    writeAudit(db, {
      req_id: "req-boundary",
      key_id: "kid1",
      method: "POST",
      path: "/confirmation",
      body: body4096,
      sap_status: 201,
    });
    const row = db.prepare("SELECT body FROM audit_log WHERE req_id = ?").get("req-boundary") as { body: string } | undefined;
    assert.ok(row);
    assert.equal(row!.body!.length, 4096, "body at exactly 4096 chars should not be truncated");
  });

  it("writeAudit truncates body at 4097 characters", () => {
    insertKey(db, { id: "kid1", hash: "h", label: "t", scopes: "ping", rate_limit_per_min: null, created_at: 1000 });
    const body4097 = "x".repeat(4097);
    writeAudit(db, {
      req_id: "req-over",
      key_id: "kid1",
      method: "POST",
      path: "/confirmation",
      body: body4097,
      sap_status: 201,
    });
    const row = db.prepare("SELECT body FROM audit_log WHERE req_id = ?").get("req-over") as { body: string } | undefined;
    assert.ok(row);
    assert.ok(row!.body!.length > 4096, "truncated body should include the suffix marker");
    assert.ok(row!.body!.includes("[truncated"), "should contain truncation marker");
  });

  it("v2 adds sap_duration_ms column", () => {
    insertKey(db, { id: "k", hash: "h", label: "t", scopes: "ping", rate_limit_per_min: null, created_at: 1000 });
    // Insert a row so the SELECT works even with an empty table
    writeAudit(db, { req_id: "v2test", key_id: "k", method: "GET", path: "/t", sap_duration_ms: 42 });
    const row = db.prepare("SELECT sap_duration_ms FROM audit_log WHERE req_id = ?").get("v2test") as Record<string, unknown> | undefined;
    assert.ok(row);
    assert.equal(row!.sap_duration_ms, 42);
  });
});

describe("DB layer — migrations", () => {
  it("runMigrations creates _migrations table", () => {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'").get() as { name: string } | undefined;
    assert.ok(table);
    assert.equal(table!.name, "_migrations");
  });

  it("runMigrations applies latest version", () => {
    const row = db.prepare("SELECT version FROM _migrations ORDER BY version DESC LIMIT 1").get() as { version: number } | undefined;
    assert.ok(row);
    assert.ok(row!.version >= 9);
  });

  it("runMigrations is idempotent — calling twice does not re-apply v1", () => {
    const before = db.prepare("SELECT COUNT(*) AS cnt FROM _migrations").get() as { cnt: number };
    runMigrations(db); // second call
    const after = db.prepare("SELECT COUNT(*) AS cnt FROM _migrations").get() as { cnt: number };
    assert.equal(after.cnt, before.cnt);
  });

  it("v1 creates expected indexes (v6 drops created_at, v9 drops key_id)", () => {
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'").all() as { name: string }[];
    const names = indexes.map(i => i.name);
    // idx_idempotency_created_at: created by v1, dropped by v8 table recreate,
    // then re-created by v8 migration. So it should still exist.
    assert.ok(names.includes("idx_idempotency_created_at"));
    // idx_audit_log_key_id was created by v1 but dropped by v9 (redundant
    // with v4's idx_audit_log_key_created composite which subsumes it)
    assert.ok(!names.includes("idx_audit_log_key_id"), "v9 should have dropped this redundant index");
    // idx_audit_log_created_at was created by v1 but dropped by v6 (redundant
    // with v5's idx_audit_log_created_at_retention which serves the same column)
    assert.ok(!names.includes("idx_audit_log_created_at"), "v6 should have dropped this redundant index");
  });

  it("v4 creates composite and idempotency indexes", () => {
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'").all() as { name: string }[];
    const names = indexes.map(i => i.name);
    assert.ok(names.includes("idx_audit_log_key_created"), "composite index on audit_log(key_id, created_at)");
    assert.ok(names.includes("idx_idempotency_key_id"), "index on idempotency_keys(key_id)");
    assert.ok(names.includes("idx_audit_log_path"), "v3 path index");
  });

  it("v5 creates retention index, v6 drops redundant created_at index", () => {
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'").all() as { name: string }[];
    const names = indexes.map(i => i.name);
    assert.ok(names.includes("idx_audit_log_created_at_retention"), "v5 retention index");
    assert.ok(!names.includes("idx_audit_log_created_at"), "v6 dropped redundant index");
  });

  it("v8 migrates idempotency_keys PK from (key) to (key, key_id)", () => {
    const tableInfo = db.prepare("PRAGMA table_info(idempotency_keys)").all() as { name: string; pk: number }[];
    const pkCols = tableInfo.filter(c => c.pk > 0).map(c => c.name);
    assert.deepStrictEqual(pkCols, ["key", "key_id"], "composite PK should be (key, key_id)");
  });

  it("v11 adds REFERENCES api_keys(id) to audit_log.key_id and idempotency_keys.key_id", () => {
    // Check audit_log.key_id references api_keys.id
    const auditFK = db.prepare("PRAGMA foreign_key_list(audit_log)").all() as { table: string; from: string; to: string }[];
    const auditKeyIdFK = auditFK.find(fk => fk.from === "key_id");
    assert.ok(auditKeyIdFK, "audit_log.key_id should have a foreign key");
    assert.equal(auditKeyIdFK!.table, "api_keys", "audit_log.key_id should reference api_keys");
    assert.equal(auditKeyIdFK!.to, "id", "audit_log.key_id should reference api_keys.id");

    // Check idempotency_keys.key_id references api_keys.id
    const idempFK = db.prepare("PRAGMA foreign_key_list(idempotency_keys)").all() as { table: string; from: string; to: string }[];
    const idempKeyIdFK = idempFK.find(fk => fk.from === "key_id");
    assert.ok(idempKeyIdFK, "idempotency_keys.key_id should have a foreign key");
    assert.equal(idempKeyIdFK!.table, "api_keys", "idempotency_keys.key_id should reference api_keys");
    assert.equal(idempKeyIdFK!.to, "id", "idempotency_keys.key_id should reference api_keys.id");
  });

  it("FK enforcement prevents inserting audit_log with non-existent key_id", () => {
    assert.throws(
      () => writeAudit(db, {
        req_id: "orphan",
        key_id: "nonexistent_key",
        method: "GET",
        path: "/ping",
      }),
      (err: unknown) => err instanceof Error && err.message.includes("FOREIGN KEY"),
    );
  });

  it("FK enforcement prevents inserting idempotency_keys with non-existent key_id", () => {
    assert.throws(
      () => checkIdempotency(db, "ik1", "nonexistent_key", "/conf", 201, "hash1"),
      (err: unknown) => err instanceof Error && err.message.includes("FOREIGN KEY"),
    );
  });
});

describe("DB layer — pruneAuditLog batch boundary", () => {
  it("prunes >10k rows across multiple batch iterations", () => {
    insertKey(db, { id: "k", hash: "h", label: "t", scopes: "ping", rate_limit_per_min: null, created_at: 1000 });
    const now = Math.floor(Date.now() / 1000);
    const stale = now - 31 * 86_400;
    // Insert 10_001 stale rows to exercise the do/while boundary
    const insert = db.prepare(
      "INSERT INTO audit_log (req_id, key_id, method, path, body, sap_status, sap_duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const insertMany = db.transaction((count: number) => {
      for (let i = 0; i < count; i++) {
        insert.run(`batch-${i}`, "k", "GET", "/ping", null, 200, null, stale);
      }
    });
    insertMany(10_001);
    // Also insert a recent row that must survive
    db.prepare(
      "INSERT INTO audit_log (req_id, key_id, method, path, body, sap_status, sap_duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("recent", "k", "GET", "/ping", null, 200, null, now);

    const removed = pruneAuditLog(db, 30);
    assert.equal(removed, 10_001, "all stale rows should be pruned across batches");

    // Recent row survives
    const recent = db.prepare("SELECT req_id FROM audit_log WHERE req_id = 'recent'").get();
    assert.ok(recent, "recent row should survive pruning");

    // Total rows left = 1
    const remaining = db.prepare("SELECT COUNT(*) AS cnt FROM audit_log").get() as { cnt: number };
    assert.equal(remaining.cnt, 1, "only the recent row should remain");
  });
});
