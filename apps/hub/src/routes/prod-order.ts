import { Hono } from "hono";
import type { SapClient } from "@zzapi-mes/core";
import type { HubVariables } from "../types.js";
import { validateParam } from "./validate.js";
import { withSapCall } from "./sap-call.js";

export function createProdOrderRouter(sap: SapClient) {
  const router = new Hono<{ Variables: HubVariables }>();

  router.get("/prod-order/:aufnr", async (c) => {
    const aufnr = c.req.param("aufnr");
    const bad = validateParam(c, "aufnr", aufnr, 12);
    if (bad) return bad;
    return withSapCall(c, "/prod-order/:aufnr", () => sap.getProdOrder(aufnr));
  });

  return router;
}
