import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server.js";
import { SapClient, ZzapiMesHttpError } from "@zzapi-mes/core";
import type { PingResponse, PoResponse, ProdOrderResponse, MaterialResponse, StockResponse, PoItemsResponse, RoutingResponse, WorkCenterResponse } from "@zzapi-mes/core";
import { sign } from "hono/jwt";
import Database from "better-sqlite3";
import argon2 from "argon2";
import { runMigrations, insertKey } from "../db/index.js";

const JWT_SECRET = "test-secret";

// Set env vars before creating app
process.env.HUB_JWT_SECRET = JWT_SECRET;
process.env.HUB_JWT_TTL_SECONDS = "900";

// --- In-memory DB setup ---

let db: Database.Database;
let testKeyPlaintext: string;

async function seedTestKey(scopes = "ping,po,prod_order,material,stock,routing,work_center,conf,gr,gi"): Promise<string> {
  const keyId = "testkey1234";
  const secret = "abc123xyz789def456ghi012jkl345mno678pqr";
  const plaintext = `${keyId}.${secret}`;
  const hash = await argon2.hash(plaintext, { type: argon2.argon2id });

  insertKey(db, {
    id: keyId,
    hash,
    label: "test key",
    scopes,
    rate_limit_per_min: null,
    created_at: Math.floor(Date.now() / 1000),
  });

  return plaintext;
}

// --- Mock SapClient ---

let mockPingResult: PingResponse | null = null;
let mockPoResult: PoResponse | null = null;
let mockProdOrderResult: ProdOrderResponse | null = null;
let mockMaterialResult: MaterialResponse | null = null;
let mockStockResult: StockResponse | null = null;
let mockPoItemsResult: PoItemsResponse | null = null;
let mockRoutingResult: RoutingResponse | null = null;
let mockWorkCenterResult: WorkCenterResponse | null = null;
let mockPingError: ZzapiMesHttpError | null = null;
let mockPoError: ZzapiMesHttpError | null = null;

class MockSapClient {
  async ping(): Promise<PingResponse> {
    if (mockPingError) throw mockPingError;
    return mockPingResult!;
  }
  async getPo(ebeln: string): Promise<PoResponse> {
    if (mockPoError) throw mockPoError;
    return mockPoResult!;
  }
  async getProdOrder(aufnr: string): Promise<ProdOrderResponse> {
    return mockProdOrderResult!;
  }
  async getMaterial(matnr: string, werks?: string): Promise<MaterialResponse> {
    return mockMaterialResult!;
  }
  async getStock(matnr: string, werks: string, lgort?: string): Promise<StockResponse> {
    return mockStockResult!;
  }
  async getPoItems(ebeln: string): Promise<PoItemsResponse> {
    return mockPoItemsResult!;
  }
  async getRouting(matnr: string, werks: string): Promise<RoutingResponse> {
    return mockRoutingResult!;
  }
  async getWorkCenter(arbpl: string, werks: string): Promise<WorkCenterResponse> {
    return mockWorkCenterResult!;
  }
}

beforeEach(async () => {
  mockPingResult = { ok: true, sap_time: "20260422163000" };
  mockPoResult = { ebeln: "3010000608", aedat: "20170306", lifnr: "0000500340", eindt: "20170630" };
  mockProdOrderResult = { aufnr: "1000000", auart: "PP01", werks: "1000", matnr: "10000001", gamng: 1000, gstrp: "20260401", gltrp: "20260415" };
  mockMaterialResult = { matnr: "10000001", mtart: "FERT", meins: "EA", maktx: "Test material" };
  mockStockResult = { matnr: "10000001", werks: "1000", items: [{ lgort: "0001", clabs: 250, avail_qty: 200 }] };
  mockPoItemsResult = { ebeln: "4500000001", items: [{ ebelp: "00010", matnr: "10000001", menge: 100, meins: "EA" }] };
  mockRoutingResult = { matnr: "10000001", werks: "1000", plnnr: "50000123", operations: [{ vornr: "0010", ltxa1: "Turning" }] };
  mockWorkCenterResult = { arbpl: "TURN1", werks: "1000", ktext: "CNC Turning Center", steus: "PP01" };
  mockPingError = null;
  mockPoError = null;

  db = new Database(":memory:");
  runMigrations(db);
  testKeyPlaintext = await seedTestKey();
});

// --- Helpers ---

function app() {
  return createApp(new MockSapClient() as unknown as SapClient, { db });
}

async function fetchApi(path: string, opts?: RequestInit) {
  const req = new Request(`http://localhost${path}`, opts);
  return app().fetch(req);
}

async function validToken(scopes = ["ping", "po", "prod_order", "material", "stock", "routing", "work_center", "conf", "gr", "gi"]): Promise<string> {
  return sign(
    { key_id: "testkey1234", scopes, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 900 },
    JWT_SECRET,
  );
}

