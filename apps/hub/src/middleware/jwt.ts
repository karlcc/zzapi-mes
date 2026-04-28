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
    // Validate rate_limit_per_min type — a compromised JWT secret or bug in
    // token signing could inject non-number values that bypass the ?? fallback
    // in rate-limit.ts, causing NaN arithmetic (DoS for that key).
    // NaN and Infinity satisfy typeof === "number" but are not finite — they
    // cause NaN/Infinity token-bucket arithmetic, either rate-limiting every
    // request (NaN) or never rate-limiting (Infinity).
    const rpm = payload.rate_limit_per_min;
    if (rpm !== undefined && rpm !== null && (typeof rpm !== "number" || !Number.isFinite(rpm))) {
      return c.json({ error: "Invalid token: bad rate_limit_per_min" }, 401);
    }
    // Reject tokens minted far in the future — indicates clock skew or
    // deliberate backdating. hono/jwt verify() rejects future iat already,
    // but we add an explicit defense-in-depth check with configurable leeway
    // in case verify()'s behavior changes across Hono versions.
    const nowSec = Math.floor(Date.now() / 1000);
    const iatLeeway = 60;
    if (typeof payload.iat === "number" && payload.iat > nowSec + iatLeeway) {
      return c.json({ error: "Invalid token: future iat" }, 401);
    }
    // Validate aud claim if present — prevents cross-instance token confusion
    // when multiple hub instances share a JWT secret. Tokens issued by this
    // hub always have aud="zzapi-mes-hub".
    if (payload.aud !== undefined && payload.aud !== "zzapi-mes-hub") {
      return c.json({ error: "Invalid token: wrong audience" }, 401);
    }
    // Validate iss claim if HUB_JWT_ISSUER is configured — prevents tokens
    // minted by a different hub instance from being accepted.
    const expectedIssuer = process.env.HUB_JWT_ISSUER;
    if (expectedIssuer && payload.iss !== undefined && payload.iss !== expectedIssuer) {
      return c.json({ error: "Invalid token: wrong issuer" }, 401);
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
