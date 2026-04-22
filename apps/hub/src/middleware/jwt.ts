import { createMiddleware } from "hono/factory";
import type { JWTPayload } from "hono/utils/jwt/types";

const JWT_SECRET = () => process.env.HUB_JWT_SECRET ?? "";

/** Verify bearer JWT on protected routes. Sets c.set("jwtPayload"). */
export const requireJwt = createMiddleware<{
  Variables: { jwtPayload: JWTPayload };
}>(async (c, next) => {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    return c.json({ error: "Missing or malformed Authorization header" }, 401);
  }
  const token = header.slice(7);
  try {
    const { verify } = await import("hono/jwt");
    const payload = await verify(token, JWT_SECRET(), "HS256");
    c.set("jwtPayload", payload);
    await next();
  } catch {
    return c.json({ error: "Invalid or expired token" }, 401);
  }
});
