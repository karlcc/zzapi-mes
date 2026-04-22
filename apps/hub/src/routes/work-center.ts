import { Hono } from "hono";
import type { SapClient } from "@zzapi-mes/core";
import { ZzapiMesHttpError } from "@zzapi-mes/core";
import { sapDuration } from "../metrics.js";
import type { HubVariables } from "../types.js";

export function createWorkCenterRouter(sap: SapClient) {
  const router = new Hono<{ Variables: HubVariables }>();

  router.get("/work-center/:arbpl", async (c) => {
    const arbpl = c.req.param("arbpl");
    if (arbpl.length > 8) return c.json({ error: "Parameter 'arbpl' exceeds maximum length of 8" }, 400);
    const werks = c.req.query("werks");
    if (!werks) {
      return c.json({ error: "Missing required query parameter: werks" }, 400);
    }
    try {
      const start = performance.now();
      const result = await sap.getWorkCenter(arbpl, werks);
      const sapDurationMs = performance.now() - start;
      c.set("sapStatus", 200);
      c.set("sapDurationMs", Math.round(sapDurationMs));
      sapDuration.labels({ route: "/work-center/:arbpl" }).observe(sapDurationMs / 1000);
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
