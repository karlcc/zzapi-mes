import type { MiddlewareHandler } from "hono";
import { requestsTotal, requestDuration } from "../metrics.js";

/** Middleware that records request metrics after the handler runs. */
export const metricsMiddleware: MiddlewareHandler = async (c, next) => {
  const start = performance.now();
  await next();
  const duration = (performance.now() - start) / 1000;
  const route = c.req.path === "/metrics" ? "/metrics"
    : c.req.path === "/healthz" ? "/healthz"
    : c.req.path === "/auth/token" ? "/auth/token"
    : c.req.path.startsWith("/po/") && c.req.path.endsWith("/items") ? "/po/:ebeln/items"
    : c.req.path.startsWith("/po/") ? "/po/:ebeln"
    : c.req.path.startsWith("/prod-order/") ? "/prod-order/:aufnr"
    : c.req.path.startsWith("/material/") ? "/material/:matnr"
    : c.req.path.startsWith("/stock/") ? "/stock/:matnr"
    : c.req.path.startsWith("/routing/") ? "/routing/:matnr"
    : c.req.path.startsWith("/work-center/") ? "/work-center/:arbpl"
    : c.req.path === "/confirmation" ? "/confirmation"
    : c.req.path === "/goods-receipt" ? "/goods-receipt"
    : c.req.path === "/goods-issue" ? "/goods-issue"
    : c.req.path;

  const keyId = (c.get("jwtPayload") as Record<string, unknown> | undefined)?.key_id as string ?? "-";
  const status = String(c.res.status);

  requestsTotal.labels({ route, status, key_id: keyId }).inc();
  requestDuration.labels({ route }).observe(duration);
};
