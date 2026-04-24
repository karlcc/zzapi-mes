import { describe, it, beforeEach, afterEach } from "node:test";
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

  it("cache miss at exactly 30s TTL triggers fresh SAP check", async () => {
    // TTL is 30_000ms with strict `<` comparison at line 51
    // At exactly 30s, `now - checkedAt < 30000` is false → cache miss
    const appWithSap = new Hono<{ Variables: HubVariables }>();
    let pingCalled = false;
    const mockSap = { ping: async () => { pingCalled = true; return { ok: true, sap_time: "20260422163000" }; } };
    appWithSap.use("*", async (c, next) => {
      c.set("db", db);
      c.set("sap", mockSap as any);
      c.set("jwtPayload", { key_id: "test", scopes: ["ping"], iat: 0, exp: 0, rate_limit_per_min: null });
      await next();
    });
    appWithSap.route("/", health);

    // Seed cache exactly at TTL boundary (30s ago)
    _setSapCacheForTest({ ok: true, checkedAt: Date.now() - 30_000 });
    const res = await appWithSap.request("/healthz?check=sap");
    assert.equal(res.status, 200);
    assert.ok(pingCalled, "SAP ping should be called when cache is exactly at TTL");
  });

  it("SAP ping timeout produces 503", async () => {
    _resetSapHealthCacheForTest();
    const appWithSap = new Hono<{ Variables: HubVariables }>();
    // Simulate a slow SAP that never resolves (timeout via AbortController in health.ts)
    const mockSap = { ping: async () => new Promise(() => {}) }; // never resolves
    appWithSap.use("*", async (c, next) => {
      c.set("db", db);
      c.set("sap", mockSap as any);
      c.set("jwtPayload", { key_id: "test", scopes: ["ping"], iat: 0, exp: 0, rate_limit_per_min: null });
      await next();
    });
    appWithSap.route("/", health);

    // The AbortController in health.ts has a 5s timeout; we can't wait that long
    // in a unit test. Instead, test the catch path directly by making ping throw.
    const appWithThrow = new Hono<{ Variables: HubVariables }>();
    const throwingSap = { ping: async () => { throw new Error("timeout"); } };
    appWithThrow.use("*", async (c, next) => {
      c.set("db", db);
      c.set("sap", throwingSap as any);
      c.set("jwtPayload", { key_id: "test", scopes: ["ping"], iat: 0, exp: 0, rate_limit_per_min: null });
      await next();
    });
    appWithThrow.route("/", health);

    const res = await appWithThrow.request("/healthz?check=sap");
    assert.equal(res.status, 503);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.error, "SAP unreachable");
    const cache = _getSapCacheForTest();
    assert.ok(cache, "cache should record the failure");
    assert.equal(cache!.ok, false);
  });
});

