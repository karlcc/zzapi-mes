import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SapClient, ZzapiMesClient, ZzapiMesHttpError, ensureProtocol, parseRetryAfter, readResponseBody, PingResponseSchema, PoResponseSchema, ErrorResponseSchema, ProdOrderResponseSchema, MaterialResponseSchema, StockResponseSchema, PoItemsResponseSchema, RoutingResponseSchema, WorkCenterResponseSchema, ConfirmationRequestSchema, ConfirmationResponseSchema, GoodsReceiptRequestSchema, GoodsReceiptResponseSchema, GoodsIssueRequestSchema, GoodsIssueResponseSchema, TokenResponseSchema, HealthzResponseSchema, ALL_SCOPES } from "../index.js";
import type { PingResponse } from "../index.js";

const BASE = "http://sapdev.test:8000";
const CFG = { host: BASE, client: 200, user: "u", password: "p", timeout: 5000 };

let origFetch: typeof globalThis.fetch;
let capturedUrl: string | undefined;
let capturedOpts: RequestInit | undefined;

function mockFetch(status: number, body: string) {
  return async (url: string | URL | Request, init?: RequestInit) => {
    capturedUrl = url.toString();
    capturedOpts = init;
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  };
}

beforeEach(() => { origFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = origFetch; });

describe("SapClient", () => {
  it("ping builds correct URL with sap-client", async () => {
    globalThis.fetch = mockFetch(200, '{"ok":true,"sap_time":"20260422163000"}');
    await new SapClient(CFG).ping();
    assert.match(capturedUrl!, /zzapi\/mes\/ping.*sap-client=200/);
  });

  it("getPo builds correct URL with ebeln and sap-client", async () => {
    globalThis.fetch = mockFetch(200, '{"ebeln":"3010000608","aedat":"20170306","lifnr":"0000500340","eindt":"20170630"}');
    await new SapClient(CFG).getPo("3010000608");
    assert.match(capturedUrl!, /ebeln=3010000608/);
    assert.match(capturedUrl!, /sap-client=200/);
  });

  it("sends Basic auth header", async () => {
    globalThis.fetch = mockFetch(200, '{"ok":true,"sap_time":"20260422163000"}');
    await new SapClient(CFG).ping();
    const auth = capturedOpts?.headers as Record<string, string>;
    assert.equal(auth?.Authorization, "Basic " + btoa("u:p"));
  });

  it("throws ZzapiMesHttpError on error response", async () => {
    globalThis.fetch = mockFetch(404, '{"error":"PO not found"}');
    const c = new SapClient(CFG);
    await assert.rejects(() => c.getPo("999"), (err: unknown) => {
      assert(err instanceof ZzapiMesHttpError);
      assert.equal(err.status, 404);
      assert.equal(err.message, "PO not found");
      return true;
    });
  });

  it("repairs ABAP zz_cl_json empty-value malformation (e.g. \"sakl\":})", async () => {
    // SAP's zz_cl_json serializer with compress=true omits values for empty
    // fields, producing invalid JSON like {"sakl":} instead of {"sakl":null}.
    // SapClient should repair this common pattern rather than failing with
    // "Non-JSON response".
    globalThis.fetch = mockFetch(200, '{"arbpl":"00310211","werks":"1000","costCenters":[{"kostl":"0009552100","sakl":}]}');
    const result = await new SapClient(CFG).getWorkCenter("00310211", "1000");
    assert.equal((result as Record<string, unknown>).arbpl, "00310211");
    // The repaired null value should be accessible
    const ccs = ((result as Record<string, unknown>).costCenters ?? []) as Array<Record<string, unknown>>;
    assert.ok(ccs.length > 0, "costCenters should have at least one entry");
    const first = ccs[0]!;
    assert.equal(first.sakl, null);
  });

  it("repairs ABAP zz_cl_json empty-value in middle of object (e.g. \"sakl\":,)", async () => {
    // Variant where the empty value is followed by another key, not end-of-object
    globalThis.fetch = mockFetch(200, '{"sakl":,"kostl":"123"}');
    const result = await new SapClient(CFG).ping();
    assert.equal((result as Record<string, unknown>).sakl, null);
    assert.equal((result as Record<string, unknown>).kostl, "123");
  });

  it("throws on truly non-JSON (HTML) response even after repair attempt", async () => {
    globalThis.fetch = mockFetch(401, "<html>Unauthorized</html>");
    const c = new SapClient(CFG);
    await assert.rejects(() => c.ping(), (err: unknown) => {
      assert(err instanceof ZzapiMesHttpError);
      assert.equal(err.status, 401);
      assert.match(err.message, /Non-JSON response/);
      return true;
    });
  });

  it("strips trailing slash from host", async () => {
    globalThis.fetch = mockFetch(200, '{"ok":true,"sap_time":"20260422163000"}');
    await new SapClient({ ...CFG, host: "http://sapdev.test:8000/" }).ping();
    assert.ok(!capturedUrl?.includes(":8000//sap"));
  });

  it("ZzapiMesClient is SapClient (back-compat alias)", () => {
    assert.equal(ZzapiMesClient, SapClient);
  });

  it("calls onRequest hook before each request", async () => {
    globalThis.fetch = mockFetch(200, '{"ok":true,"sap_time":"20260422163000"}');
    const hookCalls: Array<{ url: string; method: string }> = [];
    await new SapClient({
      ...CFG,
      onRequest: (ctx) => { hookCalls.push(ctx); },
    }).ping();
    assert.equal(hookCalls.length, 1);
    assert.equal(hookCalls[0]!.method, "GET");
    assert.match(hookCalls[0]!.url, /zzapi\/mes\/ping/);
  });

  it("calls onResponse hook after each response", async () => {
    globalThis.fetch = mockFetch(200, '{"ok":true,"sap_time":"20260422163000"}');
    const hookCalls: Array<{ url: string; status: number; durationMs: number }> = [];
    await new SapClient({
      ...CFG,
      onResponse: (ctx) => { hookCalls.push(ctx); },
    }).ping();
    assert.equal(hookCalls.length, 1);
    assert.equal(hookCalls[0]!.status, 200);
    assert.ok(hookCalls[0]!.durationMs >= 0);
  });

  it("calls onRequest hook with POST method on write-back", async () => {
    globalThis.fetch = mockFetch(201, '{"orderid":"1000000","operation":"0010","yield":50,"scrap":0,"confNo":"00000100","confCnt":"0001","status":"confirmed","message":"ok"}');
    const hookCalls: Array<{ url: string; method: string }> = [];
    await new SapClient({
      ...CFG,
      onRequest: (ctx) => { hookCalls.push(ctx); },
    }).postConfirmation({ orderid: "1000000", operation: "0010", yield: 50 });
    assert.equal(hookCalls.length, 1);
    assert.equal(hookCalls[0]!.method, "POST");
  });

  it("calls onResponse hook with 201 status on write-back", async () => {
    globalThis.fetch = mockFetch(201, '{"orderid":"1000000","operation":"0010","yield":50,"scrap":0,"confNo":"00000100","confCnt":"0001","status":"confirmed","message":"ok"}');
    const hookCalls: Array<{ url: string; status: number; durationMs: number }> = [];
    await new SapClient({
      ...CFG,
      onResponse: (ctx) => { hookCalls.push(ctx); },
    }).postConfirmation({ orderid: "1000000", operation: "0010", yield: 50 });
    assert.equal(hookCalls.length, 1);
    assert.equal(hookCalls[0]!.status, 201);
  });

  // Phase 5A methods

  it("getProdOrder builds correct URL", async () => {
    globalThis.fetch = mockFetch(200, '{"aufnr":"1000000","auart":"PP01","werks":"1000","matnr":"10000001","gamng":1000,"gstrp":"20260401","gltrp":"20260415"}');
    await new SapClient(CFG).getProdOrder("1000000");
    assert.match(capturedUrl!, /zzapi\/mes\/prod_order.*aufnr=1000000/);
  });

  it("getMaterial builds correct URL with optional werks", async () => {
    globalThis.fetch = mockFetch(200, '{"matnr":"10000001","mtart":"FERT","meins":"EA"}');
    await new SapClient(CFG).getMaterial("10000001", "1000");
    assert.match(capturedUrl!, /zzapi\/mes\/material.*matnr=10000001.*werks=1000/);
  });

  it("getStock builds correct URL with required werks", async () => {
    globalThis.fetch = mockFetch(200, '{"matnr":"10000001","werks":"1000","items":[{"lgort":"0001","clabs":250}]}');
    await new SapClient(CFG).getStock("10000001", "1000");
    assert.match(capturedUrl!, /zzapi\/mes\/stock.*matnr=10000001.*werks=1000/);
  });

  it("getStock includes optional lgort", async () => {
    globalThis.fetch = mockFetch(200, '{"matnr":"10000001","werks":"1000","items":[{"lgort":"0001","clabs":250}]}');
    await new SapClient(CFG).getStock("10000001", "1000", "0001");
    assert.match(capturedUrl!, /lgort=0001/);
  });

  it("getPoItems builds correct URL", async () => {
    globalThis.fetch = mockFetch(200, '{"ebeln":"4500000001","items":[{"ebelp":"00010","matnr":"10000001","menge":100,"meins":"EA"}]}');
    await new SapClient(CFG).getPoItems("4500000001");
    assert.match(capturedUrl!, /zzapi\/mes\/po_items.*ebeln=4500000001/);
  });

  it("getRouting builds correct URL", async () => {
    globalThis.fetch = mockFetch(200, '{"matnr":"10000001","werks":"1000","plnnr":"50000123","operations":[{"vornr":"0010","ltxa1":"Turning"}]}');
    await new SapClient(CFG).getRouting("10000001", "1000");
    assert.match(capturedUrl!, /zzapi\/mes\/routing.*matnr=10000001.*werks=1000/);
  });

  it("getWorkCenter builds correct URL", async () => {
    globalThis.fetch = mockFetch(200, '{"arbpl":"TURN1","werks":"1000","ktext":"CNC Turning Center","steus":"PP01"}');
    await new SapClient(CFG).getWorkCenter("TURN1", "1000");
    assert.match(capturedUrl!, /zzapi\/mes\/wc.*arbpl=TURN1.*werks=1000/);
  });

  it("postConfirmation sends POST with JSON body to zzapi/mes/conf", async () => {
    globalThis.fetch = mockFetch(201, '{"orderid":"1000000","operation":"0010","yield":50,"scrap":0,"confNo":"00000100","confCnt":"0001","status":"confirmed"}');
    const res = await new SapClient(CFG).postConfirmation({ orderid: "1000000", operation: "0010", yield: 50 });
    assert.equal(capturedOpts?.method, "POST");
    assert.match(capturedUrl!, /zzapi\/mes\/conf/);
    assert.match(capturedUrl!, /sap-client=200/);
    assert.equal(res.status, "confirmed");
    const body = JSON.parse(capturedOpts?.body as string);
    assert.equal(body.orderid, "1000000");
  });

  it("postGoodsReceipt sends POST with JSON body to zzapi/mes/gr", async () => {
    globalThis.fetch = mockFetch(201, '{"ebeln":"4500000001","ebelp":"00010","menge":100,"materialDocument":"5000000001","documentYear":"2026","status":"posted"}');
    const res = await new SapClient(CFG).postGoodsReceipt({ ebeln: "4500000001", ebelp: "00010", menge: 100, werks: "1000", lgort: "0001" });
    assert.equal(capturedOpts?.method, "POST");
    assert.match(capturedUrl!, /zzapi\/mes\/gr/);
    assert.equal(res.status, "posted");
  });

  it("postGoodsIssue sends POST with JSON body to zzapi/mes/gi", async () => {
    globalThis.fetch = mockFetch(201, '{"orderid":"1000000","matnr":"20000001","menge":50,"materialDocument":"5000000002","documentYear":"2026","status":"posted"}');
    const res = await new SapClient(CFG).postGoodsIssue({ orderid: "1000000", matnr: "20000001", menge: 50, werks: "1000", lgort: "0001" });
    assert.equal(capturedOpts?.method, "POST");
    assert.match(capturedUrl!, /zzapi\/mes\/gi/);
    assert.equal(res.status, "posted");
  });

  it("postRequest throws ZzapiMesHttpError on SAP error", async () => {
    globalThis.fetch = mockFetch(422, '{"error":"Order already confirmed"}');
    await assert.rejects(
      () => new SapClient(CFG).postConfirmation({ orderid: "1000000", operation: "0010", yield: 50 }),
      (e: unknown) => e instanceof ZzapiMesHttpError && e.status === 422,
    );
  });

  it("postGoodsReceipt throws ZzapiMesHttpError on 422", async () => {
    globalThis.fetch = mockFetch(422, '{"error":"PO already received"}');
    await assert.rejects(
      () => new SapClient(CFG).postGoodsReceipt({ ebeln: "4500000001", ebelp: "00010", menge: 100, werks: "1000", lgort: "0001" }),
      (e: unknown) => e instanceof ZzapiMesHttpError && e.status === 422,
    );
  });

  it("postGoodsIssue throws ZzapiMesHttpError on 409 backflush", async () => {
    globalThis.fetch = mockFetch(409, '{"error":"Backflush is active"}');
    await assert.rejects(
      () => new SapClient(CFG).postGoodsIssue({ orderid: "1000000", matnr: "20000001", menge: 50, werks: "1000", lgort: "0001" }),
      (e: unknown) => e instanceof ZzapiMesHttpError && e.status === 409,
    );
  });

  it("postGoodsIssue throws ZzapiMesHttpError on 422", async () => {
    globalThis.fetch = mockFetch(422, '{"error":"Material not found"}');
    await assert.rejects(
      () => new SapClient(CFG).postGoodsIssue({ orderid: "1000000", matnr: "20000001", menge: 50, werks: "1000", lgort: "0001" }),
      (e: unknown) => e instanceof ZzapiMesHttpError && e.status === 422,
    );
  });

  it("POST methods throw ZzapiMesHttpError on 500 upstream failure", async () => {
    globalThis.fetch = mockFetch(500, '{"error":"Internal Server Error"}');
    await assert.rejects(
      () => new SapClient(CFG).postConfirmation({ orderid: "1000000", operation: "0010", yield: 50 }),
      (e: unknown) => e instanceof ZzapiMesHttpError && e.status === 500,
    );
  });

  it("POST methods throw on non-JSON response", async () => {
    globalThis.fetch = mockFetch(502, "<html>Bad Gateway</html>");
    await assert.rejects(
      () => new SapClient(CFG).postGoodsReceipt({ ebeln: "4500000001", ebelp: "00010", menge: 100, werks: "1000", lgort: "0001" }),
      (e: unknown) => e instanceof ZzapiMesHttpError && e.message.includes("Non-JSON"),
    );
  });

  it("POST methods send Content-Type application/json", async () => {
    globalThis.fetch = mockFetch(201, '{"orderid":"1000000","operation":"0010","yield":50,"scrap":0,"confNo":"00000100","confCnt":"0001","status":"confirmed"}');
    await new SapClient(CFG).postConfirmation({ orderid: "1000000", operation: "0010", yield: 50 });
    const headers = capturedOpts?.headers as Record<string, string>;
    assert.equal(headers?.["Content-Type"], "application/json");
  });

  it("POST methods send Basic auth header", async () => {
    globalThis.fetch = mockFetch(201, '{"orderid":"1000000","operation":"0010","yield":50,"scrap":0,"confNo":"00000100","confCnt":"0001","status":"confirmed"}');
    await new SapClient(CFG).postConfirmation({ orderid: "1000000", operation: "0010", yield: 50 });
    const headers = capturedOpts?.headers as Record<string, string>;
    assert.ok(headers?.["Authorization"]?.startsWith("Basic "));
  });

  it("GET request wraps timeout abort in ZzapiMesHttpError(408)", async () => {
    globalThis.fetch = async () => { throw new DOMException("The operation was aborted", "AbortError"); };
    const client = new SapClient({ ...CFG, timeout: 1 });
    await assert.rejects(
      () => client.ping(),
      (e: unknown) => e instanceof ZzapiMesHttpError && e.status === 408 && e.message.includes("timeout"),
    );
  });

  it("POST request wraps timeout abort in ZzapiMesHttpError(408)", async () => {
    globalThis.fetch = async () => { throw new DOMException("The operation was aborted", "AbortError"); };
    const client = new SapClient({ ...CFG, timeout: 1 });
    await assert.rejects(
      () => client.postConfirmation({ orderid: "1000000", operation: "0010", yield: 50 }),
      (e: unknown) => e instanceof ZzapiMesHttpError && e.status === 408,
    );
  });

  it("GET request wraps TypeError (network failure) in ZzapiMesHttpError(502)", async () => {
    globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
    const client = new SapClient(CFG);
    await assert.rejects(
      () => client.ping(),
      (e: unknown) => {
        assert(e instanceof ZzapiMesHttpError);
        assert.equal(e.status, 502);
        assert.match(e.message, /Network error/);
        return true;
      },
    );
  });

  it("POST request wraps TypeError (network failure) in ZzapiMesHttpError(502)", async () => {
    globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
    const client = new SapClient(CFG);
    await assert.rejects(
      () => client.postConfirmation({ orderid: "1000000", operation: "0010", yield: 50 }),
      (e: unknown) => {
        assert(e instanceof ZzapiMesHttpError);
        assert.equal(e.status, 502);
        assert.match(e.message, /Network error/);
        return true;
      },
    );
  });
});

