import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { metricsMiddleware, normalizeRoute } from "../middleware/metrics.js";
import { register, requestsTotal, requestDuration, sapDuration } from "../metrics.js";
import type { HubVariables } from "../types.js";

/** Build a minimal app that runs the metrics middleware and sets a jwtPayload. */
function buildApp(): Hono<{ Variables: HubVariables }> {
  const app = new Hono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    c.set("jwtPayload", {
      key_id: "test-key",
      scopes: ["ping"],
      iat: 0,
      exp: 0,
      rate_limit_per_min: null,
    });
    await next();
  });
  app.use("*", metricsMiddleware);
  app.all("*", (c) => c.json({ ok: true }));
  return app;
}

async function getRouteLabelFromCounter(): Promise<string[]> {
  const metrics = await register.getMetricsAsJSON();
  const counter = metrics.find((m) => m.name === "zzapi_hub_requests_total");
  if (!counter || !("values" in counter)) return [];
  return (counter.values as Array<{ labels: { route?: string } }>)
    .map((v) => v.labels.route ?? "")
    .filter((r): r is string => !!r);
}

describe("metrics middleware route normalization", () => {
  beforeEach(() => {
    requestsTotal.reset();
    requestDuration.reset();
  });

  const cases: Array<{ path: string; expected: string }> = [
    { path: "/metrics", expected: "/metrics" },
    { path: "/healthz", expected: "/healthz" },
    { path: "/auth/token", expected: "/auth/token" },
    { path: "/po/4500000001", expected: "/po/:ebeln" },
    { path: "/po/4500000001/items", expected: "/po/:ebeln/items" },
    { path: "/prod-order/1000000", expected: "/prod-order/:aufnr" },
    { path: "/material/20000001", expected: "/material/:matnr" },
    { path: "/stock/20000001", expected: "/stock/:matnr" },
    { path: "/routing/20000001", expected: "/routing/:matnr" },
    { path: "/work-center/TURN1", expected: "/work-center/:arbpl" },
    { path: "/confirmation", expected: "/confirmation" },
    { path: "/goods-receipt", expected: "/goods-receipt" },
    { path: "/goods-issue", expected: "/goods-issue" },
    { path: "/unknown", expected: "unknown" }, // fallback bounded label
  ];

  for (const { path, expected } of cases) {
    it(`normalizes ${path} → ${expected}`, async () => {
      const app = buildApp();
      await app.request(path, { method: path === "/confirmation" || path === "/goods-receipt" || path === "/goods-issue" ? "POST" : "GET" });
      const routes = await getRouteLabelFromCounter();
      assert.ok(routes.includes(expected), `expected ${expected}, got ${JSON.stringify(routes)}`);
    });
  }

  it("records zero-scope key_id as '-' when jwtPayload missing", async () => {
    const app = new Hono<{ Variables: HubVariables }>();
    app.use("*", metricsMiddleware);
    app.get("*", (c) => c.json({ ok: true }));
    await app.request("/healthz");
    const metrics = await register.getMetricsAsJSON();
    const counter = metrics.find((m) => m.name === "zzapi_hub_requests_total");
    const values = (counter as { values: Array<{ labels: { key_id?: string } }> }).values;
    assert.ok(values.some((v) => v.labels.key_id === "-"));
  });
});