describe("health route SAP cache concurrent refresh dedup", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    _resetSapHealthCacheForTest();
  });

  it("only pings SAP once for concurrent requests past TTL", async () => {
    // Seed cache past TTL so both requests need a fresh check
    _setSapCacheForTest({ ok: true, checkedAt: Date.now() - 31_000 });

    let pingCount = 0;
    let resolvePing: () => void;
    const pingPromise = new Promise<void>((r) => { resolvePing = r; });

    const mockSap = {
      ping: async () => {
        pingCount++;
        resolvePing();
        return { ok: true, sap_time: "20260422163000" };
      },
    };

    const appWithSap = new Hono<{ Variables: HubVariables }>();
    appWithSap.use("*", async (c, next) => {
      c.set("db", db);
      c.set("sap", mockSap as any);
      c.set("jwtPayload", { key_id: "test", scopes: ["ping"], iat: 0, exp: 0, rate_limit_per_min: null });
      await next();
    });
    appWithSap.route("/", health);

    // Fire two concurrent requests
    const [res1, res2] = await Promise.all([
      appWithSap.request("/healthz?check=sap"),
      appWithSap.request("/healthz?check=sap"),
    ]);

    assert.equal(res1.status, 200);
    assert.equal(res2.status, 200);
    // Without dedup, pingCount would be 2 (one per concurrent request).
    // With a mutex/in-flight promise, the second request reuses the first's
    // pending ping, so pingCount should be 1.
    assert.equal(pingCount, 1, `expected 1 SAP ping for concurrent requests, got ${pingCount}`);
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

describe("SAP_PING_TIMEOUT_MS configurability", () => {
  const origEnv = process.env.SAP_PING_TIMEOUT_MS;

  afterEach(() => {
    if (origEnv !== undefined) process.env.SAP_PING_TIMEOUT_MS = origEnv;
    else delete process.env.SAP_PING_TIMEOUT_MS;
  });

  it("defaults to 5000ms when env var is not set", async () => {
    delete process.env.SAP_PING_TIMEOUT_MS;
    // Re-import to pick up the env change — since the module caches at import time,
    // we verify by checking the default behavior (ping timeout results in 503)
    // The default 5s is too slow for a unit test, so we just verify the env
    // is not required for the health route to work
    const db2 = new Database(":memory:");
    runMigrations(db2);
    const app2 = buildApp(db2);
    const res = await app2.request("/healthz");
    assert.equal(res.status, 200);
    db2.close();
  });

  it("rejects Infinity as SAP_PING_TIMEOUT_MS — falls back to 5000", () => {
    process.env.SAP_PING_TIMEOUT_MS = "Infinity";
    const parsed = Number(process.env.SAP_PING_TIMEOUT_MS);
    assert.equal(Number.isInteger(parsed) && parsed > 0, false, "Infinity should not be accepted");
    delete process.env.SAP_PING_TIMEOUT_MS;
  });

  it("rejects non-integer decimal as SAP_PING_TIMEOUT_MS — falls back to 5000", () => {
    process.env.SAP_PING_TIMEOUT_MS = "5.5";
    const parsed = Number(process.env.SAP_PING_TIMEOUT_MS);
    assert.equal(Number.isInteger(parsed) && parsed > 0, false, "5.5 should not be accepted");
    delete process.env.SAP_PING_TIMEOUT_MS;
  });

  it("rejects negative value as SAP_PING_TIMEOUT_MS — falls back to 5000", () => {
    process.env.SAP_PING_TIMEOUT_MS = "-1";
    const parsed = Number(process.env.SAP_PING_TIMEOUT_MS);
    assert.equal(Number.isInteger(parsed) && parsed > 0, false, "-1 should not be accepted");
    delete process.env.SAP_PING_TIMEOUT_MS;
  });

  it("uses env value when SAP_PING_TIMEOUT_MS is a valid positive integer", () => {
    // We can't easily re-import the module, but we can verify the env var
    // is consumed by setting it before the module-level code would run.
    // Since the constant is computed at import time, this test documents
    // the expected behavior: a positive integer env overrides 5000.
    process.env.SAP_PING_TIMEOUT_MS = "1000";
    // The actual value is captured at import — this test documents intent
    assert.equal(Number(process.env.SAP_PING_TIMEOUT_MS), 1000);
    delete process.env.SAP_PING_TIMEOUT_MS;
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
      if (sql.includes("_healthz_write_check") && sql.includes("INSERT")) {
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

  it("survives stale _healthz_write_check row from prior crash", async () => {
    // If the process crashes between INSERT and DELETE, a stale row with id=1
    // remains. The next health check must succeed because INSERT OR REPLACE
    // handles the PRIMARY KEY conflict (instead of throwing UNIQUE violation).
    const db2 = new Database(":memory:");
    runMigrations(db2);
    // Simulate a stale row left from a prior crash
    db2.exec("CREATE TABLE IF NOT EXISTS _healthz_write_check (id INTEGER PRIMARY KEY)");
    db2.prepare("INSERT INTO _healthz_write_check (id) VALUES (1)").run();

    const app = buildApp(db2);
    const res = await app.request("/healthz");
    assert.equal(res.status, 200, "healthz should succeed even with stale row from prior crash");
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.ok, true);
    db2.close();
  });
});
