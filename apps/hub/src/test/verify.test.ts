import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import argon2 from "argon2";
import { verifyApiKey } from "../auth/verify.js";
import { runMigrations, insertKey } from "../db/index.js";

let db: Database.Database;

describe("verifyApiKey", () => {
  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
  });

  async function seedKey(id: string, scopes = "ping,po", rateLimit: number | null = null): Promise<string> {
    const secret = "testsecret123456789abcdef0123456789";
    const plaintext = `${id}.${secret}`;
    const hash = await argon2.hash(plaintext, { type: argon2.argon2id });
    insertKey(db, {
      id,
      hash,
      label: "verify test key",
      scopes,
      rate_limit_per_min: rateLimit,
      created_at: Math.floor(Date.now() / 1000),
    });
    return plaintext;
  }

  it("returns verified key for valid API key", async () => {
    const plaintext = await seedKey("validkey1");
    const result = await verifyApiKey(db, plaintext);
    assert.ok(result);
    assert.equal(result.key_id, "validkey1");
    assert.deepEqual(result.scopes, ["ping", "po"]);
    assert.equal(result.rate_limit_per_min, null);
  });

  it("returns null for key with no dot separator", async () => {
    await seedKey("nodotkey");
    const result = await verifyApiKey(db, "nodotkey");
    assert.equal(result, null);
  });

  it("returns null for key starting with dot", async () => {
    const result = await verifyApiKey(db, ".secret");
    assert.equal(result, null);
  });

  it("returns null for unknown key_id", async () => {
    const result = await verifyApiKey(db, "unknown.someSecret1234567890123456");
    assert.equal(result, null);
  });

  it("returns null for revoked key", async () => {
    const plaintext = await seedKey("revokedkey");
    db.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ?").run(Math.floor(Date.now() / 1000), "revokedkey");
    const result = await verifyApiKey(db, plaintext);
    assert.equal(result, null);
  });

  it("returns null for wrong secret", async () => {
    await seedKey("goodkey");
    const result = await verifyApiKey(db, "goodkey.wrongsecret00000000000000");
    assert.equal(result, null);
  });

  it("parses scopes with extra whitespace", async () => {
    const plaintext = await seedKey("wskey", " ping , po , material ");
    const result = await verifyApiKey(db, plaintext);
    assert.ok(result);
    assert.deepEqual(result.scopes, ["ping", "po", "material"]);
  });

  it("preserves rate_limit_per_min", async () => {
    const plaintext = await seedKey("ratelimited", "ping", 30);
    const result = await verifyApiKey(db, plaintext);
    assert.ok(result);
    assert.equal(result.rate_limit_per_min, 30);
  });

  it("handles key with multiple dots (splits on first)", async () => {
    const secret = "part2.part3";
    const plaintext = `multidot.${secret}`;
    const hash = await argon2.hash(plaintext, { type: argon2.argon2id });
    insertKey(db, {
      id: "multidot",
      hash,
      label: "multi-dot test",
      scopes: "ping",
      rate_limit_per_min: null,
      created_at: Math.floor(Date.now() / 1000),
    });
    const result = await verifyApiKey(db, plaintext);
    assert.ok(result);
    assert.equal(result.key_id, "multidot");
  });

  it("returns null for empty string input", async () => {
    const result = await verifyApiKey(db, "");
    assert.equal(result, null);
  });

  it("returns null when DB throws during findById", async () => {
    const plaintext = await seedKey("dberrkey");
    const brokenDb = {
      prepare: () => { throw new Error("disk I/O error"); },
    } as unknown as Database.Database;
    const result = await verifyApiKey(brokenDb, plaintext);
    assert.equal(result, null);
  });

  it("returns null when argon2.verify throws (corrupted hash)", async () => {
    insertKey(db, {
      id: "corruptkey",
      hash: "$argon2id$INVALID_HASH_GARBAGE",
      label: "corrupt test",
      scopes: "ping",
      rate_limit_per_min: null,
      created_at: Math.floor(Date.now() / 1000),
    });
    const result = await verifyApiKey(db, "corruptkey.someSecret1234567890123456");
    assert.equal(result, null);
  });

  it("filters empty entries from scopes string", async () => {
    const plaintext = await seedKey("scopefilter");
    // Manually update the scopes to include empty entries
    db.prepare("UPDATE api_keys SET scopes = ? WHERE id = ?").run(",ping,,po,", "scopefilter");
    const result = await verifyApiKey(db, plaintext);
    assert.ok(result);
    assert.deepEqual(result!.scopes, ["ping", "po"]);
  });
});
