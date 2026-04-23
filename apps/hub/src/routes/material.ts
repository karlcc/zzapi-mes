import { Hono } from "hono";
import type { SapClient } from "@zzapi-mes/core";
import type { HubVariables } from "../types.js";
import { validateParam } from "./validate.js";
import { withSapCall } from "./sap-call.js";

export function createMaterialRouter(sap: SapClient) {
  const router = new Hono<{ Variables: HubVariables }>();

  router.get("/material/:matnr", async (c) => {
    const matnr = c.req.param("matnr");
    const bad = validateParam(c, "matnr", matnr, 18);
    if (bad) return bad;
    const werks = c.req.query("werks");
    if (werks !== undefined) {
      const badW = validateParam(c, "werks", werks, 4, "query");
      if (badW) return badW;
    }
    return withSapCall(c, "/material/:matnr", () => sap.getMaterial(matnr, werks));
  });

  return router;
}
