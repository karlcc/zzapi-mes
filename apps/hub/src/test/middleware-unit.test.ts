import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { requestId } from "../middleware/request-id.js";
import { securityHeaders } from "../middleware/security-headers.js";
import { accessLog } from "../middleware/log.js";
import { methodGuard, requireJwt, requireScope } from "../middleware/jwt.js";
import type { HubVariables } from "../types.js";

const JWT_SECRET = "test-secret-16ch";

function buildApp(middleware: (app: Hono<{ Variables: HubVariables }>) => void): Hono<{ Variables: HubVariables }> {
  const app = new Hono<{ Variables: HubVariables }>();
  middleware(app);
  app.all("*", (c) => c.json({ ok: true }));
  return app;
}

// ---------------------------------------------------------------------------
// requestId middleware
// ---------------------------------------------------------------------------

describe("requestId middleware", () => {
  it("generates UUID when no x-request-id header", async () => {
    const app = buildApp((a) => a.use("*", requestId));
    const res = await app.request("/test");
    const reqId = res.headers.get("x-request-id");
    assert.ok(reqId, "should set x-request-id header");
    // UUID format: 8-4-4-4-12 hex chars
    assert.match(reqId!, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("echoes valid x-request-id header", async () => {
    const app = buildApp((a) => a.use("*", requestId));
    const res = await app.request("/test", {
      headers: { "x-request-id": "my-req-id-123" },
    });
    assert.equal(res.headers.get("x-request-id"), "my-req-id-123");
  });

  it("rejects x-request-id with special characters and generates UUID", async () => {
    const app = buildApp((a) => a.use("*", requestId));
    const res = await app.request("/test", {
      headers: { "x-request-id": "bad!id@#" },
    });
    const reqId = res.headers.get("x-request-id");
    assert.ok(reqId, "should set x-request-id header");
    assert.notEqual(reqId, "bad!id@#", "should not echo invalid id");
    assert.match(reqId!, /^[0-9a-f]{8}-/, "should generate UUID instead");
  });

  it("rejects x-request-id shorter than 8 chars", async () => {
    const app = buildApp((a) => a.use("*", requestId));
    const res = await app.request("/test", {
      headers: { "x-request-id": "short" },
    });
    const reqId = res.headers.get("x-request-id");
    assert.ok(reqId, "should set x-request-id header");
    assert.notEqual(reqId, "short", "should reject short id");
  });

  it("rejects x-request-id longer than 64 chars", async () => {
    const app = buildApp((a) => a.use("*", requestId));
    const longId = "a".repeat(65);
    const res = await app.request("/test", {
      headers: { "x-request-id": longId },
    });
    const reqId = res.headers.get("x-request-id");
    assert.ok(reqId, "should set x-request-id header");
    assert.notEqual(reqId, longId, "should reject long id");
  });
});

// ---------------------------------------------------------------------------
// securityHeaders middleware
// ---------------------------------------------------------------------------

describe("securityHeaders middleware", () => {
  const origHsts = process.env.HUB_HSTS;

  afterEach(() => {
    process.env.HUB_HSTS = origHsts;
  });

  it("sets X-Content-Type-Options: nosniff", async () => {
    const app = buildApp((a) => a.use("*", securityHeaders));
    const res = await app.request("/test");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  });

  it("sets X-Frame-Options: DENY", async () => {
    const app = buildApp((a) => a.use("*", securityHeaders));
    const res = await app.request("/test");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
  });

  it("sets Referrer-Policy: no-referrer", async () => {
    const app = buildApp((a) => a.use("*", securityHeaders));
    const res = await app.request("/test");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  });

  it("omits HSTS when HUB_HSTS is not '1'", async () => {
    process.env.HUB_HSTS = "0";
    const app = buildApp((a) => a.use("*", securityHeaders));
    const res = await app.request("/test");
    assert.equal(res.headers.get("strict-transport-security"), null);
  });

  it("sets HSTS when HUB_HSTS=1", async () => {
    process.env.HUB_HSTS = "1";
    const app = buildApp((a) => a.use("*", securityHeaders));
    const res = await app.request("/test");
    const hsts = res.headers.get("strict-transport-security");
    assert.ok(hsts, "should set HSTS header");
    assert.match(hsts!, /max-age=63072000/);
    assert.match(hsts!, /includeSubDomains/);
  });

  it("sets Cache-Control: no-store on /auth/token", async () => {
    const app = buildApp((a) => a.use("*", securityHeaders));
    const res = await app.request("/auth/token");
    assert.equal(res.headers.get("cache-control"), "no-store");
  });

  it("omits Cache-Control on non-auth paths", async () => {
    const app = buildApp((a) => a.use("*", securityHeaders));
    const res = await app.request("/ping");
    assert.equal(res.headers.get("cache-control"), null);
  });
});

// ---------------------------------------------------------------------------
// accessLog middleware
// ---------------------------------------------------------------------------

describe("accessLog middleware", () => {
  let logged: string[];

  beforeEach(() => {
    logged = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array) => {
      if (typeof chunk === "string") {
        logged.push(chunk.trim());
      }
      return true;
    };
    // Store original for restore
    (process.stdout as unknown as { _origWrite: typeof origWrite })._origWrite = origWrite;
  });

  afterEach(() => {
    process.stdout.write = (process.stdout as unknown as { _origWrite: typeof process.stdout.write })._origWrite;
  });

  it("writes one JSON log line per request", async () => {
    const app = buildApp((a) => a.use("*", requestId).use("*", accessLog));
    await app.request("/ping");
    assert.equal(logged.length, 1);
    const entry = JSON.parse(logged[0]!);
    assert.equal(entry.method, "GET");
    assert.equal(entry.path, "/ping");
    assert.equal(entry.status, 200);
    assert.ok(entry.req_id, "should have req_id");
  });

  it("uses '-' for key_id when jwtPayload not set", async () => {
    const app = buildApp((a) => a.use("*", requestId).use("*", accessLog));
    await app.request("/ping");
    const entry = JSON.parse(logged[0]!);
    assert.equal(entry.key_id, "-");
  });
});

// ---------------------------------------------------------------------------
// methodGuard middleware
// ---------------------------------------------------------------------------

describe("methodGuard middleware", () => {
  it("allows correct method", async () => {
    const app = new Hono<{ Variables: HubVariables }>();
    app.all("/test", methodGuard("POST"), (c) => c.json({ ok: true }));
    const res = await app.request("/test", { method: "POST" });
    assert.equal(res.status, 200);
  });

  it("rejects wrong method with 405", async () => {
    const app = new Hono<{ Variables: HubVariables }>();
    app.all("/test", methodGuard("POST"), (c) => c.json({ ok: true }));
    const res = await app.request("/test", { method: "GET" });
    assert.equal(res.status, 405);
    const body = await res.json();
    assert.equal(body.error, "Method not allowed");
  });

  it("rejects PUT when POST expected", async () => {
    const app = new Hono<{ Variables: HubVariables }>();
    app.all("/test", methodGuard("POST"), (c) => c.json({ ok: true }));
    const res = await app.request("/test", { method: "PUT" });
    assert.equal(res.status, 405);
  });

  it("allows GET when GET expected", async () => {
    const app = new Hono<{ Variables: HubVariables }>();
    app.all("/test", methodGuard("GET"), (c) => c.json({ ok: true }));
    const res = await app.request("/test");
    assert.equal(res.status, 200);
  });
});

// ---------------------------------------------------------------------------
// requireJwt middleware
// ---------------------------------------------------------------------------

describe("requireJwt middleware", () => {
  beforeEach(() => { process.env.HUB_JWT_SECRET = JWT_SECRET; });
  afterEach(() => { delete process.env.HUB_JWT_SECRET; });

  it("rejects missing Authorization header with 401", async () => {
    const app = new Hono<{ Variables: HubVariables }>();
    app.use("/protected", requireJwt);
    app.get("/protected", (c) => c.json({ ok: true }));
    const res = await app.request("/protected");
    assert.equal(res.status, 401);
  });

  it("rejects non-Bearer Authorization with 401", async () => {
    const app = new Hono<{ Variables: HubVariables }>();
    app.use("/protected", requireJwt);
    app.get("/protected", (c) => c.json({ ok: true }));
    const res = await app.request("/protected", {
      headers: { Authorization: "Basic abc123" },
    });
    assert.equal(res.status, 401);
  });

  it("rejects expired/invalid JWT with 401", async () => {
    const app = new Hono<{ Variables: HubVariables }>();
    app.use("/protected", requireJwt);
    app.get("/protected", (c) => c.json({ ok: true }));
    const res = await app.request("/protected", {
      headers: { Authorization: "Bearer invalid.token.here" },
    });
    assert.equal(res.status, 401);
  });
});

// ---------------------------------------------------------------------------
// requireScope middleware
// ---------------------------------------------------------------------------

describe("requireScope middleware", () => {
  it("allows request with matching scope", async () => {
    const app = new Hono<{ Variables: HubVariables }>();
    app.use("/ping", async (c, next) => {
      c.set("jwtPayload", { key_id: "k1", scopes: ["ping", "po"], iat: 0, exp: 0, rate_limit_per_min: null });
      await next();
    });
    app.get("/ping", requireScope("ping"), (c) => c.json({ ok: true }));
    const res = await app.request("/ping");
    assert.equal(res.status, 200);
  });

  it("rejects request without matching scope with 403", async () => {
    const app = new Hono<{ Variables: HubVariables }>();
    app.use("/conf", async (c, next) => {
      c.set("jwtPayload", { key_id: "k1", scopes: ["ping"], iat: 0, exp: 0, rate_limit_per_min: null });
      await next();
    });
    app.post("/conf", requireScope("conf"), (c) => c.json({ ok: true }));
    const res = await app.request("/conf", { method: "POST" });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.match(body.error, /Insufficient scope/);
  });

  it("rejects request with empty scopes array", async () => {
    const app = new Hono<{ Variables: HubVariables }>();
    app.use("/ping", async (c, next) => {
      c.set("jwtPayload", { key_id: "k1", scopes: [], iat: 0, exp: 0, rate_limit_per_min: null });
      await next();
    });
    app.get("/ping", requireScope("ping"), (c) => c.json({ ok: true }));
    const res = await app.request("/ping");
    assert.equal(res.status, 403);
  });
});
