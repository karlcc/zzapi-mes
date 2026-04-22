import type { MiddlewareHandler } from "hono";
import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";

const LOG_FILE = resolve(process.env.HUB_LOG_FILE ?? "./hub.log");

/** Structured JSON access-log middleware. Writes one line per request. */
export const accessLog: MiddlewareHandler = async (c, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    ms,
    sub: (c.get("jwtPayload") as Record<string, string> | undefined)?.sub ?? "-",
  });
  // Fire-and-forget write; errors are swallowed deliberately to avoid
  // logging failures breaking the request path.
  appendFile(LOG_FILE, entry + "\n").catch(() => {});
};
