import type { MiddlewareHandler } from "hono";

/** Adds security headers to all responses. */
export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  // Cache-Control: no-store on /auth/token to prevent token caching
  if (c.req.path === "/auth/token") {
    c.header("Cache-Control", "no-store");
  }
};
