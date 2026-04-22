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
      } else if (req.url?.includes("zzapi_mes_prod_order")) {
        const match = req.url.match(/aufnr=([0-9]+)/);
        const aufnr = match?.[1] ?? "0";
        res.end(JSON.stringify({
          aufnr,
          auart: "PP01",
          werks: "1000",
          matnr: "10000001",
          gamng: 1000,
          gstrp: "20260401",
          gltrp: "20260415",
          operations: [{ vornr: "0010", ltxa1: "Turning", arbpl: "TURN1", vgwrt: 2.5 }],
          components: [{ matnr: "20000001", bdmenge: 500, meins: "EA", werks: "1000" }],
        }));
      } else if (req.url?.includes("zzapi_mes_material")) {
        const match = req.url.match(/matnr=([^&]+)/);
        const matnr = match?.[1] ?? "0";
        res.end(JSON.stringify({
          matnr,
          mtart: "FERT",
          meins: "EA",
          maktx: "Test material",
        }));
      } else if (req.url?.includes("zzapi_mes_routing")) {
        const match = req.url.match(/matnr=([^&]+)/);
        const matnr = match?.[1] ?? "0";
        res.end(JSON.stringify({
          matnr,
          werks: "1000",
          plnnr: "50000123",
          operations: [{ vornr: "0010", ltxa1: "Turning", arbpl: "TURN1", vgwrt: 2.5 }],
        }));
      } else if (req.url?.includes("zzapi_mes_wc")) {
        const match = req.url.match(/arbpl=([^&]+)/);
        const arbpl = match?.[1] ?? "0";
        res.end(JSON.stringify({
          arbpl,
          werks: "1000",
          ktext: "CNC Turning Center",
          steus: "PP01",
        }));
      } else if (req.url?.includes("zzapi_mes_stock")) {
        const match = req.url.match(/matnr=([^&]+)/);
        const matnr = match?.[1] ?? "0";
        res.end(JSON.stringify({
          matnr,
          werks: "1000",
          items: [{ lgort: "0001", clabs: 250, avail_qty: 200 }],
        }));
      } else if (req.url?.includes("zzapi_mes_po_items")) {
        const match = req.url.match(/ebeln=([0-9]+)/);
        const ebeln = match?.[1] ?? "0";
        res.end(JSON.stringify({
          ebeln,
          items: [{ ebelp: "00010", matnr: "10000001", menge: 100, meins: "EA" }],
        }));
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
      scopes: "ping,po,prod_order,material,stock,routing,work_center,conf",
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

    // 7. Phase 5A endpoints
    const prodOrderRes = await app.fetch(new Request("http://localhost/prod-order/1000000", {
      headers: { authorization: `Bearer ${token}` },
    }));
    assert.equal(prodOrderRes.status, 200);
    const prodOrderBody = await prodOrderRes.json() as Record<string, unknown>;
    assert.equal(prodOrderBody.aufnr, "1000000");

    const materialRes = await app.fetch(new Request("http://localhost/material/10000001", {
      headers: { authorization: `Bearer ${token}` },
    }));
    assert.equal(materialRes.status, 200);
    const materialBody = await materialRes.json() as Record<string, unknown>;
    assert.equal(materialBody.mtart, "FERT");

    const stockRes = await app.fetch(new Request("http://localhost/stock/10000001?werks=1000", {
      headers: { authorization: `Bearer ${token}` },
    }));
    assert.equal(stockRes.status, 200);

    const poItemsRes = await app.fetch(new Request("http://localhost/po/4500000001/items", {
      headers: { authorization: `Bearer ${token}` },
    }));
    assert.equal(poItemsRes.status, 200);

    const routingRes = await app.fetch(new Request("http://localhost/routing/10000001?werks=1000", {
      headers: { authorization: `Bearer ${token}` },
    }));
    assert.equal(routingRes.status, 200);
    const routingBody = await routingRes.json() as Record<string, unknown>;
    assert.equal(routingBody.plnnr, "50000123");

    const wcRes = await app.fetch(new Request("http://localhost/work-center/TURN1?werks=1000", {
      headers: { authorization: `Bearer ${token}` },
    }));
    assert.equal(wcRes.status, 200);
    const wcBody = await wcRes.json() as Record<string, unknown>;
    assert.equal(wcBody.steus, "PP01");
  });

  it("POST /confirmation accepts valid production confirmation", async () => {
    const sap = new SapClient({
      host: `http://127.0.0.1:${sapPort}`,
      client: 200,
      user: "test",
      password: "test",
    });
    const app = createApp(sap, { db });

    // Get JWT
    const authRes = await app.fetch(new Request("http://localhost/auth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: testKeyPlaintext }),
    }));
    const { token } = await authRes.json() as { token: string };

    // Post confirmation
    const confRes = await app.fetch(new Request("http://localhost/confirmation", {
      method: "POST",
      headers: {
        "authorization": `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "test-conf-key-001",
      },
      body: JSON.stringify({
        orderid: "1000000",
        operation: "0010",
        yield: 50,
      }),
    }));
    assert.equal(confRes.status, 201);
    const confBody = await confRes.json() as Record<string, unknown>;
    assert.equal(confBody.orderid, "1000000");
    assert.equal(confBody.status, "confirmed");
  });

  it("POST /confirmation rejects duplicate idempotency key", async () => {
    const sap = new SapClient({
      host: `http://127.0.0.1:${sapPort}`,
      client: 200,
      user: "test",
      password: "test",
    });
    const app = createApp(sap, { db });

    const authRes = await app.fetch(new Request("http://localhost/auth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: testKeyPlaintext }),
    }));
    const { token } = await authRes.json() as { token: string };

    const headers = {
      "authorization": `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": "dup-key-001",
    };

    // First request succeeds
    const res1 = await app.fetch(new Request("http://localhost/confirmation", {
      method: "POST",
      headers,
      body: JSON.stringify({ orderid: "1000000", operation: "0010", yield: 50 }),
    }));
    assert.equal(res1.status, 201);

    // Duplicate idempotency key → 409
    const res2 = await app.fetch(new Request("http://localhost/confirmation", {
      method: "POST",
      headers,
      body: JSON.stringify({ orderid: "1000000", operation: "0010", yield: 50 }),
    }));
    assert.equal(res2.status, 409);
  });

  it("POST /confirmation rejects missing idempotency key", async () => {
    const sap = new SapClient({
      host: `http://127.0.0.1:${sapPort}`,
      client: 200,
      user: "test",
      password: "test",
    });
    const app = createApp(sap, { db });

    const authRes = await app.fetch(new Request("http://localhost/auth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: testKeyPlaintext }),
    }));
    const { token } = await authRes.json() as { token: string };

    const res = await app.fetch(new Request("http://localhost/confirmation", {
      method: "POST",
      headers: {
        "authorization": `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ orderid: "1000000", operation: "0010", yield: 50 }),
    }));
    assert.equal(res.status, 400);
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

    // po scope missing
    const res = await app.fetch(new Request("http://localhost/po/123", {
      headers: { authorization: `Bearer ${token}` },
    }));
    assert.equal(res.status, 403);
  });

  it("requires werks query param for stock endpoint", async () => {
    const sap = new SapClient({
      host: `http://127.0.0.1:${sapPort}`,
      client: 200,
      user: "test",
      password: "test",
    });
    const app = createApp(sap, { db });

    const authRes = await app.fetch(new Request("http://localhost/auth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: testKeyPlaintext }),
    }));
    const { token } = await authRes.json() as { token: string };

    // Missing werks → 400
    const res = await app.fetch(new Request("http://localhost/stock/10000001", {
      headers: { authorization: `Bearer ${token}` },
    }));
    assert.equal(res.status, 400);
  });

  it("rejects Phase 5A endpoints without correct scope", async () => {
    const token = await sign(
      { key_id: "e2etestkey001", scopes: ["ping", "po"], iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 900 },
      JWT_SECRET,
    );

    const sap = new SapClient({
      host: `http://127.0.0.1:${sapPort}`,
      client: 200,
      user: "test",
      password: "test",
    });
    const app = createApp(sap, { db });

    // prod_order scope missing → 403
    const prodRes = await app.fetch(new Request("http://localhost/prod-order/1000000", {
      headers: { authorization: `Bearer ${token}` },
    }));
    assert.equal(prodRes.status, 403);

    // material scope missing → 403
    const matRes = await app.fetch(new Request("http://localhost/material/10000001", {
      headers: { authorization: `Bearer ${token}` },
    }));
    assert.equal(matRes.status, 403);
  });
});
