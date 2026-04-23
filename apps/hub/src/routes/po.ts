import { Hono } from "hono";
import type { SapClient } from "@zzapi-mes/core";
import { ZzapiMesHttpError } from "@zzapi-mes/core";
import { sapDuration } from "../metrics.js";
import type { HubVariables } from "../types.js";
import { validateParam } from "./validate.js";

export function createPoRouter(sap: SapClient) {
  const router = new Hono<{ Variables: HubVariables }>();

  router.get("/po/:ebeln", async (c) => {
    const ebeln = c.req.param("ebeln");
    const bad = validateParam(c, "ebeln", ebeln, 10);
    if (bad) return bad;
    try {
      const start = performance.now();
      const result = await sap.getPo(ebeln);
      const sapDurationMs = performance.now() - start;
      c.set("sapStatus", 200);
      c.set("sapDurationMs", Math.round(sapDurationMs));
      sapDuration.labels({ route: "/po/:ebeln" }).observe(sapDurationMs / 1000);
      return c.json(result);
    } catch (err) {
      if (err instanceof ZzapiMesHttpError) {
        const status = err.status === 408 ? 504 : err.status;
        c.set("sapStatus", err.status);
        return c.json({ error: err.message }, status as 400 | 404 | 405 | 500 | 504);
      }
      return c.json({ error: "Internal proxy error" }, 502);
    }
  });

  return router;
}
