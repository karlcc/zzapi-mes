import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createApp } from "../server.js";
import { SapClient, ALL_SCOPES } from "@zzapi-mes/core";
import { sign } from "hono/jwt";
import Database from "better-sqlite3";
import argon2 from "argon2";
import { runMigrations, insertKey } from "../db/index.js";

const JWT_SECRET = "integration-test-16ch";

process.env.HUB_JWT_SECRET = JWT_SECRET;
process.env.HUB_JWT_TTL_SECONDS = "900";

// --- Mock SAP server ---

function startMockSap(errorMode: string = ""): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");

      // --- POST write-back endpoints ---
      if (req.method === "POST" && req.url?.includes("zzapi/mes/conf")) {
        let body = "";
        req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        req.on("end", () => {
          if (errorMode === "conf-422") {
            res.statusCode = 422;
            res.end(JSON.stringify({ error: "Order already confirmed" }));
            return;
          }
          if (errorMode === "conf-500") {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: "Internal Server Error" }));
            return;
          }
          const data = JSON.parse(body);
          res.end(JSON.stringify({
            orderid: data.orderid,
            operation: data.operation,
            yield: data.yield,
            scrap: data.scrap ?? 0,
            confNo: "00000100",
            confCnt: "0001",
            status: "confirmed",
            message: "Production confirmation recorded",
          }));
        });
        return;
      }
      if (req.method === "POST" && req.url?.includes("zzapi/mes/gr")) {
        let body = "";
        req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        req.on("end", () => {
          if (errorMode === "gr-422") {
            res.statusCode = 422;
            res.end(JSON.stringify({ error: "PO already received" }));
            return;
          }
          if (errorMode === "gr-500") {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: "Internal Server Error" }));
            return;
          }
          const data = JSON.parse(body);
          res.end(JSON.stringify({
            ebeln: data.ebeln,
            ebelp: data.ebelp,
            menge: data.menge,
            materialDocument: "5000000001",
            documentYear: "2026",
            status: "posted",
            message: "Goods receipt posted",
          }));
        });
        return;
      }
      if (req.method === "POST" && req.url?.includes("zzapi/mes/gi")) {
        let body = "";
        req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        req.on("end", () => {
          if (errorMode === "gi-409") {
            res.statusCode = 409;
            res.end(JSON.stringify({ error: "Backflush is active for this order" }));
            return;
          }
          if (errorMode === "gi-422") {
            res.statusCode = 422;
            res.end(JSON.stringify({ error: "Material not found" }));
            return;
          }
          if (errorMode === "gi-500") {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: "Internal Server Error" }));
            return;
          }
          const data = JSON.parse(body);
          res.end(JSON.stringify({
            orderid: data.orderid,
            matnr: data.matnr,
            menge: data.menge,
            materialDocument: "5000000002",
            documentYear: "2026",
            status: "posted",
            message: "Goods issue posted",
          }));
        });
        return;
      }

      // --- GET read endpoints ---
      if (req.url?.includes("zzapi/mes/ping")) {
        res.end(JSON.stringify({ ok: true, sap_time: "20260422163000" }));
      } else if (req.url?.includes("zzapi/mes/prod_order")) {
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
      } else if (req.url?.includes("zzapi/mes/material")) {
        const match = req.url.match(/matnr=([^&]+)/);
        const matnr = match?.[1] ?? "0";
        res.end(JSON.stringify({
          matnr,
          mtart: "FERT",
          meins: "EA",
          maktx: "Test material",
        }));
      } else if (req.url?.includes("zzapi/mes/routing")) {
        const match = req.url.match(/matnr=([^&]+)/);
        const matnr = match?.[1] ?? "0";
        res.end(JSON.stringify({
          matnr,
          werks: "1000",
          plnnr: "50000123",
          operations: [{ vornr: "0010", ltxa1: "Turning", arbpl: "TURN1", vgwrt: 2.5 }],
        }));
      } else if (req.url?.includes("zzapi/mes/wc")) {
        const match = req.url.match(/arbpl=([^&]+)/);
        const arbpl = match?.[1] ?? "0";
        res.end(JSON.stringify({
          arbpl,
          werks: "1000",
          ktext: "CNC Turning Center",
          steus: "PP01",
        }));
      } else if (req.url?.includes("zzapi/mes/stock")) {
        const match = req.url.match(/matnr=([^&]+)/);
        const matnr = match?.[1] ?? "0";
        res.end(JSON.stringify({
          matnr,
          werks: "1000",
          items: [{ lgort: "0001", clabs: 250, avail_qty: 200 }],
        }));
      } else if (req.url?.includes("zzapi/mes/po_items")) {
        const match = req.url.match(/ebeln=([0-9]+)/);
        const ebeln = match?.[1] ?? "0";
        res.end(JSON.stringify({
          ebeln,
          items: [{ ebelp: "00010", matnr: "10000001", menge: 100, meins: "EA" }],
        }));
      } else if (req.url?.includes("zzapi/mes/handler") && req.url?.includes("ebeln=")) {
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
      scopes: ALL_SCOPES.join(","),
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

    const { app } = createApp(sap, { db });

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

    // 5. Metrics endpoint works (in test mode, x-real-ip header required for
    // loopback check since there's no real TCP socket)
    const metricsRes = await app.fetch(new Request("http://localhost/metrics", {
      headers: { "x-real-ip": "127.0.0.1" },
    }));
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
    const { app } = createApp(sap, { db });

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
    const { app } = createApp(sap, { db });

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
    const { app } = createApp(sap, { db });

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
    const { app } = createApp(sap, { db });

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
    const { app } = createApp(sap, { db });

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
    const { app } = createApp(sap, { db });

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
    const { app } = createApp(sap, { db });

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

  // --- Phase 5B write-back tests ---

  it("POST /goods-receipt accepts valid GR", async () => {
    const sap = new SapClient({
      host: `http://127.0.0.1:${sapPort}`,
      client: 200,
      user: "test",
      password: "test",
    });
    const { app } = createApp(sap, { db });

    const authRes = await app.fetch(new Request("http://localhost/auth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: testKeyPlaintext }),
    }));
    const { token } = await authRes.json() as { token: string };

    const grRes = await app.fetch(new Request("http://localhost/goods-receipt", {
      method: "POST",
      headers: {
        "authorization": `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "gr-key-001",
      },
      body: JSON.stringify({
        ebeln: "4500000001",
        ebelp: "00010",
        menge: 100,
        werks: "1000",
        lgort: "0001",
      }),
    }));
    assert.equal(grRes.status, 201);
    const grBody = await grRes.json() as Record<string, unknown>;
    assert.equal(grBody.ebeln, "4500000001");
    assert.equal(grBody.status, "posted");
  });

  it("POST /goods-receipt rejects missing idempotency key", async () => {
    const sap = new SapClient({
      host: `http://127.0.0.1:${sapPort}`,
      client: 200,
      user: "test",
      password: "test",
    });
    const { app } = createApp(sap, { db });

    const authRes = await app.fetch(new Request("http://localhost/auth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: testKeyPlaintext }),
    }));
    const { token } = await authRes.json() as { token: string };

    const res = await app.fetch(new Request("http://localhost/goods-receipt", {
      method: "POST",
      headers: {
        "authorization": `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ebeln: "4500000001",
        ebelp: "00010",
        menge: 100,
        werks: "1000",
        lgort: "0001",
      }),
    }));
    assert.equal(res.status, 400);
  });

  it("POST /goods-issue accepts valid GI", async () => {
    const sap = new SapClient({
      host: `http://127.0.0.1:${sapPort}`,
      client: 200,
      user: "test",
      password: "test",
    });
    const { app } = createApp(sap, { db });

    const authRes = await app.fetch(new Request("http://localhost/auth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: testKeyPlaintext }),
    }));
    const { token } = await authRes.json() as { token: string };

    const giRes = await app.fetch(new Request("http://localhost/goods-issue", {
      method: "POST",
      headers: {
        "authorization": `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "gi-key-001",
      },
      body: JSON.stringify({
        orderid: "1000000",
        matnr: "20000001",
        menge: 50,
        werks: "1000",
        lgort: "0001",
      }),
    }));
    assert.equal(giRes.status, 201);
    const giBody = await giRes.json() as Record<string, unknown>;
    assert.equal(giBody.orderid, "1000000");
    assert.equal(giBody.status, "posted");
  });

  it("POST /goods-issue rejects missing idempotency key", async () => {
    const sap = new SapClient({
      host: `http://127.0.0.1:${sapPort}`,
      client: 200,
      user: "test",
      password: "test",
    });
    const { app } = createApp(sap, { db });

    const authRes = await app.fetch(new Request("http://localhost/auth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: testKeyPlaintext }),
    }));
    const { token } = await authRes.json() as { token: string };

    const res = await app.fetch(new Request("http://localhost/goods-issue", {
      method: "POST",
      headers: {
        "authorization": `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        orderid: "1000000",
        matnr: "20000001",
        menge: 50,
        werks: "1000",
        lgort: "0001",
      }),
    }));
    assert.equal(res.status, 400);
  });

  it("rejects Phase 5B endpoints without correct scope", async () => {
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
    const { app } = createApp(sap, { db });

    // gr scope missing → 403
    const grRes = await app.fetch(new Request("http://localhost/goods-receipt", {
      method: "POST",
      headers: {
        "authorization": `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "scope-test-001",
      },
      body: JSON.stringify({
        ebeln: "4500000001",
        ebelp: "00010",
        menge: 100,
        werks: "1000",
        lgort: "0001",
      }),
    }));
    assert.equal(grRes.status, 403);

    // gi scope missing → 403
    const giRes = await app.fetch(new Request("http://localhost/goods-issue", {
      method: "POST",
      headers: {
        "authorization": `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "scope-test-002",
      },
      body: JSON.stringify({
        orderid: "1000000",
        matnr: "20000001",
        menge: 50,
        werks: "1000",
        lgort: "0001",
      }),
    }));
    assert.equal(giRes.status, 403);
  });

  // --- Phase 5B SAP error path tests ---

  it("POST /confirmation returns 422 when SAP rejects business logic", async () => {
    const errSap = await startMockSap("conf-422");
    try {
      const sap = new SapClient({ host: `http://127.0.0.1:${errSap.port}`, client: 200, user: "test", password: "test" });
      const { app } = createApp(sap, { db });

      const authRes = await app.fetch(new Request("http://localhost/auth/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: testKeyPlaintext }),
      }));
      const { token } = await authRes.json() as { token: string };

      const res = await app.fetch(new Request("http://localhost/confirmation", {
        method: "POST",
        headers: { "authorization": `Bearer ${token}`, "content-type": "application/json", "idempotency-key": "err-conf-422" },
        body: JSON.stringify({ orderid: "1000000", operation: "0010", yield: 50 }),
      }));
      assert.equal(res.status, 422);
    } finally {
      errSap.server.close();
    }
  });

  it("POST /confirmation returns 502 on SAP upstream failure", async () => {
    const errSap = await startMockSap("conf-500");
    try {
      const sap = new SapClient({ host: `http://127.0.0.1:${errSap.port}`, client: 200, user: "test", password: "test" });
      const { app } = createApp(sap, { db });

      const authRes = await app.fetch(new Request("http://localhost/auth/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: testKeyPlaintext }),
      }));
      const { token } = await authRes.json() as { token: string };

      const res = await app.fetch(new Request("http://localhost/confirmation", {
        method: "POST",
        headers: { "authorization": `Bearer ${token}`, "content-type": "application/json", "idempotency-key": "err-conf-502" },
        body: JSON.stringify({ orderid: "1000000", operation: "0010", yield: 50 }),
      }));
      assert.equal(res.status, 502);
    } finally {
      errSap.server.close();
    }
  });

  it("POST /goods-receipt returns 422 when SAP rejects business logic", async () => {
    const errSap = await startMockSap("gr-422");
    try {
      const sap = new SapClient({ host: `http://127.0.0.1:${errSap.port}`, client: 200, user: "test", password: "test" });
      const { app } = createApp(sap, { db });

      const authRes = await app.fetch(new Request("http://localhost/auth/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: testKeyPlaintext }),
      }));
      const { token } = await authRes.json() as { token: string };

      const res = await app.fetch(new Request("http://localhost/goods-receipt", {
        method: "POST",
        headers: { "authorization": `Bearer ${token}`, "content-type": "application/json", "idempotency-key": "err-gr-422" },
        body: JSON.stringify({ ebeln: "4500000001", ebelp: "00010", menge: 100, werks: "1000", lgort: "0001" }),
      }));
      assert.equal(res.status, 422);
    } finally {
      errSap.server.close();
    }
  });

  it("POST /goods-receipt returns 502 on SAP upstream failure", async () => {
    const errSap = await startMockSap("gr-500");
    try {
      const sap = new SapClient({ host: `http://127.0.0.1:${errSap.port}`, client: 200, user: "test", password: "test" });
      const { app } = createApp(sap, { db });

      const authRes = await app.fetch(new Request("http://localhost/auth/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: testKeyPlaintext }),
      }));
      const { token } = await authRes.json() as { token: string };

      const res = await app.fetch(new Request("http://localhost/goods-receipt", {
        method: "POST",
        headers: { "authorization": `Bearer ${token}`, "content-type": "application/json", "idempotency-key": "err-gr-502" },
        body: JSON.stringify({ ebeln: "4500000001", ebelp: "00010", menge: 100, werks: "1000", lgort: "0001" }),
      }));
      assert.equal(res.status, 502);
    } finally {
      errSap.server.close();
    }
  });

  it("POST /goods-issue returns 409 on SAP backflush conflict", async () => {
    const errSap = await startMockSap("gi-409");
    try {
      const sap = new SapClient({ host: `http://127.0.0.1:${errSap.port}`, client: 200, user: "test", password: "test" });
      const { app } = createApp(sap, { db });

      const authRes = await app.fetch(new Request("http://localhost/auth/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: testKeyPlaintext }),
      }));
      const { token } = await authRes.json() as { token: string };

      const res = await app.fetch(new Request("http://localhost/goods-issue", {
        method: "POST",
        headers: { "authorization": `Bearer ${token}`, "content-type": "application/json", "idempotency-key": "err-gi-409" },
        body: JSON.stringify({ orderid: "1000000", matnr: "20000001", menge: 50, werks: "1000", lgort: "0001" }),
      }));
      assert.equal(res.status, 409);
    } finally {
      errSap.server.close();
    }
  });

  it("POST /goods-issue returns 422 when SAP rejects business logic", async () => {
    const errSap = await startMockSap("gi-422");
    try {
      const sap = new SapClient({ host: `http://127.0.0.1:${errSap.port}`, client: 200, user: "test", password: "test" });
      const { app } = createApp(sap, { db });

      const authRes = await app.fetch(new Request("http://localhost/auth/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: testKeyPlaintext }),
      }));
      const { token } = await authRes.json() as { token: string };

      const res = await app.fetch(new Request("http://localhost/goods-issue", {
        method: "POST",
        headers: { "authorization": `Bearer ${token}`, "content-type": "application/json", "idempotency-key": "err-gi-422" },
        body: JSON.stringify({ orderid: "1000000", matnr: "20000001", menge: 50, werks: "1000", lgort: "0001" }),
      }));
      assert.equal(res.status, 422);
    } finally {
      errSap.server.close();
    }
  });

  it("POST /goods-issue returns 502 on SAP upstream failure", async () => {
    const errSap = await startMockSap("gi-500");
    try {
      const sap = new SapClient({ host: `http://127.0.0.1:${errSap.port}`, client: 200, user: "test", password: "test" });
      const { app } = createApp(sap, { db });

      const authRes = await app.fetch(new Request("http://localhost/auth/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: testKeyPlaintext }),
      }));
      const { token } = await authRes.json() as { token: string };

      const res = await app.fetch(new Request("http://localhost/goods-issue", {
        method: "POST",
        headers: { "authorization": `Bearer ${token}`, "content-type": "application/json", "idempotency-key": "err-gi-502" },
        body: JSON.stringify({ orderid: "1000000", matnr: "20000001", menge: 50, werks: "1000", lgort: "0001" }),
      }));
      assert.equal(res.status, 502);
    } finally {
      errSap.server.close();
    }
  });

  it("POST /goods-receipt rejects duplicate idempotency key", async () => {
    const sap = new SapClient({
      host: `http://127.0.0.1:${sapPort}`,
      client: 200,
      user: "test",
      password: "test",
    });
    const { app } = createApp(sap, { db });

    const authRes = await app.fetch(new Request("http://localhost/auth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: testKeyPlaintext }),
    }));
    const { token } = await authRes.json() as { token: string };

    const headers = {
      "authorization": `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": "dup-gr-key-001",
    };
    const reqBody = JSON.stringify({ ebeln: "4500000001", ebelp: "00010", menge: 100, werks: "1000", lgort: "0001" });

    const res1 = await app.fetch(new Request("http://localhost/goods-receipt", { method: "POST", headers, body: reqBody }));
    assert.equal(res1.status, 201);

    const res2 = await app.fetch(new Request("http://localhost/goods-receipt", { method: "POST", headers, body: reqBody }));
    assert.equal(res2.status, 409);
  });

  it("POST /goods-issue rejects duplicate idempotency key", async () => {
    const sap = new SapClient({
      host: `http://127.0.0.1:${sapPort}`,
      client: 200,
      user: "test",
      password: "test",
    });
    const { app } = createApp(sap, { db });

    const authRes = await app.fetch(new Request("http://localhost/auth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: testKeyPlaintext }),
    }));
    const { token } = await authRes.json() as { token: string };

    const headers = {
      "authorization": `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": "dup-gi-key-001",
    };
    const reqBody = JSON.stringify({ orderid: "1000000", matnr: "20000001", menge: 50, werks: "1000", lgort: "0001" });

    const res1 = await app.fetch(new Request("http://localhost/goods-issue", { method: "POST", headers, body: reqBody }));
    assert.equal(res1.status, 201);

    const res2 = await app.fetch(new Request("http://localhost/goods-issue", { method: "POST", headers, body: reqBody }));
    assert.equal(res2.status, 409);
  });

  it("POST /confirmation rejects invalid request body", async () => {
    const sap = new SapClient({
      host: `http://127.0.0.1:${sapPort}`,
      client: 200,
      user: "test",
      password: "test",
    });
    const { app } = createApp(sap, { db });

    const authRes = await app.fetch(new Request("http://localhost/auth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: testKeyPlaintext }),
    }));
    const { token } = await authRes.json() as { token: string };

    const res = await app.fetch(new Request("http://localhost/confirmation", {
      method: "POST",
      headers: { "authorization": `Bearer ${token}`, "content-type": "application/json", "idempotency-key": "zod-conf-001" },
      body: JSON.stringify({ orderid: "1000000", yield: -1 }),
    }));
    assert.equal(res.status, 400);
    const body = await res.json() as Record<string, unknown>;
    assert.ok(String(body.error).includes("yield"));
  });

  it("POST /goods-receipt rejects invalid request body", async () => {
    const sap = new SapClient({
      host: `http://127.0.0.1:${sapPort}`,
      client: 200,
      user: "test",
      password: "test",
    });
    const { app } = createApp(sap, { db });

    const authRes = await app.fetch(new Request("http://localhost/auth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: testKeyPlaintext }),
    }));
    const { token } = await authRes.json() as { token: string };

    const res = await app.fetch(new Request("http://localhost/goods-receipt", {
      method: "POST",
      headers: { "authorization": `Bearer ${token}`, "content-type": "application/json", "idempotency-key": "zod-gr-001" },
      body: JSON.stringify({ ebeln: "4500000001", ebelp: "00010", menge: -5, werks: "1000", lgort: "0001" }),
    }));
    assert.equal(res.status, 400);
    const body = await res.json() as Record<string, unknown>;
    assert.ok(String(body.error).includes("menge"));
  });

  it("POST /goods-issue rejects invalid request body", async () => {
    const sap = new SapClient({
      host: `http://127.0.0.1:${sapPort}`,
      client: 200,
      user: "test",
      password: "test",
    });
    const { app } = createApp(sap, { db });

    const authRes = await app.fetch(new Request("http://localhost/auth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: testKeyPlaintext }),
    }));
    const { token } = await authRes.json() as { token: string };

    const res = await app.fetch(new Request("http://localhost/goods-issue", {
      method: "POST",
      headers: { "authorization": `Bearer ${token}`, "content-type": "application/json", "idempotency-key": "zod-gi-001" },
      body: JSON.stringify({ orderid: "1000000", matnr: "20000001", menge: -1, werks: "1000", lgort: "0001" }),
    }));
    assert.equal(res.status, 400);
    const body = await res.json() as Record<string, unknown>;
    assert.ok(String(body.error).includes("menge"));
  });
});
