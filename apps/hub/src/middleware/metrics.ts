import type { MiddlewareHandler } from "hono";
import type { HubVariables } from "../types.js";
import { requestsTotal, requestDuration } from "../metrics.js";

/**
 * Route normalizer rules. First matching rule wins, so more specific prefixes
 * (e.g. "/po/:ebeln/items") MUST be listed before less specific ones
 * (e.g. "/po/:ebeln"). Exact matches are handled by the `exact` predicate.
 */
const ROUTE_RULES: Array<{ match: (path: string) => boolean; label: string }> = [
  { match: (p) => p === "/metrics", label: "/metrics" },
  { match: (p) => p === "/healthz", label: "/healthz" },
  { match: (p) => p === "/auth/token", label: "/auth/token" },
  { match: (p) => p.startsWith("/po/") && p.endsWith("/items"), label: "/po/:ebeln/items" },
  { match: (p) => p.startsWith("/po/"), label: "/po/:ebeln" },
  { match: (p) => p.startsWith("/prod-order/"), label: "/prod-order/:aufnr" },
  { match: (p) => p.startsWith("/material/"), label: "/material/:matnr" },
  { match: (p) => p.startsWith("/stock/"), label: "/stock/:matnr" },
  { match: (p) => p.startsWith("/routing/"), label: "/routing/:matnr" },
  { match: (p) => p.startsWith("/work-center/"), label: "/work-center/:arbpl" },
  { match: (p) => p === "/confirmation", label: "/confirmation" },
  { match: (p) => p === "/goods-receipt", label: "/goods-receipt" },
  { match: (p) => p === "/goods-issue", label: "/goods-issue" },
];

/** Normalize a request path to a low-cardinality metric label. Exported for tests. */
export function normalizeRoute(path: string): string {
  // Strip query string and trailing slash before matching
  let clean: string = path.split("?")[0]!;
  if (clean.length > 1 && clean.endsWith("/")) clean = clean.slice(0, -1);
  for (const rule of ROUTE_RULES) {
    if (rule.match(clean)) return rule.label;
  }
  return clean;
}

/** Middleware that records request metrics after the handler runs. */
export const metricsMiddleware: MiddlewareHandler<{ Variables: HubVariables }> = async (c, next) => {
  const start = performance.now();
  await next();
  const duration = (performance.now() - start) / 1000;
  const route = normalizeRoute(c.req.path);

  const keyId = c.get("jwtPayload")?.key_id ?? "-";
  const status = String(c.res.status);

  requestsTotal.labels({ route, status, key_id: keyId }).inc();
  requestDuration.labels({ route }).observe(duration);
};
