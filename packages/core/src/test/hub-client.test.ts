import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { HubClient, ZzapiMesHttpError } from "../index.js";
import type { PingResponse, PoResponse } from "../index.js";

const BASE = "http://hub.test:8080";
const API_KEY = "test-api-key";
const JWT_SECRET = "test-jwt-secret";

let origFetch: typeof globalThis.fetch;
let capturedUrl: string | undefined;
let capturedOpts: RequestInit | undefined;
let capturedUrls: string[] = [];

function mockFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  return async (url: string | URL | Request, init?: RequestInit) => {
    const u = url.toString();
    capturedUrl = u;
    capturedOpts = init;
    capturedUrls.push(u);
    return impl(u, init);
  };
}

function jsonResponse(status: number, body: object) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  origFetch = globalThis.fetch;
  capturedUrl = undefined;
  capturedOpts = undefined;
  capturedUrls = [];
});
afterEach(() => { globalThis.fetch = origFetch; });

describe("HubClient", () => {
  it("fetches JWT on first request", async () => {
    let callCount = 0;
    globalThis.fetch = mockFetch((url) => {
      callCount++;
      if (url.endsWith("/auth/token")) {
        return jsonResponse(200, { token: "jwt-abc", expires_in: 900 });
      }
      return jsonResponse(200, { ok: true, sap_time: "20260422163000" });
    });

    const client = new HubClient({ url: BASE, apiKey: API_KEY });
    await client.ping();

    assert.equal(callCount, 2); // 1 auth + 1 ping
    assert.match(capturedUrls[0], /\/auth\/token$/);
    assert.match(capturedUrls[1], /\/ping$/);
  });

  it("sends API key in auth request body", async () => {
    let authBody: string | undefined;
    globalThis.fetch = mockFetch((url, init) => {
      if (url.endsWith("/auth/token")) {
        authBody = init?.body as string;
        return jsonResponse(200, { token: "jwt-abc", expires_in: 900 });
      }
      return jsonResponse(200, { ok: true, sap_time: "20260422163000" });
    });

    const client = new HubClient({ url: BASE, apiKey: API_KEY });
    await client.ping();

    assert.ok(authBody);
    const body = JSON.parse(authBody);
    assert.equal(body.api_key, API_KEY);
  });

  it("caches JWT and reuses it for subsequent requests", async () => {
    let authCalls = 0;
    globalThis.fetch = mockFetch((url) => {
      if (url.endsWith("/auth/token")) {
        authCalls++;
        return jsonResponse(200, { token: "jwt-abc", expires_in: 900 });
      }
      return jsonResponse(200, { ok: true, sap_time: "20260422163000" });
    });

    const client = new HubClient({ url: BASE, apiKey: API_KEY });
    await client.ping();
    await client.ping();

    assert.equal(authCalls, 1); // Only one auth call, token reused
  });

  it("sends Bearer token on protected requests", async () => {
    const capturedHeaders: Record<string, string>[] = [];
    globalThis.fetch = mockFetch((url, init) => {
      if (url.endsWith("/auth/token")) {
        return jsonResponse(200, { token: "jwt-abc", expires_in: 900 });
      }
      if (init?.headers) capturedHeaders.push(init.headers as Record<string, string>);
      return jsonResponse(200, { ok: true, sap_time: "20260422163000" });
    });

    const client = new HubClient({ url: BASE, apiKey: API_KEY });
    await client.ping();

    assert.equal(capturedHeaders.length, 1);
    assert.equal(capturedHeaders[0].authorization, "Bearer jwt-abc");
  });

  it("retries with new JWT on 401", async () => {
    let authCalls = 0;
    let pingCalls = 0;
    globalThis.fetch = mockFetch((url) => {
      if (url.endsWith("/auth/token")) {
        authCalls++;
        return jsonResponse(200, { token: `jwt-${authCalls}`, expires_in: 900 });
      }
      pingCalls++;
      if (pingCalls === 1) {
        return jsonResponse(401, { error: "Invalid or expired token" });
      }
      return jsonResponse(200, { ok: true, sap_time: "20260422163000" });
    });

    const client = new HubClient({ url: BASE, apiKey: API_KEY });
    const result = await client.ping();

    assert.equal(authCalls, 2); // Initial + retry after 401
    assert.equal(pingCalls, 2); // First failed + retry
    assert.equal(result.ok, true);
  });

  it("throws on auth failure", async () => {
    globalThis.fetch = mockFetch((url) => {
      if (url.endsWith("/auth/token")) {
        return jsonResponse(401, { error: "Invalid API key" });
      }
      return jsonResponse(200, { ok: true, sap_time: "20260422163000" });
    });

    const client = new HubClient({ url: BASE, apiKey: "wrong-key" });
    await assert.rejects(() => client.ping(), (err: unknown) => {
      assert(err instanceof ZzapiMesHttpError);
      assert.equal(err.status, 401);
      assert.match(err.message, /Hub auth failed/);
      return true;
    });
  });

  it("getPo builds correct URL with ebeln", async () => {
    globalThis.fetch = mockFetch((url) => {
      if (url.endsWith("/auth/token")) {
        return jsonResponse(200, { token: "jwt-abc", expires_in: 900 });
      }
      return jsonResponse(200, { ebeln: "3010000608", aedat: "20170306", lifnr: "0000500340", eindt: "20170630" });
    });

    const client = new HubClient({ url: BASE, apiKey: API_KEY });
    const result = await client.getPo("3010000608");

    assert.equal(result.ebeln, "3010000608");
    assert.match(capturedUrl!, /\/po\/3010000608$/);
  });

  it("passthroughs error responses from hub", async () => {
    globalThis.fetch = mockFetch((url) => {
      if (url.endsWith("/auth/token")) {
        return jsonResponse(200, { token: "jwt-abc", expires_in: 900 });
      }
      return jsonResponse(404, { error: "PO not found" });
    });

    const client = new HubClient({ url: BASE, apiKey: API_KEY });
    await assert.rejects(() => client.getPo("999"), (err: unknown) => {
      assert(err instanceof ZzapiMesHttpError);
      assert.equal(err.status, 404);
      assert.equal(err.message, "PO not found");
      return true;
    });
  });

  it("throws on non-JSON response", async () => {
    globalThis.fetch = mockFetch((url) => {
      if (url.endsWith("/auth/token")) {
        return jsonResponse(200, { token: "jwt-abc", expires_in: 900 });
      }
      return new Response("<html>Error</html>", { status: 502, headers: { "content-type": "text/html" } });
    });

    const client = new HubClient({ url: BASE, apiKey: API_KEY });
    await assert.rejects(() => client.ping(), (err: unknown) => {
      assert(err instanceof ZzapiMesHttpError);
      assert.equal(err.status, 502);
      assert.match(err.message, /Non-JSON response/);
      return true;
    });
  });

  it("strips trailing slash from url", async () => {
    globalThis.fetch = mockFetch((url) => {
      if (url.endsWith("/auth/token")) {
        return jsonResponse(200, { token: "jwt-abc", expires_in: 900 });
      }
      return jsonResponse(200, { ok: true, sap_time: "20260422163000" });
    });

    const client = new HubClient({ url: `${BASE}/`, apiKey: API_KEY });
    await client.ping();
    assert.ok(!capturedUrl?.includes("8080//"));
  });
});
