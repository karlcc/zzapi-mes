import type { Context } from "hono";
import { ZzapiMesHttpError } from "@zzapi-mes/core";
import { sapDuration } from "../metrics.js";
import type { HubVariables } from "../types.js";

/** Execute a SAP call with timing, metrics, and error mapping.
 *  Deduplicates the try/catch + metrics + error mapping across all GET routes. */
export async function withSapCall<T>(
  c: Context<{ Variables: HubVariables }>,
  route: string,
  fn: () => Promise<T>,
) {
  try {
    const start = performance.now();
    const result = await fn();
    const sapDurationMs = performance.now() - start;
    c.set("sapStatus", 200);
    c.set("sapDurationMs", Math.round(sapDurationMs));
    sapDuration.labels({ route }).observe(sapDurationMs / 1000);
    return c.json(result);
  } catch (err) {
    if (err instanceof ZzapiMesHttpError) {
      const status = err.status === 408 ? 504 : err.status;
      c.set("sapStatus", err.status);
      return c.json(
        { error: err.message },
        status as 400 | 404 | 405 | 500 | 502 | 504,
      );
    }
    return c.json({ error: "Internal proxy error" }, 502);
  }
}