describe("ensureProtocol", () => {
  it("prepends http:// to bare host", () => {
    assert.equal(ensureProtocol("sapdev.test:8000"), "http://sapdev.test:8000");
  });

  it("keeps existing http://", () => {
    assert.equal(ensureProtocol("http://sapdev.test:8000"), "http://sapdev.test:8000");
  });

  it("keeps existing https://", () => {
    assert.equal(ensureProtocol("https://sapprd.test:443"), "https://sapprd.test:443");
  });

  it("rejects URL with query string — not a bare host", () => {
    // ensureProtocol is meant for host-only input. A query string would
    // cause path interpolation in HubClient/SapClient to produce a
    // malformed URL like "http://host?x=1/ping".
    assert.throws(() => ensureProtocol("hub.example.com?foo=bar"), /query string/);
  });

  it("rejects URL with hash fragment", () => {
    assert.throws(() => ensureProtocol("hub.example.com#section"), /fragment/);
  });
});

describe("Zod schemas", () => {
  it("PingResponseSchema accepts valid ping", () => {
    const r = PingResponseSchema.parse({ ok: true, sap_time: "20260422163000" });
    assert.equal(r.ok, true);
    assert.equal(r.sap_time, "20260422163000");
  });

  it("PingResponseSchema rejects invalid sap_time", () => {
    assert.throws(() => PingResponseSchema.parse({ ok: true, sap_time: "short" }));
  });

  it("PoResponseSchema accepts valid PO", () => {
    const r = PoResponseSchema.parse({ ebeln: "3010000608", aedat: "20170306", lifnr: "0000500340", eindt: "20170630" });
    assert.equal(r.ebeln, "3010000608");
  });

  it("ErrorResponseSchema accepts error object", () => {
    const r = ErrorResponseSchema.parse({ error: "PO not found" });
    assert.equal(r.error, "PO not found");
  });

  it("ErrorResponseSchema does NOT have errorField — responses use dynamic keys", () => {
    // Write-back error responses include route-specific keys (orderid, ebeln)
    // dynamically, not via a fixed errorField property.
    const shape = ErrorResponseSchema.shape as Record<string, unknown>;
    assert.equal("errorField" in shape, false, "ErrorResponseSchema should not have errorField property");
  });

  // Phase 5A schemas

  it("ProdOrderResponseSchema accepts valid prod order", () => {
    const r = ProdOrderResponseSchema.parse({
      aufnr: "1000000", auart: "PP01", werks: "1000", matnr: "10000001",
      gamng: 1000, gstrp: "20260401", gltrp: "20260415",
      operations: [{ vornr: "0010", ltxa1: "Turning", arbpl: "TURN1", vgwrt: 2.5 }],
      components: [{ matnr: "20000001", bdmenge: 500, meins: "EA", werks: "1000" }],
    });
    assert.equal(r.aufnr, "1000000");
    assert.equal(r.operations!.length, 1);
  });

  it("MaterialResponseSchema accepts valid material", () => {
    const r = MaterialResponseSchema.parse({
      matnr: "10000001", mtart: "FERT", meins: "EA", maktx: "Test material",
    });
    assert.equal(r.mtart, "FERT");
  });

  it("StockResponseSchema accepts valid stock", () => {
    const r = StockResponseSchema.parse({
      matnr: "10000001", werks: "1000",
      items: [{ lgort: "0001", clabs: 250, avail_qty: 200 }],
    });
    assert.equal(r.items!.length, 1);
  });

  it("PoItemsResponseSchema accepts valid PO items", () => {
    const r = PoItemsResponseSchema.parse({
      ebeln: "4500000001",
      items: [{ ebelp: "00010", matnr: "10000001", menge: 100, meins: "EA" }],
    });
    assert.equal(r.items.length, 1);
  });

  it("RoutingResponseSchema accepts valid routing", () => {
    const r = RoutingResponseSchema.parse({
      matnr: "10000001", werks: "1000", plnnr: "50000123",
      operations: [{ vornr: "0010", ltxa1: "Turning", arbpl: "TURN1", vgwrt: 2.5 }],
    });
    assert.equal(r.plnnr, "50000123");
  });

  it("WorkCenterResponseSchema accepts valid work center", () => {
    const r = WorkCenterResponseSchema.parse({
      arbpl: "TURN1", werks: "1000", ktext: "CNC Turning Center", steus: "PP01",
    });
    assert.equal(r.steus, "PP01");
  });

  // Phase 5B schemas

  it("ConfirmationRequestSchema accepts valid confirmation", () => {
    const r = ConfirmationRequestSchema.parse({
      orderid: "1000000", operation: "0010", yield: 50,
    });
    assert.equal(r.orderid, "1000000");
  });

  it("ConfirmationResponseSchema accepts valid response with confNo/confCnt", () => {
    const r = ConfirmationResponseSchema.parse({
      orderid: "1000000", operation: "0010", yield: 50, scrap: 0, confNo: "00000100", confCnt: "0001", status: "confirmed",
    });
    assert.equal(r.status, "confirmed");
    assert.equal(r.confNo, "00000100");
  });

  it("GoodsReceiptRequestSchema accepts valid GR", () => {
    const r = GoodsReceiptRequestSchema.parse({
      ebeln: "4500000001", ebelp: "00010", menge: 100, werks: "1000", lgort: "0001",
    });
    assert.equal(r.ebeln, "4500000001");
  });

  it("GoodsReceiptResponseSchema accepts valid response with materialDocument", () => {
    const r = GoodsReceiptResponseSchema.parse({
      ebeln: "4500000001", ebelp: "00010", menge: 100, materialDocument: "5000000001", documentYear: "2026", status: "posted",
    });
    assert.equal(r.status, "posted");
    assert.equal(r.materialDocument, "5000000001");
  });

  it("GoodsIssueRequestSchema accepts valid GI", () => {
    const r = GoodsIssueRequestSchema.parse({
      orderid: "1000000", matnr: "20000001", menge: 50, werks: "1000", lgort: "0001",
    });
    assert.equal(r.orderid, "1000000");
  });

  it("GoodsIssueResponseSchema accepts valid response with materialDocument", () => {
    const r = GoodsIssueResponseSchema.parse({
      orderid: "1000000", matnr: "20000001", menge: 50, materialDocument: "5000000002", documentYear: "2026", status: "posted",
    });
    assert.equal(r.status, "posted");
    assert.equal(r.materialDocument, "5000000002");
  });

  it("TokenResponseSchema accepts valid token response", () => {
    const r = TokenResponseSchema.parse({ token: "jwt.here", expires_in: 900 });
    assert.equal(r.token, "jwt.here");
    assert.equal(r.expires_in, 900);
  });

  it("TokenResponseSchema rejects missing token", () => {
    assert.throws(() => TokenResponseSchema.parse({ expires_in: 900 }));
  });

  it("TokenResponseSchema rejects non-integer expires_in", () => {
    assert.throws(() => TokenResponseSchema.parse({ token: "t", expires_in: 1.5 }));
  });

  it("HealthzResponseSchema accepts ok=true", () => {
    const r = HealthzResponseSchema.parse({ ok: true });
    assert.equal(r.ok, true);
  });

  it("HealthzResponseSchema rejects non-boolean ok", () => {
    assert.throws(() => HealthzResponseSchema.parse({ ok: "yes" }));
  });
});