async function expiredToken(): Promise<string> {
  return sign(
    { key_id: "testkey1234", scopes: ["ping", "po"], iat: Math.floor(Date.now() / 1000) - 960, exp: Math.floor(Date.now() / 1000) - 60 },
    JWT_SECRET,
  );
}

// --- Tests ---

describe("POST /auth/token", () => {
  it("issues JWT for valid API key", async () => {
    const res = await fetchApi("/auth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: testKeyPlaintext }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as Record<string, unknown>;
    assert.ok(typeof body.token === "string");
    assert.equal(body.expires_in, 900);
  });

  it("rejects invalid API key with 401", async () => {
    const res = await fetchApi("/auth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: "wrong.key" }),
    });
    assert.equal(res.status, 401);
  });

  it("rejects revoked key with 401", async () => {
    // Revoke the test key
    db.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ?").run(Math.floor(Date.now() / 1000), "testkey1234");
    const res = await fetchApi("/auth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: testKeyPlaintext }),
    });
    assert.equal(res.status, 401);
  });

  it("rejects missing api_key with 400", async () => {
    const res = await fetchApi("/auth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });
});

describe("Protected routes without JWT", () => {
  it("GET /ping returns 401 without token", async () => {
    const res = await fetchApi("/ping");
    assert.equal(res.status, 401);
  });

  it("GET /po/123 returns 401 without token", async () => {
    const res = await fetchApi("/po/123");
    assert.equal(res.status, 401);
  });
});

describe("Protected routes with valid JWT", () => {
  it("GET /ping proxies to SAP", async () => {
    const token = await validToken();
    const res = await fetchApi("/ping", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.ok, true);
  });

  it("GET /po/:ebeln proxies to SAP", async () => {
    const token = await validToken();
    const res = await fetchApi("/po/3010000608", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.ebeln, "3010000608");
  });

  it("passthrough SAP 404 as 404", async () => {
    mockPoError = new ZzapiMesHttpError(404, "PO not found");
    mockPoResult = null;
    const token = await validToken();
    const res = await fetchApi("/po/999", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 404);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.error, "PO not found");
  });
});

describe("JWT scope enforcement", () => {
  it("denies /ping with ping scope missing", async () => {
    const token = await validToken(["po"]);
    const res = await fetchApi("/ping", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 403);
  });

  it("denies /po/:ebeln with po scope missing", async () => {
    const token = await validToken(["ping"]);
    const res = await fetchApi("/po/3010000608", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 403);
  });

  it("allows /ping with correct scope", async () => {
    const token = await validToken(["ping"]);
    const res = await fetchApi("/ping", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
  });
});

describe("Expired JWT", () => {
  it("returns 401 for expired token", async () => {
    const token = await expiredToken();
    const res = await fetchApi("/ping", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 401);
  });
});

describe("GET /healthz", () => {
  it("returns ok without auth", async () => {
    const res = await fetchApi("/healthz");
    assert.equal(res.status, 200);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.ok, true);
  });
});

describe("Rate limiting", () => {
  it("returns 429 when token bucket is exhausted", async () => {
    // Create a key with very low rate limit (2 req/min)
    const keyId = "ratelimited";
    const secret = "ratelimitedsecret123456789abcdef0";
    const plaintext = `${keyId}.${secret}`;
    const hash = await argon2.hash(plaintext, { type: argon2.argon2id });
    insertKey(db, {
      id: keyId,
      hash,
      label: "rate limit test key",
      scopes: "ping,po",
      rate_limit_per_min: 2,
      created_at: Math.floor(Date.now() / 1000),
    });

    // Get JWT with the low-limit key
    const authRes = await fetchApi("/auth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: plaintext }),
    });
    assert.equal(authRes.status, 200);
    const { token } = await authRes.json() as { token: string };

    // First two requests should succeed
    const res1 = await fetchApi("/ping", { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res1.status, 200);
    const res2 = await fetchApi("/ping", { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res2.status, 200);

    // Third request should be rate limited
    const res3 = await fetchApi("/ping", { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res3.status, 429);
    const body = await res3.json() as Record<string, unknown>;
    assert.equal(body.error, "Rate limit exceeded");
    assert.ok(res3.headers.get("retry-after"));
  });
});

describe("Metrics", () => {
  it("increments request counters after requests", async () => {
    // Make a request first
    const token = await validToken();
    await fetchApi("/ping", { headers: { authorization: `Bearer ${token}` } });

    // Check metrics endpoint
    const res = await fetchApi("/metrics");
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes("zzapi_hub_requests_total"));
    assert.ok(text.includes("zzapi_hub_request_duration_seconds"));
    assert.ok(text.includes("zzapi_hub_sap_duration_seconds"));
  });
});

describe("Phase 5A routes", () => {
  it("GET /prod-order/:aufnr proxies to SAP", async () => {
    const token = await validToken();
    const res = await fetchApi("/prod-order/1000000", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.aufnr, "1000000");
  });

  it("GET /material/:matnr proxies to SAP", async () => {
    const token = await validToken();
    const res = await fetchApi("/material/10000001", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.mtart, "FERT");
  });

  it("GET /stock/:matnr requires werks", async () => {
    const token = await validToken();
    const res = await fetchApi("/stock/10000001", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 400);
  });

  it("GET /stock/:matnr with werks proxies to SAP", async () => {
    const token = await validToken();
    const res = await fetchApi("/stock/10000001?werks=1000", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
  });

  it("GET /po/:ebeln/items proxies to SAP", async () => {
    const token = await validToken();
    const res = await fetchApi("/po/4500000001/items", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.ebeln, "4500000001");
  });

  it("GET /routing/:matnr requires werks", async () => {
    const token = await validToken();
    const res = await fetchApi("/routing/10000001", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 400);
  });

  it("GET /routing/:matnr with werks proxies to SAP", async () => {
    const token = await validToken();
    const res = await fetchApi("/routing/10000001?werks=1000", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
  });

  it("GET /work-center/:arbpl requires werks", async () => {
    const token = await validToken();
    const res = await fetchApi("/work-center/TURN1", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 400);
  });

  it("GET /work-center/:arbpl with werks proxies to SAP", async () => {
    const token = await validToken();
    const res = await fetchApi("/work-center/TURN1?werks=1000", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.steus, "PP01");
  });
});

describe("Phase 5B write-back routes", () => {
  it("POST /confirmation with idempotency key returns 201", async () => {
    const token = await validToken();
    const res = await fetchApi("/confirmation", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "unit-test-conf-001",
      },
      body: JSON.stringify({ orderid: "1000000", operation: "0010", yield: 50 }),
    });
    assert.equal(res.status, 201);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.status, "confirmed");
  });

  it("POST /confirmation without idempotency key returns 400", async () => {
    const token = await validToken();
    const res = await fetchApi("/confirmation", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ orderid: "1000000", operation: "0010", yield: 50 }),
    });
    assert.equal(res.status, 400);
  });

  it("POST /confirmation duplicate idempotency key returns 409", async () => {
    const token = await validToken();
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": "dup-unit-test-001",
    };
    const body = JSON.stringify({ orderid: "1000000", operation: "0010", yield: 50 });

    const res1 = await fetchApi("/confirmation", { method: "POST", headers, body });
    assert.equal(res1.status, 201);

    const res2 = await fetchApi("/confirmation", { method: "POST", headers, body });
    assert.equal(res2.status, 409);
  });

  it("POST /goods-receipt with idempotency key returns 201", async () => {
    const token = await validToken();
    const res = await fetchApi("/goods-receipt", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "unit-test-gr-001",
      },
      body: JSON.stringify({ ebeln: "4500000001", ebelp: "00010", menge: 100, werks: "1000", lgort: "0001" }),
    });
    assert.equal(res.status, 201);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.status, "posted");
  });

  it("POST /goods-issue with idempotency key returns 201", async () => {
    const token = await validToken();
    const res = await fetchApi("/goods-issue", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "unit-test-gi-001",
      },
      body: JSON.stringify({ orderid: "1000000", matnr: "20000001", menge: 50, werks: "1000", lgort: "0001" }),
    });
    assert.equal(res.status, 201);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.status, "posted");
  });

  it("write-back routes require correct scope", async () => {
    const token = await validToken(["ping"]);
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": "scope-test-001",
    };
    const confRes = await fetchApi("/confirmation", {
      method: "POST", headers,
      body: JSON.stringify({ orderid: "1000000", operation: "0010", yield: 50 }),
    });
    assert.equal(confRes.status, 403);

    const grRes = await fetchApi("/goods-receipt", {
      method: "POST", headers: { ...headers, "idempotency-key": "scope-test-002" },
      body: JSON.stringify({ ebeln: "4500000001", ebelp: "00010", menge: 100, werks: "1000", lgort: "0001" }),
    });
    assert.equal(grRes.status, 403);

    const giRes = await fetchApi("/goods-issue", {
      method: "POST", headers: { ...headers, "idempotency-key": "scope-test-003" },
      body: JSON.stringify({ orderid: "1000000", matnr: "20000001", menge: 50, werks: "1000", lgort: "0001" }),
    });
    assert.equal(giRes.status, 403);
  });

  it("idempotency status is updated after handler", async () => {
    const token = await validToken();
    const idemKey = "status-update-test-001";
    await fetchApi("/confirmation", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": idemKey,
      },
      body: JSON.stringify({ orderid: "1000000", operation: "0010", yield: 50 }),
    });
    // Check that the stored status was updated from 0 to 201
    const row = db.prepare("SELECT status FROM idempotency_keys WHERE key = ?").get(idemKey) as { status: number } | undefined;
    assert.ok(row);
    assert.equal(row.status, 201);
  });
});
