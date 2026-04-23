import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server.js";
import { SapClient, ZzapiMesHttpError, ALL_SCOPES } from "@zzapi-mes/core";
import type { PingResponse, PoResponse, ProdOrderResponse, MaterialResponse, StockResponse, PoItemsResponse, RoutingResponse, WorkCenterResponse, ConfirmationRequest, ConfirmationResponse, GoodsReceiptRequest, GoodsReceiptResponse, GoodsIssueRequest, GoodsIssueResponse } from "@zzapi-mes/core";
import { sign } from "hono/jwt";
import Database from "better-sqlite3";
import argon2 from "argon2";
import { runMigrations, insertKey, writeAudit, revokeKey } from "../db/index.js";
import { _resetBucketsForTest } from "../middleware/rate-limit.js";
import { _resetSapHealthCacheForTest } from "../routes/health.js";

const JWT_SECRET = "test-secret";

// Set env vars before creating app
process.env.HUB_JWT_SECRET = JWT_SECRET;
process.env.HUB_JWT_TTL_SECONDS = "900";

// --- In-memory DB setup ---

let db: Database.Database;
let testKeyPlaintext: string;

async function seedTestKey(scopes = ALL_SCOPES.join(",")): Promise<string> {
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
let mockProdOrderError: ZzapiMesHttpError | null = null;
let mockMaterialError: ZzapiMesHttpError | null = null;
let mockStockError: ZzapiMesHttpError | null = null;
let mockPoItemsError: ZzapiMesHttpError | null = null;
let mockRoutingError: ZzapiMesHttpError | null = null;
let mockWorkCenterError: ZzapiMesHttpError | null = null;
let mockConfError: ZzapiMesHttpError | null = null;
let mockGrError: ZzapiMesHttpError | null = null;
let mockGiError: ZzapiMesHttpError | null = null;

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
    if (mockProdOrderError) throw mockProdOrderError;
    return mockProdOrderResult!;
  }
  async getMaterial(matnr: string, werks?: string): Promise<MaterialResponse> {
    if (mockMaterialError) throw mockMaterialError;
    return mockMaterialResult!;
  }
  async getStock(matnr: string, werks: string, lgort?: string): Promise<StockResponse> {
    if (mockStockError) throw mockStockError;
    return mockStockResult!;
  }
  async getPoItems(ebeln: string): Promise<PoItemsResponse> {
    if (mockPoItemsError) throw mockPoItemsError;
    return mockPoItemsResult!;
  }
  async getRouting(matnr: string, werks: string): Promise<RoutingResponse> {
    if (mockRoutingError) throw mockRoutingError;
    return mockRoutingResult!;
  }
  async getWorkCenter(arbpl: string, werks: string): Promise<WorkCenterResponse> {
    if (mockWorkCenterError) throw mockWorkCenterError;
    return mockWorkCenterResult!;
  }
  async postConfirmation(data: ConfirmationRequest): Promise<ConfirmationResponse> {
    if (mockConfError) throw mockConfError;
    return {
      orderid: data.orderid,
      operation: data.operation,
      yield: data.yield,
      scrap: data.scrap ?? 0,
      confNo: "00000100",
      confCnt: "0001",
      status: "confirmed",
      message: "Production confirmation recorded",
    };
  }
  async postGoodsReceipt(data: GoodsReceiptRequest): Promise<GoodsReceiptResponse> {
    if (mockGrError) throw mockGrError;
    return {
      ebeln: data.ebeln,
      ebelp: data.ebelp,
      menge: data.menge,
      materialDocument: "5000000001",
      documentYear: "2026",
      status: "posted",
      message: "Goods receipt posted",
    };
  }
  async postGoodsIssue(data: GoodsIssueRequest): Promise<GoodsIssueResponse> {
    if (mockGiError) throw mockGiError;
    return {
      orderid: data.orderid,
      matnr: data.matnr,
      menge: data.menge,
      materialDocument: "5000000002",
      documentYear: "2026",
      status: "posted",
      message: "Goods issue posted",
    };
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
  mockProdOrderError = null;
  mockMaterialError = null;
  mockStockError = null;
  mockPoItemsError = null;
  mockRoutingError = null;
  mockWorkCenterError = null;
  mockConfError = null;
  mockGrError = null;
  mockGiError = null;

  db = new Database(":memory:");
  runMigrations(db);
  _resetBucketsForTest();
  _resetSapHealthCacheForTest();
  testKeyPlaintext = await seedTestKey();
});

// --- Helpers ---

function app() {
  return createApp(new MockSapClient() as unknown as SapClient, { db }).app;
}

async function fetchApi(path: string, opts?: RequestInit) {
  const req = new Request(`http://localhost${path}`, opts);
  return app().fetch(req);
}

async function validToken(scopes: string[] = [...ALL_SCOPES]): Promise<string> {
  return sign(
    { key_id: "testkey1234", scopes, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 900, rate_limit_per_min: 600 },
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

  it("returns 401 for expired token on write-back route", async () => {
    const token = await expiredToken();
    const res = await fetchApi("/confirmation", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "expired-jwt-test",
      },
      body: JSON.stringify({ orderid: "1000000", operation: "0010", yield: 50 }),
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

  it("returns 503 when DB is unreachable", async () => {
    // Create app with a db that throws on prepare()
    const brokenDb = {
      prepare: () => { throw new Error("disk I/O error"); },
    } as unknown as Database.Database;
    const brokenApp = createApp(new MockSapClient() as unknown as SapClient, { db: brokenDb }).app;
    const req = new Request("http://localhost/healthz");
    const res = await brokenApp.fetch(req);
    assert.equal(res.status, 503);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.ok, false);
    assert.equal(body.error, "database unreachable");
  });

  it("returns ok with sap=reachable when ?check=sap and SAP responds", async () => {
    const res = await fetchApi("/healthz?check=sap");
    assert.equal(res.status, 200);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.ok, true);
    assert.equal(body.sap, "reachable");
  });

  it("returns 503 when ?check=sap and SAP is unreachable", async () => {
    mockPingError = new ZzapiMesHttpError(502, "Network error");
    const res = await fetchApi("/healthz?check=sap");
    assert.equal(res.status, 503);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.ok, false);
    assert.equal(body.error, "SAP unreachable");
  });
});

