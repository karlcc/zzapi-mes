import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import health, { _resetSapHealthCacheForTest, _setSapCacheForTest, _getSapCacheForTest } from "../routes/health.js";
import type { HubVariables } from "../types.js";
import Database from "better-sqlite3";
import { runMigrations } from "../db/index.js";

function buildApp(db: Database.Database): Hono<{ Variables: HubVariables }> {
  const app = new Hono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("jwtPayload", { key_id: "test", scopes: ["ping"], iat: 0, exp: 0, rate_limit_per_min: null });
    await next();
  });
  app.route("/", health);
  return app;
}

describe("health route SAP cache", () => {
  let db: Database.Database;
  let app: Hono<{ Variables: HubVariables }>;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    app = buildApp(db);
    _resetSapHealthCacheForTest();
  });

  it("returns cached SAP result within TTL", async () => {
    // Seed the cache with a recent "reachable" result
    _setSapCacheForTest({ ok: true, checkedAt: Date.now() - 1000 }); // 1s ago
    const res = await app.request("/healthz?check=sap");
    assert.equal(res.status, 200);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.sap, "reachable");
    // No SapClient was needed — cache served the response
  });

  it("returns cached error within TTL", async () => {
    _setSapCacheForTest({ ok: false, checkedAt: Date.now() - 1000, error: "SAP unreachable" });
    const res = await app.request("/healthz?check=sap");
    assert.equal(res.status, 503);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.error, "SAP unreachable");
  });

  it("returns 503 when SAP client is not configured and cache is stale", async () => {
    // Stale cache (31s ago, past 30s TTL) — no sap client configured
    _setSapCacheForTest({ ok: true, checkedAt: Date.now() - 31_000 });
    const res = await app.request("/healthz?check=sap");
    assert.equal(res.status, 503);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.error, "SAP client not configured");
  });

  it("returns 503 when SAP client is not configured and no cache exists", async () => {
    _resetSapHealthCacheForTest();
    const res = await app.request("/healthz?check=sap");
    assert.equal(res.status, 503);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.error, "SAP client not configured");
  });

  it("updates cache after fresh SAP ping (success)", async () => {
    _resetSapHealthCacheForTest();
    // Build app WITH a sap client mock
    const appWithSap = new Hono<{ Variables: HubVariables }>();
    const mockSap = { ping: async () => ({ ok: true, sap_time: "20260422163000" }) };
    appWithSap.use("*", async (c, next) => {
      c.set("db", db);
      c.set("sap", mockSap as any);
      c.set("jwtPayload", { key_id: "test", scopes: ["ping"], iat: 0, exp: 0, rate_limit_per_min: null });
      await next();
    });
    appWithSap.route("/", health);

    const res = await appWithSap.request("/healthz?check=sap");
    assert.equal(res.status, 200);
    const cache = _getSapCacheForTest();
    assert.ok(cache, "cache should be populated after ping");
    assert.equal(cache!.ok, true);
  });

  it("updates cache after fresh SAP ping (failure)", async () => {
    _resetSapHealthCacheForTest();
    const appWithSap = new Hono<{ Variables: HubVariables }>();
    const mockSap = { ping: async () => { throw new Error("connection refused"); } };
    appWithSap.use("*", async (c, next) => {
      c.set("db", db);
      c.set("sap", mockSap as any);
      c.set("jwtPayload", { key_id: "test", scopes: ["ping"], iat: 0, exp: 0, rate_limit_per_min: null });
      await next();
    });
    appWithSap.route("/", health);

    const res = await appWithSap.request("/healthz?check=sap");
    assert.equal(res.status, 503);
    const cache = _getSapCacheForTest();
    assert.ok(cache, "cache should be populated after failed ping");
    assert.equal(cache!.ok, false);
    assert.equal(cache!.error, "SAP unreachable");
  });
});