describe("ALL_SCOPES", () => {
  it("contains all expected scope names", () => {
    const expected = ["ping", "po", "prod_order", "material", "stock", "routing", "work_center", "conf", "gr", "gi"];
    assert.deepEqual([...ALL_SCOPES], expected);
  });

  it("has no duplicates", () => {
    assert.equal(new Set(ALL_SCOPES).size, ALL_SCOPES.length);
  });
});

describe("parseRetryAfter", () => {
  it("parses a numeric string", () => {
    assert.equal(parseRetryAfter("30"), 30);
  });

  it("parses a decimal string", () => {
    assert.equal(parseRetryAfter("1.5"), 1.5);
  });

  it("returns undefined for null", () => {
    assert.equal(parseRetryAfter(null), undefined);
  });

  it("returns undefined for undefined", () => {
    assert.equal(parseRetryAfter(undefined), undefined);
  });

  it("returns undefined for empty string", () => {
    assert.equal(parseRetryAfter(""), undefined);
  });

  it("returns undefined for non-numeric string", () => {
    assert.equal(parseRetryAfter("abc"), undefined);
  });

  it("returns undefined for zero", () => {
    assert.equal(parseRetryAfter("0"), undefined);
  });

  it("returns undefined for negative number", () => {
    assert.equal(parseRetryAfter("-5"), undefined);
  });

  it("returns undefined for NaN string", () => {
    assert.equal(parseRetryAfter("NaN"), undefined);
  });

  it("computes delta-seconds from HTTP-date format", () => {
    // RFC 7231: Retry-After can be an HTTP-date like "Fri, 25 Apr 2026 02:00:00 GMT"
    // Should return the difference in seconds between the date and now
    const future = new Date(Date.now() + 30_000);
    const httpDate = future.toUTCString();
    const result = parseRetryAfter(httpDate);
    assert.ok(result !== undefined, "should parse HTTP-date");
    assert.ok(result! > 25 && result! < 35, `expected ~30s, got ${result}`);
  });

  it("returns undefined for past HTTP-date", () => {
    const past = new Date(Date.now() - 10_000);
    const httpDate = past.toUTCString();
    const result = parseRetryAfter(httpDate);
    assert.equal(result, undefined, "past date should return undefined");
  });

  it("caps numeric Retry-After at 3600 seconds", () => {
    // Absurdly large values like 999999999s would lock clients out for decades
    const result = parseRetryAfter("999999999");
    assert.ok(result !== undefined, "should still return a value");
    assert.ok(result! <= 3600, `expected cap at 3600, got ${result}`);
  });

  it("capped numeric value equals original when below cap", () => {
    const result = parseRetryAfter("60");
    assert.equal(result, 60);
  });

  it("caps HTTP-date delta at 3600 seconds", () => {
    const farFuture = new Date(Date.now() + 86400_000); // 1 day ahead
    const httpDate = farFuture.toUTCString();
    const result = parseRetryAfter(httpDate);
    assert.ok(result !== undefined, "should parse HTTP-date");
    assert.ok(result! <= 3600, `expected cap at 3600, got ${result}`);
  });

  it("returns undefined for malformed date string", () => {
    const result = parseRetryAfter("not-a-date");
    assert.equal(result, undefined);
  });
});