describe("Request ID middleware", () => {
  it("generates UUID when no x-request-id header is sent", async () => {
    const res = await fetchApi("/healthz");
    const reqId = res.headers.get("x-request-id");
    assert.ok(reqId);
    assert.match(reqId!, /^[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it("echoes valid x-request-id header", async () => {
    const res = await fetchApi("/healthz", {
      headers: { "x-request-id": "my-req-id-1234" },
    });
    assert.equal(res.headers.get("x-request-id"), "my-req-id-1234");
  });

  it("replaces too-short x-request-id with UUID", async () => {
    const res = await fetchApi("/healthz", {
      headers: { "x-request-id": "short" },
    });
    const reqId = res.headers.get("x-request-id");
    assert.ok(reqId);
    assert.match(reqId!, /^[0-9a-f]{8}-/); // UUID, not "short"
  });

  it("replaces x-request-id with special chars with UUID", async () => {
    const res = await fetchApi("/healthz", {
      headers: { "x-request-id": "bad!@#$%^&*()" },
    });
    const reqId = res.headers.get("x-request-id");
    assert.ok(reqId);
    assert.match(reqId!, /^[0-9a-f]{8}-/);
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

  it("tokens refill after waiting", async () => {
    // Create a key with 60 req/min = 1 token/sec
    const keyId = "refilltest";
    const secret = "refilltestsecret123456789abcdef01";
    const plaintext = `${keyId}.${secret}`;
    const hash = await argon2.hash(plaintext, { type: argon2.argon2id });
    insertKey(db, {
      id: keyId,
      hash,
      label: "refill test key",
      scopes: "ping",
      rate_limit_per_min: 60,
      created_at: Math.floor(Date.now() / 1000),
    });

    const authRes = await fetchApi("/auth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: plaintext }),
    });
    assert.equal(authRes.status, 200);
    const { token } = await authRes.json() as { token: string };

    // Exhaust the bucket (60 tokens)
    for (let i = 0; i < 60; i++) {
      await fetchApi("/ping", { headers: { authorization: `Bearer ${token}` } });
    }

    // Next request should be rate limited
    const limited = await fetchApi("/ping", { headers: { authorization: `Bearer ${token}` } });
    assert.equal(limited.status, 429);

    // Wait ~1.1s for token refill (1 token/sec at 60 RPM)
    await new Promise((r) => setTimeout(r, 1100));

    // Should succeed again after refill
    const after = await fetchApi("/ping", { headers: { authorization: `Bearer ${token}` } });
    assert.equal(after.status, 200);
  });

  it("retry-after header has positive integer value", async () => {
    const keyId = "retrytest";
    const secret = "retrytestsecret123456789abcdef012";
    const plaintext = `${keyId}.${secret}`;
    const hash = await argon2.hash(plaintext, { type: argon2.argon2id });
    insertKey(db, {
      id: keyId,
      hash,
      label: "retry test key",
      scopes: "ping",
      rate_limit_per_min: 1,
      created_at: Math.floor(Date.now() / 1000),
    });

    const authRes = await fetchApi("/auth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: plaintext }),
    });
    assert.equal(authRes.status, 200);
    const { token } = await authRes.json() as { token: string };

    // Use the one allowed request
    await fetchApi("/ping", { headers: { authorization: `Bearer ${token}` } });

    // Next request is rate limited
    const res = await fetchApi("/ping", { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 429);
    const retryAfter = res.headers.get("retry-after");
    assert.ok(retryAfter);
    const val = Number(retryAfter);
    assert.ok(Number.isInteger(val) && val > 0, `retry-after should be positive integer, got ${retryAfter}`);
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

  it("rejects non-localhost access with 403", async () => {
    // Use a non-localhost URL to test the hostname check
    const req = new Request("http://10.0.0.1/metrics");
    const res = await app().fetch(req);
    assert.equal(res.status, 403);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.error, "Forbidden");
  });

  it("allows metrics via trusted proxy (x-real-ip localhost)", async () => {
    const req = new Request("http://10.0.0.1/metrics", {
      headers: { "x-real-ip": "127.0.0.1" },
    });
    const res = await app().fetch(req);
    assert.equal(res.status, 200);
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

  it("idempotency key with different body returns 422", async () => {
    const token = await validToken();
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": "mismatch-test-001",
    };
    const body1 = JSON.stringify({ orderid: "1000000", operation: "0010", yield: 50 });
    const body2 = JSON.stringify({ orderid: "2000000", operation: "0020", yield: 100 });

    const res1 = await fetchApi("/confirmation", { method: "POST", headers, body: body1 });
    assert.equal(res1.status, 201);

    const res2 = await fetchApi("/confirmation", { method: "POST", headers, body: body2 });
    assert.equal(res2.status, 422);
    const data = await res2.json() as Record<string, unknown>;
    assert.match(data.error as string, /different request body/);
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

  it("POST /confirmation returns 422 when SAP rejects business logic", async () => {
    mockConfError = new ZzapiMesHttpError(422, "Order already confirmed");
    const token = await validToken();
    const res = await fetchApi("/confirmation", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "sapi-err-001",
      },
      body: JSON.stringify({ orderid: "1000000", operation: "0010", yield: 50 }),
    });
    assert.equal(res.status, 422);
  });

  it("POST /goods-issue returns 409 when SAP rejects backflush conflict", async () => {
    mockGiError = new ZzapiMesHttpError(409, "Backflush is active for this order");
    const token = await validToken();
    const res = await fetchApi("/goods-issue", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "sapi-gi-err-001",
      },
      body: JSON.stringify({ orderid: "1000000", matnr: "20000001", menge: 50, werks: "1000", lgort: "0001" }),
    });
    assert.equal(res.status, 409);
  });

  it("POST /goods-receipt returns 502 on SAP upstream failure", async () => {
    mockGrError = new ZzapiMesHttpError(500, "Internal Server Error");
    const token = await validToken();
    const res = await fetchApi("/goods-receipt", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "sapi-gr-502",
      },
      body: JSON.stringify({ ebeln: "4500000001", ebelp: "00010", menge: 100, werks: "1000", lgort: "0001" }),
    });
    assert.equal(res.status, 502);
  });

  it("POST /goods-receipt returns 422 when SAP rejects business logic", async () => {
    mockGrError = new ZzapiMesHttpError(422, "PO already received");
    const token = await validToken();
    const res = await fetchApi("/goods-receipt", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "sapi-gr-422",
      },
      body: JSON.stringify({ ebeln: "4500000001", ebelp: "00010", menge: 100, werks: "1000", lgort: "0001" }),
    });
    assert.equal(res.status, 422);
  });

  it("POST /confirmation returns 502 on SAP upstream failure", async () => {
    mockConfError = new ZzapiMesHttpError(500, "Internal Server Error");
    const token = await validToken();
    const res = await fetchApi("/confirmation", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "sapi-conf-502",
      },
      body: JSON.stringify({ orderid: "1000000", operation: "0010", yield: 50 }),
    });
    assert.equal(res.status, 502);
  });

  it("POST /goods-issue returns 502 on SAP upstream failure", async () => {
    mockGiError = new ZzapiMesHttpError(500, "Internal Server Error");
    const token = await validToken();
    const res = await fetchApi("/goods-issue", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "sapi-gi-502",
      },
      body: JSON.stringify({ orderid: "1000000", matnr: "20000001", menge: 50, werks: "1000", lgort: "0001" }),
    });
    assert.equal(res.status, 502);
  });

  it("POST /goods-issue returns 422 when SAP rejects business logic", async () => {
    mockGiError = new ZzapiMesHttpError(422, "Material not found");
    const token = await validToken();
    const res = await fetchApi("/goods-issue", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "sapi-gi-422",
      },
      body: JSON.stringify({ orderid: "1000000", matnr: "20000001", menge: 50, werks: "1000", lgort: "0001" }),
    });
    assert.equal(res.status, 422);
  });

  // --- Zod validation failures ---

  it("POST /confirmation returns 400 on invalid request body", async () => {
    const token = await validToken();
    const res = await fetchApi("/confirmation", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "zod-conf-001",
      },
      body: JSON.stringify({ orderid: "1000000", operation: "0010", yield: -1 }),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as Record<string, unknown>;
    assert.ok(String(body.error).includes("yield"));
  });

  it("POST /confirmation returns 400 on invalid postg_date format", async () => {
    const token = await validToken();
    const res = await fetchApi("/confirmation", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "zod-conf-date",
      },
      body: JSON.stringify({ orderid: "1000000", operation: "0010", yield: 50, postg_date: "2026-04-22" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as Record<string, unknown>;
    assert.ok(String(body.error).includes("postg_date"));
  });

  it("POST /goods-receipt returns 400 on invalid request body", async () => {
    const token = await validToken();
    const res = await fetchApi("/goods-receipt", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "zod-gr-001",
      },
      body: JSON.stringify({ ebeln: "4500000001", ebelp: "00010", menge: -5 }),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as Record<string, unknown>;
    assert.ok(String(body.error).includes("menge"));
  });

  it("POST /goods-issue returns 400 on invalid request body", async () => {
    const token = await validToken();
    const res = await fetchApi("/goods-issue", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "zod-gi-001",
      },
      body: JSON.stringify({ orderid: "1000000", matnr: "20000001", menge: -1 }),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as Record<string, unknown>;
    assert.ok(String(body.error).includes("menge"));
  });

  it("POST /goods-issue returns 400 on missing required fields", async () => {
    const token = await validToken();
    const res = await fetchApi("/goods-issue", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "zod-gi-missing",
      },
      body: JSON.stringify({ orderid: "1000000" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as Record<string, unknown>;
    assert.ok(String(body.error).includes("matnr") || String(body.error).includes("Required"));
  });

  // --- Malformed JSON body ---

  it("POST /confirmation returns 400 on malformed JSON body", async () => {
    const token = await validToken();
    const res = await fetchApi("/confirmation", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "malformed-conf",
      },
      body: "not valid json{",
    });
    assert.equal(res.status, 400);
    const body = await res.json() as Record<string, unknown>;
    assert.ok(String(body.error).includes("valid JSON"));
  });

  it("POST /goods-receipt returns 400 on malformed JSON body", async () => {
    const token = await validToken();
    const res = await fetchApi("/goods-receipt", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "malformed-gr",
      },
      body: "broken{",
    });
    assert.equal(res.status, 400);
    const body = await res.json() as Record<string, unknown>;
    assert.ok(String(body.error).includes("valid JSON"));
  });

  it("POST /goods-issue returns 400 on malformed JSON body", async () => {
    const token = await validToken();
    const res = await fetchApi("/goods-issue", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "malformed-gi",
      },
      body: "{invalid",
    });
    assert.equal(res.status, 400);
    const body = await res.json() as Record<string, unknown>;
    assert.ok(String(body.error).includes("valid JSON"));
  });

  // --- Idempotency duplicates for GR and GI ---

  it("POST /goods-receipt duplicate idempotency key returns 409", async () => {
    const token = await validToken();
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": "dup-gr-001",
    };
    const body = JSON.stringify({ ebeln: "4500000001", ebelp: "00010", menge: 100, werks: "1000", lgort: "0001" });

    const res1 = await fetchApi("/goods-receipt", { method: "POST", headers, body });
    assert.equal(res1.status, 201);

    const res2 = await fetchApi("/goods-receipt", { method: "POST", headers, body });
    assert.equal(res2.status, 409);
  });

  it("POST /goods-issue duplicate idempotency key returns 409", async () => {
    const token = await validToken();
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": "dup-gi-001",
    };
    const body = JSON.stringify({ orderid: "1000000", matnr: "20000001", menge: 50, werks: "1000", lgort: "0001" });

    const res1 = await fetchApi("/goods-issue", { method: "POST", headers, body });
    assert.equal(res1.status, 201);

    const res2 = await fetchApi("/goods-issue", { method: "POST", headers, body });
    assert.equal(res2.status, 409);
  });

  // --- Audit log verification ---

  it("POST /confirmation writes audit log entry", async () => {
    const token = await validToken();
    await fetchApi("/confirmation", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "audit-conf-001",
      },
      body: JSON.stringify({ orderid: "1000000", operation: "0010", yield: 50 }),
    });
    const row = db.prepare("SELECT method, path, sap_status FROM audit_log WHERE path = '/confirmation' ORDER BY rowid DESC LIMIT 1").get() as { method: string; path: string; sap_status: number } | undefined;
    assert.ok(row);
    assert.equal(row.method, "POST");
    assert.equal(row.path, "/confirmation");
    assert.equal(row.sap_status, 201);
  });

  it("POST /goods-receipt writes audit log entry", async () => {
    const token = await validToken();
    await fetchApi("/goods-receipt", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "audit-gr-001",
      },
      body: JSON.stringify({ ebeln: "4500000001", ebelp: "00010", menge: 100, werks: "1000", lgort: "0001" }),
    });
    const row = db.prepare("SELECT method, path, sap_status FROM audit_log WHERE path = '/goods-receipt' ORDER BY rowid DESC LIMIT 1").get() as { method: string; path: string; sap_status: number } | undefined;
    assert.ok(row);
    assert.equal(row.method, "POST");
    assert.equal(row.path, "/goods-receipt");
    assert.equal(row.sap_status, 201);
  });

  it("POST /goods-issue writes audit log entry", async () => {
    const token = await validToken();
    await fetchApi("/goods-issue", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "audit-gi-001",
      },
      body: JSON.stringify({ orderid: "1000000", matnr: "20000001", menge: 50, werks: "1000", lgort: "0001" }),
    });
    const row = db.prepare("SELECT method, path, sap_status FROM audit_log WHERE path = '/goods-issue' ORDER BY rowid DESC LIMIT 1").get() as { method: string; path: string; sap_status: number } | undefined;
    assert.ok(row);
    assert.equal(row.method, "POST");
    assert.equal(row.path, "/goods-issue");
    assert.equal(row.sap_status, 201);
  });

  it("truncates oversized audit body to bounded size", async () => {
    const huge = "x".repeat(10_000);
    writeAudit(db, {
      req_id: "r-trunc",
      key_id: "k-trunc",
      method: "POST",
      path: "/confirmation",
      body: huge,
      sap_status: 201,
    });
    const row = db.prepare("SELECT body FROM audit_log WHERE req_id = 'r-trunc'").get() as { body: string } | undefined;
    assert.ok(row);
    assert.ok(row.body.length < huge.length, "body must be truncated");
    assert.ok(row.body.includes("[truncated"), "body must carry truncation marker");
  });
});

