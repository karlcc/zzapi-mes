import { Hono } from "hono";
import { cors } from "hono/cors";
import { SapClient } from "@zzapi-mes/core";
import { accessLog } from "./middleware/log.js";
import { requestId } from "./middleware/request-id.js";
import { securityHeaders } from "./middleware/security-headers.js";
import { requireJwt, requireScope, methodGuard } from "./middleware/jwt.js";
import { rateLimit } from "./middleware/rate-limit.js";
import { metricsMiddleware } from "./middleware/metrics.js";
import type { HubVariables } from "./types.js";
import health from "./routes/health.js";
import metricsRoute from "./routes/metrics.js";
import { createPingRouter } from "./routes/ping.js";
import { createPoRouter } from "./routes/po.js";
import { createProdOrderRouter } from "./routes/prod-order.js";
import { createMaterialRouter } from "./routes/material.js";
import { createStockRouter } from "./routes/stock.js";
import { createPoItemsRouter } from "./routes/po-items.js";
import { createRoutingRouter } from "./routes/routing.js";
import { createWorkCenterRouter } from "./routes/work-center.js";
import { createConfirmationRouter } from "./routes/confirmation.js";
import { createGoodsReceiptRouter } from "./routes/goods-receipt.js";
import { createGoodsIssueRouter } from "./routes/goods-issue.js";
import { idempotencyGuard } from "./middleware/idempotency.js";
import { z } from "zod";
import { sign } from "hono/jwt";
import type Database from "better-sqlite3";
import { openDb, runMigrations } from "./db/index.js";
import { verifyApiKey } from "./auth/verify.js";
import { getClientIp } from "./middleware/client-ip.js";

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return val;
}

function requireEnvMin(name: string, minLen: number): string {
  const val = requireEnv(name);
  if (val.length < minLen) {
    console.error(`Env var ${name} must be at least ${minLen} characters (got ${val.length})`);
    process.exit(1);
  }
  return val;
}

// ---------------------------------------------------------------------------
// Auth route
// ---------------------------------------------------------------------------

const TokenRequestSchema = z.object({ api_key: z.string().min(1) });

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

export interface AppDeps {
  db?: Database.Database;
}

