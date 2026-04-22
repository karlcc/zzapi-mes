import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server.js";
import { SapClient, ZzapiMesHttpError } from "@zzapi-mes/core";
import type { PingResponse, PoResponse } from "@zzapi-mes/core";
import { sign } from "hono/jwt";

const JWT_SECRET = "test-secret";
const API_KEY = "test-key-123";

// Set env vars before creating app
process.env.HUB_JWT_SECRET = JWT_SECRET;
process.env.HUB_API_KEYS = API_KEY;

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

beforeEach(() => {
  mockPingResult = { ok: true, sap_time: "20260422163000" };
  mockPoResult = { ebeln: "3010000608", aedat: "20170306", lifnr: "0000500340", eindt: "20170630" };
  mockPingError = null;
  mockPoError = null;
});

// --- Helpers ---

function app() {
  return createApp(new MockSapClient() as unknown as SapClient);
}

async function fetchApi(path: string, opts?: RequestInit) {
  const req = new Request(`http://localhost${path}`, opts);
  return app().fetch(req);
}

async function validToken(): Promise<string> {
  return sign({ sub: "test-user", exp: Math.floor(Date.now() / 1000) + 900 }, JWT_SECRET);
}

async function expiredToken(): Promise<string> {
  return sign({ sub: "test-user", exp: Math.floor(Date.now() / 1000) - 60 }, JWT_SECRET);
}

// --- Tests ---

describe("POST /auth/token", () => {
  it("issues JWT for valid API key", async () => {
    const res = await fetchApi("/auth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: API_KEY }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(typeof body.token === "string");
    assert.equal(body.expires_in, 900);
  });

  it("rejects invalid API key with 401", async () => {
    const res = await fetchApi("/auth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: "wrong" }),
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
    const body = await res.json();
    assert.equal(body.ok, true);
  });

  it("GET /po/:ebeln proxies to SAP", async () => {
    const token = await validToken();
    const res = await fetchApi("/po/3010000608", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
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
    const body = await res.json();
    assert.equal(body.error, "PO not found");
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
    const body = await res.json();
    assert.equal(body.ok, true);
  });
});
