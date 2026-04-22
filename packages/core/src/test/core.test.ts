import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SapClient, ZzapiMesClient, ZzapiMesHttpError, ensureProtocol, PingResponseSchema, PoResponseSchema, ErrorResponseSchema, ProdOrderResponseSchema, MaterialResponseSchema, StockResponseSchema, PoItemsResponseSchema, RoutingResponseSchema, WorkCenterResponseSchema, ConfirmationRequestSchema, ConfirmationResponseSchema, GoodsReceiptRequestSchema, GoodsReceiptResponseSchema, GoodsIssueRequestSchema, GoodsIssueResponseSchema, TokenResponseSchema, HealthzResponseSchema, ALL_SCOPES } from "../index.js";

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
    assert.match(capturedUrl!, /zzapi_mes_ping.*sap-client=200/);
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
    assert.match(hookCalls[0]!.url, /zzapi_mes_ping/);
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

  // Phase 5A methods

  it("getProdOrder builds correct URL", async () => {
    globalThis.fetch = mockFetch(200, '{"aufnr":"1000000","auart":"PP01","werks":"1000","matnr":"10000001","gamng":1000,"gstrp":"20260401","gltrp":"20260415"}');
    await new SapClient(CFG).getProdOrder("1000000");
    assert.match(capturedUrl!, /zzapi_mes_prod_order.*aufnr=1000000/);
  });

  it("getMaterial builds correct URL with optional werks", async () => {
    globalThis.fetch = mockFetch(200, '{"matnr":"10000001","mtart":"FERT","meins":"EA"}');
    await new SapClient(CFG).getMaterial("10000001", "1000");
    assert.match(capturedUrl!, /zzapi_mes_material.*matnr=10000001.*werks=1000/);
  });

  it("getStock builds correct URL with required werks", async () => {
    globalThis.fetch = mockFetch(200, '{"matnr":"10000001","werks":"1000","items":[{"lgort":"0001","clabs":250}]}');
    await new SapClient(CFG).getStock("10000001", "1000");
    assert.match(capturedUrl!, /zzapi_mes_stock.*matnr=10000001.*werks=1000/);
  });

  it("getStock includes optional lgort", async () => {
    globalThis.fetch = mockFetch(200, '{"matnr":"10000001","werks":"1000","items":[{"lgort":"0001","clabs":250}]}');
    await new SapClient(CFG).getStock("10000001", "1000", "0001");
    assert.match(capturedUrl!, /lgort=0001/);
  });

  it("getPoItems builds correct URL", async () => {
    globalThis.fetch = mockFetch(200, '{"ebeln":"4500000001","items":[{"ebelp":"00010","matnr":"10000001","menge":100,"meins":"EA"}]}');
    await new SapClient(CFG).getPoItems("4500000001");
    assert.match(capturedUrl!, /zzapi_mes_po_items.*ebeln=4500000001/);
  });

  it("getRouting builds correct URL", async () => {
    globalThis.fetch = mockFetch(200, '{"matnr":"10000001","werks":"1000","plnnr":"50000123","operations":[{"vornr":"0010","ltxa1":"Turning"}]}');
    await new SapClient(CFG).getRouting("10000001", "1000");
    assert.match(capturedUrl!, /zzapi_mes_routing.*matnr=10000001.*werks=1000/);
  });

  it("getWorkCenter builds correct URL", async () => {
    globalThis.fetch = mockFetch(200, '{"arbpl":"TURN1","werks":"1000","ktext":"CNC Turning Center","steus":"PP01"}');
    await new SapClient(CFG).getWorkCenter("TURN1", "1000");
    assert.match(capturedUrl!, /zzapi_mes_wc.*arbpl=TURN1.*werks=1000/);
  });

  it("postConfirmation sends POST with JSON body to zzapi_mes_conf", async () => {
    globalThis.fetch = mockFetch(201, '{"orderid":"1000000","operation":"0010","yield":50,"scrap":0,"confNo":"00000100","confCnt":"0001","status":"confirmed"}');
    const res = await new SapClient(CFG).postConfirmation({ orderid: "1000000", operation: "0010", yield: 50 });
    assert.equal(capturedOpts?.method, "POST");
    assert.match(capturedUrl!, /zzapi_mes_conf/);
    assert.match(capturedUrl!, /sap-client=200/);
    assert.equal(res.status, "confirmed");
    const body = JSON.parse(capturedOpts?.body as string);
    assert.equal(body.orderid, "1000000");
  });

  it("postGoodsReceipt sends POST with JSON body to zzapi_mes_gr", async () => {
    globalThis.fetch = mockFetch(201, '{"ebeln":"4500000001","ebelp":"00010","menge":100,"materialDocument":"5000000001","documentYear":"2026","status":"posted"}');
    const res = await new SapClient(CFG).postGoodsReceipt({ ebeln: "4500000001", ebelp: "00010", menge: 100, werks: "1000", lgort: "0001" });
    assert.equal(capturedOpts?.method, "POST");
    assert.match(capturedUrl!, /zzapi_mes_gr/);
    assert.equal(res.status, "posted");
  });

  it("postGoodsIssue sends POST with JSON body to zzapi_mes_gi", async () => {
    globalThis.fetch = mockFetch(201, '{"orderid":"1000000","matnr":"20000001","menge":50,"materialDocument":"5000000002","documentYear":"2026","status":"posted"}');
    const res = await new SapClient(CFG).postGoodsIssue({ orderid: "1000000", matnr: "20000001", menge: 50, werks: "1000", lgort: "0001" });
    assert.equal(capturedOpts?.method, "POST");
    assert.match(capturedUrl!, /zzapi_mes_gi/);
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