describe("SapClient Retry-After extraction from SAP 429", () => {
  it("extracts Retry-After header on 429 GET response", async () => {
    globalThis.fetch = async () => new Response(
      JSON.stringify({ error: "Too Many Requests" }),
      { status: 429, headers: { "retry-after": "30", "content-type": "application/json" } },
    );
    try {
      await new SapClient(CFG).ping();
      assert.fail("should have thrown");
    } catch (e) {
      assert.ok(e instanceof ZzapiMesHttpError);
      assert.equal(e.status, 429);
      assert.equal(e.retryAfter, 30);
    }
  });

  it("extracts Retry-After header on 429 POST response", async () => {
    globalThis.fetch = async () => new Response(
      JSON.stringify({ error: "Too Many Requests" }),
      { status: 429, headers: { "retry-after": "60", "content-type": "application/json" } },
    );
    try {
      await new SapClient(CFG).postConfirmation({ orderid: "1000000", operation: "0010", yield: 50 });
      assert.fail("should have thrown");
    } catch (e) {
      assert.ok(e instanceof ZzapiMesHttpError);
      assert.equal(e.status, 429);
      assert.equal(e.retryAfter, 60);
    }
  });

  it("does not set retryAfter on non-429 error", async () => {
    globalThis.fetch = async () => new Response(
      JSON.stringify({ error: "Not found" }),
      { status: 404, headers: { "retry-after": "30", "content-type": "application/json" } },
    );
    try {
      await new SapClient(CFG).ping();
      assert.fail("should have thrown");
    } catch (e) {
      assert.ok(e instanceof ZzapiMesHttpError);
      assert.equal(e.status, 404);
      assert.equal(e.retryAfter, undefined);
    }
  });
});

