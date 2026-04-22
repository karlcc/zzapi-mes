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
    const result = checkIdempotency(db, "key-1", "kid1", "/conf", 201, "hash1");
    assert.equal(result, null);
  });

  it("checkIdempotency returns existing record on duplicate", () => {
    checkIdempotency(db, "key-1", "kid1", "/conf", 201, "hash1");
    const result = checkIdempotency(db, "key-1", "kid2", "/conf", 201, "hash1");
    assert.ok(result);
    assert.equal(result!.key, "key-1");
    assert.equal(result!.status, 201);
    assert.equal(result!.body_hash, "hash1");
  });

  it("updateIdempotencyStatus changes stored status", () => {
    checkIdempotency(db, "key-2", "kid1", "/gr", 201, "hash2");
    updateIdempotencyStatus(db, "key-2", 500);
    const result = checkIdempotency(db, "key-2", "kid1", "/gr", 201, "hash2");
    assert.ok(result);
    assert.equal(result!.status, 500);
  });

  it("evictIdempotencyKeys removes old entries", () => {
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
    writeAudit(db, {
      req_id: "req-1",
      key_id: "kid1",
      method: "POST",
      path: "/confirmation",
      body: '{"orderid":"1000000"}',
      sap_status: 201,
    });
    const row = db.prepare("SELECT * FROM audit_log WHERE req_id = ?").get("req-1") as Record<string, unknown> | undefined;
    assert.ok(row);
    assert.equal(row!.method, "POST");
    assert.equal(row!.path, "/confirmation");
    assert.equal(row!.sap_status, 201);
    assert.equal(row!.key_id, "kid1");
  });

  it("writeAudit with optional fields null", () => {
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
  });
});
