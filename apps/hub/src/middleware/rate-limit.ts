import { createMiddleware } from "hono/factory";
import type { HubVariables } from "../types.js";

interface Bucket {
  tokens: number;
  lastRefill: number;
}

const DEFAULT_RPM = 60;
const BUCKET_CAP = 10_000; // Hard cap on bucket count to bound memory
const IDLE_TIMEOUT_MS = 10 * 60_000; // Evict buckets idle for 10+ minutes
// In-memory token buckets — state is lost on process restart, allowing a brief
// burst of previously-throttled traffic after deployment. This is an accepted
// trade-off vs. the complexity of persisting buckets to SQLite.
const buckets = new Map<string, Bucket>();
let lastSweep = Date.now();
const SWEEP_INTERVAL_MS = 60_000; // Sweep once per minute at most

function getTokens(keyId: string, rpm: number): { allowed: boolean; retryAfter: number } {
  const now = Date.now();
  let bucket = buckets.get(keyId);

  if (!bucket) {
    if (buckets.size >= BUCKET_CAP) {
      // Over cap — reject request rather than growing the Map unboundedly
      return { allowed: false, retryAfter: 60 };
    }
    bucket = { tokens: rpm, lastRefill: now };
    buckets.set(keyId, bucket);
  }

  // Refill tokens based on elapsed time
  const elapsed = now - bucket.lastRefill;
  const refill = (elapsed / 60_000) * rpm;
  bucket.tokens = Math.min(rpm, bucket.tokens + refill);
  bucket.lastRefill = now;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { allowed: true, retryAfter: 0 };
  }

  // Calculate time until next token
  const retryAfter = Math.ceil(((1 - bucket.tokens) / rpm) * 60_000 / 1000);
  return { allowed: false, retryAfter };
}

/** Remove buckets that haven't been accessed in a while. */
function sweepIdleBuckets(): void {
  const now = Date.now();
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  for (const [keyId, bucket] of buckets) {
    if (now - bucket.lastRefill > IDLE_TIMEOUT_MS) {
      buckets.delete(keyId);
    }
  }
  // If still over cap after idle eviction, drop the oldest half
  if (buckets.size > BUCKET_CAP) {
    const entries = [...buckets.entries()].sort((a, b) => a[1].lastRefill - b[1].lastRefill);
    const toRemove = entries.slice(0, Math.ceil(entries.length / 2));
    for (const [keyId] of toRemove) buckets.delete(keyId);
  }
}

/** Per-key token-bucket rate limiting. Reads rate_limit_per_min from JWT. */
export const rateLimit = createMiddleware<{ Variables: HubVariables }>(async (c, next) => {
  const payload = c.get("jwtPayload");
  const keyId = payload.key_id;
  const rpm = payload.rate_limit_per_min ?? DEFAULT_RPM;
  if (!Number.isFinite(rpm) || rpm <= 0) {
    return c.json({ error: "Invalid rate_limit_per_min: must be a positive finite number" }, 400);
  }

  const { allowed, retryAfter } = getTokens(keyId, rpm);

  // Periodically sweep idle buckets to prevent memory leak
  sweepIdleBuckets();

  if (!allowed) {
    c.header("retry-after", String(retryAfter));
    return c.json({ error: "Rate limit exceeded" }, 429);
  }

  await next();
});

/** Reset in-memory buckets for test isolation. */
export function _resetBucketsForTest(): void {
  buckets.clear();
  lastSweep = Date.now();
}

/** Test-only: seed a bucket with a specific lastRefill timestamp (to simulate idle). */
export function _seedBucketForTest(keyId: string, tokens: number, lastRefill: number): void {
  buckets.set(keyId, { tokens, lastRefill });
}

/** Test-only: return bucket count. */
export function _bucketCountForTest(): number {
  return buckets.size;
}

/** Test-only: force a sweep regardless of SWEEP_INTERVAL_MS. */
export function _forceSweepForTest(): void {
  lastSweep = 0;
  sweepIdleBuckets();
}

/** Test-only: invoke sweepIdleBuckets without resetting lastSweep (tests throttle path). */
export function _trySweepForTest(): void {
  sweepIdleBuckets();
}

/** Test-only: get lastSweep timestamp. */
export function _lastSweepForTest(): number {
  return lastSweep;
}
