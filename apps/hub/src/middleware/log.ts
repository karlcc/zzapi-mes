import type { MiddlewareHandler } from "hono";
import type { HubVariables } from "../types.js";

/** Strip ANSI escape sequences from a string to prevent injection in log output. */
export function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
}

/** Write to stdout, silently catching EPIPE errors. When stdout is piped to
 *  `head`, `awk`, or a log-rotation tool that exits mid-stream, `write()`
 *  throws EPIPE. Without this guard, the unhandled exception crashes the hub.
 */
export function safeWrite(line: string): void {
  try {
    process.stdout.write(line);
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code !== "EPIPE") throw e;
    // EPIPE: downstream reader gone — nothing to do, log is dropped.
  }
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
  safeWrite(entry + "\n");
};
