import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ZzapiMesHttpError } from "@zzapi-mes/core";
import { mapSapError } from "../routes/write-back.js";
import Database from "better-sqlite3";
import { runMigrations, insertKey, checkIdempotency, updateIdempotencyStatus } from "../db/index.js";

describe("mapSapError all-branches unit test", () => {
  it("409 → clientStatus 409, message preserved", () => {
    const result = mapSapError(new ZzapiMesHttpError(409, "Backflush conflict"));
    assert.equal(result.sapStatus, 409);
    assert.equal(result.clientStatus, 409);
    assert.equal(result.errorMsg, "Backflush conflict");
  });

  it("422 → clientStatus 422, message preserved", () => {
    const result = mapSapError(new ZzapiMesHttpError(422, "No authorization"));
    assert.equal(result.sapStatus, 422);
    assert.equal(result.clientStatus, 422);
    assert.equal(result.errorMsg, "No authorization");
  });

  it("429 → clientStatus 429, message preserved, retryAfter captured", () => {
    const result = mapSapError(new ZzapiMesHttpError(429, "Too many requests", 30));
    assert.equal(result.sapStatus, 429);
    assert.equal(result.clientStatus, 429);
    assert.equal(result.errorMsg, "Too many requests");
    assert.equal(result.retryAfter, 30);
  });

  it("408 → clientStatus 504, message rewritten to 'SAP upstream error'", () => {
    const result = mapSapError(new ZzapiMesHttpError(408, "SAP request timeout"));
    assert.equal(result.sapStatus, 408);
    assert.equal(result.clientStatus, 504);
    assert.equal(result.errorMsg, "SAP upstream error");
  });

  it("400 → clientStatus 502, message 'SAP rejected request'", () => {
    // SAP 400 is a client error from SAP's perspective, not ours.
    // A specific message avoids misleading "SAP upstream error" phrasing.
    const result = mapSapError(new ZzapiMesHttpError(400, "Bad request"));
    assert.equal(result.sapStatus, 400);
    assert.equal(result.clientStatus, 502);
    assert.equal(result.errorMsg, "SAP rejected request");
  });

  it("other 4xx (e.g. 403) → clientStatus 502, message rewritten", () => {
    const result = mapSapError(new ZzapiMesHttpError(403, "Forbidden"));
    assert.equal(result.sapStatus, 403);
    assert.equal(result.clientStatus, 502);
    assert.equal(result.errorMsg, "SAP upstream error");
  });

  it("5xx (e.g. 500) → clientStatus 502, message rewritten", () => {
    const result = mapSapError(new ZzapiMesHttpError(500, "Internal server error"));
    assert.equal(result.sapStatus, 500);
    assert.equal(result.clientStatus, 502);
    assert.equal(result.errorMsg, "SAP upstream error");
  });

  it("non-ZzapiMesHttpError → clientStatus 502, generic message", () => {
    const result = mapSapError(new Error("network failure"));
    assert.equal(result.sapStatus, 502);
    assert.equal(result.clientStatus, 502);
    assert.equal(result.errorMsg, "SAP upstream error");
  });

  it("404 → clientStatus 502, message 'SAP endpoint not found'", () => {
    // Misconfigured ICF path returns 404 — should give a more specific
    // message than the generic "SAP upstream error".
    const result = mapSapError(new ZzapiMesHttpError(404, "Not found"));
    assert.equal(result.sapStatus, 404);
    assert.equal(result.clientStatus, 502);
    assert.equal(result.errorMsg, "SAP endpoint not found");
  });

  it("400 → clientStatus 502, message 'SAP rejected request'", () => {
    // SAP 400 is a client error from SAP's perspective, not ours.
    // A specific message avoids misleading "SAP upstream error" phrasing.
    const result = mapSapError(new ZzapiMesHttpError(400, "Bad request"));
    assert.equal(result.sapStatus, 400);
    assert.equal(result.clientStatus, 502);
    assert.equal(result.errorMsg, "SAP rejected request");
  });
});

describe("withWriteBack crash-before-audit: pending idempotency blocks retry", () => {
  // When withWriteBack crashes after SAP succeeds but before the atomic
  // audit+idempotency transaction commits, the idempotency key stays at
  // status=0 (pending). A subsequent retry with the same key should get 409
  // with "previous attempt did not complete" rather than being allowed through.

  it("pending idempotency key (status=0) blocks retry via checkIdempotency", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    insertKey(db, { id: "k1", hash: "h", label: "t", scopes: "conf", rate_limit_per_min: null, created_at: Math.floor(Date.now() / 1000) });
    const EMPTY_BODY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    // Simulate crash-before-audit: key inserted with status=0 but never updated
    const result1 = checkIdempotency(db, "crash-key-001", "k1", "/confirmation", 0, EMPTY_BODY_HASH);
    assert.equal(result1, null, "first insert should succeed");

    // Retry with same key — should return the pending record
    const result2 = checkIdempotency(db, "crash-key-001", "k1", "/confirmation", 0, EMPTY_BODY_HASH);
    assert.ok(result2, "duplicate should return existing record");
    assert.equal(result2!.status, 0, "pending status should be 0");

    updateIdempotencyStatus(db, "crash-key-001", "k1", 201);
    const result3 = checkIdempotency(db, "crash-key-001", "k1", "/confirmation", 0, EMPTY_BODY_HASH);
    assert.ok(result3, "should return record after status update");
    assert.equal(result3!.status, 201, "status should be updated to 201");

    db.close();
  });

  it("different key_id for same key does NOT collide — each key_id has its own namespace", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    insertKey(db, { id: "k1", hash: "h", label: "t", scopes: "conf", rate_limit_per_min: null, created_at: Math.floor(Date.now() / 1000) });
    insertKey(db, { id: "k2", hash: "h", label: "t", scopes: "conf", rate_limit_per_min: null, created_at: Math.floor(Date.now() / 1000) });
    const EMPTY_BODY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    checkIdempotency(db, "shared-crash-key", "k1", "/confirmation", 0, EMPTY_BODY_HASH);
    const result = checkIdempotency(db, "shared-crash-key", "k2", "/confirmation", 0, EMPTY_BODY_HASH);
    // Different API key (key_id) using the same Idempotency-Key header
    // should NOT see k1's record — idempotency is scoped per key_id
    assert.equal(result, null, "different key_id should not see k1's idempotency record");

    db.close();
  });
});
