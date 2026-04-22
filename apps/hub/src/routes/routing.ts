import { Hono } from "hono";
import type { SapClient } from "@zzapi-mes/core";
import { ZzapiMesHttpError } from "@zzapi-mes/core";
import { sapDuration } from "../metrics.js";
import type { HubVariables } from "../types.js";

export function createRoutingRouter(sap: SapClient) {
  const router = new Hono<{ Variables: HubVariables }>();

  router.get("/routing/:matnr", async (c) => {
    const matnr = c.req.param("matnr");
    const werks = c.req.query("werks");
    if (!werks) {
      return c.json({ error: "Missing required query parameter: werks" }, 400);
    }
    try {
      const start = performance.now();
      const result = await sap.getRouting(matnr, werks);
      const sapDurationMs = performance.now() - start;
      c.set("sapStatus", 200);
      c.set("sapDurationMs", Math.round(sapDurationMs));
      sapDuration.labels({ route: "/routing/:matnr" }).observe(sapDurationMs / 1000);
      return c.json(result);
    } catch (err) {
      if (err instanceof ZzapiMesHttpError) {
        c.set("sapStatus", err.status);
        return c.json({ error: err.message }, err.status as 404 | 405 | 500);
      }
      return c.json({ error: "Internal proxy error" }, 502);
    }
  });

  return router;
}