describe("Zod schema .strict() on write-back requests", () => {
  it("ConfirmationRequestSchema rejects extra fields", () => {
    assert.throws(
      () => ConfirmationRequestSchema.parse({
        orderid: "1000000",
        operation: "0010",
        yield: 50,
        injected_field: "should be rejected",
      }),
      /unrecognized_keys/,
    );
  });

  it("GoodsReceiptRequestSchema rejects extra fields", () => {
    assert.throws(
      () => GoodsReceiptRequestSchema.parse({
        ebeln: "4500000001",
        ebelp: "00010",
        menge: 100,
        werks: "1000",
        lgort: "0001",
        extra_key: "value",
      }),
      /unrecognized_keys/,
    );
  });

  it("GoodsIssueRequestSchema rejects extra fields", () => {
    assert.throws(
      () => GoodsIssueRequestSchema.parse({
        orderid: "1000000",
        matnr: "20000001",
        menge: 50,
        werks: "1000",
        lgort: "0001",
        custom: true,
      }),
      /unrecognized_keys/,
    );
  });
});

describe("SapClient URL encoding", () => {
  it("does not double-encode raw parameter values", async () => {
    // URLSearchParams encodes raw values once — values with % should be
    // percent-encoded, not double-encoded. A raw "100%" becomes "100%25"
    // (correct single encoding), NOT "100%2525" (double encoding).
    globalThis.fetch = mockFetch(200, '{"ok":true,"sap_time":"20260422163000"}');
    const client = new SapClient(CFG);
    // Use a public method — the param value goes through URLSearchParams once
    await client.getPo("100%");
    const url = capturedUrl!;
    // "100%" should be encoded as "100%25" (single encoding), NOT "100%2525"
    assert.match(url, /ebeln=100%25/);
    assert.ok(!url.includes("100%2525"), `double-encoding detected in URL: ${url}`);
  });

  it("correctly encodes special characters in query params", async () => {
    globalThis.fetch = mockFetch(200, '{"matnr":"10000001","mtart":"FERT","meins":"EA"}');
    const client = new SapClient(CFG);
    await client.getMaterial("10000001", "1 2"); // space in werks
    const url = capturedUrl!;
    // Space should be encoded as + or %20 by URLSearchParams
    assert.ok(url.includes("werks=1+2") || url.includes("werks=1%202"), `expected encoded space in URL: ${url}`);
  });
});

