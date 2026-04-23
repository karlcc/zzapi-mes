import { Hono } from "hono";
import { SapClient } from "@zzapi-mes/core";
import { accessLog } from "./middleware/log.js";
import { requestId } from "./middleware/request-id.js";
import { securityHeaders } from "./middleware/security-headers.js";
import { requireJwt, requireScope } from "./middleware/jwt.js";
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

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`Missing required env var: ${name}`);
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
export function createApp(sap?: SapClient, deps?: AppDeps): { app: Hono<{ Variables: HubVariables }>; db: Database.Database } {
  const jwtSecret = requireEnv("HUB_JWT_SECRET");
  const jwtTtl = Number(process.env.HUB_JWT_TTL_SECONDS) || 900;

  const client = sap ?? new SapClient({
    host: requireEnv("SAP_HOST"),
    client: Number(requireEnv("SAP_CLIENT")),
    user: requireEnv("SAP_USER"),
    password: requireEnv("SAP_PASS"),
  });

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
    await next();
  });

  // Reject oversized request bodies (1 MB limit)
  // Content-Length check catches most cases; for chunked encoding we consume
  // the raw body and check its length before downstream handlers read it.
  app.use("*", async (c, next) => {
    const contentLength = c.req.header("content-length");
    if (contentLength && Number(contentLength) > 1_048_576) {
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

  // Security headers on all routes
  app.use("*", securityHeaders);

  // Request ID on all routes
  app.use("*", requestId);

  // Access logging on all routes
  app.use("*", accessLog);

  // Metrics on all routes
  app.use("*", metricsMiddleware);

  // --- Public routes ---

  // 405 helper (must be defined before first use)
  const notAllowed = (c: any) => c.json({ error: "Method not allowed" }, 405);

  // GET /metrics (no auth, but localhost-only — enforced inside the route)
  app.route("/", metricsRoute);

  // 405 for public routes
  for (const m of ["post", "put", "patch", "delete"] as const) {
    app[m]("/metrics", notAllowed);
  }
  app.get("/auth/token", notAllowed);
  app.put("/auth/token", notAllowed);
  app.patch("/auth/token", notAllowed);
  app.delete("/auth/token", notAllowed);

  // Rate limit /auth/token (per-IP token bucket) to prevent brute-force
  // In-memory — state is lost on process restart, allowing a brief burst.
  // Accepted trade-off vs. persistence complexity.
  const authBuckets = new Map<string, { tokens: number; lastRefill: number }>();
  const AUTH_RPM = 10; // 10 auth attempts per minute per IP
  const AUTH_IDLE_MS = 5 * 60_000; // Evict buckets idle for 5+ minutes
  let authLastSweep = Date.now();
  app.use("/auth/token", async (c, next) => {
    // Periodic eviction of stale auth buckets
    const now = Date.now();
    if (now - authLastSweep > 60_000) {
      authLastSweep = now;
      for (const [ip, b] of authBuckets) {
        if (now - b.lastRefill > AUTH_IDLE_MS) authBuckets.delete(ip);
      }
    }
    const ip = c.req.header("x-real-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    let bucket = authBuckets.get(ip);
    if (!bucket) {
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

  // GET /healthz
  app.route("/", health);

  // 405 for /healthz
  app.post("/healthz", notAllowed);
  app.put("/healthz", notAllowed);
  app.patch("/healthz", notAllowed);
  app.delete("/healthz", notAllowed);

  // --- Protected routes (JWT + scope + rate limit) ---
  app.use("/ping", requireJwt, requireScope("ping"), rateLimit);
  app.use("/po/*", requireJwt, requireScope("po"), rateLimit);
  app.use("/prod-order/*", requireJwt, requireScope("prod_order"), rateLimit);
  app.use("/material/*", requireJwt, requireScope("material"), rateLimit);
  app.use("/stock/*", requireJwt, requireScope("stock"), rateLimit);
  app.use("/routing/*", requireJwt, requireScope("routing"), rateLimit);
  app.use("/work-center/*", requireJwt, requireScope("work_center"), rateLimit);
  // 405 Method Not Allowed — POST-only routes must reject GET before idempotency guard
  for (const m of ["get", "put", "patch", "delete"] as const) {
    app[m]("/confirmation", notAllowed);
    app[m]("/goods-receipt", notAllowed);
    app[m]("/goods-issue", notAllowed);
  }

  // Write-back routes: JWT + scope + idempotency + rate limit
  app.use("/confirmation", requireJwt, requireScope("conf"), idempotencyGuard, rateLimit);
  app.use("/goods-receipt", requireJwt, requireScope("gr"), idempotencyGuard, rateLimit);
  app.use("/goods-issue", requireJwt, requireScope("gi"), idempotencyGuard, rateLimit);
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

  // 405 Method Not Allowed — GET-only routes: reject non-GET
  for (const m of ["post", "put", "patch", "delete"] as const) {
    app[m]("/ping", notAllowed);
    app[m]("/po/*", notAllowed);
    app[m]("/prod-order/*", notAllowed);
    app[m]("/material/*", notAllowed);
    app[m]("/stock/*", notAllowed);
    app[m]("/routing/*", notAllowed);
    app[m]("/work-center/*", notAllowed);
  }

  return { app, db };
}
