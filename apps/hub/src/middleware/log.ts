import type { MiddlewareHandler } from "hono";
import type { HubVariables } from "../types.js";

/** Strip ANSI escape sequences from a string to prevent injection in log output. */
export function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
}

/** Structured JSON access-log middleware. Writes one line per request to stdout. */
export const accessLog: MiddlewareHandler<{ Variables: HubVariables }> = async (c, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  const payload = c.get("jwtPayload");
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    level: "info",
    req_id: c.get("reqId") ?? "-",
    key_id: payload?.key_id ?? "-",
    method: c.req.method,
    path: stripAnsi(c.req.path),
    status: c.res.status,
    latency_ms: ms,
    sap_status: c.get("sapStatus") ?? undefined,
    sap_duration_ms: c.get("sapDurationMs") ?? undefined,
  });
  process.stdout.write(entry + "\n");
};