describe("SapClient POST Zod schema validation", () => {
  it("postConfirmation rejects extra fields via schema.parse()", async () => {
    const client = new SapClient(CFG);
    await assert.rejects(
      // @ts-expect-error — runtime test: extra field bypasses TS but not Zod
      () => client.postConfirmation({ orderid: "1000000", operation: "0010", yield: 50, injected: true }),
      (e: unknown) => {
        assert.ok(e instanceof Error);
        assert.match(e.message, /unrecognized_keys|Unrecognized keys/);
        return true;
      },
    );
  });

  it("postConfirmation rejects wrong type for yield", async () => {
    const client = new SapClient(CFG);
    await assert.rejects(
      // @ts-expect-error — runtime test: string yield bypasses TS but not Zod
      () => client.postConfirmation({ orderid: "1000000", operation: "0010", yield: "fifty" }),
      (e: unknown) => {
        assert.ok(e instanceof Error);
        return true;
      },
    );
  });

  it("postGoodsReceipt rejects extra fields via schema.parse()", async () => {
    const client = new SapClient(CFG);
    await assert.rejects(
      // @ts-expect-error — runtime test
      () => client.postGoodsReceipt({ ebeln: "4500000001", ebelp: "00010", menge: 100, werks: "1000", lgort: "0001", evil: true }),
      (e: unknown) => {
        assert.ok(e instanceof Error);
        assert.match(e.message, /unrecognized_keys|Unrecognized keys/);
        return true;
      },
    );
  });

  it("postGoodsIssue rejects extra fields via schema.parse()", async () => {
    const client = new SapClient(CFG);
    await assert.rejects(
      // @ts-expect-error — runtime test
      () => client.postGoodsIssue({ orderid: "1000000", matnr: "20000001", menge: 50, werks: "1000", lgort: "0001", hack: "yes" }),
      (e: unknown) => {
        assert.ok(e instanceof Error);
        assert.match(e.message, /unrecognized_keys|Unrecognized keys/);
        return true;
      },
    );
  });

  it("postConfirmation accepts valid data through schema.parse()", async () => {
    globalThis.fetch = mockFetch(201, '{"orderid":"1000000","operation":"0010","yield":50,"scrap":0,"confNo":"00000100","confCnt":"0001","status":"confirmed"}');
    const result = await new SapClient(CFG).postConfirmation({ orderid: "1000000", operation: "0010", yield: 50 });
    assert.equal(result.orderid, "1000000");
  });

  it("postGoodsReceipt accepts valid data through schema.parse()", async () => {
    globalThis.fetch = mockFetch(201, '{"ebeln":"4500000001","ebelp":"00010","menge":100,"materialDocument":"5000000001","documentYear":"2026","status":"posted"}');
    const result = await new SapClient(CFG).postGoodsReceipt({ ebeln: "4500000001", ebelp: "00010", menge: 100, werks: "1000", lgort: "0001" });
    assert.equal(result.status, "posted");
  });

  it("postGoodsIssue accepts valid data through schema.parse()", async () => {
    globalThis.fetch = mockFetch(201, '{"orderid":"1000000","matnr":"20000001","menge":50,"materialDocument":"5000000002","documentYear":"2026","status":"posted"}');
    const result = await new SapClient(CFG).postGoodsIssue({ orderid: "1000000", matnr: "20000001", menge: 50, werks: "1000", lgort: "0001" });
    assert.equal(result.status, "posted");
  });
});

