import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { runMigrations, checkIdempotency, evictIdempotencyKeys } from "../db/index.js";
import { maybeEvict, IDEMPOTENCY_MAX_AGE_SECONDS, EVICTION_PROBABILITY } from "../middleware/idempotency.js";

let db: Database.Database;

describe("idempotency guard eviction logic", () => {
  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
  });
  afterEach(() => { db.close(); });

  it("maybeEvict calls evictIdempotencyKeys when random < EVICTION_PROBABILITY", () => {
    const now = Math.floor(Date.now() / 1000);
    // Insert a stale key
    db.prepare("INSERT INTO idempotency_keys (key, key_id, path, status, body_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("stale-key", "k1", "/confirmation", 201, "hash1", now - 600);
    // Insert a fresh key
    checkIdempotency(db, "fresh-key", "k1", "/confirmation", 201, "hash2");

    // Force eviction by passing random=0 (always < 0.01)
    maybeEvict(db, 0);

    const stale = db.prepare("SELECT key FROM idempotency_keys WHERE key = 'stale-key'").get();
    const fresh = db.prepare("SELECT key FROM idempotency_keys WHERE key = 'fresh-key'").get();
    assert.equal(stale, undefined, "stale key should be evicted");
    assert.ok(fresh, "fresh key should survive");
  });

  it("maybeEvict is a no-op when random >= EVICTION_PROBABILITY", () => {
    const now = Math.floor(Date.now() / 1000);
    db.prepare("INSERT INTO idempotency_keys (key, key_id, path, status, body_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("stale-key", "k1", "/confirmation", 201, "hash1", now - 600);

    // Skip eviction by passing random=1 (always >= 0.01)
    maybeEvict(db, 1);

    const stale = db.prepare("SELECT key FROM idempotency_keys WHERE key = 'stale-key'").get();
    assert.ok(stale, "stale key should NOT be evicted when random >= threshold");
  });

  it("maybeEvict is a no-op when db is undefined", () => {
    // Should not throw
    maybeEvict(undefined, 0);
  });

  it("EVICTION_PROBABILITY is approximately 1%", () => {
    assert.ok(EVICTION_PROBABILITY > 0 && EVICTION_PROBABILITY < 0.1);
  });

  it("IDEMPOTENCY_MAX_AGE_SECONDS is 300 (5 minutes)", () => {
    assert.equal(IDEMPOTENCY_MAX_AGE_SECONDS, 300);
  });
});

describe("checkIdempotency race condition (UNIQUE constraint retry)", () => {
  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
  });
  afterEach(() => { db.close(); });

  it("simulates UNIQUE constraint race by inserting same key directly", () => {
    // First insert succeeds
    const result1 = checkIdempotency(db, "race-key", "k1", "/confirmation", 201, "hash1");
    assert.equal(result1, null, "first insert should return null");

    // Second insert of the same key should return the existing record (UNIQUE constraint path)
    const result2 = checkIdempotency(db, "race-key", "k1", "/confirmation", 201, "hash1");
    assert.ok(result2, "duplicate insert should return existing record");
    assert.equal(result2!.key, "race-key");
    assert.equal(result2!.body_hash, "hash1");
  });

  it("returns existing record even when called with different key_id", () => {
    checkIdempotency(db, "shared-key", "k1", "/confirmation", 201, "hash1");
    const result = checkIdempotency(db, "shared-key", "k2", "/confirmation", 201, "hash1");
    assert.ok(result, "should return existing record regardless of key_id");
  });
});

describe("idempotency guard pending-status handling", () => {
  let pendDb: Database.Database;
  beforeEach(() => {
    pendDb = new Database(":memory:");
    runMigrations(pendDb);
  });
  afterEach(() => { pendDb.close(); });

  it("checkIdempotency returns status=0 for newly inserted key (pending)", () => {
    const result = checkIdempotency(pendDb, "pending-key", "k1", "/confirmation", 0, "hash1");
    assert.equal(result, null, "first insert returns null");
    // Look up again — should get the record with status=0
    const existing = checkIdempotency(pendDb, "pending-key", "k1", "/confirmation", 0, "hash1");
    assert.ok(existing, "duplicate should return existing record");
    assert.equal(existing!.status, 0, "pending status should be 0");
  });
});
