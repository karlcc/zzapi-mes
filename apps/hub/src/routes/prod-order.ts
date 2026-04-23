import { Hono } from "hono";
import type { SapClient } from "@zzapi-mes/core";
import { ZzapiMesHttpError } from "@zzapi-mes/core";
import { sapDuration } from "../metrics.js";
import type { HubVariables } from "../types.js";
import { validateParam } from "./validate.js";

export function createProdOrderRouter(sap: SapClient) {
  const router = new Hono<{ Variables: HubVariables }>();

  router.get("/prod-order/:aufnr", async (c) => {
    const aufnr = c.req.param("aufnr");
    const bad = validateParam(c, "aufnr", aufnr, 12);
    if (bad) return bad;
    try {
      const start = performance.now();
      const result = await sap.getProdOrder(aufnr);
      const sapDurationMs = performance.now() - start;
      c.set("sapStatus", 200);
      c.set("sapDurationMs", Math.round(sapDurationMs));
      sapDuration.labels({ route: "/prod-order/:aufnr" }).observe(sapDurationMs / 1000);
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