describe("SapClient Content-Type validation", () => {
  it("rejects 200 response with text/html content-type", async () => {
    globalThis.fetch = async () => new Response(
      "<html><body>SAP login page</body></html>",
      { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
    );
    await assert.rejects(
      () => new SapClient(CFG).ping(),
      (e: unknown) => {
        assert(e instanceof ZzapiMesHttpError);
        assert.equal(e.status, 502, "should report 502 for wrong content-type, not 200");
        assert.match(e.message, /text\/html|content-type/i, `expected content-type hint, got: ${e.message}`);
        return true;
      },
    );
  });

  it("accepts 200 response with application/json content-type", async () => {
    globalThis.fetch = async () => new Response(
      '{"ok":true,"sap_time":"20260422163000"}',
      { status: 200, headers: { "content-type": "application/json" } },
    );
    const result = await new SapClient(CFG).ping();
    assert.equal(result.ok, true);
  });

  it("accepts 200 response with application/json; charset=utf-8", async () => {
    globalThis.fetch = async () => new Response(
      '{"ok":true,"sap_time":"20260422163000"}',
      { status: 200, headers: { "content-type": "application/json; charset=utf-8" } },
    );
    const result = await new SapClient(CFG).ping();
    assert.equal(result.ok, true);
  });

  it("rejects 200 response with text/plain content-type", async () => {
    globalThis.fetch = async () => new Response(
      "Just some plain text",
      { status: 200, headers: { "content-type": "text/plain" } },
    );
    await assert.rejects(
      () => new SapClient(CFG).ping(),
      (e: unknown) => {
        assert(e instanceof ZzapiMesHttpError);
        assert.equal(e.status, 502);
        assert.match(e.message, /text\/plain|content-type/i, `expected content-type hint, got: ${e.message}`);
        return true;
      },
    );
  });
});

describe("SapClient ABAP error detection", () => {
  it("detects ABAP 422 with 'errors' (plural array) on GET", async () => {
    globalThis.fetch = async () => new Response(
      JSON.stringify({ errors: [{ message: "No authorization for transaction MB01" }, { message: "BWART 101 not allowed" }] }),
      { status: 422, headers: { "content-type": "application/json" } },
    );
    await assert.rejects(
      () => new SapClient(CFG).ping(),
      (e: unknown) => {
        assert(e instanceof ZzapiMesHttpError);
        assert.equal(e.status, 422);
        assert.match(e.message, /No authorization for transaction MB01/);
        assert.match(e.message, /BWART 101 not allowed/);
        return true;
      },
    );
  });

  it("detects ABAP 422 with 'errors' (plural array) on POST", async () => {
    globalThis.fetch = async () => new Response(
      JSON.stringify({ errors: [{ message: "Plant 1000 not allowed" }] }),
      { status: 422, headers: { "content-type": "application/json" } },
    );
    await assert.rejects(
      () => new SapClient(CFG).postConfirmation({ orderid: "1000000", operation: "0010", yield: 50 }),
      (e: unknown) => {
        assert(e instanceof ZzapiMesHttpError);
        assert.equal(e.status, 422);
        assert.match(e.message, /Plant 1000 not allowed/);
        return true;
      },
    );
  });

  it("handles 'errors' as string array (non-object entries)", async () => {
    globalThis.fetch = async () => new Response(
      JSON.stringify({ errors: ["Error one", "Error two"] }),
      { status: 422, headers: { "content-type": "application/json" } },
    );
    await assert.rejects(
      () => new SapClient(CFG).ping(),
      (e: unknown) => {
        assert(e instanceof ZzapiMesHttpError);
        assert.equal(e.status, 422);
        assert.match(e.message, /Error one/);
        assert.match(e.message, /Error two/);
        return true;
      },
    );
  });

  it("catches 4xx/5xx without 'error' or 'errors' field", async () => {
    globalThis.fetch = async () => new Response(
      JSON.stringify({ status: "rejected", code: "BACKFLUSH_CONFLICT" }),
      { status: 409, headers: { "content-type": "application/json" } },
    );
    await assert.rejects(
      () => new SapClient(CFG).postGoodsIssue({ orderid: "1000000", matnr: "20000001", menge: 50, werks: "1000", lgort: "0001" }),
      (e: unknown) => {
        assert(e instanceof ZzapiMesHttpError);
        assert.equal(e.status, 409);
        assert.match(e.message, /SAP error/);
        return true;
      },
    );
  });

  it("catches 500 with unrecognized body as SAP error", async () => {
    globalThis.fetch = async () => new Response(
      JSON.stringify({ dump: "SYSTEM_ERROR", stack: "..." }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
    await assert.rejects(
      () => new SapClient(CFG).ping(),
      (e: unknown) => {
        assert(e instanceof ZzapiMesHttpError);
        assert.equal(e.status, 500);
        assert.match(e.message, /SAP error/);
        return true;
      },
    );
  });

  it("detects 3xx redirect and throws descriptive error", async () => {
    // SapClient uses redirect: "manual" — SAP ICF may redirect to a login page
    // when the service is not activated. Without detection this produces a
    // confusing "Non-JSON response" error.
    globalThis.fetch = async () => new Response(null, {
      status: 302,
      headers: { location: "/sap/bc/bsp/sap/system_login.htm" },
    });
    await assert.rejects(
      () => new SapClient(CFG).ping(),
      (e: unknown) => {
        assert(e instanceof ZzapiMesHttpError);
        assert.equal(e.status, 302);
        assert.match(e.message, /redirect/i, `expected redirect hint, got: ${e.message}`);
        return true;
      },
    );
  });
});

describe("SapClient empty-string host validation", () => {
  it("rejects host that is only a scheme with no authority", () => {
    // "http://" passes ensureProtocol (has scheme) but produces broken URLs
    assert.throws(
      () => new SapClient({ host: "http://", client: 200, user: "u", password: "p" }),
      /non-empty|host/i,
      `"http://" should be rejected as an invalid host`,
    );
  });

  it("rejects host that is https:// with no authority", () => {
    assert.throws(
      () => new SapClient({ host: "https://", client: 200, user: "u", password: "p" }),
      /non-empty|host/i,
      `"https://" should be rejected as an invalid host`,
    );
  });
});

describe("readResponseBody byte-length check for multi-byte UTF-8", () => {
  it("rejects CJK response in no-reader fallback where byte length exceeds maxBytes but string length does not", async () => {
    // CJK characters: 3 bytes in UTF-8 but 1 char in JS string length.
    // 400 CJK chars = 400 string length but 1200 bytes > 500 limit.
    const cjkBody = "漢".repeat(400);
    assert.ok(cjkBody.length < 500, `string length ${cjkBody.length} should be under 500`);
    const byteLen = new TextEncoder().encode(cjkBody).byteLength;
    assert.ok(byteLen > 500, `byte length ${byteLen} should exceed 500`);

    // Simulate a Response with no body (body=null → getReader() returns undefined)
    // but text() returns CJK content. This hits the `if (!reader)` fallback path
    // which incorrectly uses text.length instead of byte length.
    const fakeRes = {
      headers: new Headers(),
      body: null,
      text: async () => cjkBody,
    } as unknown as Response;

    await assert.rejects(
      () => readResponseBody(fakeRes, 500),
      (err: unknown) => {
        assert(err instanceof ZzapiMesHttpError);
        assert.equal(err.status, 502);
        assert.match(err.message, /too large/);
        return true;
      },
    );
  });

  it("accepts CJK response in no-reader fallback when byte length is within maxBytes", async () => {
    const cjkBody = "字".repeat(100); // 100 chars × 3 bytes = 300 bytes
    const fakeRes = {
      headers: new Headers(),
      body: null,
      text: async () => cjkBody,
    } as unknown as Response;

    const text = await readResponseBody(fakeRes, 300);
    assert.equal(text.length, 100);
  });

  it("rejects CJK response in stream-error fallback where byte length exceeds maxBytes", async () => {
    const cjkBody = "漢".repeat(400); // 400 chars, 1200 bytes
    // Create a ReadableStream that throws after returning some data,
    // forcing the catch fallback path which uses text.length.
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
        controller.error(new Error("stream error"));
      },
    });
    // After stream errors, res.text() won't work, so mock text() to return CJK
    const origText = Response.prototype.text;
    const fakeRes = {
      headers: new Headers(),
      body: stream,
      get text() {
        // After stream error, the real text() would fail; simulate the fallback
        // scenario where a new read succeeds with CJK content.
        return async () => cjkBody;
      },
    } as unknown as Response;

    await assert.rejects(
      () => readResponseBody(fakeRes, 500),
      (err: unknown) => {
        assert(err instanceof ZzapiMesHttpError);
        assert.equal(err.status, 502);
        return true;
      },
    );
  });

  it("accepts response where streaming byte length equals maxBytes exactly", async () => {
    // ASCII: 1 byte per char — streaming path correctly uses byteLength
    const body = "a".repeat(1_048_576);
    const res = new Response(body, { status: 200 });
    const text = await readResponseBody(res);
    assert.equal(text.length, 1_048_576);
  });

  it("rejects streaming CJK response where byte length exceeds maxBytes", async () => {
    // CJK through the streaming path — already uses byteLength correctly,
    // this test confirms the streaming path rejects oversized CJK bodies.
    const cjkBody = "漢".repeat(400_000); // 1_200_000 bytes
    const res = new Response(cjkBody, { status: 200 });
    await assert.rejects(
      () => readResponseBody(res),
      (err: unknown) => {
        assert(err instanceof ZzapiMesHttpError);
        assert.equal(err.status, 502);
        return true;
      },
    );
  });
});

