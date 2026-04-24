import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import type { HubVariables } from "../types.js";
import { securityHeaders } from "../middleware/security-headers.js";
import { requestId } from "../middleware/request-id.js";

// ---------------------------------------------------------------------------
// security-headers tests
// ---------------------------------------------------------------------------

describe("securityHeaders", () => {
  const origHsts = process.env.HUB_HSTS;

  beforeEach(() => { delete process.env.HUB_HSTS; });
  afterEach(() => {
    if (origHsts !== undefined) process.env.HUB_HSTS = origHsts;
    else delete process.env.HUB_HSTS;
  });

  function makeApp() {
    const app = new Hono();
    app.use("*", securityHeaders);
    app.get("/anything", (c) => c.json({ ok: true }));
    app.post("/auth/token", (c) => c.json({ token: "x" }));
    return app;
  }

  it("sets X-Content-Type-Options: nosniff", async () => {
    const res = await makeApp().request("/anything");
    assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
  });

  it("sets X-Frame-Options: DENY", async () => {
    const res = await makeApp().request("/anything");
    assert.equal(res.headers.get("X-Frame-Options"), "DENY");
  });

  it("sets Referrer-Policy: no-referrer", async () => {
    const res = await makeApp().request("/anything");
    assert.equal(res.headers.get("Referrer-Policy"), "no-referrer");
  });

  it("omits HSTS when HUB_HSTS is not set", async () => {
    const res = await makeApp().request("/anything");
    assert.equal(res.headers.get("Strict-Transport-Security"), null);
  });

  it("sets HSTS when HUB_HSTS=1", async () => {
    process.env.HUB_HSTS = "1";
    const res = await makeApp().request("/anything");
    const hsts = res.headers.get("Strict-Transport-Security");
    assert.ok(hsts?.includes("max-age=63072000"));
    assert.ok(hsts?.includes("includeSubDomains"));
  });

  it("sets Cache-Control: no-store on /auth/token", async () => {
    const res = await makeApp().request("/auth/token", { method: "POST" });
    assert.equal(res.headers.get("Cache-Control"), "no-store");
  });

  it("does not set Cache-Control on non-auth paths", async () => {
    const res = await makeApp().request("/anything");
    assert.equal(res.headers.get("Cache-Control"), null);
  });
});

// ---------------------------------------------------------------------------
// request-id tests
// ---------------------------------------------------------------------------

describe("requestId", () => {
  function makeApp() {
    const app = new Hono<{ Variables: HubVariables }>();
    app.use("*", requestId);
    app.get("/test", (c) => c.json({ reqId: c.get("reqId") }));
    return app;
  }

  it("generates UUID when no x-request-id header is sent", async () => {
    const res = await makeApp().request("/test");
    const body = await res.json();
    // UUID v4 format: 8-4-4-4-12 hex chars
    assert.match(body.reqId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(res.headers.get("x-request-id"), body.reqId);
  });

  it("echos valid x-request-id header", async () => {
    const res = await makeApp().request("/test", {
      headers: { "x-request-id": "abc-123_def" },
    });
    const body = await res.json();
    assert.equal(body.reqId, "abc-123_def");
    assert.equal(res.headers.get("x-request-id"), "abc-123_def");
  });

  it("rejects too-short x-request-id and generates UUID", async () => {
    const res = await makeApp().request("/test", {
      headers: { "x-request-id": "short" },
    });
    const body = await res.json();
    assert.match(body.reqId, /^[0-9a-f]{8}-/); // UUID generated
    assert.notEqual(body.reqId, "short");
  });

  it("rejects x-request-id with special characters and generates UUID", async () => {
    const res = await makeApp().request("/test", {
      headers: { "x-request-id": "has spaces and!chars" },
    });
    const body = await res.json();
    assert.match(body.reqId, /^[0-9a-f]{8}-/);
  });

  it("accepts x-request-id at max length (64 chars)", async () => {
    const id = "A".repeat(64);
    const res = await makeApp().request("/test", {
      headers: { "x-request-id": id },
    });
    const body = await res.json();
    assert.equal(body.reqId, id);
  });

  it("rejects x-request-id exceeding max length (65 chars) and generates UUID", async () => {
    const id = "A".repeat(65);
    const res = await makeApp().request("/test", {
      headers: { "x-request-id": id },
    });
    const body = await res.json();
    assert.match(body.reqId, /^[0-9a-f]{8}-/);
  });
});