describe("Access log middleware", () => {
  it("writes JSON log entry with correct fields", async () => {
    const token = await validToken();
    const reqId = "log-test-req-001";

    // Capture stdout
    const chunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Buffer | Uint8Array) => {
      if (typeof chunk === "string") chunks.push(chunk);
      return true;
    };

    try {
      await fetchApi("/ping", {
        headers: {
          authorization: `Bearer ${token}`,
          "x-request-id": reqId,
        },
      });
    } finally {
      process.stdout.write = origWrite;
    }

    const logLine = chunks.find((c) => c.includes(reqId));
    assert.ok(logLine, "log entry for our request-id should appear in stdout");

    const entry = JSON.parse(logLine!);
    assert.equal(entry.level, "info");
    assert.equal(entry.req_id, reqId);
    assert.equal(entry.method, "GET");
    assert.equal(entry.path, "/ping");
    assert.equal(entry.status, 200);
    assert.ok(typeof entry.latency_ms === "number" && entry.latency_ms >= 0);
    assert.ok(typeof entry.key_id === "string" && entry.key_id.length > 0);
    assert.match(entry.ts, /^\d{4}-\d{2}-\d{2}T/);
  });

  it("log entry for unauthenticated request has key_id dash", async () => {
    const chunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Buffer | Uint8Array) => {
      if (typeof chunk === "string") chunks.push(chunk);
      return true;
    };

    try {
      await fetchApi("/healthz");
    } finally {
      process.stdout.write = origWrite;
    }

    const logLine = chunks.find((c) => c.includes("healthz"));
    assert.ok(logLine, "log entry for healthz should appear");
    const entry = JSON.parse(logLine!);
    assert.equal(entry.key_id, "-");
    assert.equal(entry.path, "/healthz");
  });
});