describe("SapClient 2xx non-200 status handling", () => {
  it("returns empty object for 204 No Content", async () => {
    // 204 has no body and typically no Content-Type — must not throw
    globalThis.fetch = async () => new Response(null, {
      status: 204,
      headers: { "content-type": "application/json" },
    });
    const result = await new SapClient(CFG).ping();
    assert.deepStrictEqual(result, {} as PingResponse);
  });

  it("parses JSON body for 206 Partial Content", async () => {
    globalThis.fetch = async () => new Response('{"ok":true,"sap_time":"20260422163000"}', {
      status: 206,
      headers: { "content-type": "application/json" },
    });
    const result = await new SapClient(CFG).ping();
    assert.equal((result as { ok: boolean }).ok, true);
  });

  it("returns empty object for 204 even without Content-Type header", async () => {
    // Some servers omit Content-Type on 204 No Content
    globalThis.fetch = async () => new Response(null, { status: 204 });
    const result = await new SapClient(CFG).ping();
    assert.deepStrictEqual(result, {} as PingResponse);
  });
});

describe("ZzapiMesHttpError message length cap", () => {
  it("truncates error messages exceeding max length", () => {
    const longMsg = "x".repeat(2000);
    const err = new ZzapiMesHttpError(500, longMsg);
    assert.ok(err.message.length < 2000, `message length ${err.message.length} should be capped below 2000`);
    assert.ok(err.message.endsWith("…") || err.message.length <= 1024,
      `truncated message should end with ellipsis or be within cap`);
  });
});
