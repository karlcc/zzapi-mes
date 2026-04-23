import { Hono } from "hono";
import type { SapClient } from "@zzapi-mes/core";
import { ZzapiMesHttpError, GoodsReceiptRequestSchema } from "@zzapi-mes/core";
import { sapDuration } from "../metrics.js";
import type { HubVariables } from "../types.js";
import type Database from "better-sqlite3";
import { writeAudit } from "../db/index.js";

export function createGoodsReceiptRouter(sap: SapClient) {
  const router = new Hono<{ Variables: HubVariables }>();

  router.post("/goods-receipt", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Request body must be valid JSON" }, 400);
    }

    const parsed = GoodsReceiptRequestSchema.safeParse(body);
    if (!parsed.success) {
      const issues = parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ");
      return c.json({ error: `Invalid request: ${issues}` }, 400);
    }

    const payload = c.get("jwtPayload") as Record<string, unknown> | undefined;
    const keyId = (payload?.key_id as string) ?? "unknown";
    const reqId = c.get("reqId") ?? "-";

    // Call SAP via SapClient POST
    let result: Record<string, unknown> | null = null;
    let sapStatus: number;
    let clientStatus: number;
    let errorMsg: string | null = null;
    const start = performance.now();
    try {
      result = await sap.postGoodsReceipt(parsed.data) as Record<string, unknown>;
      sapStatus = 201;
      clientStatus = 201;
    } catch (e) {
      if (e instanceof ZzapiMesHttpError) {
        sapStatus = e.status;
        clientStatus = e.status === 409 ? 409 : e.status === 422 ? 422 : e.status === 408 ? 504 : 502;
        errorMsg = (e.status === 409 || e.status === 422) ? e.message : "SAP upstream error";
      } else {
        sapStatus = 502;
        clientStatus = 502;
        errorMsg = "SAP upstream error";
      }
    }
    const durationMs = performance.now() - start;

    // Audit log (both success and failure)
    const db = c.get("db") as Database.Database | undefined;
    if (db) {
      writeAudit(db, {
        req_id: reqId,
        key_id: keyId,
        method: "POST",
        path: "/goods-receipt",
        body: JSON.stringify(parsed.data),
        sap_status: sapStatus,
        sap_duration_ms: Math.round(durationMs),
      });
    }

    sapDuration.labels({ route: "/goods-receipt" }).observe(durationMs / 1000);
    c.set("sapStatus", sapStatus);
    c.set("sapDurationMs", Math.round(durationMs));

    if (errorMsg !== null) {
      return c.json({ error: errorMsg, ebeln: parsed.data.ebeln }, clientStatus as 409 | 422 | 502 | 504);
    }
    return c.json(result, sapStatus as 201);
  });

  return router;
}