/** Build the Hono app. Callers provide a SapClient (or one is created from env). */
export function createApp(sap?: SapClient, deps?: AppDeps): {
  app: Hono<{ Variables: HubVariables }>;
  db: Database.Database;
  _seedAuthBucketForTest: (ip: string, tokens: number, lastRefill: number) => void;
  _authBucketCountForTest: () => number;
  _forceAuthSweepForTest: () => void;
  _clearAuthBucketsForTest: () => void;
} {
  const jwtSecret = requireEnvMin("HUB_JWT_SECRET", 16);
  const jwtTtl = process.env.HUB_JWT_TTL_SECONDS !== undefined && process.env.HUB_JWT_TTL_SECONDS !== ""
    ? Number(process.env.HUB_JWT_TTL_SECONDS)
    : 900;
  if (!Number.isFinite(jwtTtl) || !Number.isInteger(jwtTtl) || jwtTtl <= 60) {
    console.error(`HUB_JWT_TTL_SECONDS must be > 60 (got ${jwtTtl}). HubClient rejects tokens with expires_in <= 60.`);
    process.exit(1);
  }

  // Only validate SAP env vars when creating SapClient from env (not when
  // caller provides one, e.g. in tests)
  const client = sap ?? (() => {
    const sapClientNum = Number(requireEnv("SAP_CLIENT"));
    if (!Number.isFinite(sapClientNum) || !Number.isInteger(sapClientNum) || sapClientNum <= 0) {
      console.error(`SAP_CLIENT must be a positive integer (got ${process.env.SAP_CLIENT})`);
      process.exit(1);
    }
    return new SapClient({
      host: requireEnv("SAP_HOST"),
      client: sapClientNum,
      user: requireEnv("SAP_USER"),
      password: requireEnv("SAP_PASS"),
      timeout: (() => {
        const t = process.env.SAP_TIMEOUT;
        if (t !== undefined && t !== "") {
          const n = Number(t);
          if (!Number.isFinite(n) || n <= 0) {
            console.error(`SAP_TIMEOUT must be a positive integer (got ${t})`);
            process.exit(1);
          }
          return n;
        }
        return undefined;
      })(),
    });
  })();

  // Open DB if not provided (production path)
  const db = deps?.db ?? (() => {
    const d = openDb();
    runMigrations(d);
    return d;
  })();

  const app = new Hono<{ Variables: HubVariables }>();

  // Expose db to Hono context for write-back middleware
  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("sap", client);
    await next();
  });

  // Reject oversized request bodies (1 MB limit)
  // Content-Length check catches most cases; for chunked encoding we consume
  // the raw body and check its length before downstream handlers read it.
  app.use("*", async (c, next) => {
    const contentLength = c.req.header("content-length");
    // Validate Content-Length: must be a finite number, and if so must not
    // exceed 1 MB. Number("abc") produces NaN, and NaN > N is always false,
    // which allowed the old check to be bypassed. Reject non-finite values.
    if (contentLength && (!Number.isFinite(Number(contentLength)) || Number(contentLength) > 1_048_576)) {
      return c.json({ error: "Request body too large (max 1 MB)" }, 413);
    }
    // For chunked transfer (no Content-Length), read body and enforce limit
    if (!contentLength && c.req.method !== "GET" && c.req.method !== "HEAD") {
      const rawBody = await c.req.text();
      if (rawBody.length > 1_048_576) {
        return c.json({ error: "Request body too large (max 1 MB)" }, 413);
      }
      // Re-attach parsed body so downstream c.req.json() / c.req.text() works
      c.req.raw = new Request(c.req.raw, { body: rawBody });
    }
    await next();
  });

  // CORS — disabled by default. Setting HUB_CORS_ORIGIN to a list of explicit
  // origins enables it; credentials (Bearer tokens) are allowed for those
  // origins. We deliberately reject `*` with credentials — a wildcard origin
  // plus credentialed requests is a CSRF vector, and browsers reject it
  // anyway. Service-to-service callers (CLI, other backends) don't need CORS.
  const corsOrigins = process.env.HUB_CORS_ORIGIN;
  if (corsOrigins) {
    if (corsOrigins.trim() === "*") {
      console.error("HUB_CORS_ORIGIN=* with credentials is not permitted. Set explicit origins or leave unset.");
      process.exit(1);
    }
    // Reject dangerous origin schemes (javascript:, data:) that could enable XSS
    const origins = corsOrigins.split(",").map(o => o.trim());
    for (const origin of origins) {
      if (/^(javascript|data):/i.test(origin)) {
        console.error(`HUB_CORS_ORIGIN contains dangerous scheme: ${origin}. Only http/https origins are allowed.`);
        process.exit(1);
      }
    }
    app.use("*", cors({
      origin: origins,
      allowMethods: ["GET", "POST"],
      allowHeaders: ["Authorization", "Content-Type", "Idempotency-Key", "X-Request-ID"],
      exposeHeaders: ["X-Request-ID", "Retry-After"],
      maxAge: 600,
      credentials: true,
    }));
  }

  // Security headers on all routes
  app.use("*", securityHeaders);

  // Request ID on all routes
  app.use("*", requestId);

  // Access logging on all routes
  app.use("*", accessLog);

  // Metrics on all routes
  app.use("*", metricsMiddleware);

  // --- Public routes ---

  // GET /metrics (no auth, but localhost-only — enforced inside the route)
  app.use("/metrics", methodGuard("GET"));
  app.route("/", metricsRoute);

  // POST /auth/token only; methodGuard rejects GET/PUT/PATCH/DELETE with 405
  app.use("/auth/token", methodGuard("POST"));

  // Rate limit /auth/token (per-IP token bucket) to prevent brute-force
  // In-memory — state is lost on process restart, allowing a brief burst.
  // Accepted trade-off vs. persistence complexity.
  const authBuckets = new Map<string, { tokens: number; lastRefill: number }>();
  const AUTH_RPM = 10; // 10 auth attempts per minute per IP
  const AUTH_IDLE_MS = 5 * 60_000; // Evict buckets idle for 5+ minutes
  const AUTH_BUCKET_CAP = 1_000; // Hard cap on bucket count to bound memory
  let authLastSweep = Date.now();

  /** Test-only: seed an auth bucket. */
  function _seedAuthBucketForTest(ip: string, tokens: number, lastRefill: number): void {
    authBuckets.set(ip, { tokens, lastRefill });
  }
  /** Test-only: return auth bucket count. */
  function _authBucketCountForTest(): number {
    return authBuckets.size;
  }
  /** Test-only: force a sweep regardless of throttle. */
  function _forceAuthSweepForTest(): void {
    const now = Date.now();
    authLastSweep = 0;
    for (const [ip, b] of authBuckets) {
      if (now - b.lastRefill > AUTH_IDLE_MS) authBuckets.delete(ip);
    }
    if (authBuckets.size > AUTH_BUCKET_CAP) {
      const entries = [...authBuckets.entries()].sort((a, b) => a[1].lastRefill - b[1].lastRefill);
      const toRemove = entries.slice(0, Math.ceil(entries.length / 2));
      for (const [ip] of toRemove) authBuckets.delete(ip);
    }
    authLastSweep = now;
  }
  /** Test-only: clear all auth buckets. */
  function _clearAuthBucketsForTest(): void {
    authBuckets.clear();
    authLastSweep = Date.now();
  }
  app.use("/auth/token", async (c, next) => {
    const now = Date.now();
    // Periodic eviction of stale auth buckets + enforce hard cap
    if (now - authLastSweep > 60_000) {
      authLastSweep = now;
      for (const [ip, b] of authBuckets) {
        if (now - b.lastRefill > AUTH_IDLE_MS) authBuckets.delete(ip);
      }
      // If still over cap after idle eviction, drop the oldest half
      if (authBuckets.size > AUTH_BUCKET_CAP) {
        const entries = [...authBuckets.entries()].sort((a, b) => a[1].lastRefill - b[1].lastRefill);
        const toRemove = entries.slice(0, Math.ceil(entries.length / 2));
        for (const [ip] of toRemove) authBuckets.delete(ip);
      }
    }
    const ip = getClientIp(c) || "unknown";
    let bucket = authBuckets.get(ip);
    if (!bucket) {
      if (authBuckets.size >= AUTH_BUCKET_CAP) {
        return c.json({ error: "Auth rate limit exceeded" }, 429);
      }
      bucket = { tokens: AUTH_RPM, lastRefill: now };
      authBuckets.set(ip, bucket);
    }
    const elapsed = now - bucket.lastRefill;
    const refill = (elapsed / 60_000) * AUTH_RPM;
    bucket.tokens = Math.min(AUTH_RPM, bucket.tokens + refill);
    bucket.lastRefill = now;
    if (bucket.tokens < 1) {
      const retryAfter = Math.ceil(((1 - bucket.tokens) / AUTH_RPM) * 60_000 / 1000);
      c.header("retry-after", String(retryAfter));
      return c.json({ error: "Auth rate limit exceeded" }, 429);
    }
    bucket.tokens -= 1;
    await next();
  });

  // POST /auth/token
  app.post("/auth/token", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Request body must be valid JSON: { api_key: string }" }, 400);
    }
    const parsed = TokenRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Request body must be { api_key: string }" }, 400);
    }
    const { api_key } = parsed.data;

    const verified = await verifyApiKey(db, api_key);
    if (!verified) {
      // Auth-failure log for forensics. Only the key_id prefix (before the dot)
      // is logged — never the secret component. Clients that don't use the
      // `keyId.secret` format get a hashed prefix to avoid log injection.
      const dotIdx = api_key.indexOf(".");
      const prefix = dotIdx > 0 && dotIdx <= 32
        ? api_key.slice(0, dotIdx).replace(/[^A-Za-z0-9]/g, "")
        : "malformed";
      const ip = getClientIp(c) || "unknown";
      console.log(JSON.stringify({
        type: "auth_failure",
        ip,
        key_id_prefix: prefix,
        req_id: c.get("reqId") ?? "-",
        t: Math.floor(Date.now() / 1000),
      }));
      return c.json({ error: "Invalid API key" }, 401);
    }

    const now = Math.floor(Date.now() / 1000);
    const token = await sign(
      {
        key_id: verified.key_id,
        scopes: verified.scopes,
        iat: now,
        exp: now + jwtTtl,
        rate_limit_per_min: verified.rate_limit_per_min,
      },
      jwtSecret,
    );
    return c.json({ token, expires_in: jwtTtl });
  });

  // GET /healthz only; methodGuard rejects POST/PUT/PATCH/DELETE with 405
  app.use("/healthz", methodGuard("GET"));
  app.route("/", health);

  // --- Protected routes (JWT + scope + rate limit) ---
  // GET-only routes: methodGuard rejects non-GET before JWT check
  app.use("/ping", methodGuard("GET"), requireJwt, requireScope("ping"), rateLimit);
  app.use("/po/*", methodGuard("GET"), requireJwt, requireScope("po"), rateLimit);
  app.use("/prod-order/*", methodGuard("GET"), requireJwt, requireScope("prod_order"), rateLimit);
  app.use("/material/*", methodGuard("GET"), requireJwt, requireScope("material"), rateLimit);
  app.use("/stock/*", methodGuard("GET"), requireJwt, requireScope("stock"), rateLimit);
  app.use("/routing/*", methodGuard("GET"), requireJwt, requireScope("routing"), rateLimit);
  app.use("/work-center/*", methodGuard("GET"), requireJwt, requireScope("work_center"), rateLimit);

  // Write-back routes: methodGuard rejects non-POST before JWT/idempotency
  app.use("/confirmation", methodGuard("POST"), requireJwt, requireScope("conf"), idempotencyGuard, rateLimit);
  app.use("/goods-receipt", methodGuard("POST"), requireJwt, requireScope("gr"), idempotencyGuard, rateLimit);
  app.use("/goods-issue", methodGuard("POST"), requireJwt, requireScope("gi"), idempotencyGuard, rateLimit);
  app.route("/", createPingRouter(client));         // GET /ping
  app.route("/", createPoRouter(client));            // GET /po/:ebeln
  app.route("/", createPoItemsRouter(client));       // GET /po/:ebeln/items
  app.route("/", createProdOrderRouter(client));     // GET /prod-order/:aufnr
  app.route("/", createMaterialRouter(client));      // GET /material/:matnr
  app.route("/", createStockRouter(client));         // GET /stock/:matnr
  app.route("/", createRoutingRouter(client));       // GET /routing/:matnr
  app.route("/", createWorkCenterRouter(client));    // GET /work-center/:arbpl
  app.route("/", createConfirmationRouter(client));  // POST /confirmation
  app.route("/", createGoodsReceiptRouter(client));  // POST /goods-receipt
  app.route("/", createGoodsIssueRouter(client));    // POST /goods-issue

  // 404 handler — unmatched routes return ErrorResponse schema ({ error })
  // instead of Hono's default { message: "Not Found" }
  app.notFound((c) => c.json({ error: "Not Found" }, 404));

  // Global error handler — ensures unhandled exceptions return ErrorResponse
  // schema ({ error: string }) rather than Hono's default { message: string }
  app.onError((err, c) => {
    console.error(JSON.stringify({ type: "unhandled_error", path: c.req.path, error: err.message }));
    return c.json({ error: "Internal Server Error" }, 500);
  });

  return {
    app,
    db,
    _seedAuthBucketForTest,
    _authBucketCountForTest,
    _forceAuthSweepForTest,
    _clearAuthBucketsForTest,
  };
}
