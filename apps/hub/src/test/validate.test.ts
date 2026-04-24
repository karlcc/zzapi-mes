import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { validateParam } from "../routes/validate.js";

function makeApp() {
  const app = new Hono();
  app.get("/test/:id", (c) => {
    const err = validateParam(c, "id", c.req.param("id"), 10);
    if (err) return err;
    return c.json({ ok: true });
  });
  app.get("/query", (c) => {
    const err = validateParam(c, "werks", c.req.query("werks") ?? "", 4, "query");
    if (err) return err;
    return c.json({ ok: true });
  });
  return app;
}

describe("validateParam", () => {
  const app = makeApp();

  it("accepts valid path param", async () => {
    const res = await app.fetch(new Request("http://localhost/test/12345"));
    assert.equal(res.status, 200);
  });

  it("rejects empty path param", async () => {
    // Hono won't route an empty segment, so test validateParam directly
    const sub = new Hono();
    sub.get("/x", (c) => {
      const err = validateParam(c, "id", "", 10);
      if (err) return err;
      return c.json({ ok: true });
    });
    const res = await sub.fetch(new Request("http://localhost/x"));
    assert.equal(res.status, 400);
    const body = await res.json() as Record<string, unknown>;
    assert.ok(String(body.error).includes("must not be empty"));
  });

  it("rejects path param exceeding maxLength", async () => {
    const res = await app.fetch(new Request(`http://localhost/test/${"A".repeat(11)}`));
    assert.equal(res.status, 400);
    const body = await res.json() as Record<string, unknown>;
    assert.ok(String(body.error).includes("id"));
    assert.ok(String(body.error).includes("maximum length"));
  });

  it("rejects path param with special characters", async () => {
    const res = await app.fetch(new Request("http://localhost/test/abc%3Bdef"));
    assert.equal(res.status, 400);
    const body = await res.json() as Record<string, unknown>;
    assert.ok(String(body.error).includes("invalid characters"));
  });

  it("accepts valid query param", async () => {
    const res = await app.fetch(new Request("http://localhost/query?werks=1000"));
    assert.equal(res.status, 200);
  });

  it("rejects empty query param", async () => {
    const res = await app.fetch(new Request("http://localhost/query?werks="));
    assert.equal(res.status, 400);
    const body = await res.json() as Record<string, unknown>;
    assert.ok(String(body.error).includes("must not be empty"));
  });

  it("rejects query param exceeding maxLength", async () => {
    const res = await app.fetch(new Request("http://localhost/query?werks=ABCDE"));
    assert.equal(res.status, 400);
    const body = await res.json() as Record<string, unknown>;
    assert.ok(String(body.error).includes("werks"));
    assert.ok(String(body.error).includes("maximum length"));
  });

  it("rejects query param with special characters", async () => {
    const res = await app.fetch(new Request("http://localhost/query?werks=1%27OR"));
    assert.equal(res.status, 400);
    const body = await res.json() as Record<string, unknown>;
    assert.ok(String(body.error).includes("invalid characters"));
  });

  it("uses 'Query parameter' label for source=query", async () => {
    const res = await app.fetch(new Request("http://localhost/query?werks="));
    const body = await res.json() as Record<string, unknown>;
    assert.ok(String(body.error).includes("Query parameter"));
  });

  it("uses 'Parameter' label for source=path (default)", async () => {
    const res = await app.fetch(new Request(`http://localhost/test/${"A".repeat(11)}`));
    const body = await res.json() as Record<string, unknown>;
    assert.ok(String(body.error).includes("Parameter"));
    assert.ok(!String(body.error).includes("Query parameter"));
  });

  it("accepts path param at exactly maxLength", async () => {
    const res = await app.fetch(new Request(`http://localhost/test/${"1".repeat(10)}`));
    assert.equal(res.status, 200);
  });

  it("accepts SAP work-center IDs containing hyphens and underscores", async () => {
    // SAP work-center (ARBPL) and similar identifiers can contain '-' and '_'
    // alongside alphanumerics. Reject regex must not block these valid IDs.
    const sub = new Hono();
    sub.get("/w/:arbpl", (c) => {
      const err = validateParam(c, "arbpl", c.req.param("arbpl"), 8);
      if (err) return err;
      return c.json({ ok: true });
    });
    for (const id of ["TURN-1", "WC_01", "A-B_C"]) {
      const res = await sub.fetch(new Request(`http://localhost/w/${id}`));
      assert.equal(res.status, 200, `expected 200 for '${id}', got ${res.status}`);
    }
  });

  it("still rejects disallowed punctuation (dot, slash, quote, semicolon)", async () => {
    const sub = new Hono();
    sub.get("/w/:arbpl", (c) => {
      const err = validateParam(c, "arbpl", c.req.param("arbpl"), 8);
      if (err) return err;
      return c.json({ ok: true });
    });
    for (const id of ["TURN.1", "a;b", "a'b"]) {
      const res = await sub.fetch(new Request(`http://localhost/w/${encodeURIComponent(id)}`));
      assert.equal(res.status, 400, `expected 400 for '${id}'`);
      const body = await res.json() as Record<string, unknown>;
      assert.ok(String(body.error).includes("invalid characters"));
    }
  });

  it("accepts alphanumeric-only path param with leading zeros", async () => {
    // Use a value within the test app's maxLength (10)
    const sub = new Hono();
    sub.get("/x/:id", (c) => {
      const err = validateParam(c, "id", c.req.param("id"), 18);
      if (err) return err;
      return c.json({ ok: true });
    });
    const res = await sub.fetch(new Request("http://localhost/x/003010000608"));
    assert.equal(res.status, 200);
  });

  it("rejects any non-empty input when maxLength=0", async () => {
    const sub = new Hono();
    sub.get("/x/:id", (c) => {
      const err = validateParam(c, "id", c.req.param("id"), 0);
      if (err) return err;
      return c.json({ ok: true });
    });
    const res = await sub.fetch(new Request("http://localhost/x/a"));
    assert.equal(res.status, 400);
    const body = await res.json() as Record<string, unknown>;
    assert.ok(String(body.error).includes("maximum length"), `expected maxLength error, got: ${body.error}`);
  });

  it("rejects Unicode characters in path param (CJK)", async () => {
    const sub = new Hono();
    sub.get("/x/:id", (c) => {
      const err = validateParam(c, "id", c.req.param("id"), 18);
      if (err) return err;
      return c.json({ ok: true });
    });
    const res = await sub.fetch(new Request("http://localhost/x/\u6D4B\u8BD5"));
    assert.equal(res.status, 400);
    const body = await res.json() as Record<string, unknown>;
    assert.ok(String(body.error).includes("invalid characters"));
  });

  it("rejects Unicode characters in query param (emoji)", async () => {
    const res = await app.fetch(new Request("http://localhost/query?werks=\u{1F600}"));
    assert.equal(res.status, 400);
    const body = await res.json() as Record<string, unknown>;
    assert.ok(String(body.error).includes("invalid characters"));
  });

  it("rejects query param with non-ASCII accented characters", async () => {
    const res = await app.fetch(new Request("http://localhost/query?werks=caf%C3%A9"));
    assert.equal(res.status, 400);
    const body = await res.json() as Record<string, unknown>;
    assert.ok(String(body.error).includes("invalid characters"));
  });

  it("accepts query param with hyphen and underscore via source:query", async () => {
    // Hyphens and underscores are valid in SAP identifiers (e.g. work-center IDs)
    const sub = new Hono();
    sub.get("/q", (c) => {
      const err = validateParam(c, "arbpl", c.req.query("arbpl") ?? "", 8, "query");
      if (err) return err;
      return c.json({ ok: true });
    });
    const res = await sub.fetch(new Request("http://localhost/q?arbpl=TURN-1"));
    assert.equal(res.status, 200);
  });

  it("normalizes NFD input to NFC before validation", async () => {
    // NFD (decomposed) é = e + combining accent (2 codepoints)
    // NFC (composed) é = single codepoint (1 codepoint)
    // SAP IDs are ASCII-only, but NFC normalization ensures NFD-vs-NFC
    // mismatch cannot bypass or reject valid identifiers.
    const sub = new Hono();
    sub.get("/x/:id", (c) => {
      const err = validateParam(c, "id", c.req.param("id"), 18);
      if (err) return err;
      return c.json({ ok: true });
    });
    // NFD-encoded "cafe\u0301" — the combining accent makes it non-ASCII
    // so it should be rejected by the alphanumeric regex regardless of NFC normalization.
    const nfdValue = "cafe\u0301";
    const res = await sub.fetch(new Request(`http://localhost/x/${encodeURIComponent(nfdValue)}`));
    assert.equal(res.status, 400, "NFD non-ASCII should be rejected by alphanumeric check");
    const body = await res.json() as Record<string, unknown>;
    assert.ok(String(body.error).includes("invalid characters"));
  });

  it("NFC normalization does not alter valid ASCII identifiers", async () => {
    // Ensure NFC normalization doesn't accidentally break valid SAP IDs
    const sub = new Hono();
    sub.get("/x/:id", (c) => {
      const err = validateParam(c, "id", c.req.param("id"), 18);
      if (err) return err;
      return c.json({ ok: true });
    });
    const res = await sub.fetch(new Request("http://localhost/x/3010000608"));
    assert.equal(res.status, 200);
  });
});
