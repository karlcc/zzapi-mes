import { Hono } from "hono";
import type { SapClient } from "@zzapi-mes/core";
import { ZzapiMesHttpError } from "@zzapi-mes/core";
import { sapDuration } from "../metrics.js";
import type { HubVariables } from "../types.js";

export function createMaterialRouter(sap: SapClient) {
  const router = new Hono<{ Variables: HubVariables }>();

  router.get("/material/:matnr", async (c) => {
    const matnr = c.req.param("matnr");
    if (matnr.length > 18) return c.json({ error: "Parameter 'matnr' exceeds maximum length of 18" }, 400);
    const werks = c.req.query("werks");
    if (werks !== undefined && werks.length > 4) return c.json({ error: "Query parameter 'werks' exceeds maximum length of 4" }, 400);
    try {
      const start = performance.now();
      const result = await sap.getMaterial(matnr, werks);
      const sapDurationMs = performance.now() - start;
      c.set("sapStatus", 200);
      c.set("sapDurationMs", Math.round(sapDurationMs));
      sapDuration.labels({ route: "/material/:matnr" }).observe(sapDurationMs / 1000);
      return c.json(result);
    } catch (err) {
      if (err instanceof ZzapiMesHttpError) {
        c.set("sapStatus", err.status);
        return c.json({ error: err.message }, err.status as 404 | 405 | 500);
      }
      return c.json({ error: "Internal proxy error" }, 502);
    }
  });

  router.on("POST|PUT|PATCH|DELETE", "/material/:matnr", (c) => c.json({ error: "Method not allowed" }, 405));

  return router;
}
