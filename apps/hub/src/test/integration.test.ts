import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createApp } from "../server.js";
import { SapClient } from "@zzapi-mes/core";
import { sign } from "hono/jwt";
import Database from "better-sqlite3";
import argon2 from "argon2";
import { runMigrations, insertKey } from "../db/index.js";

const JWT_SECRET = "integration-test-secret";

process.env.HUB_JWT_SECRET = JWT_SECRET;
process.env.HUB_JWT_TTL_SECONDS = "900";

// --- Mock SAP server ---

function startMockSap(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");

      if (req.url?.includes("zzapi_mes_ping")) {
        res.end(JSON.stringify({ ok: true, sap_time: "20260422163000" }));
      } else if (req.url?.includes("zzapi_mes") && req.url?.includes("ebeln=")) {
        const match = req.url.match(/ebeln=([0-9]+)/);
        const ebeln = match?.[1] ?? "0";
        res.end(JSON.stringify({
          ebeln,
          aedat: "20170306",
          lifnr: "0000500340",
          eindt: "20170630",
        }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "Not found" }));
      }
    });
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

// --- Test ---

describe("E2E integration against mock SAP", () => {
  let mockSap: Server;
  let sapPort: number;
  let db: Database.Database;
  let testKeyPlaintext: string;

  before(async () => {
    const { server, port } = await startMockSap();
    mockSap = server;
    sapPort = port;

    db = new Database(":memory:");
    runMigrations(db);

    const keyId = "e2etestkey001";
    const secret = "integrationtestsecret123456789abcdef";
    testKeyPlaintext = `${keyId}.${secret}`;
    const hash = await argon2.hash(testKeyPlaintext, { type: argon2.argon2id });

    insertKey(db, {
      id: keyId,
      hash,
      label: "e2e test key",
      scopes: "ping,po",
      rate_limit_per_min: null,
      created_at: Math.floor(Date.now() / 1000),
    });
  });

  after(() => {
    mockSap.close();
    db.close();
  });

  it("authenticates and proxies ping + po through hub to mock SAP", async () => {
    const sap = new SapClient({
      host: `http://127.0.0.1:${sapPort}`,
      client: 200,
      user: "test",
      password: "test",
    });

    const app = createApp(sap, { db });

    // 1. Get JWT
    const authRes = await app.fetch(new Request("http://localhost/auth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: testKeyPlaintext }),
    }));
    assert.equal(authRes.status, 200);
    const authBody = await authRes.json() as Record<string, unknown>;
    assert.ok(typeof authBody.token === "string");
    const token = authBody.token as string;

    // 2. Ping
    const pingRes = await app.fetch(new Request("http://localhost/ping", {
      headers: { authorization: `Bearer ${token}` },
    }));
    assert.equal(pingRes.status, 200);
    const pingBody = await pingRes.json() as Record<string, unknown>;
    assert.equal(pingBody.ok, true);
    assert.ok(pingBody.sap_time);

    // 3. PO lookup
    const poRes = await app.fetch(new Request("http://localhost/po/4500000001", {
      headers: { authorization: `Bearer ${token}` },
    }));
    assert.equal(poRes.status, 200);
    const poBody = await poRes.json() as Record<string, unknown>;
    assert.equal(poBody.ebeln, "4500000001");

    // 4. x-request-id present in responses
    assert.ok(pingRes.headers.get("x-request-id"));

    // 5. Metrics endpoint works
    const metricsRes = await app.fetch(new Request("http://localhost/metrics"));
    assert.equal(metricsRes.status, 200);
    const metricsText = await metricsRes.text();
    assert.ok(metricsText.includes("zzapi_hub_requests_total"));

    // 6. Healthz
    const healthRes = await app.fetch(new Request("http://localhost/healthz"));
    assert.equal(healthRes.status, 200);
  });

  it("rejects request without valid JWT", async () => {
    const sap = new SapClient({
      host: `http://127.0.0.1:${sapPort}`,
      client: 200,
      user: "test",
      password: "test",
    });
    const app = createApp(sap, { db });

    const res = await app.fetch(new Request("http://localhost/ping"));
    assert.equal(res.status, 401);
  });

  it("rejects request with wrong scope", async () => {
    const token = await sign(
      { key_id: "e2etestkey001", scopes: ["ping"], iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 900 },
      JWT_SECRET,
    );

    const sap = new SapClient({
      host: `http://127.0.0.1:${sapPort}`,
      client: 200,
      user: "test",
      password: "test",
    });
    const app = createApp(sap, { db });

    const res = await app.fetch(new Request("http://localhost/po/123", {
      headers: { authorization: `Bearer ${token}` },
    }));
    assert.equal(res.status, 403);
  });
});
