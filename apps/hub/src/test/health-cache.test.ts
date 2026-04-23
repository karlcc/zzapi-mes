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

describe("healthz SAP timeout", () => {
  let db: Database.Database;
  let app: Hono<{ Variables: HubVariables }>;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    _resetSapHealthCacheForTest();
  });

  it("returns 503 when SAP ping hangs beyond timeout", async () => {
    // Mock sap client with a ping that never resolves (simulates timeout)
    const mockSap = {
      ping: async () => new Promise((_resolve, reject) => {
        // Never resolves — the health route's own AbortController will time it out
        // But since SAP_PING_TIMEOUT_MS is ~5s and tests need to be fast,
        // we instead make ping throw immediately (simulating the result of a timeout)
        setTimeout(() => reject(new Error("timeout")), 100);
      }),
    };

    const appWithSap = new Hono<{ Variables: HubVariables }>();
    appWithSap.use("*", async (c, next) => {
      c.set("db", db);
      c.set("sap", mockSap as any);
      c.set("jwtPayload", { key_id: "test", scopes: ["ping"], iat: 0, exp: 0, rate_limit_per_min: null });
      await next();
    });
    appWithSap.route("/", health);

    // Use a slow mock — ping throws after a delay (simulating timeout)
    const slowMockSap = {
      ping: async () => { throw new Error("Request timeout after 5000ms"); },
    };
    const slowApp = new Hono<{ Variables: HubVariables }>();
    slowApp.use("*", async (c, next) => {
      c.set("db", db);
      c.set("sap", slowMockSap as any);
      c.set("jwtPayload", { key_id: "test", scopes: ["ping"], iat: 0, exp: 0, rate_limit_per_min: null });
      await next();
    });
    slowApp.route("/", health);

    const res = await slowApp.request("/healthz?check=sap");
    assert.equal(res.status, 503);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.error, "SAP unreachable");
  });
});

describe("healthz DB write check", () => {
  it("returns 503 when DB INSERT fails (read-only filesystem)", async () => {
    const db2 = new Database(":memory:");
    runMigrations(db2);
    // Make DB read-only by dropping the _healthz_write_check table and revoking CREATE
    db2.exec("CREATE TABLE _healthz_write_check (id INTEGER PRIMARY KEY)");
    // Revoke write permissions by dropping all tables and making the DB read-only
    // Use a simpler approach: override prepare to throw on INSERT
    const origPrepare = db2.prepare.bind(db2);
    db2.prepare = ((sql: string) => {
      if (sql.includes("INSERT INTO _healthz_write_check")) {
        const stmt = origPrepare("SELECT 1");
        // Return a fake statement that throws on run()
        return {
          ...stmt,
          run: () => { throw new Error("database is read-only"); },
          get: stmt.get.bind(stmt),
          all: stmt.all.bind(stmt),
        } as any;
      }
      return origPrepare(sql);
    }) as any;

    const app = buildApp(db2);
    const res = await app.request("/healthz");
    assert.equal(res.status, 503);
    const body = await res.json() as Record<string, unknown>;
    assert.match(String(body.error), /not writable/);
    db2.close();
  });
});