describe("Failed write-back audit logging", () => {
  it("POST /confirmation writes audit on SAP 422 rejection", async () => {
    mockConfError = new ZzapiMesHttpError(422, "Order already confirmed");
    const token = await validToken();
    await fetchApi("/confirmation", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "audit-err-conf-001",
      },
      body: JSON.stringify({ orderid: "1000000", operation: "0010", yield: 50 }),
    });
    const row = db.prepare("SELECT sap_status FROM audit_log WHERE path = '/confirmation' ORDER BY rowid DESC LIMIT 1").get() as { sap_status: number } | undefined;
    assert.ok(row);
    assert.equal(row.sap_status, 422);
  });

  it("POST /goods-receipt writes audit on SAP 502 upstream failure", async () => {
    mockGrError = new ZzapiMesHttpError(500, "Internal Server Error");
    const token = await validToken();
    await fetchApi("/goods-receipt", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "audit-err-gr-001",
      },
      body: JSON.stringify({ ebeln: "4500000001", ebelp: "00010", menge: 100, werks: "1000", lgort: "0001" }),
    });
    const row = db.prepare("SELECT sap_status FROM audit_log WHERE path = '/goods-receipt' ORDER BY rowid DESC LIMIT 1").get() as { sap_status: number } | undefined;
    assert.ok(row);
    assert.equal(row.sap_status, 500);
  });

  it("POST /goods-issue writes audit on SAP 409 conflict", async () => {
    mockGiError = new ZzapiMesHttpError(409, "Backflush conflict");
    const token = await validToken();
    await fetchApi("/goods-issue", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "audit-err-gi-001",
      },
      body: JSON.stringify({ orderid: "1000000", matnr: "20000001", menge: 50, werks: "1000", lgort: "0001" }),
    });
    const row = db.prepare("SELECT sap_status FROM audit_log WHERE path = '/goods-issue' ORDER BY rowid DESC LIMIT 1").get() as { sap_status: number } | undefined;
    assert.ok(row);
    assert.equal(row.sap_status, 409);
  });
});

