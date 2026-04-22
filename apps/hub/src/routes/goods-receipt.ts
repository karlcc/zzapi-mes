import { Hono } from "hono";
import type { SapClient } from "@zzapi-mes/core";
import { sapDuration } from "../metrics.js";
import type { HubVariables } from "../types.js";
import type Database from "better-sqlite3";
import { writeAudit } from "../db/index.js";
import { z } from "zod";

const GoodsReceiptRequestSchema = z.object({
  ebeln: z.string().min(1),
  ebelp: z.string().min(1),
  menge: z.number().min(0),
  werks: z.string().min(1),
  lgort: z.string().min(1),
  budat: z.string().regex(/^[0-9]{8}$/).optional(),
  charg: z.string().min(1).optional(),
});

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

    // Placeholder response — actual SAP BAPI call requires ABAP handler deployment
    const result = {
      ebeln: parsed.data.ebeln,
      ebelp: parsed.data.ebelp,
      menge: parsed.data.menge,
      material_document: "5000000001",
      status: "posted",
      message: "Goods receipt recorded (SAP BAPI call pending Phase 1 deployment)",
    };

    const db = c.get("db") as Database.Database | undefined;
    if (db) {
      writeAudit(db, {
        req_id: reqId,
        key_id: keyId,
        method: "POST",
        path: "/goods-receipt",
        body: JSON.stringify(parsed.data),
        sap_status: 200,
      });
    }

    sapDuration.labels({ route: "/goods-receipt" }).observe(0);
    c.set("sapStatus", 200);
    c.set("sapDurationMs", 0);

    return c.json(result, 201);
  });

  return router;
}
