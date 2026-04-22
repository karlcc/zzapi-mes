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

    // Call SAP via SapClient POST
    let result: Record<string, unknown>;
    let sapStatus: number;
    const start = performance.now();
    try {
      result = await sap.postConfirmation(parsed.data) as Record<string, unknown>;
      sapStatus = 201;
    } catch (e) {
      if (e instanceof ZzapiMesHttpError) {
        // Map SAP error back to client — 422 from SAP means business logic rejection
        const status = e.status === 422 ? 422 : 502;
        return c.json({ error: e.message, orderid: parsed.data.orderid }, status);
      }
      return c.json({ error: "SAP upstream error" }, 502);
    }
    const durationMs = performance.now() - start;

    // Audit log
    const db = c.get("db") as Database.Database | undefined;
    if (db) {
      writeAudit(db, {
        req_id: reqId,
        key_id: keyId,
        method: "POST",
        path: "/confirmation",
        body: JSON.stringify(parsed.data),
        sap_status: sapStatus,
      });
    }

    sapDuration.labels({ route: "/confirmation" }).observe(durationMs / 1000);
    c.set("sapStatus", sapStatus);
    c.set("sapDurationMs", durationMs);

    return c.json(result, sapStatus as 201);
  });

  return router;
}