describe("Path parameter validation", () => {
  it("GET /po/:ebeln rejects ebeln longer than 10 chars", async () => {
    const token = await validToken();
    const res = await fetchApi(`/po/${"A".repeat(11)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 400);
    const body = await res.json() as Record<string, unknown>;
    assert.ok(String(body.error).includes("ebeln"));
  });

  it("GET /po/:ebeln rejects ebeln with special characters", async () => {
    const token = await validToken();
    const res = await fetchApi(`/po/123%3B456`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 400);
    const body = await res.json() as Record<string, unknown>;
    assert.ok(String(body.error).includes("invalid characters"));
  });

  it("GET /prod-order/:aufnr rejects aufnr longer than 12 chars", async () => {
    const token = await validToken();
    const res = await fetchApi(`/prod-order/${"A".repeat(13)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 400);
  });

  it("GET /prod-order/:aufnr rejects aufnr with special characters", async () => {
    const token = await validToken();
    const res = await fetchApi(`/prod-order/123%3Cscript%3E`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 400);
    const body = await res.json() as Record<string, unknown>;
    assert.ok(String(body.error).includes("invalid characters"));
  });

  it("GET /material/:matnr allows matnr up to 18 chars", async () => {
    const token = await validToken();
    const res = await fetchApi(`/material/${"1".repeat(18)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    // Should reach SAP (200 or error from mock), not 400 from validation
    assert.notEqual(res.status, 400);
  });

  it("GET /material/:matnr rejects matnr with special characters", async () => {
    const token = await validToken();
    const res = await fetchApi(`/material/123%27OR%201%3D1`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 400);
  });

  it("GET /work-center/:arbpl rejects arbpl longer than 8 chars", async () => {
    const token = await validToken();
    const res = await fetchApi(`/work-center/${"A".repeat(9)}?werks=1000`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 400);
  });

  it("GET /work-center/:arbpl rejects arbpl with special characters", async () => {
    const token = await validToken();
    const res = await fetchApi(`/work-center/AB%20CD?werks=1000`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 400);
  });
});

describe("Request body size limit", () => {
  it("rejects request body larger than 1 MB with 413", async () => {
    const token = await validToken();
    const bigBody = "x".repeat(1_048_577); // just over 1 MB
    const res = await fetchApi("/confirmation", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "content-length": String(bigBody.length),
        "idempotency-key": "oversized-001",
      },
      body: bigBody,
    });
    assert.equal(res.status, 413);
    const body = await res.json() as Record<string, unknown>;
    assert.ok(String(body.error).includes("too large"));
  });

  it("rejects chunked body larger than 1 MB with 413", async () => {
    const token = await validToken();
    // No content-length header → triggers chunked body limit path
    const bigBody = "x".repeat(1_048_577);
    const res = await fetchApi("/confirmation", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "chunked-oversized-001",
      },
      body: bigBody,
    });
    assert.equal(res.status, 413);
  });

  it("chunked body under limit reaches handler successfully", async () => {
    const token = await validToken();
    // No content-length header → chunked path, but body is small and valid
    const res = await fetchApi("/confirmation", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "chunked-ok-001",
      },
      body: JSON.stringify({ orderid: "1000000", operation: "0010", yield: 50 }),
    });
    assert.equal(res.status, 201);
    const data = await res.json() as Record<string, unknown>;
    assert.equal(data.status, "confirmed");
  });
});

describe("JWT edge cases", () => {
  it("rejects JWT signed with wrong secret", async () => {
    const forged = await sign(
      { key_id: "testkey1234", scopes: ["ping"], iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 900 },
      "wrong-secret-12345",
    );
    const res = await fetchApi("/ping", { headers: { authorization: `Bearer ${forged}` } });
    assert.equal(res.status, 401);
  });

  it("rejects empty bearer token", async () => {
    const res = await fetchApi("/ping", { headers: { authorization: "Bearer " } });
    assert.equal(res.status, 401);
  });

  it("rejects token missing scopes claim", async () => {
    const noScopes = await sign(
      { key_id: "testkey1234", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 900 },
      JWT_SECRET,
    );
    const res = await fetchApi("/ping", { headers: { authorization: `Bearer ${noScopes}` } });
    // Token verifies but scope is empty → 403
    assert.equal(res.status, 403);
  });
});

describe("Query parameter validation", () => {
  it("rejects werks exceeding maxLength on /stock", async () => {
    const token = await validToken();
    const res = await fetchApi("/stock/10000001?werks=ABCDE&lgort=0001", { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 400);
    const body = await res.json() as Record<string, unknown>;
    assert.ok(String(body.error).includes("werks"));
  });

  it("rejects lgort exceeding maxLength on /stock", async () => {
    const token = await validToken();
    const res = await fetchApi("/stock/10000001?werks=1000&lgort=ABCDE", { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 400);
    const body = await res.json() as Record<string, unknown>;
    assert.ok(String(body.error).includes("lgort"));
  });

  it("rejects werks exceeding maxLength on /routing", async () => {
    const token = await validToken();
    const res = await fetchApi("/routing/10000001?werks=ABCDE", { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 400);
  });

  it("rejects werks exceeding maxLength on /work-center", async () => {
    const token = await validToken();
    const res = await fetchApi("/work-center/TURN1?werks=ABCDE", { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 400);
  });

  it("rejects werks exceeding maxLength on /material", async () => {
    const token = await validToken();
    const res = await fetchApi("/material/10000001?werks=ABCDE", { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 400);
  });

  it("rejects werks with special characters on /stock", async () => {
    const token = await validToken();
    const res = await fetchApi("/stock/10000001?werks=1%3B00&lgort=0001", { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 400);
    const body = await res.json() as Record<string, unknown>;
    assert.ok(String(body.error).includes("invalid characters"));
  });
});

describe("Auth rate limiting", () => {
  it("rate-limits /auth/token after 10 attempts from same IP", async () => {
    // Create a single app instance so the in-memory bucket persists across requests
    const testApp = app();
    const headers = { "content-type": "application/json", "x-real-ip": "10.0.0.99" };
    const body = JSON.stringify({ api_key: "wrong.key" });

    async function fetchSameApp(path: string, opts?: RequestInit) {
      const req = new Request(`http://localhost${path}`, opts);
      return await testApp.fetch(req);
    }

    // First 10 should not be rate-limited (they'll return 401 for wrong key)
    for (let i = 0; i < 10; i++) {
      const res = await fetchSameApp("/auth/token", { method: "POST", headers, body });
      assert.equal(res.status, 401, `attempt ${i + 1} should be 401, not rate-limited`);
    }

    // 11th should be rate-limited
    const res = await fetchSameApp("/auth/token", { method: "POST", headers, body });
    assert.equal(res.status, 429);
    const data = await res.json() as Record<string, unknown>;
    assert.ok(String(data.error).includes("Auth rate limit"));
    assert.ok(res.headers.get("retry-after"));
  });
});

describe("Rate limit per min = 0", () => {
  it("rejects request with rate_limit_per_min=0", async () => {
    const zeroRpmToken = await sign(
      { key_id: "testkey1234", scopes: ["ping"], rate_limit_per_min: 0, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 900 },
      JWT_SECRET,
    );
    const res = await fetchApi("/ping", { headers: { authorization: `Bearer ${zeroRpmToken}` } });
    assert.equal(res.status, 403);
  });
});

describe("Empty Idempotency-Key header", () => {
  it("rejects empty string idempotency-key", async () => {
    const token = await validToken();
    const res = await fetchApi("/confirmation", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "",
      },
      body: JSON.stringify({ orderid: "1000000", operation: "0010", yield: 50 }),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as Record<string, unknown>;
    assert.ok(String(body.error).includes("Idempotency-Key"));
  });

  it("rejects whitespace-only idempotency-key", async () => {
    const token = await validToken();
    const res = await fetchApi("/confirmation", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "   ",
      },
      body: JSON.stringify({ orderid: "1000000", operation: "0010", yield: 50 }),
    });
    assert.equal(res.status, 400);
  });

  it("rejects idempotency-key exceeding maxLength 128", async () => {
    const token = await validToken();
    const res = await fetchApi("/confirmation", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "x".repeat(129),
      },
      body: JSON.stringify({ orderid: "1000000", operation: "0010", yield: 50 }),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as Record<string, unknown>;
    assert.ok(String(body.error).includes("128"));
  });
});

