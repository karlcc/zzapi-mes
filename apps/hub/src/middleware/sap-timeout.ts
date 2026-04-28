import { createMiddleware } from "hono/factory";
import type { HubVariables } from "../types.js";

/** Default per-request timeout: 60 seconds (covers slow SAP calls). */
const DEFAULT_SAP_REQUEST_TIMEOUT_MS = 60_000;

/** Per-request timeout middleware. Creates an AbortController whose signal
 *  is stored in the Hono context for route handlers to forward to SapClient.
 *  If the timer fires before the response is sent, the signal aborts any
 *  in-flight SAP fetch and the route handler returns 504.
 *
 *  Configured via HUB_SAP_REQUEST_TIMEOUT_MS env var (positive integer ms).
 *  Must be placed after requireJwt so JWT validation is not arbitrarily aborted.
 */
export const sapTimeout = createMiddleware<{ Variables: HubVariables }>(async (c, next) => {
  const timeoutMs = (() => {
    const raw = process.env.HUB_SAP_REQUEST_TIMEOUT_MS;
    if (raw !== undefined && raw !== "") {
      const n = Number(raw);
      if (Number.isFinite(n) && Number.isInteger(n) && n > 0) return n;
    }
    return DEFAULT_SAP_REQUEST_TIMEOUT_MS;
  })();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  c.set("sapSignal", controller.signal);

  try {
    await next();
  } finally {
    clearTimeout(timer);
  }
});
