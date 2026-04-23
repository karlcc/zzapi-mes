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
    evictIdempotencyKeys(db, IDEMPOTENCY_MAX_AGE_SECONDS);
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
  if (idempotencyKey.length > 128) {
    return c.json({ error: "Idempotency-Key header exceeds maximum length of 128" }, 400);
  }
  if (/[\x00-\x1F\x7F]/.test(idempotencyKey)) {
    return c.json({ error: "Idempotency-Key header contains invalid characters" }, 400);
  }

  // Hash the request body for dedup comparison
  let bodyHash = "";
  try {
    const body = await c.req.text();
    const encoder = new TextEncoder();
    const data = encoder.encode(body);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    bodyHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
  } catch {
    // Empty body — hash stays empty
  }

  const payload = c.get("jwtPayload");
  const keyId = payload.key_id;

  // Access db from app context — passed via env
  const db = c.get("db");
  if (!db) {
    // No DB available (test scenario without db) — skip check
    c.set("idempotencyKey", idempotencyKey);
    await next();
    return;
  }

  let existing: IdempotencyRecord | null;
  try {
    existing = checkIdempotency(db, idempotencyKey, keyId, c.req.path, 0, bodyHash);
  } catch {
    // DB write failure (disk full, I/O error, lock). Proceed without
    // idempotency protection rather than returning an opaque 500 —
    // matches the audit-write failure pattern in sap-call.ts.
    c.set("idempotencyKey", idempotencyKey);
    await next();
    return;
  }
  if (existing) {
    // Body hash mismatch: client reused idempotency key with different body
    if (existing.body_hash !== bodyHash) {
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

  c.set("idempotencyKey", idempotencyKey);
  await next();
});