describe("Idempotency key reuse across routes", () => {
  it("rejects same idempotency key on a different route", async () => {
    const token = await validToken();
    const confBody = JSON.stringify({ orderid: "1000000", operation: "0010", yield: 50 });
    const confRes = await fetchApi("/confirmation", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "cross-route-1",
      },
      body: confBody,
    });
    assert.equal(confRes.status, 201);

    const grBody = JSON.stringify({ ebeln: "4500000001", ebelp: "00010", menge: 100, werks: "1000", lgort: "0001" });
    const grRes = await fetchApi("/goods-receipt", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "cross-route-1",
      },
      body: grBody,
    });
    // Same idempotency key on different route → 422 (hash mismatch) or 409
    assert.ok(grRes.status === 409 || grRes.status === 422, `Expected 409 or 422, got ${grRes.status}`);
  });
});

describe("405 Method Not Allowed", () => {
  it("POST /ping returns 405", async () => {
    const token = await validToken();
    const res = await fetchApi("/ping", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 405);
    const body = await res.json() as Record<string, unknown>;
    assert.ok(String(body.error).includes("not allowed"));
  });

  it("POST /po/:ebeln returns 405", async () => {
    const token = await validToken();
    const res = await fetchApi("/po/3010000608", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 405);
  });

  it("GET /confirmation returns 405", async () => {
    const token = await validToken();
    const res = await fetchApi("/confirmation", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 405);
    const body = await res.json() as Record<string, unknown>;
    assert.ok(String(body.error).includes("not allowed"));
  });

  it("GET /goods-receipt returns 405", async () => {
    const token = await validToken();
    const res = await fetchApi("/goods-receipt", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 405);
  });

  it("GET /goods-issue returns 405", async () => {
    const token = await validToken();
    const res = await fetchApi("/goods-issue", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 405);
  });

  it("GET /auth/token returns 405", async () => {
    const res = await fetchApi("/auth/token");
    assert.equal(res.status, 405);
  });

  it("POST /healthz returns 405", async () => {
    const res = await fetchApi("/healthz", { method: "POST" });
    assert.equal(res.status, 405);
  });

  it("POST /metrics returns 405", async () => {
    const res = await fetchApi("/metrics", { method: "POST" });
    assert.equal(res.status, 405);
  });

  it("PUT /ping returns 405", async () => {
    const token = await validToken();
    const res = await fetchApi("/ping", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 405);
  });

  it("DELETE /po/:ebeln returns 405", async () => {
    const token = await validToken();
    const res = await fetchApi("/po/3010000608", {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 405);
  });

  it("PUT /confirmation returns 405", async () => {
    const token = await validToken();
    const res = await fetchApi("/confirmation", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 405);
  });
});

describe("Security headers", () => {
  it("sets X-Content-Type-Options nosniff", async () => {
    const res = await fetchApi("/healthz");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  });

  it("sets X-Frame-Options DENY", async () => {
    const res = await fetchApi("/healthz");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
  });

  it("sets Cache-Control no-store on /auth/token", async () => {
    const res = await fetchApi("/auth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: testKeyPlaintext }),
    });
    assert.equal(res.headers.get("cache-control"), "no-store");
  });

  it("does not set Cache-Control on other routes", async () => {
    const res = await fetchApi("/healthz");
    assert.equal(res.headers.get("cache-control"), null);
  });

  it("sets Referrer-Policy no-referrer", async () => {
    const res = await fetchApi("/healthz");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  });
});

