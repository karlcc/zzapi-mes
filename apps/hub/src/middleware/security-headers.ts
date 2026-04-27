import type { MiddlewareHandler } from "hono";

/**
 * Adds security headers to all responses.
 *
 * HSTS is emitted when HUB_HSTS=1 (opt-in) — only turn this on when the hub
 * is served over HTTPS, since HSTS on plaintext would make the service
 * permanently unreachable from affected browsers. TLS termination typically
 * happens at a reverse proxy (nginx/Caddy) in front of the hub.
 *
 * The /docs endpoint has a relaxed CSP to allow ReDoc CDN scripts and inline
 * spec injection. All other endpoints use strict CSP (default-src 'none').
 */
export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "no-referrer");

  // ReDoc /docs page needs: script-src for cdn.redoc.ly + inline spec,
  // style-src for ReDoc's dynamic styles, img-src for any spec images.
  if (c.req.path === "/docs" || c.req.path === "/docs/") {
    c.header("Content-Security-Policy",
      "default-src 'none'; script-src cdn.redoc.ly 'unsafe-inline'; style-src 'unsafe-inline' cdn.redoc.ly; img-src data:; frame-ancestors 'none'");
  } else {
    c.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  }

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
