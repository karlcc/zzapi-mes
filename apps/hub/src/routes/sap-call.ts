import type { Context } from "hono";
import { ZzapiMesHttpError } from "@zzapi-mes/core";
import { sapDuration } from "../metrics.js";
import type { HubVariables } from "../types.js";
import { writeAudit } from "../db/index.js";
import { transformResponse, parseTransformOpts } from "../transform/transform.js";

/** Execute a SAP call with timing, metrics, error mapping, and audit logging.
 *  Deduplicates the try/catch + metrics + error mapping across all GET routes. */
export async function withSapCall<T>(
  c: Context<{ Variables: HubVariables }>,
  route: string,
  fn: () => Promise<T>,
) {
  const payload = c.get("jwtPayload");
  const keyId = payload.key_id;
  const reqId = c.get("reqId") ?? "-";
  const start = performance.now();

  try {
    const result = await fn();
    const sapDurationMs = performance.now() - start;
    c.set("sapStatus", 200);
    c.set("sapDurationMs", Math.round(sapDurationMs));
    sapDuration.labels({ route }).observe(sapDurationMs / 1000);

    // Read-only audit trail: records who accessed what and when, with SAP
    // timing. No request body to log for GET requests.
    const db = c.get("db");
    if (db) {
      try {
        writeAudit(db, {
          req_id: reqId,
          key_id: keyId,
          method: "GET",
          path: route,
          sap_status: 200,
          sap_duration_ms: Math.round(sapDurationMs),
        });
      } catch {
        // Audit write failure must not break the read path
      }
    }

    // Transform SAP response: friendly names by default, ?format=raw for legacy
    const transformOpts = parseTransformOpts((n) => c.req.query(n));
    const output = transformResponse(result, route, transformOpts);
    return c.json(output);
  } catch (err) {
    const sapDurationMs = performance.now() - start;

    if (err instanceof ZzapiMesHttpError) {
      // Map SAP timeout (408) to gateway timeout (504) per OpenAPI spec.
      // Sanitize 5xx errors to avoid leaking SAP internals (short dumps,
      // table names, ABAP stack traces) to external clients — matches the
      // write-back route behavior.
      const isClientError = err.status >= 400 && err.status < 500;
      const status = err.status === 408 ? 504 : isClientError ? err.status : 502;
      const message = isClientError ? err.message : "SAP upstream error";
      c.set("sapStatus", err.status);
      c.set("sapDurationMs", Math.round(sapDurationMs));
      sapDuration.labels({ route }).observe(sapDurationMs / 1000);

      const db = c.get("db");
      if (db) {
        try {
          writeAudit(db, {
            req_id: reqId,
            key_id: keyId,
            method: "GET",
            path: route,
            sap_status: err.status,
            sap_duration_ms: Math.round(sapDurationMs),
          });
        } catch {
          // Audit write failure must not break the read path
        }
      }

      // Forward Retry-After from SAP 429 so hub clients know how long to wait
      if (err.retryAfter && status === 429) {
        c.header("retry-after", String(err.retryAfter));
      }

      return c.json(
        { error: message },
        status as 400 | 404 | 405 | 429 | 502 | 504,
      );
    }
    // Generic Error (network failure, DNS, etc.) — still write audit for forensics
    c.set("sapStatus", 502);
    c.set("sapDurationMs", Math.round(sapDurationMs));
    sapDuration.labels({ route }).observe(sapDurationMs / 1000);

    const db = c.get("db");
    if (db) {
      try {
        writeAudit(db, {
          req_id: reqId,
          key_id: keyId,
          method: "GET",
          path: route,
          sap_status: 502,
          sap_duration_ms: Math.round(sapDurationMs),
        });
      } catch {
        // Audit write failure must not break the read path
      }
    }
    return c.json({ error: "SAP upstream error" }, 502);
  }
}