describe("normalizeRoute", () => {
  it("maps dynamic read paths to parameterized labels", () => {
    assert.equal(normalizeRoute("/po/3010000608"), "/po/:ebeln");
    assert.equal(normalizeRoute("/po/3010000608/items"), "/po/:ebeln/items");
    assert.equal(normalizeRoute("/prod-order/1000000"), "/prod-order/:aufnr");
    assert.equal(normalizeRoute("/material/10000001"), "/material/:matnr");
    assert.equal(normalizeRoute("/stock/10000001"), "/stock/:matnr");
    assert.equal(normalizeRoute("/routing/10000001"), "/routing/:matnr");
    assert.equal(normalizeRoute("/work-center/TURN1"), "/work-center/:arbpl");
  });

  it("maps exact paths unchanged", () => {
    assert.equal(normalizeRoute("/metrics"), "/metrics");
    assert.equal(normalizeRoute("/healthz"), "/healthz");
    assert.equal(normalizeRoute("/auth/token"), "/auth/token");
    assert.equal(normalizeRoute("/confirmation"), "/confirmation");
    assert.equal(normalizeRoute("/goods-receipt"), "/goods-receipt");
    assert.equal(normalizeRoute("/goods-issue"), "/goods-issue");
  });

  it("returns bounded 'unknown' for unrecognized paths", () => {
    assert.equal(normalizeRoute("/some/unknown/path"), "unknown");
    assert.equal(normalizeRoute("/"), "unknown");
  });

  it("prefers /po/:ebeln/items over /po/:ebeln (rule ordering)", () => {
    // Regression guard: if rule ordering breaks, /po/X/items would match /po/:ebeln first
    assert.equal(normalizeRoute("/po/4500000001/items"), "/po/:ebeln/items");
  });

  it("strips query strings before matching", () => {
    assert.equal(normalizeRoute("/po/3010000608?foo=bar"), "/po/:ebeln");
    assert.equal(normalizeRoute("/auth/token?unused=1"), "/auth/token");
  });

  it("strips trailing slashes before matching", () => {
    assert.equal(normalizeRoute("/metrics/"), "/metrics");
    assert.equal(normalizeRoute("/po/3010000608/"), "/po/:ebeln");
  });

  it("strips both query string and trailing slash", () => {
    assert.equal(normalizeRoute("/healthz/?format=json"), "/healthz");
  });
});

describe("histogram bucket configuration", () => {
  it("includes sub-millisecond bucket (0.005) for high-resolution timing", () => {
    // Requests <10ms fall into the <0.01 bucket with no resolution.
    // A 0.005 bucket allows distinguishing 1-5ms from 5-10ms responses.
    const histObj = requestDuration as unknown as { buckets: number[] };
    assert.ok(histObj.buckets.includes(0.005), `expected 0.005 bucket, got [${histObj.buckets}]`);
  });

  it("sapDuration includes sub-millisecond bucket (0.005)", () => {
    const histObj = sapDuration as unknown as { buckets: number[] };
    assert.ok(histObj.buckets.includes(0.005), `expected 0.005 bucket, got [${histObj.buckets}]`);
  });
});

describe("registry isolation between test suites", () => {
  it("resetMetrics() zeroes all values without de-registering metrics", async () => {
    // Produce a labelled observation
    requestsTotal.labels({ route: "/ping", status: "200", key_id: "isolation-test" }).inc();
    const before = await register.getMetricsAsJSON();
    const counter = before.find((m) => m.name === "zzapi_hub_requests_total");
    assert.ok(counter, "requestsTotal counter should exist after inc()");
    const values = (counter as { values: Array<{ labels: { key_id?: string }; value: number }> }).values;
    assert.ok(values.some((v) => v.labels.key_id === "isolation-test" && v.value > 0));

    // resetMetrics zeroes values but keeps metrics registered
    register.resetMetrics();
    const after = await register.getMetricsAsJSON();
    const counterAfter = after.find((m) => m.name === "zzapi_hub_requests_total");
    assert.ok(counterAfter, "metric should still be registered after resetMetrics()");
    const valuesAfter = (counterAfter as { values: Array<{ value: number }> }).values;
    assert.ok(valuesAfter.every((v) => v.value === 0), "all values should be 0 after resetMetrics()");
  });

  it("clear() removes all metrics from registry (deregisters them)", async () => {
    register.clear();
    const metrics = await register.getMetricsAsJSON();
    assert.equal(metrics.length, 0, "registry should be empty after clear()");
  });
});
