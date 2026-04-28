import { Hono } from "hono";
import type { SapClient } from "@zzapi-mes/core";
import type { HubVariables } from "../types.js";
import { validateParam } from "./validate.js";
import { withSapCall } from "./sap-call.js";

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
    return withSapCall(c, "/routing/:matnr", () => sap.getRouting(matnr, werks, { signal: c.get("sapSignal") }));
  });

  return router;
}
