import { createMiddleware } from "hono/factory";
import type { HubVariables } from "../types.js";

const JWT_SECRET = () => process.env.HUB_JWT_SECRET ?? "";

/** Reject requests with wrong HTTP method. Must be placed before JWT/scope
 *  middleware so 405 takes priority over 401/400/etc. */
export function methodGuard(method: string) {
  return createMiddleware<{ Variables: HubVariables }>(async (c, next) => {
    if (c.req.method !== method) {
      return c.json({ error: "Method not allowed" }, 405);
    }
    await next();
  });
}

/** Verify bearer JWT on protected routes. Sets c.set("jwtPayload"). */
export const requireJwt = createMiddleware<{ Variables: HubVariables }>(async (c, next) => {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    return c.json({ error: "Missing or malformed Authorization header" }, 401);
  }
  const token = header.slice(7);
  try {
    const { verify } = await import("hono/jwt");
    const payload = await verify(token, JWT_SECRET(), "HS256");
    // Reject tokens with empty/missing key_id — these would pollute audit logs
    // with untraceable entries. Tokens issued by /auth/token always have a
    // non-empty key_id, so this only catches manually crafted or misused JWTs.
    if (!payload.key_id || typeof payload.key_id !== "string" || payload.key_id.trim() === "") {
      return c.json({ error: "Invalid token: missing key_id" }, 401);
    }
    c.set("jwtPayload", payload);
    await next();
  } catch {
    return c.json({ error: "Invalid or expired token" }, 401);
  }
});

/** Require that the JWT payload includes a specific scope. */
export function requireScope(scope: string) {
  return createMiddleware<{ Variables: HubVariables }>(async (c, next) => {
    const payload = c.get("jwtPayload");
    const scopes = Array.isArray(payload?.scopes) ? payload.scopes : [];
    if (!scopes.includes(scope)) {
      return c.json({ error: `Insufficient scope: requires '${scope}'` }, 403);
    }
    await next();
  });
}
