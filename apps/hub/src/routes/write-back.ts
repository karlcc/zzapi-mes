import type { Context } from "hono";
import { ZzapiMesHttpError } from "@zzapi-mes/core";
import { z } from "zod";
import { sapDuration } from "../metrics.js";
import type { HubVariables } from "../types.js";
import { writeAudit, updateIdempotencyStatus } from "../db/index.js";
import type Database from "better-sqlite3";

/** Map SAP write-back error status to client-facing status and message. */
function mapSapError(e: unknown): { sapStatus: number; clientStatus: number; errorMsg: string } {
  if (e instanceof ZzapiMesHttpError) {
    const sapStatus = e.status;
    const clientStatus = e.status === 409 ? 409 : e.status === 422 ? 422 : e.status === 408 ? 504 : 502;
    const errorMsg = (e.status === 409 || e.status === 422) ? e.message : "SAP upstream error";
    return { sapStatus, clientStatus, errorMsg };
  }
  return { sapStatus: 502, clientStatus: 502, errorMsg: "SAP upstream error" };
}

/** Execute a write-back SAP call with Zod validation, error mapping, atomic
 *  audit+idempotency write, and metrics. Deduplicates ~70 lines per route
 *  across confirmation, goods-receipt, and goods-issue. */
export async function withWriteBack<T extends z.ZodTypeAny>(
  c: Context<{ Variables: HubVariables }>,
  opts: {
    /** Route path for audit/metrics, e.g. "/confirmation" */
    route: string;
    /** Zod schema for request body validation */
    schema: T;
    /** SAP call — receives the parsed, validated request data */
    fn: (data: z.infer<T>) => Promise<Record<string, unknown>>;
    /** Field name from parsed data to include in error responses (e.g. "orderid") */
    errorField: string;
  },
) {
  const { route, schema, fn, errorField } = opts;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i: z.ZodIssue) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return c.json({ error: `Invalid request: ${issues}` }, 400);
  }

  const payload = c.get("jwtPayload") as Record<string, unknown> | undefined;
  const keyId = (payload?.key_id as string) ?? "unknown";
  const reqId = c.get("reqId") ?? "-";
  const idempotencyKey = c.get("idempotencyKey") as string | undefined;

  let result: Record<string, unknown> | null = null;
  let sapStatus: number;
  let clientStatus: number;
  let errorMsg: string | null = null;
  const start = performance.now();
  try {
    result = await fn(parsed.data);
    sapStatus = 201;
    clientStatus = 201;
  } catch (e) {
    const mapped = mapSapError(e);
    sapStatus = mapped.sapStatus;
    clientStatus = mapped.clientStatus;
    errorMsg = mapped.errorMsg;
  }
  const durationMs = performance.now() - start;

  // Audit log + idempotency status update in one atomic transaction.
  // If the process crashes after SAP succeeds but before this commit,
  // the idempotency key remains at status=0 (pending), allowing a safe
  // retry rather than blocking with no audit trail.
  const db = c.get("db") as Database.Database | undefined;
  if (db) {
    try {
      const finalizeWrite = db.transaction(() => {
        writeAudit(db, {
          req_id: reqId,
          key_id: keyId,
          method: "POST",
          path: route,
          body: JSON.stringify(parsed.data),
          sap_status: sapStatus,
          sap_duration_ms: Math.round(durationMs),
        });
        if (idempotencyKey) {
          updateIdempotencyStatus(db, idempotencyKey, clientStatus);
        }
      });
      finalizeWrite();
    } catch (dbErr) {
      // SAP already committed — do not return error to client (would cause
      // duplicate retry). Log and continue with the successful SAP response.
      console.error(JSON.stringify({
        type: "audit_write_error",
        path: route,
        req_id: reqId,
        error: dbErr instanceof Error ? dbErr.message : String(dbErr),
      }));
    }
  }

  sapDuration.labels({ route }).observe(durationMs / 1000);
  c.set("sapStatus", sapStatus);
  c.set("sapDurationMs", Math.round(durationMs));

  if (errorMsg !== null) {
    return c.json(
      { error: errorMsg, [errorField]: (parsed.data as Record<string, unknown>)[errorField] },
      clientStatus as 409 | 422 | 502 | 504,
    );
  }
  return c.json(result, sapStatus as 201);
}
