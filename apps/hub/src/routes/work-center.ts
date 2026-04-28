import { Hono } from "hono";
import type { SapClient } from "@zzapi-mes/core";
import type { HubVariables } from "../types.js";
import { validateParam } from "./validate.js";
import { withSapCall } from "./sap-call.js";

export function createWorkCenterRouter(sap: SapClient) {
  const router = new Hono<{ Variables: HubVariables }>();

  router.get("/work-center/:arbpl", async (c) => {
    const arbpl = c.req.param("arbpl");
    const bad = validateParam(c, "arbpl", arbpl, 8);
    if (bad) return bad;
    const werks = c.req.query("werks");
    if (!werks) {
      return c.json({ error: "Missing required query parameter: werks" }, 400);
    }
    const badW = validateParam(c, "werks", werks, 4, "query");
    if (badW) return badW;
    return withSapCall(c, "/work-center/:arbpl", () => sap.getWorkCenter(arbpl, werks, { signal: c.get("sapSignal") }));
  });

  return router;
}