describe("GET route SAP error handling", () => {
  it("maps SAP timeout 408 to 504 on /ping", async () => {
    mockPingError = new ZzapiMesHttpError(408, "SAP request timeout");
    const token = await validToken(["ping"]);
    const res = await fetchApi("/ping", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 504);
    const body = await res.json() as { error: string };
    assert.match(body.error, /timeout/i);
  });

  it("maps SAP timeout 408 to 504 on /po/:ebeln", async () => {
    mockPoError = new ZzapiMesHttpError(408, "SAP request timeout");
    const token = await validToken(["po"]);
    const res = await fetchApi("/po/3010000608", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 504);
  });

  it("maps SAP timeout 408 to 504 on /prod-order/:aufnr", async () => {
    mockProdOrderError = new ZzapiMesHttpError(408, "SAP request timeout");
    const token = await validToken(["prod_order"]);
    const res = await fetchApi("/prod-order/1000000", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 504);
  });

  it("passes SAP 500 through on /ping", async () => {
    mockPingError = new ZzapiMesHttpError(500, "SAP internal error");
    const token = await validToken(["ping"]);
    const res = await fetchApi("/ping", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 500);
  });

  it("returns 502 on non-ZzapiMesHttpError from SAP", async () => {
    // Temporarily override ping to throw a plain Error
    const origPing = MockSapClient.prototype.ping;
    MockSapClient.prototype.ping = async () => { throw new Error("Network failure"); };
    const token = await validToken(["ping"]);
    const res = await fetchApi("/ping", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 502);
    MockSapClient.prototype.ping = origPing;
  });

  it("maps SAP timeout 408 to 504 on /material/:matnr", async () => {
    mockMaterialError = new ZzapiMesHttpError(408, "SAP request timeout");
    const token = await validToken(["material"]);
    const res = await fetchApi("/material/10000001", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 504);
  });

  it("maps SAP timeout 408 to 504 on /stock/:matnr", async () => {
    mockStockError = new ZzapiMesHttpError(408, "SAP request timeout");
    const token = await validToken(["stock"]);
    const res = await fetchApi("/stock/10000001?werks=1000", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 504);
  });

  it("maps SAP timeout 408 to 504 on /routing/:matnr", async () => {
    mockRoutingError = new ZzapiMesHttpError(408, "SAP request timeout");
    const token = await validToken(["routing"]);
    const res = await fetchApi("/routing/10000001?werks=1000", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 504);
  });

  it("maps SAP timeout 408 to 504 on /work-center/:arbpl", async () => {
    mockWorkCenterError = new ZzapiMesHttpError(408, "SAP request timeout");
    const token = await validToken(["work_center"]);
    const res = await fetchApi("/work-center/TURN1?werks=1000", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 504);
  });

  it("maps SAP timeout 408 to 504 on /po/:ebeln/items", async () => {
    mockPoItemsError = new ZzapiMesHttpError(408, "SAP request timeout");
    const token = await validToken(["po"]);
    const res = await fetchApi("/po/4500000001/items", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 504);
  });
});

describe("POST route SAP timeout handling", () => {
  async function writeBack(token: string, path: string, body: Record<string, unknown>, idemKey: string) {
    return fetchApi(path, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": idemKey,
      },
      body: JSON.stringify(body),
    });
  }

  it("maps SAP timeout 408 to 504 on POST /confirmation", async () => {
    mockConfError = new ZzapiMesHttpError(408, "SAP request timeout");
    const token = await validToken(["conf"]);
    const res = await writeBack(token, "/confirmation", {
      orderid: "1000000", operation: "0010", yield: 50,
    }, `conf-408-${Date.now()}`);
    assert.equal(res.status, 504);
  });

  it("maps SAP timeout 408 to 504 on POST /goods-receipt", async () => {
    mockGrError = new ZzapiMesHttpError(408, "SAP request timeout");
    const token = await validToken(["gr"]);
    const res = await writeBack(token, "/goods-receipt", {
      ebeln: "4500000001", ebelp: "00010", menge: 100, werks: "1000", lgort: "0001",
    }, `gr-408-${Date.now()}`);
    assert.equal(res.status, 504);
  });

  it("maps SAP timeout 408 to 504 on POST /goods-issue", async () => {
    mockGiError = new ZzapiMesHttpError(408, "SAP request timeout");
    const token = await validToken(["gi"]);
    const res = await writeBack(token, "/goods-issue", {
      orderid: "1000000", matnr: "10000001", menge: 50, werks: "1000", lgort: "0001",
    }, `gi-408-${Date.now()}`);
    assert.equal(res.status, 504);
  });
});

