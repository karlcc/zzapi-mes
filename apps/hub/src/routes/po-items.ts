import { Hono } from "hono";
import type { SapClient } from "@zzapi-mes/core";
import { ZzapiMesHttpError } from "@zzapi-mes/core";
import { sapDuration } from "../metrics.js";
import type { HubVariables } from "../types.js";

export function createPoItemsRouter(sap: SapClient) {
  const router = new Hono<{ Variables: HubVariables }>();

  router.get("/po/:ebeln/items", async (c) => {
    const ebeln = c.req.param("ebeln");
    if (ebeln.length > 10) return c.json({ error: "Parameter 'ebeln' exceeds maximum length of 10" }, 400);
    try {
      const start = performance.now();
      const result = await sap.getPoItems(ebeln);
      const sapDurationMs = performance.now() - start;
      c.set("sapStatus", 200);
      c.set("sapDurationMs", Math.round(sapDurationMs));
      sapDuration.labels({ route: "/po/:ebeln/items" }).observe(sapDurationMs / 1000);
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
