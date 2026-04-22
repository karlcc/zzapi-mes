import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server.js";
import { SapClient, ZzapiMesHttpError } from "@zzapi-mes/core";
import type { PingResponse, PoResponse } from "@zzapi-mes/core";
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

async function seedTestKey(scopes = "ping,po"): Promise<string> {
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
}

beforeEach(async () => {
  mockPingResult = { ok: true, sap_time: "20260422163000" };
  mockPoResult = { ebeln: "3010000608", aedat: "20170306", lifnr: "0000500340", eindt: "20170630" };
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

async function validToken(scopes = ["ping", "po"]): Promise<string> {
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
