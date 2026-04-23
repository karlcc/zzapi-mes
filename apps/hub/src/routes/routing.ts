import { Hono } from "hono";
import type { SapClient } from "@zzapi-mes/core";
import { ZzapiMesHttpError } from "@zzapi-mes/core";
import { sapDuration } from "../metrics.js";
import type { HubVariables } from "../types.js";
import { validateParam } from "./validate.js";

export function createRoutingRouter(sap: SapClient) {
  const router = new Hono<{ Variables: HubVariables }>();

  router.get("/routing/:matnr", async (c) => {
    const matnr = c.req.param("matnr");
    const bad = validateParam(c, "matnr", matnr, 18);
    if (bad) return bad;
    const werks = c.req.query("werks");
    if (!werks) {
      return c.json({ error: "Missing required query parameter: werks" }, 400);
    }
    const badW = validateParam(c, "werks", werks, 4, "query");
    if (badW) return badW;
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
        const status = err.status === 408 ? 504 : err.status;
        c.set("sapStatus", err.status);
        return c.json({ error: err.message }, status as 400 | 404 | 405 | 500 | 504);
      }
      return c.json({ error: "Internal proxy error" }, 502);
    }
  });

  return router;
}
