import { Hono } from "hono";
import type { SapClient } from "@zzapi-mes/core";
import type { HubVariables } from "../types.js";
import { withSapCall } from "./sap-call.js";

export function createPingRouter(sap: SapClient) {
  const router = new Hono<{ Variables: HubVariables }>();

  router.get("/ping", async (c) =>
    withSapCall(c, "/ping", () => sap.ping()),
  );

  return router;
}
