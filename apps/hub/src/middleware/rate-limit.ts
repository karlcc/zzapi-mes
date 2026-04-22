import { createMiddleware } from "hono/factory";
import type { HubVariables } from "../types.js";

interface Bucket {
  tokens: number;
  lastRefill: number;
}

const DEFAULT_RPM = 60;
const buckets = new Map<string, Bucket>();

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

/** Per-key token-bucket rate limiting. Reads rate_limit_per_min from JWT. */
export const rateLimit = createMiddleware<{ Variables: HubVariables }>(async (c, next) => {
  const payload = c.get("jwtPayload");
  const keyId = (payload?.key_id as string) ?? "unknown";
  const rpm = (payload?.rate_limit_per_min as number | undefined) ?? DEFAULT_RPM;

  const { allowed, retryAfter } = getTokens(keyId, rpm);
  if (!allowed) {
    c.header("retry-after", String(retryAfter));
    return c.json({ error: "Rate limit exceeded" }, 429);
  }

  await next();
});
