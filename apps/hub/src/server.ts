import { Hono } from "hono";
import { SapClient } from "@zzapi-mes/core";
import { accessLog } from "./middleware/log.js";
import { requestId } from "./middleware/request-id.js";
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
export function createApp(sap?: SapClient, deps?: AppDeps) {
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

  // Request ID on all routes
  app.use("*", requestId);

  // Access logging on all routes
  app.use("*", accessLog);

  // Metrics on all routes
  app.use("*", metricsMiddleware);

  // --- Public routes ---

  // GET /metrics (no auth, but localhost-only — enforced inside the route)
  app.route("/", metricsRoute);

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

  // --- Protected routes (JWT + scope + rate limit) ---
  app.use("/ping", requireJwt, requireScope("ping"), rateLimit);
  app.use("/po/*", requireJwt, requireScope("po"), rateLimit);
  app.use("/prod-order/*", requireJwt, requireScope("prod_order"), rateLimit);
  app.use("/material/*", requireJwt, requireScope("material"), rateLimit);
  app.use("/stock/*", requireJwt, requireScope("stock"), rateLimit);
  app.use("/routing/*", requireJwt, requireScope("routing"), rateLimit);
  app.use("/work-center/*", requireJwt, requireScope("work_center"), rateLimit);
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

  return app;
}
