import { createMiddleware } from "hono/factory";
import type { HubVariables } from "../types.js";
import { checkIdempotency, evictIdempotencyKeys, type IdempotencyRecord } from "../db/index.js";
import type Database from "better-sqlite3";

/** Evict keys older than 5 minutes (300 seconds). */
export const IDEMPOTENCY_MAX_AGE_SECONDS = 300;

/** Evict with ~1% probability per request to reduce write amplification. */
export const EVICTION_PROBABILITY = 0.01;

/** Run eviction if the random check passes. Exported for unit testing. */
export function maybeEvict(db: Database.Database | undefined, random: number): void {
  if (random < EVICTION_PROBABILITY && db) {
    try {
      evictIdempotencyKeys(db, IDEMPOTENCY_MAX_AGE_SECONDS);
    } catch {
      // Eviction is best-effort — a failed eviction must not kill the request.
      // Table locked, disk error, or missing table (e.g. test with dropped table)
      // are all non-fatal.
    }
  }
}

/** Reject duplicate write-back requests within a 5-minute window. */
export const idempotencyGuard = createMiddleware<{ Variables: HubVariables }>(async (c, next) => {
  // Probabilistic eviction of stale keys (~1% of requests)
  maybeEvict(c.get("db"), Math.random());
  const idempotencyKey = c.req.header("idempotency-key");
  if (!idempotencyKey || idempotencyKey.trim() === "") {
    return c.json({ error: "Missing Idempotency-Key header" }, 400);
  }
  // Trim leading/trailing whitespace from idempotency key —
  // "  my-key  " and "my-key" should be treated as the same key
  const trimmedKey = idempotencyKey.trim();
  if (trimmedKey.length > 128) {
    return c.json({ error: "Idempotency-Key header exceeds maximum length of 128" }, 400);
  }
  if (/[\x00-\x1F\x7F]/.test(trimmedKey)) {
    return c.json({ error: "Idempotency-Key header contains invalid characters" }, 400);
  }

  // Hash the request body for dedup comparison. If the body cannot be read
  // (already consumed by earlier middleware), use a sentinel value so that
  // a retry with a readable body doesn't false-positive a hash mismatch.
  // The DB schema enforces body_hash <> '' (CHECK constraint), so we use
  // a SHA-256 of the empty string as the sentinel for consumed/empty bodies.
  //
  // Canonicalization: parse JSON, then re-serialize with keys sorted. This
  // prevents false-positive 422 mismatches when semantically identical JSON
  // arrives with different key ordering (e.g. {"a":1,"b":2} vs {"b":2,"a":1}).
  const EMPTY_BODY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  let bodyHash = EMPTY_BODY_HASH;
  try {
    const body = await c.req.text();
    if (body.length > 0) {
      // Canonicalize: parse and re-stringify with sorted keys
      const parsed = JSON.parse(body);
      const canonical = JSON.stringify(parsed, Object.keys(parsed).sort());
      const encoder = new TextEncoder();
      const data = encoder.encode(canonical);
      const hashBuffer = await crypto.subtle.digest("SHA-256", data);
      bodyHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
    }
  } catch {
    // Body already consumed or not valid JSON — use sentinel to avoid false
    // 422 on retry. Invalid JSON bodies will be rejected by the route handler's
    // Zod validation, not by the idempotency guard.
    bodyHash = EMPTY_BODY_HASH;
  }

  const payload = c.get("jwtPayload");
  const keyId = payload.key_id;

  // Access db from app context — passed via env
  const db = c.get("db");
  if (!db) {
    // No DB available (test scenario without db) — skip check
    c.set("idempotencyKey", trimmedKey);
    await next();
    return;
  }

  let existing: IdempotencyRecord | null;
  try {
    existing = checkIdempotency(db, trimmedKey, keyId, c.req.path, 0, bodyHash);
  } catch {
    // DB write failure (disk full, I/O error, lock). Proceed without
    // idempotency protection rather than returning an opaque 500 —
    // matches the audit-write failure pattern in sap-call.ts.
    c.set("idempotencyKey", trimmedKey);
    await next();
    return;
  }
  if (existing) {
    // Body hash mismatch: client reused idempotency key with different body.
    // Skip mismatch check when either hash is the sentinel (SHA-256 of empty
    // string) — a consumed/empty body from a failed first request should not
    // block a legitimate retry.
    if (existing.body_hash !== bodyHash && existing.body_hash !== EMPTY_BODY_HASH && bodyHash !== EMPTY_BODY_HASH) {
      return c.json(
        { error: "Idempotency-Key already used with different request body" },
        422,
      );
    }
    // If status is still 0 (pending), the previous request crashed before
    // completing. Return 409 without original_status to signal the client
    // should retry with a new idempotency key rather than treating 0 as
    // a valid response code.
    if (existing.status === 0) {
      return c.json(
        { error: "Duplicate request; previous attempt did not complete. Retry with a new Idempotency-Key" },
        409,
      );
    }
    return c.json(
      { error: "Duplicate request", original_status: existing.status },
      409,
    );
  }

  c.set("idempotencyKey", trimmedKey);
  await next();
});
