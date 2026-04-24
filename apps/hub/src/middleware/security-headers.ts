import type { MiddlewareHandler } from "hono";

/**
 * Adds security headers to all responses.
 *
 * HSTS is emitted when HUB_HSTS=1 (opt-in) — only turn this on when the hub
 * is served over HTTPS, since HSTS on plaintext would make the service
 * permanently unreachable from affected browsers. TLS termination typically
 * happens at a reverse proxy (nginx/Caddy) in front of the hub.
 */
export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "no-referrer");
  if (process.env.HUB_HSTS === "1") {
    c.header("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  }
  // Cache-Control: no-store on all authenticated routes to prevent
  // intermediary caching of sensitive data (tokens, SAP business data).
  // Unauthenticated routes (/healthz, /metrics) don't need this.
  if (c.req.path === "/auth/token" || c.get("jwtPayload")) {
    c.header("Cache-Control", "no-store");
  }
};
