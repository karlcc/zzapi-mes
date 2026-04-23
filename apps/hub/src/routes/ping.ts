import { Hono } from "hono";
import type { SapClient } from "@zzapi-mes/core";
import { ZzapiMesHttpError } from "@zzapi-mes/core";
import { sapDuration } from "../metrics.js";
import type { HubVariables } from "../types.js";

export function createPingRouter(sap: SapClient) {
  const router = new Hono<{ Variables: HubVariables }>();

  router.get("/ping", async (c) => {
    try {
      const start = performance.now();
      const result = await sap.ping();
      const sapDurationMs = performance.now() - start;
      c.set("sapStatus", 200);
      c.set("sapDurationMs", Math.round(sapDurationMs));
      sapDuration.labels({ route: "/ping" }).observe(sapDurationMs / 1000);
      return c.json(result);
    } catch (err) {
      if (err instanceof ZzapiMesHttpError) {
        // Map SAP timeout (408) to gateway timeout (504) per OpenAPI spec
        const status = err.status === 408 ? 504 : err.status;
        c.set("sapStatus", err.status);
        return c.json({ error: err.message }, status as 400 | 404 | 405 | 500 | 504);
      }
      return c.json({ error: "Internal proxy error" }, 502);
    }
  });

  return router;
}
