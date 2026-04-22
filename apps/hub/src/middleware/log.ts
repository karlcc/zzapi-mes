import type { MiddlewareHandler } from "hono";
import { appendFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";

const LOG_FILE = resolve(process.env.HUB_LOG_FILE ?? "./hub.log");

// Ensure log directory exists at startup
mkdir(dirname(LOG_FILE), { recursive: true }).catch(() => {});

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
  appendFile(LOG_FILE, entry + "\n").catch(() => {});
};
