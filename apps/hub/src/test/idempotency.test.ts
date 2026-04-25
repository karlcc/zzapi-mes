import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { runMigrations, checkIdempotency, evictIdempotencyKeys, insertKey } from "../db/index.js";
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
    insertKey(db, { id: "k1", hash: "h", label: "t", scopes: "conf", rate_limit_per_min: null, created_at: now });
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
    insertKey(db, { id: "k1", hash: "h", label: "t", scopes: "conf", rate_limit_per_min: null, created_at: now });
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
    insertKey(db, { id: "k1", hash: "h", label: "t", scopes: "conf", rate_limit_per_min: null, created_at: Math.floor(Date.now() / 1000) });
    // First insert succeeds
    const result1 = checkIdempotency(db, "race-key", "k1", "/confirmation", 201, "hash1");
    assert.equal(result1, null, "first insert should return null");

    // Second insert of the same key should return the existing record (UNIQUE constraint path)
    const result2 = checkIdempotency(db, "race-key", "k1", "/confirmation", 201, "hash1");
    assert.ok(result2, "duplicate insert should return existing record");
    assert.equal(result2!.key, "race-key");
    assert.equal(result2!.body_hash, "hash1");
  });

  it("returns existing record when same key_id reuses same idempotency key", () => {
    insertKey(db, { id: "k1", hash: "h", label: "t", scopes: "conf", rate_limit_per_min: null, created_at: Math.floor(Date.now() / 1000) });
    checkIdempotency(db, "scoped-key", "k1", "/confirmation", 201, "hash1");
    const result = checkIdempotency(db, "scoped-key", "k1", "/confirmation", 201, "hash1");
    assert.ok(result, "should return existing record for same key_id");
    assert.equal(result!.body_hash, "hash1");
  });

  it("does NOT return existing record when different key_id uses same idempotency key", () => {
    insertKey(db, { id: "k1", hash: "h", label: "t", scopes: "conf", rate_limit_per_min: null, created_at: Math.floor(Date.now() / 1000) });
    insertKey(db, { id: "k2", hash: "h", label: "t", scopes: "conf", rate_limit_per_min: null, created_at: Math.floor(Date.now() / 1000) });
    checkIdempotency(db, "shared-key", "k1", "/confirmation", 201, "hash1");
    const result = checkIdempotency(db, "shared-key", "k2", "/confirmation", 201, "hash2");
    // Different API key (key_id) using the same Idempotency-Key header
    // should NOT collide — each key_id has its own idempotency namespace
    assert.equal(result, null, "different key_id should not see k1's idempotency record");
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
    insertKey(pendDb, { id: "k1", hash: "h", label: "t", scopes: "conf", rate_limit_per_min: null, created_at: Math.floor(Date.now() / 1000) });
    const result = checkIdempotency(pendDb, "pending-key", "k1", "/confirmation", 0, "hash1");
    assert.equal(result, null, "first insert returns null");
    // Look up again — should get the record with status=0
    const existing = checkIdempotency(pendDb, "pending-key", "k1", "/confirmation", 0, "hash1");
    assert.ok(existing, "duplicate should return existing record");
    assert.equal(existing!.status, 0, "pending status should be 0");
  });
});

describe("idempotency empty bodyHash edge case", () => {
  let eDb: Database.Database;
  beforeEach(() => {
    eDb = new Database(":memory:");
    runMigrations(eDb);
  });
  afterEach(() => { eDb.close(); });

  it("empty body_hash sentinel matches any subsequent body hash (crash-retry)", () => {
    insertKey(eDb, { id: "k1", hash: "h", label: "t", scopes: "conf", rate_limit_per_min: null, created_at: Math.floor(Date.now() / 1000) });
    // When the first request's body is consumed/empty, the middleware uses
    // the SHA-256 of empty string as a sentinel hash. The middleware skips
    // mismatch checks when either hash is the sentinel, so a legitimate
    // retry with a real body hash returns 409 (duplicate) not 422.
    const EMPTY_BODY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const result1 = checkIdempotency(eDb, "empty-hash-key", "k1", "/confirmation", 0, EMPTY_BODY_HASH);
    assert.equal(result1, null, "first insert with sentinel hash succeeds");

    // Second request with same key but real hash — checkIdempotency returns
    // the existing record; the middleware will skip the 422 mismatch check
    // because the stored hash is the sentinel.
    const existing = checkIdempotency(eDb, "empty-hash-key", "k1", "/confirmation", 0, "abc123def");
    assert.ok(existing, "should return existing record");
    assert.equal(existing!.body_hash, EMPTY_BODY_HASH, "stored hash should be sentinel");
  });
});

describe("idempotency body hash canonicalization", () => {
  it("same JSON with different key ordering produces same canonical hash", async () => {
    const body1 = '{"orderid":"100","menge":5}';
    const body2 = '{"menge":5,"orderid":"100"}';

    // Simulate the middleware's canonical hash computation
    const hashBody = async (body: string): Promise<string> => {
      const EMPTY_BODY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
      if (body.length === 0) return EMPTY_BODY_HASH;
      const parsed = JSON.parse(body);
      const canonical = JSON.stringify(parsed, Object.keys(parsed).sort());
      const encoder = new TextEncoder();
      const data = encoder.encode(canonical);
      const hashBuffer = await crypto.subtle.digest("SHA-256", data);
      return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
    };

    const hash1 = await hashBody(body1);
    const hash2 = await hashBody(body2);
    assert.equal(hash1, hash2, "reordered JSON should produce same canonical hash");
  });

  it("different JSON produces different canonical hash", async () => {
    const body1 = '{"orderid":"100","menge":5}';
    const body2 = '{"orderid":"200","menge":5}';

    const hashBody = async (body: string): Promise<string> => {
      const parsed = JSON.parse(body);
      const canonical = JSON.stringify(parsed, Object.keys(parsed).sort());
      const encoder = new TextEncoder();
      const data = encoder.encode(canonical);
      const hashBuffer = await crypto.subtle.digest("SHA-256", data);
      return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
    };

    const hash1 = await hashBody(body1);
    const hash2 = await hashBody(body2);
    assert.notEqual(hash1, hash2, "different JSON should produce different hash");
  });
});
