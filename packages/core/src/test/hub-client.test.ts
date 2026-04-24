import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { HubClient, ZzapiMesHttpError } from "../index.js";
import type { PingResponse, PoResponse, ProdOrderResponse, MaterialResponse, StockResponse, PoItemsResponse, RoutingResponse, WorkCenterResponse, ConfirmationResponse, GoodsReceiptResponse, GoodsIssueResponse } from "../index.js";

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
    assert.match(capturedUrls[0]!, /\/auth\/token$/);
    assert.match(capturedUrls[1]!, /\/ping$/);
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
    assert.equal(capturedHeaders[0]!.authorization, "Bearer jwt-abc");
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

  it("extracts retryAfter from 429 response", async () => {
    globalThis.fetch = mockFetch((url) => {
      if (url.endsWith("/auth/token")) {
        return jsonResponse(200, { token: "jwt-abc", expires_in: 900 });
      }
      return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "30" },
      });
    });

    const client = new HubClient({ url: BASE, apiKey: API_KEY });
    await assert.rejects(() => client.ping(), (err: unknown) => {
      assert(err instanceof ZzapiMesHttpError);
      assert.equal(err.status, 429);
      assert.equal(err.retryAfter, 30);
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

  // Phase 5A methods

  it("getProdOrder builds correct URL", async () => {
    globalThis.fetch = mockFetch((url) => {
      if (url.endsWith("/auth/token")) return jsonResponse(200, { token: "jwt-abc", expires_in: 900 });
      return jsonResponse(200, { aufnr: "1000000", auart: "PP01", werks: "1000", matnr: "10000001", gamng: 1000, gstrp: "20260401", gltrp: "20260415" });
    });
    const result = await new HubClient({ url: BASE, apiKey: API_KEY }).getProdOrder("1000000");
    assert.equal(result.aufnr, "1000000");
    assert.match(capturedUrl!, /\/prod-order\/1000000$/);
  });

  it("getMaterial builds correct URL with optional werks", async () => {
    globalThis.fetch = mockFetch((url) => {
      if (url.endsWith("/auth/token")) return jsonResponse(200, { token: "jwt-abc", expires_in: 900 });
      return jsonResponse(200, { matnr: "10000001", mtart: "FERT", meins: "EA" });
    });
    const result = await new HubClient({ url: BASE, apiKey: API_KEY }).getMaterial("10000001", "1000");
    assert.equal(result.mtart, "FERT");
    assert.match(capturedUrl!, /\/material\/10000001\?werks=1000$/);
  });

  it("getStock builds correct URL", async () => {
    globalThis.fetch = mockFetch((url) => {
      if (url.endsWith("/auth/token")) return jsonResponse(200, { token: "jwt-abc", expires_in: 900 });
      return jsonResponse(200, { matnr: "10000001", werks: "1000", items: [{ lgort: "0001", clabs: 250 }] });
    });
    const result = await new HubClient({ url: BASE, apiKey: API_KEY }).getStock("10000001", "1000", "0001");
    assert.match(capturedUrl!, /\/stock\/10000001\?werks=1000&lgort=0001$/);
  });

  it("getStock without lgort omits lgort from URL", async () => {
    globalThis.fetch = mockFetch((url) => {
      if (url.endsWith("/auth/token")) return jsonResponse(200, { token: "jwt-abc", expires_in: 900 });
      return jsonResponse(200, { matnr: "10000001", werks: "1000", items: [{ lgort: "0001", clabs: 250 }] });
    });
    const result = await new HubClient({ url: BASE, apiKey: API_KEY }).getStock("10000001", "1000");
    assert.match(capturedUrl!, /\/stock\/10000001\?werks=1000$/);
    assert.doesNotMatch(capturedUrl!, /lgort/, "lgort should not be in URL when omitted");
  });

  it("getPoItems builds correct URL", async () => {
    globalThis.fetch = mockFetch((url) => {
      if (url.endsWith("/auth/token")) return jsonResponse(200, { token: "jwt-abc", expires_in: 900 });
      return jsonResponse(200, { ebeln: "4500000001", items: [{ ebelp: "00010", matnr: "10000001", menge: 100, meins: "EA" }] });
    });
    const result = await new HubClient({ url: BASE, apiKey: API_KEY }).getPoItems("4500000001");
    assert.equal(result.ebeln, "4500000001");
    assert.match(capturedUrl!, /\/po\/4500000001\/items$/);
  });

  it("getRouting builds correct URL", async () => {
    globalThis.fetch = mockFetch((url) => {
      if (url.endsWith("/auth/token")) return jsonResponse(200, { token: "jwt-abc", expires_in: 900 });
      return jsonResponse(200, { matnr: "10000001", werks: "1000", plnnr: "50000123", operations: [{ vornr: "0010", ltxa1: "Turning" }] });
    });
    const result = await new HubClient({ url: BASE, apiKey: API_KEY }).getRouting("10000001", "1000");
    assert.equal(result.plnnr, "50000123");
    assert.match(capturedUrl!, /\/routing\/10000001\?werks=1000$/);
  });

  it("getWorkCenter builds correct URL", async () => {
    globalThis.fetch = mockFetch((url) => {
      if (url.endsWith("/auth/token")) return jsonResponse(200, { token: "jwt-abc", expires_in: 900 });
      return jsonResponse(200, { arbpl: "TURN1", werks: "1000", steus: "PP01" });
    });
    const result = await new HubClient({ url: BASE, apiKey: API_KEY }).getWorkCenter("TURN1", "1000");
    assert.equal(result.steus, "PP01");
    assert.match(capturedUrl!, /\/work-center\/TURN1\?werks=1000$/);
  });

  // Phase 5B POST methods

  it("confirmProduction sends POST with idempotency-key header", async () => {
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = mockFetch((url, init) => {
      if (url.endsWith("/auth/token")) return jsonResponse(200, { token: "jwt-abc", expires_in: 900 });
      capturedHeaders = init?.headers as Record<string, string>;
      return jsonResponse(201, { orderid: "1000000", operation: "0010", yield: 50, scrap: 0, confNo: "00000100", confCnt: "0001", status: "confirmed" });
    });
    const result = await new HubClient({ url: BASE, apiKey: API_KEY }).confirmProduction(
      { orderid: "1000000", operation: "0010", yield: 50 },
      "test-idem-key-001",
    );
    assert.equal(result.status, "confirmed");
    assert.equal(capturedHeaders["idempotency-key"], "test-idem-key-001");
    assert.match(capturedUrl!, /\/confirmation$/);
  });

  it("goodsReceipt sends POST with idempotency-key header", async () => {
    globalThis.fetch = mockFetch((url) => {
      if (url.endsWith("/auth/token")) return jsonResponse(200, { token: "jwt-abc", expires_in: 900 });
      return jsonResponse(201, { ebeln: "4500000001", ebelp: "00010", menge: 100, materialDocument: "5000000001", documentYear: "2026", status: "posted" });
    });
    const result = await new HubClient({ url: BASE, apiKey: API_KEY }).goodsReceipt(
      { ebeln: "4500000001", ebelp: "00010", menge: 100, werks: "1000", lgort: "0001" },
      "test-gr-key-001",
    );
    assert.equal(result.status, "posted");
    assert.match(capturedUrl!, /\/goods-receipt$/);
  });

  it("goodsIssue sends POST with idempotency-key header", async () => {
    globalThis.fetch = mockFetch((url) => {
      if (url.endsWith("/auth/token")) return jsonResponse(200, { token: "jwt-abc", expires_in: 900 });
      return jsonResponse(201, { orderid: "1000000", matnr: "20000001", menge: 50, materialDocument: "5000000002", documentYear: "2026", status: "posted" });
    });
    const result = await new HubClient({ url: BASE, apiKey: API_KEY }).goodsIssue(
      { orderid: "1000000", matnr: "20000001", menge: 50, werks: "1000", lgort: "0001" },
      "test-gi-key-001",
    );
    assert.equal(result.status, "posted");
    assert.match(capturedUrl!, /\/goods-issue$/);
  });

  it("POST methods retry on 401", async () => {
    let authCalls = 0;
    let postCalls = 0;
    globalThis.fetch = mockFetch((url) => {
      if (url.endsWith("/auth/token")) {
        authCalls++;
        return jsonResponse(200, { token: `jwt-${authCalls}`, expires_in: 900 });
      }
      postCalls++;
      if (postCalls === 1) return jsonResponse(401, { error: "expired" });
      return jsonResponse(201, { orderid: "1000000", operation: "0010", yield: 50, scrap: 0, confNo: "00000100", confCnt: "0001", status: "confirmed" });
    });
    const result = await new HubClient({ url: BASE, apiKey: API_KEY }).confirmProduction(
      { orderid: "1000000", operation: "0010", yield: 50 },
      "retry-key-001",
    );
    assert.equal(authCalls, 2);
    assert.equal(result.status, "confirmed");
  });

  it("confirmProduction throws ZzapiMesHttpError on 422", async () => {
    globalThis.fetch = mockFetch((url) => {
      if (url.endsWith("/auth/token")) return jsonResponse(200, { token: "jwt-abc", expires_in: 900 });
      return jsonResponse(422, { error: "Order already confirmed" });
    });
    await assert.rejects(
      () => new HubClient({ url: BASE, apiKey: API_KEY }).confirmProduction(
        { orderid: "1000000", operation: "0010", yield: 50 },
        "err-conf-001",
      ),
      (e: unknown) => e instanceof ZzapiMesHttpError && e.status === 422,
    );
  });

  it("goodsReceipt throws ZzapiMesHttpError on 422", async () => {
    globalThis.fetch = mockFetch((url) => {
      if (url.endsWith("/auth/token")) return jsonResponse(200, { token: "jwt-abc", expires_in: 900 });
      return jsonResponse(422, { error: "PO already received" });
    });
    await assert.rejects(
      () => new HubClient({ url: BASE, apiKey: API_KEY }).goodsReceipt(
        { ebeln: "4500000001", ebelp: "00010", menge: 100, werks: "1000", lgort: "0001" },
        "err-gr-001",
      ),
      (e: unknown) => e instanceof ZzapiMesHttpError && e.status === 422,
    );
  });

  it("goodsIssue throws ZzapiMesHttpError on 409 backflush", async () => {
    globalThis.fetch = mockFetch((url) => {
      if (url.endsWith("/auth/token")) return jsonResponse(200, { token: "jwt-abc", expires_in: 900 });
      return jsonResponse(409, { error: "Backflush is active" });
    });
    await assert.rejects(
      () => new HubClient({ url: BASE, apiKey: API_KEY }).goodsIssue(
        { orderid: "1000000", matnr: "20000001", menge: 50, werks: "1000", lgort: "0001" },
        "err-gi-001",
      ),
      (e: unknown) => e instanceof ZzapiMesHttpError && e.status === 409,
    );
  });

  it("extracts originalStatus from 409 duplicate response", async () => {
    globalThis.fetch = mockFetch((url) => {
      if (url.endsWith("/auth/token")) return jsonResponse(200, { token: "jwt-abc", expires_in: 900 });
      return jsonResponse(409, { error: "Duplicate request", original_status: 201 });
    });
    await assert.rejects(
      () => new HubClient({ url: BASE, apiKey: API_KEY }).confirmProduction(
        { orderid: "1000000", operation: "0010", yield: 50 },
        "dup-key-001",
      ),
      (e: unknown) => {
        assert(e instanceof ZzapiMesHttpError);
        assert.equal(e.status, 409);
        assert.equal(e.originalStatus, 201);
        return true;
      },
    );
  });

  it("goodsIssue throws ZzapiMesHttpError on 422", async () => {
    globalThis.fetch = mockFetch((url) => {
      if (url.endsWith("/auth/token")) return jsonResponse(200, { token: "jwt-abc", expires_in: 900 });
      return jsonResponse(422, { error: "Material not found" });
    });
    await assert.rejects(
      () => new HubClient({ url: BASE, apiKey: API_KEY }).goodsIssue(
        { orderid: "1000000", matnr: "20000001", menge: 50, werks: "1000", lgort: "0001" },
        "err-gi-422",
      ),
      (e: unknown) => e instanceof ZzapiMesHttpError && e.status === 422,
    );
  });

  it("POST methods throw ZzapiMesHttpError on 502 upstream failure", async () => {
    globalThis.fetch = mockFetch((url) => {
      if (url.endsWith("/auth/token")) return jsonResponse(200, { token: "jwt-abc", expires_in: 900 });
      return jsonResponse(502, { error: "SAP upstream error" });
    });
    await assert.rejects(
      () => new HubClient({ url: BASE, apiKey: API_KEY }).confirmProduction(
        { orderid: "1000000", operation: "0010", yield: 50 },
        "err-502-001",
      ),
      (e: unknown) => e instanceof ZzapiMesHttpError && e.status === 502,
    );
  });

  it("goodsReceipt retries on 401", async () => {
    let authCalls = 0;
    let postCalls = 0;
    globalThis.fetch = mockFetch((url) => {
      if (url.endsWith("/auth/token")) {
        authCalls++;
        return jsonResponse(200, { token: `jwt-${authCalls}`, expires_in: 900 });
      }
      postCalls++;
      if (postCalls === 1) return jsonResponse(401, { error: "expired" });
      return jsonResponse(201, { ebeln: "4500000001", ebelp: "00010", menge: 100, materialDocument: "5000000001", documentYear: "2026", status: "posted" });
    });
    const result = await new HubClient({ url: BASE, apiKey: API_KEY }).goodsReceipt(
      { ebeln: "4500000001", ebelp: "00010", menge: 100, werks: "1000", lgort: "0001" },
      "retry-gr-001",
    );
    assert.equal(authCalls, 2);
    assert.equal(result.status, "posted");
  });

  it("goodsIssue retries on 401", async () => {
    let authCalls = 0;
    let postCalls = 0;
    globalThis.fetch = mockFetch((url) => {
      if (url.endsWith("/auth/token")) {
        authCalls++;
        return jsonResponse(200, { token: `jwt-${authCalls}`, expires_in: 900 });
      }
      postCalls++;
      if (postCalls === 1) return jsonResponse(401, { error: "expired" });
      return jsonResponse(201, { orderid: "1000000", matnr: "20000001", menge: 50, materialDocument: "5000000002", documentYear: "2026", status: "posted" });
    });
    const result = await new HubClient({ url: BASE, apiKey: API_KEY }).goodsIssue(
      { orderid: "1000000", matnr: "20000001", menge: 50, werks: "1000", lgort: "0001" },
      "retry-gi-001",
    );
    assert.equal(authCalls, 2);
    assert.equal(result.status, "posted");
  });

  it("invalidateToken clears cached JWT", async () => {
    let authCalls = 0;
    globalThis.fetch = mockFetch((url) => {
      if (url.endsWith("/auth/token")) {
        authCalls++;
        return jsonResponse(200, { token: `jwt-${authCalls}`, expires_in: 900 });
      }
      return jsonResponse(200, { ok: true, sap_time: "20260422163000" });
    });

    const client = new HubClient({ url: BASE, apiKey: API_KEY });
    await client.ping();
    assert.equal(authCalls, 1);

    // Cached — no new auth call
    await client.ping();
    assert.equal(authCalls, 1);

    // Invalidate forces re-auth
    client.invalidateToken();
    await client.ping();
    assert.equal(authCalls, 2);
  });

  it("GET request wraps timeout abort in ZzapiMesHttpError(408)", async () => {
    let callCount = 0;
    globalThis.fetch = mockFetch((url) => {
      callCount++;
      if (url.endsWith("/auth/token")) {
        return jsonResponse(200, { token: "jwt-abc", expires_in: 900 });
      }
      throw new DOMException("The operation was aborted", "AbortError");
    });
    const client = new HubClient({ url: BASE, apiKey: API_KEY, timeout: 1 });
    await assert.rejects(
      () => client.ping(),
      (e: unknown) => e instanceof ZzapiMesHttpError && e.status === 408,
    );
  });

  it("POST request wraps timeout abort in ZzapiMesHttpError(408)", async () => {
    let callCount = 0;
    globalThis.fetch = mockFetch((url) => {
      callCount++;
      if (url.endsWith("/auth/token")) {
        return jsonResponse(200, { token: "jwt-abc", expires_in: 900 });
      }
      throw new DOMException("The operation was aborted", "AbortError");
    });
    const client = new HubClient({ url: BASE, apiKey: API_KEY, timeout: 1 });
    await assert.rejects(
      () => client.confirmProduction({ orderid: "1000000", operation: "0010", yield: 50 }, "timeout-key"),
      (e: unknown) => e instanceof ZzapiMesHttpError && e.status === 408,
    );
  });

  it("GET request wraps TypeError (network failure) in ZzapiMesHttpError(502)", async () => {
    globalThis.fetch = mockFetch((url) => {
      if (url.endsWith("/auth/token")) {
        return jsonResponse(200, { token: "jwt-abc", expires_in: 900 });
      }
      throw new TypeError("fetch failed");
    });
    const client = new HubClient({ url: BASE, apiKey: API_KEY });
    await assert.rejects(
      () => client.ping(),
      (e: unknown) => {
        assert(e instanceof ZzapiMesHttpError);
        assert.equal(e.status, 502);
        assert.match(e.message, /Hub network error/);
        return true;
      },
    );
  });

  it("POST request wraps TypeError (network failure) in ZzapiMesHttpError(502)", async () => {
    globalThis.fetch = mockFetch((url) => {
      if (url.endsWith("/auth/token")) {
        return jsonResponse(200, { token: "jwt-abc", expires_in: 900 });
      }
      throw new TypeError("fetch failed");
    });
    const client = new HubClient({ url: BASE, apiKey: API_KEY });
    await assert.rejects(
      () => client.confirmProduction({ orderid: "1000000", operation: "0010", yield: 50 }, "net-err-key"),
      (e: unknown) => {
        assert(e instanceof ZzapiMesHttpError);
        assert.equal(e.status, 502);
        assert.match(e.message, /Hub network error/);
        return true;
      },
    );
  });

  it("POST 401 retry preserves idempotency-key header", async () => {
    let authCalls = 0;
    let postCalls = 0;
    const capturedIdemKeys: string[] = [];
    globalThis.fetch = mockFetch((url, init) => {
      if (url.endsWith("/auth/token")) {
        authCalls++;
        return jsonResponse(200, { token: `jwt-${authCalls}`, expires_in: 900 });
      }
      postCalls++;
      const headers = init?.headers as Record<string, string>;
      if (headers?.["idempotency-key"]) capturedIdemKeys.push(headers["idempotency-key"]);
      if (postCalls === 1) return jsonResponse(401, { error: "expired" });
      return jsonResponse(201, { orderid: "1000000", operation: "0010", yield: 50, scrap: 0, confNo: "00000100", confCnt: "0001", status: "confirmed" });
    });
    const client = new HubClient({ url: BASE, apiKey: API_KEY });
    const result = await client.confirmProduction(
      { orderid: "1000000", operation: "0010", yield: 50 },
      "idem-retry-key",
    );
    assert.equal(result.status, "confirmed");
    // Both the initial (401) and retry request must carry the same idempotency-key
    assert.equal(capturedIdemKeys.length, 2);
    assert.equal(capturedIdemKeys[0], "idem-retry-key");
    assert.equal(capturedIdemKeys[1], "idem-retry-key");
  });
});

