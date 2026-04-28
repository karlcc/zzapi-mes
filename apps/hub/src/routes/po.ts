import { Hono } from "hono";
import type { SapClient } from "@zzapi-mes/core";
import type { HubVariables } from "../types.js";
import { validateParam } from "./validate.js";
import { withSapCall } from "./sap-call.js";

export function createPoRouter(sap: SapClient) {
  const router = new Hono<{ Variables: HubVariables }>();

  router.get("/po/:ebeln", async (c) => {
    const ebeln = c.req.param("ebeln");
    const bad = validateParam(c, "ebeln", ebeln, 10);
    if (bad) return bad;
    return withSapCall(c, "/po/:ebeln", () => sap.getPo(ebeln, { signal: c.get("sapSignal") }));
  });

  return router;
}
