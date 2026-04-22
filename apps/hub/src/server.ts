import { Hono } from "hono";
import { SapClient } from "@zzapi-mes/core";
import { accessLog } from "./middleware/log.js";
import { requireJwt } from "./middleware/jwt.js";
import health from "./routes/health.js";
import { createPingRouter } from "./routes/ping.js";
import { createPoRouter } from "./routes/po.js";
import { z } from "zod";
import { sign } from "hono/jwt";
import { createHash } from "node:crypto";

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return val;
}

// ---------------------------------------------------------------------------
// Auth route (inlined to avoid Hono sub-app routing issues)
// ---------------------------------------------------------------------------

const TokenRequestSchema = z.object({ api_key: z.string().min(1) });

const JWT_SECRET = () => process.env.HUB_JWT_SECRET ?? "";
const API_KEYS = () => (process.env.HUB_API_KEYS ?? "").split(",").map(k => k.trim()).filter(Boolean);

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

/** Build the Hono app. Callers provide a SapClient (or one is created from env). */
export function createApp(sap?: SapClient) {
  const client = sap ?? new SapClient({
    host: requireEnv("SAP_HOST"),
    client: Number(requireEnv("SAP_CLIENT")),
    user: requireEnv("SAP_USER"),
    password: requireEnv("SAP_PASS"),
  });

  const app = new Hono();

  // Access logging on all routes
  app.use("*", accessLog);

  // --- Public routes ---

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
    const validKeys = API_KEYS();
    const matched = validKeys.some(k => timingSafeEqual(k, api_key));
    if (!matched) {
      return c.json({ error: "Invalid API key" }, 401);
    }
    const sub = createHash("sha256").update(api_key).digest("hex").slice(0, 8);
    const exp = Math.floor(Date.now() / 1000) + 15 * 60;
    const token = await sign({ sub, exp }, JWT_SECRET());
    return c.json({ token, expires_in: 900 });
  });

  // GET /healthz
  app.route("/", health);

  // --- Protected routes ---
  app.use("/ping", requireJwt);
  app.use("/po/*", requireJwt);
  app.route("/", createPingRouter(client));   // GET /ping
  app.route("/", createPoRouter(client));      // GET /po/:ebeln

  return app;
}
