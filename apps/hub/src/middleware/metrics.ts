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
    : c.req.path.startsWith("/po/") ? "/po/:ebeln"
    : c.req.path;

  const keyId = (c.get("jwtPayload") as Record<string, unknown> | undefined)?.key_id as string ?? "-";
  const status = String(c.res.status);

  requestsTotal.labels({ route, status, key_id: keyId }).inc();
  requestDuration.labels({ route }).observe(duration);
};
