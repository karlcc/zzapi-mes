import { createMiddleware } from "hono/factory";
import type { HubVariables } from "../types.js";
import type Database from "better-sqlite3";
import { checkIdempotency, updateIdempotencyStatus, type IdempotencyRecord } from "../db/index.js";

/** Reject duplicate write-back requests within a 5-minute window. */
export const idempotencyGuard = createMiddleware<{ Variables: HubVariables }>(async (c, next) => {
  const idempotencyKey = c.req.header("idempotency-key");
  if (!idempotencyKey) {
    return c.json({ error: "Missing Idempotency-Key header" }, 400);
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

  const payload = c.get("jwtPayload") as Record<string, unknown> | undefined;
  const keyId = (payload?.key_id as string) ?? "unknown";

  // Access db from app context — passed via env
  const db = c.get("db") as Database.Database | undefined;
  if (!db) {
    // No DB available (test scenario without db) — skip check
    c.set("idempotencyKey", idempotencyKey);
    c.set("idempotencyBodyHash", bodyHash);
    await next();
    return;
  }

  const existing = checkIdempotency(db, idempotencyKey, keyId, c.req.path, 0, bodyHash);
  if (existing) {
    return c.json(
      { error: "Duplicate request", original_status: existing.status },
      409,
    );
  }

  c.set("idempotencyKey", idempotencyKey);
  c.set("idempotencyBodyHash", bodyHash);
  await next();

  // Update stored status with actual response code
  if (db && idempotencyKey) {
    updateIdempotencyStatus(db, idempotencyKey, c.res.status);
  }
});
