import { Hono } from "hono";
import type { SapClient } from "@zzapi-mes/core";
import type { HubVariables } from "../types.js";
import { validateParam } from "./validate.js";
import { withSapCall } from "./sap-call.js";

export function createStockRouter(sap: SapClient) {
  const router = new Hono<{ Variables: HubVariables }>();

  router.get("/stock/:matnr", async (c) => {
    const matnr = c.req.param("matnr");
    const bad = validateParam(c, "matnr", matnr, 18);
    if (bad) return bad;
    const werks = c.req.query("werks");
    const lgort = c.req.query("lgort");
    if (!werks) {
      return c.json({ error: "Missing required query parameter: werks" }, 400);
    }
    const badW = validateParam(c, "werks", werks, 4, "query");
    if (badW) return badW;
    if (lgort !== undefined) {
      const badL = validateParam(c, "lgort", lgort, 4, "query");
      if (badL) return badL;
    }
    return withSapCall(c, "/stock/:matnr", () => sap.getStock(matnr, werks, lgort, { signal: c.get("sapSignal") }));
  });

  return router;
}
