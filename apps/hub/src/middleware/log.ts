import type { MiddlewareHandler } from "hono";

/** Structured JSON access-log middleware. Writes one line per request to stdout. */
export const accessLog: MiddlewareHandler = async (c, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  const payload = c.get("jwtPayload") as Record<string, unknown> | undefined;
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    level: "info",
    req_id: c.get("reqId") ?? "-",
    key_id: (payload?.key_id as string) ?? "-",
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    latency_ms: ms,
    sap_status: c.get("sapStatus") ?? undefined,
    sap_duration_ms: c.get("sapDurationMs") ?? undefined,
  });
  process.stdout.write(entry + "\n");
};
