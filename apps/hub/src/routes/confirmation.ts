import { Hono } from "hono";
import type { SapClient } from "@zzapi-mes/core";
import { ZzapiMesHttpError } from "@zzapi-mes/core";
import { sapDuration } from "../metrics.js";
import type { HubVariables } from "../types.js";
import type Database from "better-sqlite3";
import { writeAudit } from "../db/index.js";
import { z } from "zod";

const ConfirmationRequestSchema = z.object({
  orderid: z.string().min(1),
  operation: z.string().min(1),
  yield: z.number().min(0),
  scrap: z.number().min(0).optional(),
  work_actual: z.number().min(0).optional(),
  postg_date: z.string().regex(/^[0-9]{8}$/).optional(),
});

export function createConfirmationRouter(sap: SapClient) {
  const router = new Hono<{ Variables: HubVariables }>();

  router.post("/confirmation", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Request body must be valid JSON" }, 400);
    }

    const parsed = ConfirmationRequestSchema.safeParse(body);
    if (!parsed.success) {
      const issues = parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ");
      return c.json({ error: `Invalid request: ${issues}` }, 400);
    }

    const payload = c.get("jwtPayload") as Record<string, unknown> | undefined;
    const keyId = (payload?.key_id as string) ?? "unknown";
    const reqId = c.get("reqId") ?? "-";

    // For now, return a placeholder response — the actual SAP BAPI call
    // requires the ABAP handler ZCL_ZZAPI_MES_CONF to be deployed on SAP.
    // This route validates input, logs the audit trail, and returns the
    // confirmation structure.
    const result = {
      orderid: parsed.data.orderid,
      operation: parsed.data.operation,
      yield: parsed.data.yield,
      scrap: parsed.data.scrap ?? 0,
      status: "confirmed",
      message: "Production confirmation recorded (SAP BAPI call pending Phase 1 deployment)",
    };

    // Audit log
    const db = c.get("db") as Database.Database | undefined;
    if (db) {
      writeAudit(db, {
        req_id: reqId,
        key_id: keyId,
        method: "POST",
        path: "/confirmation",
        body: JSON.stringify(parsed.data),
        sap_status: 200,
      });
    }

    sapDuration.labels({ route: "/confirmation" }).observe(0);
    c.set("sapStatus", 200);
    c.set("sapDurationMs", 0);

    return c.json(result, 201);
  });

  return router;
}
