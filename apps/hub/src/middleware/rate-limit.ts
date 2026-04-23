import { createMiddleware } from "hono/factory";
import type { HubVariables } from "../types.js";

interface Bucket {
  tokens: number;
  lastRefill: number;
}

const DEFAULT_RPM = 60;
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
}

/** Per-key token-bucket rate limiting. Reads rate_limit_per_min from JWT. */
export const rateLimit = createMiddleware<{ Variables: HubVariables }>(async (c, next) => {
  const payload = c.get("jwtPayload");
  const keyId = (payload?.key_id as string) ?? "unknown";
  const rpm = (payload?.rate_limit_per_min as number | undefined) ?? DEFAULT_RPM;
  if (rpm <= 0) {
    return c.json({ error: "Rate limit disabled for this key" }, 403);
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