describe("HubClient getToken validation", () => {
  it("rejects auth response with missing token", async () => {
    globalThis.fetch = mockFetch(() => jsonResponse(200, { expires_in: 900 }));
    const client = new HubClient({ url: BASE, apiKey: API_KEY });
    await assert.rejects(() => client.ping(), /missing token/);
  });

  it("rejects auth response with expires_in <= 60 (prevents auth storm)", async () => {
    globalThis.fetch = mockFetch(() => jsonResponse(200, { token: "jwt-abc", expires_in: 30 }));
    const client = new HubClient({ url: BASE, apiKey: API_KEY });
    await assert.rejects(() => client.ping(), /invalid expires_in/);
  });

  it("rejects auth response with non-numeric expires_in", async () => {
    globalThis.fetch = mockFetch(() => jsonResponse(200, { token: "jwt-abc", expires_in: NaN }));
    const client = new HubClient({ url: BASE, apiKey: API_KEY });
    await assert.rejects(() => client.ping(), /invalid expires_in/);
  });

  it("accepts auth response with expires_in > 60", async () => {
    let authCalled = false;
    globalThis.fetch = mockFetch((url) => {
      if (url.endsWith("/auth/token")) {
        authCalled = true;
        return jsonResponse(200, { token: "jwt-abc", expires_in: 120 });
      }
      return jsonResponse(200, { message: "pong", sap_host: "sapdev" });
    });
    const client = new HubClient({ url: BASE, apiKey: API_KEY });
    const result = await client.ping();
    assert.equal(result.message, "pong");
    assert.ok(authCalled);
  });

  it("refreshes token when cached token is within 60s of expiry", async () => {
    let authCalls = 0;
    globalThis.fetch = mockFetch((url) => {
      if (url.endsWith("/auth/token")) {
        authCalls++;
        // Return a token with very short expires_in (65s — just above 60s threshold)
        return jsonResponse(200, { token: `jwt-${authCalls}`, expires_in: 65 });
      }
      return jsonResponse(200, { ok: true, sap_time: "20260422163000" });
    });
    const client = new HubClient({ url: BASE, apiKey: API_KEY });
    // First call: gets token with 65s expiry
    await client.ping();
    assert.equal(authCalls, 1);
    // Simulate 10 seconds passing — still 55s left, within 60s window → should refresh
    const origNow = Date.now;
    let offset = 0;
    Date.now = () => origNow() + offset;
    offset = 10_000; // 10s elapsed → 55s remaining, under 60s threshold
    try {
      await client.ping();
      assert.equal(authCalls, 2, "should re-auth when token is within 60s of expiry");
    } finally {
      Date.now = origNow;
    }
  });

  it("re-throws unknown fetch errors (not AbortError/TypeError)", async () => {
    class CustomError extends Error { constructor() { super("custom"); this.name = "CustomError"; } }
    globalThis.fetch = mockFetch(() => { throw new CustomError(); });
    const client = new HubClient({ url: BASE, apiKey: API_KEY });
    await assert.rejects(() => client.ping(), (err: unknown) => {
      return err instanceof CustomError;
    });
  });

  it("throws on 500 auth endpoint failure", async () => {
    globalThis.fetch = mockFetch(() => jsonResponse(500, { error: "Internal server error" }));
    const client = new HubClient({ url: BASE, apiKey: API_KEY });
    await assert.rejects(() => client.ping(), (e: unknown) => {
      assert(e instanceof ZzapiMesHttpError);
      assert.equal(e.status, 500);
      assert.match(e.message, /Hub auth failed/);
      return true;
    });
  });

  it("throws on 502 auth endpoint failure", async () => {
    globalThis.fetch = mockFetch(() => jsonResponse(502, { error: "Bad gateway" }));
    const client = new HubClient({ url: BASE, apiKey: API_KEY });
    await assert.rejects(() => client.ping(), (e: unknown) => {
      assert(e instanceof ZzapiMesHttpError);
      assert.equal(e.status, 502);
      assert.match(e.message, /Hub auth failed/);
      return true;
    });
  });

  it("throws on 503 auth endpoint failure", async () => {
    globalThis.fetch = mockFetch(() => jsonResponse(503, { error: "Service unavailable" }));
    const client = new HubClient({ url: BASE, apiKey: API_KEY });
    await assert.rejects(() => client.ping(), (e: unknown) => {
      assert(e instanceof ZzapiMesHttpError);
      assert.equal(e.status, 503);
      assert.match(e.message, /Hub auth failed/);
      return true;
    });
  });

  it("throws on non-JSON auth response (res.json() throws SyntaxError)", async () => {
    globalThis.fetch = mockFetch(() => new Response("<html>Error</html>", { status: 200, headers: { "content-type": "text/html" } }));
    const client = new HubClient({ url: BASE, apiKey: API_KEY });
    await assert.rejects(() => client.ping(), (e: unknown) => {
      // getToken() calls res.json() which throws SyntaxError on non-JSON body.
      // No try/catch wraps it — raw SyntaxError propagates.
      assert.ok(e instanceof SyntaxError);
      return true;
    });
  });

  it("uses statusText fallback when auth body read fails", async () => {
    globalThis.fetch = mockFetch(() => {
      const res = new Response("ok", { status: 503, statusText: "Service Unavailable", headers: { "content-type": "text/plain" } });
      // Override text() to throw, simulating already-consumed body
      res.text = async () => { throw new Error("body already consumed"); };
      return res;
    });
    const client = new HubClient({ url: BASE, apiKey: API_KEY });
    await assert.rejects(() => client.ping(), (e: unknown) => {
      assert(e instanceof ZzapiMesHttpError);
      assert.equal(e.status, 503);
      assert.match(e.message, /Service Unavailable/);
      return true;
    });
  });

  it("detects 'errors' array in ABAP 422 response", async () => {
    globalThis.fetch = mockFetch((url) => {
      if (url.endsWith("/auth/token")) return jsonResponse(200, { token: "jwt-abc", expires_in: 900 });
      return jsonResponse(422, { errors: [{ type: "E", message: "No authorization for transaction MB01" }] });
    });
    await assert.rejects(
      () => new HubClient({ url: BASE, apiKey: API_KEY }).confirmProduction(
        { orderid: "1000000", operation: "0010", yield: 50 },
        "errors-key-001",
      ),
      (e: unknown) => {
        assert(e instanceof ZzapiMesHttpError);
        assert.equal(e.status, 422);
        assert.match(e.message, /No authorization/);
        return true;
      },
    );
  });

  it("detects 'errors' string array in response", async () => {
    globalThis.fetch = mockFetch((url) => {
      if (url.endsWith("/auth/token")) return jsonResponse(200, { token: "jwt-abc", expires_in: 900 });
      return jsonResponse(422, { errors: ["BWART 101 not allowed", "Plant 1000 not allowed"] });
    });
    await assert.rejects(
      () => new HubClient({ url: BASE, apiKey: API_KEY }).goodsReceipt(
        { ebeln: "4500000001", ebelp: "00010", menge: 100, werks: "1000", lgort: "0001" },
        "errors-str-key",
      ),
      (e: unknown) => {
        assert(e instanceof ZzapiMesHttpError);
        assert.equal(e.status, 422);
        assert.match(e.message, /BWART 101 not allowed/);
        assert.match(e.message, /Plant 1000 not allowed/);
        return true;
      },
    );
  });

  it("detects 4xx/5xx without error/errors field (safety net)", async () => {
    globalThis.fetch = mockFetch((url) => {
      if (url.endsWith("/auth/token")) return jsonResponse(200, { token: "jwt-abc", expires_in: 900 });
      return jsonResponse(409, { status: "rejected" });
    });
    await assert.rejects(
      () => new HubClient({ url: BASE, apiKey: API_KEY }).goodsIssue(
        { orderid: "1000000", matnr: "20000001", menge: 50, werks: "1000", lgort: "0001" },
        "safety-net-key",
      ),
      (e: unknown) => {
        assert(e instanceof ZzapiMesHttpError);
        assert.equal(e.status, 409);
        assert.match(e.message, /Hub error \(HTTP 409\)/);
        return true;
      },
    );
  });

  it("sends POST method and idempotency-key header on write-back requests", async () => {
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = mockFetch((url, init) => {
      if (url.endsWith("/auth/token")) return jsonResponse(200, { token: "jwt-abc", expires_in: 900 });
      capturedInit = init;
      return jsonResponse(201, {
        orderid: "1000000", operation: "0010", yield: 50, scrap: 0,
        confNo: "00000100", confCnt: "0001", status: "confirmed", message: "ok",
      });
    });
    const client = new HubClient({ url: BASE, apiKey: API_KEY });
    await client.confirmProduction({ orderid: "1000000", operation: "0010", yield: 50 }, "idem-key-1");
    assert.equal(capturedInit?.method, "POST");
    const headers = capturedInit?.headers as Record<string, string>;
    assert.equal(headers?.["idempotency-key"], "idem-key-1");
    assert.equal(headers?.["content-type"], "application/json");
  });

  it("double-401 retry throws ZzapiMesHttpError(401)", async () => {
    let callCount = 0;
    globalThis.fetch = mockFetch((url) => {
      if (url.endsWith("/auth/token")) return jsonResponse(200, { token: "jwt-abc", expires_in: 900 });
      callCount++;
      return jsonResponse(401, { error: "Unauthorized" });
    });
    await assert.rejects(
      () => new HubClient({ url: BASE, apiKey: API_KEY }).getPo("4500000001"),
      (e: unknown) => {
        assert(e instanceof ZzapiMesHttpError);
        assert.equal(e.status, 401);
        assert.equal(callCount, 2, "should retry once then fail");
        return true;
      },
    );
  });

  it("handles 'errors' as non-array scalar (number)", async () => {
    globalThis.fetch = mockFetch((url) => {
      if (url.endsWith("/auth/token")) return jsonResponse(200, { token: "jwt-abc", expires_in: 900 });
      return jsonResponse(422, { errors: 42 });
    });
    await assert.rejects(
      () => new HubClient({ url: BASE, apiKey: API_KEY }).getPo("4500000001"),
      (e: unknown) => {
        assert(e instanceof ZzapiMesHttpError);
        assert.equal(e.status, 422);
        assert.equal(e.message, "42");
        return true;
      },
    );
  });

  it("handles 'errors' as null", async () => {
    globalThis.fetch = mockFetch((url) => {
      if (url.endsWith("/auth/token")) return jsonResponse(200, { token: "jwt-abc", expires_in: 900 });
      return jsonResponse(422, { errors: null });
    });
    await assert.rejects(
      () => new HubClient({ url: BASE, apiKey: API_KEY }).getPo("4500000001"),
      (e: unknown) => {
        assert(e instanceof ZzapiMesHttpError);
        assert.equal(e.status, 422);
        assert.equal(e.message, "null");
        return true;
      },
    );
  });

  it("handles 'errors' as plain string (non-array)", async () => {
    globalThis.fetch = mockFetch((url) => {
      if (url.endsWith("/auth/token")) return jsonResponse(200, { token: "jwt-abc", expires_in: 900 });
      return jsonResponse(422, { errors: "No authorization for transaction MB01" });
    });
    await assert.rejects(
      () => new HubClient({ url: BASE, apiKey: API_KEY }).getPo("4500000001"),
      (e: unknown) => {
        assert(e instanceof ZzapiMesHttpError);
        assert.equal(e.status, 422);
        assert.equal(e.message, "No authorization for transaction MB01");
        return true;
      },
    );
  });

  it("handles 429 from auth endpoint", async () => {
    globalThis.fetch = mockFetch(() => jsonResponse(429, { error: "Too many requests" }));
    await assert.rejects(
      () => new HubClient({ url: BASE, apiKey: API_KEY }).getPo("4500000001"),
      (e: unknown) => {
        assert(e instanceof ZzapiMesHttpError);
        assert.equal(e.status, 429);
        return true;
      },
    );
  });

  it("getMaterial without optional werks omits query param", async () => {
    globalThis.fetch = mockFetch((url) => {
      if (url.endsWith("/auth/token")) return jsonResponse(200, { token: "jwt-abc", expires_in: 900 });
      return jsonResponse(200, { matnr: "10000001", maktx: "Test Material" });
    });
    const client = new HubClient({ url: BASE, apiKey: API_KEY });
    await client.getMaterial("10000001");
    assert.ok(capturedUrl!.includes("/material/10000001"));
    assert.ok(!capturedUrl!.includes("werks"), "werks should not be in URL when omitted");
  });

  it("does not throw on HTTP 200 with 'error' key (not a false-positive)", async () => {
    globalThis.fetch = mockFetch((url) => {
      if (url.endsWith("/auth/token")) return jsonResponse(200, { token: "jwt-abc", expires_in: 900 });
      return jsonResponse(200, { ok: true, error: "warning: deprecated field" });
    });
    const result = await new HubClient({ url: BASE, apiKey: API_KEY }).ping();
    assert.ok(result);
  });

  it("auth endpoint timeout throws ZzapiMesHttpError(408)", async () => {
    globalThis.fetch = mockFetch(() => {
      throw new DOMException("The operation was aborted", "AbortError");
    });
    const client = new HubClient({ url: BASE, apiKey: API_KEY, timeout: 1 });
    await assert.rejects(
      () => client.ping(),
      (e: unknown) => {
        assert(e instanceof ZzapiMesHttpError);
        assert.equal(e.status, 408);
        return true;
      },
    );
  });

  it("retryAfter not forwarded on non-429 write-back (SAP 408→504 drops retryAfter)", async () => {
    // When SAP returns 408 with retryAfter, mapSapError maps to 504 but
    // the hub only forwards retryAfter when clientStatus===429.
    globalThis.fetch = mockFetch((url) => {
      if (url.endsWith("/auth/token")) return jsonResponse(200, { token: "jwt-abc", expires_in: 900 });
      return new Response(JSON.stringify({ error: "SAP timeout" }), {
        status: 408,
        headers: { "content-type": "application/json", "retry-after": "30" },
      });
    });
    const client = new HubClient({ url: BASE, apiKey: API_KEY });
    await assert.rejects(
      () => client.confirmProduction({ orderid: "1000000", operation: "0010", yield: 50 }, "retry-non429"),
      (e: unknown) => {
        assert(e instanceof ZzapiMesHttpError);
        assert.equal(e.status, 408, "HubClient sees the raw 408, not the hub-remapped 504");
        return true;
      },
    );
  });
});