describe("Graceful shutdown closes DB", () => {
  it("createApp returns db that can be closed", () => {
    const { db: appDb } = createApp(new MockSapClient() as unknown as SapClient, { db });
    assert.doesNotThrow(() => appDb.close());
  });

  it("double-close is safe — no throw or caught (matches shutdown pattern)", () => {
    const testDb = new Database(":memory:");
    runMigrations(testDb);
    testDb.close();
    // better-sqlite3 double-close is a no-op (no throw) on modern Node.
    // Our shutdown code wraps db.close() in try/catch — safe regardless.
    assert.doesNotThrow(() => testDb.close());
  });
});

describe("Rate limit 429 on write-back route", () => {
  it("returns 429 when bucket exhausted on POST /confirmation", async () => {
    _resetBucketsForTest();
    const keyId = "wbratelimited";
    const secret = "wbratelimitedsecret123456789abcd";
    const plaintext = `${keyId}.${secret}`;
    const hash = await argon2.hash(plaintext, { type: argon2.argon2id });
    insertKey(db, {
      id: keyId,
      hash,
      label: "write-back rate limit key",
      scopes: "conf,gr,gi",
      rate_limit_per_min: 1,
      created_at: Math.floor(Date.now() / 1000),
    });

    const authRes = await fetchApi("/auth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: plaintext }),
    });
    assert.equal(authRes.status, 200);
    const { token } = await authRes.json() as { token: string };

    // First request succeeds
    const res1 = await fetchApi("/confirmation", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "rlim-wb-1",
      },
      body: JSON.stringify({ orderid: "1000000", operation: "0010", yield: 50 }),
    });
    assert.equal(res1.status, 201);

    // Second request should be rate limited
    const res2 = await fetchApi("/confirmation", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "rlim-wb-2",
      },
      body: JSON.stringify({ orderid: "1000000", operation: "0010", yield: 50 }),
    });
    assert.equal(res2.status, 429);
  });
});

describe("SAP 5xx error sanitization on write-back", () => {
  it("returns generic message for SAP 500 error", async () => {
    mockConfError = new ZzapiMesHttpError(500, "Internal SAP short dump in table T001");
    const token = await validToken(["conf"]);
    const res = await fetchApi("/confirmation", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": `san-500-${Date.now()}`,
      },
      body: JSON.stringify({ orderid: "1000000", operation: "0010", yield: 50 }),
    });
    assert.equal(res.status, 502);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.error, "SAP upstream error");
  });

  it("preserves upstream message for SAP 422 business rule error", async () => {
    mockGrError = new ZzapiMesHttpError(422, "Order already has full quantity received");
    const token = await validToken(["gr"]);
    const res = await fetchApi("/goods-receipt", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": `san-422-${Date.now()}`,
      },
      body: JSON.stringify({ ebeln: "4500000001", ebelp: "00010", menge: 100, werks: "1000", lgort: "0001" }),
    });
    assert.equal(res.status, 422);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.error, "Order already has full quantity received");
  });

  it("preserves upstream message for SAP 409 conflict error", async () => {
    mockGiError = new ZzapiMesHttpError(409, "Backflush conflict: operation locked");
    const token = await validToken(["gi"]);
    const res = await fetchApi("/goods-issue", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": `san-409-${Date.now()}`,
      },
      body: JSON.stringify({ orderid: "1000000", matnr: "10000001", menge: 50, werks: "1000", lgort: "0001" }),
    });
    assert.equal(res.status, 409);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.error, "Backflush conflict: operation locked");
  });
});

describe("Admin CLI key revoke", () => {
  it("revokeKey returns true and marks key as revoked", async () => {
    const keyId = "revokeme";
    const secret = "revokemesecret123456789abcdef0";
    const plaintext = `${keyId}.${secret}`;
    const hash = await argon2.hash(plaintext, { type: argon2.argon2id });
    insertKey(db, {
      id: keyId,
      hash,
      label: "revoke test key",
      scopes: "ping",
      rate_limit_per_min: null,
      created_at: Math.floor(Date.now() / 1000),
    });

    const ok = revokeKey(db, keyId);
    assert.equal(ok, true);

    // Verify revoked_at is set
    const row = db.prepare("SELECT revoked_at FROM api_keys WHERE id = ?").get(keyId) as { revoked_at: number | null } | undefined;
    assert.ok(row);
    assert.ok(row.revoked_at !== null);
  });

  it("revokeKey returns false for non-existent key", () => {
    const ok = revokeKey(db, "nosuchkey");
    assert.equal(ok, false);
  });

  it("revokeKey returns false for already-revoked key", async () => {
    const keyId = "alreadyrevoked";
    const secret = "alreadyrevokedsecret123456789ab";
    const plaintext = `${keyId}.${secret}`;
    const hash = await argon2.hash(plaintext, { type: argon2.argon2id });
    insertKey(db, {
      id: keyId,
      hash,
      label: "double revoke test",
      scopes: "ping",
      rate_limit_per_min: null,
      created_at: Math.floor(Date.now() / 1000),
    });

    const first = revokeKey(db, keyId);
    assert.equal(first, true);
    const second = revokeKey(db, keyId);
    assert.equal(second, false);
  });

  it("revoked key cannot exchange for JWT", async () => {
    const keyId = "authrevoked";
    const secret = "authrevokedsecret123456789abcde";
    const plaintext = `${keyId}.${secret}`;
    const hash = await argon2.hash(plaintext, { type: argon2.argon2id });
    insertKey(db, {
      id: keyId,
      hash,
      label: "auth revoke test",
      scopes: "ping",
      rate_limit_per_min: null,
      created_at: Math.floor(Date.now() / 1000),
    });

    // Revoke it
    revokeKey(db, keyId);

    // Try to get a token — should fail
    const res = await fetchApi("/auth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: plaintext }),
    });
    assert.equal(res.status, 401);
  });
});
