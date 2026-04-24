import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SapClient, ZzapiMesClient, ZzapiMesHttpError, ensureProtocol, parseRetryAfter, readResponseBody, PingResponseSchema, PoResponseSchema, ErrorResponseSchema, ProdOrderResponseSchema, MaterialResponseSchema, StockResponseSchema, PoItemsResponseSchema, RoutingResponseSchema, WorkCenterResponseSchema, ConfirmationRequestSchema, ConfirmationResponseSchema, GoodsReceiptRequestSchema, GoodsReceiptResponseSchema, GoodsIssueRequestSchema, GoodsIssueResponseSchema, TokenResponseSchema, HealthzResponseSchema, ALL_SCOPES } from "../index.js";

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

  it("throws ZzapiMesHttpError on non-JSON response", async () => {
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

  it("calls onResponse hook on error response (500)", async () => {
    globalThis.fetch = mockFetch(500, '{"error":"Internal server error"}');
    const hookCalls: Array<{ url: string; status: number; durationMs: number }> = [];
    const client = new SapClient({
      ...CFG,
      onResponse: (ctx) => { hookCalls.push(ctx); },
    });
    await assert.rejects(() => client.ping());
    assert.equal(hookCalls.length, 1, "onResponse should fire even on error responses");
    assert.equal(hookCalls[0]!.status, 500);
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

  it("getMaterial omits werks query param when not provided", async () => {
    globalThis.fetch = mockFetch(200, '{"matnr":"10000001","mtart":"FERT","meins":"EA"}');
    await new SapClient(CFG).getMaterial("10000001");
    assert.match(capturedUrl!, /zzapi\/mes\/material.*matnr=10000001/);
    assert.ok(!capturedUrl!.includes("werks"), "werks should be absent when not provided");
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

  it("getStock without lgort omits lgort from URL", async () => {
    globalThis.fetch = mockFetch(200, '{"matnr":"10000001","werks":"1000","items":[{"lgort":"0001","clabs":250}]}');
    await new SapClient(CFG).getStock("10000001", "1000");
    assert.doesNotMatch(capturedUrl!, /lgort/, "lgort should not appear in URL when omitted");
    assert.match(capturedUrl!, /werks=1000/);
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

  it("re-throws unknown fetch errors (not AbortError/TypeError)", async () => {
    class CustomError extends Error { constructor() { super("custom"); this.name = "CustomError"; } }
    globalThis.fetch = async () => { throw new CustomError(); };
    const client = new SapClient(CFG);
    await assert.rejects(
      () => client.ping(),
      (err: unknown) => err instanceof CustomError,
    );
  });

  it("POST re-throws unknown fetch errors (not AbortError/TypeError)", async () => {
    class CustomError extends Error { constructor() { super("custom-post"); this.name = "CustomError"; } }
    globalThis.fetch = async () => { throw new CustomError(); };
    const client = new SapClient(CFG);
    await assert.rejects(
      () => client.postConfirmation({ orderid: "1000000", operation: "0010", yield: 50 }),
      (err: unknown) => err instanceof CustomError,
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

  it("rejects ftp:// scheme", () => {
    assert.throws(
      () => ensureProtocol("ftp://files.example.com"),
      /Unsupported URL scheme/,
    );
  });

  it("rejects data: scheme", () => {
    assert.throws(
      () => ensureProtocol("data:text/html,<h1>hi</h1>"),
      /Unsupported URL scheme/,
    );
  });

  it("rejects javascript: scheme", () => {
    assert.throws(
      () => ensureProtocol("javascript:alert(1)"),
      /Unsupported URL scheme/,
    );
  });

  it("rejects file:// scheme", () => {
    assert.throws(
      () => ensureProtocol("file:///etc/passwd"),
      /Unsupported URL scheme/,
    );
  });

  it("case-insensitive scheme rejection (FTP://)", () => {
    assert.throws(
      () => ensureProtocol("FTP://files.example.com"),
      /Unsupported URL scheme/,
    );
  });

  it("rejects protocol-relative URL (//host)", () => {
    assert.throws(
      () => ensureProtocol("//cdn.example.com"),
      /Protocol-relative URL/,
    );
  });

  it("rejects whitespace-only host", () => {
    assert.throws(
      () => ensureProtocol("   "),
      /non-empty string/,
    );
  });

  it("rejects empty string", () => {
    assert.throws(
      () => ensureProtocol(""),
      /non-empty string/,
    );
  });

  it("trims whitespace before processing", () => {
    assert.equal(ensureProtocol("  http://sap.test  "), "http://sap.test");
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

  it("ConfirmationRequestSchema rejects missing orderid", () => {
    assert.throws(
      () => ConfirmationRequestSchema.parse({ operation: "0010", yield: 50 }),
      (e: unknown) => e instanceof Error && e.message.includes("orderid"),
    );
  });

  it("ConfirmationRequestSchema rejects negative yield", () => {
    assert.throws(
      () => ConfirmationRequestSchema.parse({ orderid: "1000000", operation: "0010", yield: -1 }),
      (e: unknown) => e instanceof Error,
    );
  });

  it("ConfirmationRequestSchema rejects string menge", () => {
    assert.throws(
      () => ConfirmationRequestSchema.parse({ orderid: "1000000", operation: "0010", yield: "fifty" } as Record<string, unknown>),
      (e: unknown) => e instanceof Error,
    );
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

  it("GoodsReceiptRequestSchema rejects missing ebeln", () => {
    assert.throws(
      () => GoodsReceiptRequestSchema.parse({ ebelp: "00010", menge: 100, werks: "1000", lgort: "0001" }),
      (e: unknown) => e instanceof Error && e.message.includes("ebeln"),
    );
  });

  it("GoodsReceiptRequestSchema rejects negative menge", () => {
    assert.throws(
      () => GoodsReceiptRequestSchema.parse({ ebeln: "4500000001", ebelp: "00010", menge: -5, werks: "1000", lgort: "0001" }),
      (e: unknown) => e instanceof Error,
    );
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

  it("GoodsIssueRequestSchema rejects missing orderid", () => {
    assert.throws(
      () => GoodsIssueRequestSchema.parse({ matnr: "20000001", menge: 50, werks: "1000", lgort: "0001" }),
      (e: unknown) => e instanceof Error && e.message.includes("orderid"),
    );
  });

  it("GoodsIssueRequestSchema rejects negative menge", () => {
    assert.throws(
      () => GoodsIssueRequestSchema.parse({ orderid: "1000000", matnr: "20000001", menge: -10, werks: "1000", lgort: "0001" }),
      (e: unknown) => e instanceof Error,
    );
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
});

describe("SapClient Retry-After extraction from SAP 429", () => {
  it("extracts Retry-After header on 429 GET response", async () => {
    globalThis.fetch = async () => new Response(
      JSON.stringify({ error: "Too Many Requests" }),
      { status: 429, headers: { "retry-after": "30" } },
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
      { status: 429, headers: { "retry-after": "60" } },
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
      { status: 404, headers: { "retry-after": "30" } },
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

describe("SapClient GET safety-net: 4xx/5xx without error/errors field", () => {
  it("throws on GET 409 with no error/errors field", async () => {
    globalThis.fetch = async () => new Response(
      JSON.stringify({ status: "rejected" }),
      { status: 409 },
    );
    try {
      await new SapClient(CFG).getPo("4500000001");
      assert.fail("should have thrown");
    } catch (e) {
      assert.ok(e instanceof ZzapiMesHttpError);
      assert.equal(e.status, 409);
      assert.match(e.message, /SAP error \(HTTP 409\)/);
    }
  });

  it("detects 'errors' array on GET request (ABAP-style)", async () => {
    globalThis.fetch = async () => new Response(
      JSON.stringify({ errors: [{ type: "E", message: "No authorization" }] }),
      { status: 422 },
    );
    try {
      await new SapClient(CFG).getMaterial("10000001", "1000");
      assert.fail("should have thrown");
    } catch (e) {
      assert.ok(e instanceof ZzapiMesHttpError);
      assert.equal(e.status, 422);
      assert.match(e.message, /No authorization/);
    }
  });

  it("throws on GET 500 with unrecognized body", async () => {
    globalThis.fetch = async () => new Response(
      JSON.stringify({ dump: "core.log" }),
      { status: 500 },
    );
    try {
      await new SapClient(CFG).getMaterial("10000001", "1000");
      assert.fail("should have thrown");
    } catch (e) {
      assert.ok(e instanceof ZzapiMesHttpError);
      assert.equal(e.status, 500);
      assert.match(e.message, /SAP error \(HTTP 500\)/);
    }
  });
});

describe("SapClient constructor validation", () => {
  it("rejects empty host", () => {
    assert.throws(
      () => new SapClient({ host: "", client: 200, user: "u", password: "p" }),
      /non-empty string/,
    );
  });

  it("rejects whitespace-only host", () => {
    assert.throws(
      () => new SapClient({ host: "   ", client: 200, user: "u", password: "p" }),
      /non-empty string/,
    );
  });

  it("rejects empty user", () => {
    assert.throws(
      () => new SapClient({ host: BASE, client: 200, user: "", password: "p" }),
      /non-empty strings/,
    );
  });

  it("rejects empty password", () => {
    assert.throws(
      () => new SapClient({ host: BASE, client: 200, user: "u", password: "" }),
      /non-empty strings/,
    );
  });

  it("rejects timeout=0", () => {
    assert.throws(
      () => new SapClient({ host: BASE, client: 200, user: "u", password: "p", timeout: 0 }),
      /positive number/,
    );
  });

  it("rejects negative timeout", () => {
    assert.throws(
      () => new SapClient({ host: BASE, client: 200, user: "u", password: "p", timeout: -1000 }),
      /positive number/,
    );
  });

  it("rejects NaN timeout", () => {
    assert.throws(
      () => new SapClient({ host: BASE, client: 200, user: "u", password: "p", timeout: NaN }),
      /positive number/,
    );
  });

  it("accepts valid config with timeout", () => {
    const client = new SapClient({ host: BASE, client: 200, user: "u", password: "p", timeout: 5000 });
    assert.ok(client);
  });

  it("accepts valid config without timeout (uses default)", () => {
    const client = new SapClient({ host: BASE, client: 200, user: "u", password: "p" });
    assert.ok(client);
  });

  it("rejects whitespace-only user", () => {
    assert.throws(
      () => new SapClient({ host: BASE, client: 200, user: "   ", password: "p" }),
      /non-empty strings/,
    );
  });

  it("rejects whitespace-only password", () => {
    assert.throws(
      () => new SapClient({ host: BASE, client: 200, user: "u", password: "   " }),
      /non-empty strings/,
    );
  });

  it("trims whitespace-padded user and password before encoding", async () => {
    // " user " passes the .trim() validation check but the constructor
    // now also trims before encoding into btoa, preventing " user " from
    // producing btoa(" user : pass ") which would fail SAP auth.
    let capturedAuth = "";
    globalThis.fetch = async (input, init) => {
      capturedAuth = init?.headers instanceof Headers
        ? (init.headers as Headers).get("authorization") ?? ""
        : (init?.headers as Record<string, string>)?.Authorization ?? "";
      return new Response(
        JSON.stringify({ ok: true, sap_time: "20260422163000" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const client = new SapClient({ host: BASE, client: 200, user: " user ", password: " pass " });
    await client.ping();
    // btoa("user:pass") — whitespace stripped before encoding
    assert.equal(capturedAuth, `Basic ${btoa("user:pass")}`);
  });

  it("rejects config.client = 0", () => {
    assert.throws(
      () => new SapClient({ host: BASE, client: 0, user: "u", password: "p" }),
      /client.*positive/,
    );
  });

  it("rejects config.client = -1", () => {
    assert.throws(
      () => new SapClient({ host: BASE, client: -1, user: "u", password: "p" }),
      /client.*positive/,
    );
  });

  it("rejects config.client = NaN", () => {
    assert.throws(
      () => new SapClient({ host: BASE, client: NaN, user: "u", password: "p" }),
      /client.*positive/,
    );
  });

  it("rejects config.client = 1.5 (non-integer)", () => {
    assert.throws(
      () => new SapClient({ host: BASE, client: 1.5, user: "u", password: "p" }),
      /client.*positive/,
    );
  });

  it("accepts fractional timeout (0.5ms) — setTimeout clamps to 1ms minimum", () => {
    // 0.5 passes Number.isFinite && > 0 validation but Node setTimeout
    // treats sub-millisecond as 1ms. Constructor accepts it; runtime
    // behavior is Node's domain.
    const client = new SapClient({ host: BASE, client: 200, user: "u", password: "p", timeout: 0.5 });
    assert.ok(client);
  });
});

describe("ZzapiMesHttpError toString format", () => {
  it("default Error toString omits status and retryAfter", () => {
    const err = new ZzapiMesHttpError(429, "Too many requests", 30);
    // Default Error.prototype.toString only returns "Error: Too many requests"
    const str = err.toString();
    assert.ok(str.includes("Too many requests"), "should include message");
    // Documents that status/retryAfter are NOT in toString output
    assert.ok(!str.includes("429"), "status should NOT appear in default toString");
  });

  it("name property is ZzapiMesHttpError", () => {
    const err = new ZzapiMesHttpError(409, "conflict");
    assert.equal(err.name, "ZzapiMesHttpError");
  });

  it("toJSON() returns structured object (Error props are non-enumerable)", () => {
    const err = new ZzapiMesHttpError(429, "Too many requests", 30);
    const json = err.toJSON();
    assert.equal(json.name, "ZzapiMesHttpError");
    assert.equal(json.status, 429);
    assert.equal(json.message, "Too many requests");
    assert.equal(json.retryAfter, 30);
    assert.equal(json.originalStatus, undefined);
  });

  it("toJSON() omits undefined retryAfter/originalStatus", () => {
    const err = new ZzapiMesHttpError(502, "upstream error");
    const json = err.toJSON();
    assert.equal("retryAfter" in json, false);
    assert.equal("originalStatus" in json, false);
  });
});

describe("SapClient HTTP 200 with error/errors key", () => {
  it("does not throw on HTTP 200 with 'error' key (not a false-positive)", async () => {
    globalThis.fetch = async () => new Response(
      JSON.stringify({ ok: true, error: "warning: deprecated field" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    const result = await new SapClient(CFG).ping();
    assert.ok(result);
  });

  it("does not throw on HTTP 200 with 'errors' key (not a false-positive)", async () => {
    globalThis.fetch = async () => new Response(
      JSON.stringify({ ok: true, errors: ["non-blocking warning"] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    const result = await new SapClient(CFG).ping();
    assert.ok(result);
  });
});

describe("SapClient POST 409 GI backflush — message loss via safety net", () => {
  it("GI backflush 409 with {status:'rejected', message:'...'} loses message to safety net", async () => {
    // ABAP goods-issue backflush returns HTTP 409 with body:
    //   { status: "rejected", message: "Backflush is active for this order" }
    // Since there is no "error" or "errors" key, the safety net throws
    //   ZzapiMesHttpError(409, "SAP error (HTTP 409)")
    // The actual message is lost — this test documents the known limitation.
    globalThis.fetch = async () => new Response(
      JSON.stringify({ status: "rejected", message: "Backflux is active for this order" }),
      { status: 409, headers: { "content-type": "application/json" } },
    );
    try {
      await new SapClient(CFG).postGoodsIssue({ orderid: "4500000001", matnr: "10000001", menge: 1, werks: "1000", lgort: "0001" });
      assert.fail("should have thrown");
    } catch (e) {
      assert.ok(e instanceof ZzapiMesHttpError);
      assert.equal(e.status, 409);
      // Message is generic — the ABAP "Backflush is active..." is NOT preserved
      assert.match(e.message, /SAP error \(HTTP 409\)/);
      // This documents that the actual business message is currently lost.
      // Fix would require SapClient to check for a "message" key on 409 responses.
    }
  });

  it("does NOT follow redirects (GET) — uses redirect: manual", async () => {
    // Verify that SapClient sets redirect: "manual" on fetch to prevent
    // Basic-auth header leakage on 301/302 redirects.
    const redirectTarget = "http://evil.example.com/steal-auth";
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      // If redirect were "follow", fetch would follow the Location header.
      // With "manual", fetch returns the 302 response directly.
      capturedOpts = init;
      return new Response(null, {
        status: 302,
        headers: { location: redirectTarget },
      });
    };
    const c = new SapClient(CFG);
    try {
      await c.ping();
    } catch {
      // 302 response body is empty → JSON parse error — that's expected
    }
    assert.equal(capturedOpts?.redirect, "manual", "SapClient GET should use redirect: 'manual'");
  });

  it("does NOT follow redirects (POST) — uses redirect: manual", async () => {
    // Same check for POST requests (write-back routes carry auth + body).
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedOpts = init;
      return new Response(null, {
        status: 302,
        headers: { location: "http://evil.example.com/steal-auth" },
      });
    };
    const c = new SapClient(CFG);
    try {
      await c.postConfirmation({ orderid: "1234", operation: "0010", yield: 50 });
    } catch {
      // 302 response body is empty → JSON parse error
    }
    assert.equal(capturedOpts?.redirect, "manual", "SapClient POST should use redirect: 'manual'");
  });

  it("throws ZzapiMesHttpError on HTTP 200 with empty body", async () => {
    // SAP sometimes returns 200 with an empty body — JSON.parse("") throws.
    globalThis.fetch = async () => new Response("", { status: 200, headers: { "content-type": "application/json" } });
    const c = new SapClient(CFG);
    await assert.rejects(() => c.ping(), (err: unknown) => {
      assert.ok(err instanceof ZzapiMesHttpError);
      assert.equal(err.status, 200);
      assert.match(err.message, /Non-JSON/);
      return true;
    });
  });
});

describe("readResponseBody size limit", () => {
  it("reads a small response body without error", async () => {
    const res = new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
    const text = await readResponseBody(res, 1024);
    assert.equal(text, '{"ok":true}');
  });

  it("rejects response with Content-Length exceeding limit", async () => {
    const res = new Response("x", { status: 200, headers: { "content-length": "9999999" } });
    await assert.rejects(
      () => readResponseBody(res, 1024),
      (err: unknown) => err instanceof ZzapiMesHttpError && err.status === 502 && err.message.includes("too large"),
    );
  });

  it("rejects streamed response body exceeding limit", async () => {
    // Create a response with a large body but no Content-Length header
    const largeBody = "x".repeat(2000);
    const res = new Response(largeBody, { status: 200 });
    await assert.rejects(
      () => readResponseBody(res, 1024),
      (err: unknown) => err instanceof ZzapiMesHttpError && err.status === 502,
    );
  });

  it("allows response body exactly at the limit", async () => {
    const body = "x".repeat(100);
    const res = new Response(body, { status: 200 });
    const text = await readResponseBody(res, 100);
    assert.equal(text.length, 100);
  });
});

describe("SapClient response size limit integration", () => {
  it("throws 502 on oversized SAP response via GET", async () => {
    globalThis.fetch = async () => new Response("x".repeat(2_000_000), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    await assert.rejects(
      () => new SapClient(CFG).ping(),
      (err: unknown) => err instanceof ZzapiMesHttpError && err.status === 502 && err.message.includes("too large"),
    );
  });

  it("throws 502 on oversized SAP response via POST", async () => {
    globalThis.fetch = async () => new Response("x".repeat(2_000_000), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    await assert.rejects(
      () => new SapClient(CFG).postConfirmation({ orderid: "1000000", operation: "0010", yield: 50 }),
      (err: unknown) => err instanceof ZzapiMesHttpError && err.status === 502 && err.message.includes("too large"),
    );
  });
});
