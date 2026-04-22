import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SapClient, ZzapiMesClient, ZzapiMesHttpError, ensureProtocol, PingResponseSchema, PoResponseSchema, ErrorResponseSchema } from "../index.js";

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
});