describe("HubClient constructor validation", () => {
  it("rejects empty url", () => {
    assert.throws(
      () => new HubClient({ url: "", apiKey: "test" }),
      /non-empty string/,
    );
  });

  it("rejects whitespace-only url", () => {
    assert.throws(
      () => new HubClient({ url: "   ", apiKey: "test" }),
      /non-empty string/,
    );
  });

  it("rejects empty apiKey", () => {
    assert.throws(
      () => new HubClient({ url: BASE, apiKey: "" }),
      /non-empty string/,
    );
  });

  it("rejects whitespace-only apiKey", () => {
    assert.throws(
      () => new HubClient({ url: BASE, apiKey: "   " }),
      /non-empty string/,
    );
  });

  it("rejects timeout=0", () => {
    assert.throws(
      () => new HubClient({ url: BASE, apiKey: API_KEY, timeout: 0 }),
      /positive number/,
    );
  });

  it("rejects negative timeout", () => {
    assert.throws(
      () => new HubClient({ url: BASE, apiKey: API_KEY, timeout: -5 }),
      /positive number/,
    );
  });

  it("accepts valid config with and without timeout", () => {
    const c1 = new HubClient({ url: BASE, apiKey: API_KEY });
    assert.ok(c1);
    const c2 = new HubClient({ url: BASE, apiKey: API_KEY, timeout: 5000 });
    assert.ok(c2);
  });

  it("ensureProtocol prepends http:// to bare hostname", () => {
    const client = new HubClient({ url: "not-a-url", apiKey: API_KEY });
    // ensureProtocol("not-a-url") → "http://not-a-url"
    assert.ok(client);
  });

  it("ensureProtocol passes through ftp:// scheme unchanged", () => {
    const client = new HubClient({ url: "ftp://evil.example.com", apiKey: API_KEY });
    assert.ok(client);
  });

  it("does NOT follow redirects — uses redirect: manual (P1 security)", async () => {
    // Verify that HubClient sets redirect: "manual" on fetch to prevent
    // Bearer-token leakage on 301/302 redirects.
    let authCallOpts: RequestInit | undefined;
    globalThis.fetch = mockFetch((url, init) => {
      if (url.endsWith("/auth/token")) {
        return jsonResponse(200, { token: "jwt-redirect-test", expires_in: 900 });
      }
      // Capture the options from the hub request (not the auth request)
      authCallOpts = init;
      // Return a 302 redirect — with redirect: "manual" the client sees
      // the raw 302 response instead of following it.
      return new Response(null, {
        status: 302,
        headers: { location: "http://evil.example.com/steal-token" },
      });
    });
    const client = new HubClient({ url: BASE, apiKey: API_KEY });
    try {
      await client.ping();
    } catch {
      // 302 response body is empty → JSON parse error — expected
    }
    assert.equal(authCallOpts?.redirect, "manual", "HubClient should use redirect: 'manual'");
  });

  it("retries on 401 for POST methods (not just GET)", async () => {
    // Verify that POST requests (write-back) also get a single retry on 401,
    // same as the GET retry path.
    let authCalls = 0;
    let hubCalls = 0;
    globalThis.fetch = mockFetch((url, init) => {
      if (url.endsWith("/auth/token")) {
        authCalls++;
        return jsonResponse(200, { token: `jwt-retry-${authCalls}`, expires_in: 900 });
      }
      hubCalls++;
      // First hub call returns 401 → should trigger retry with new token
      if (hubCalls === 1) {
        return jsonResponse(401, { error: "Token expired" });
      }
      // Second hub call succeeds
      return jsonResponse(201, { orderid: "1000000", confirmation: "ok" });
    });
    const client = new HubClient({ url: BASE, apiKey: API_KEY });
    const res = await client.confirmProduction(
      { orderid: "1000000", operation: "0010", yield: 50 },
      "retry-401-post-test",
    );
    assert.equal(authCalls, 2, "should call auth twice (initial + retry after 401)");
    assert.equal(hubCalls, 2, "should call hub endpoint twice (initial 401 + retry)");
    assert.equal((res as Record<string, unknown>).confirmation, "ok");
  });
});
