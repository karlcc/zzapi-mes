import { Hono } from "hono";
import type { SapClient } from "@zzapi-mes/core";
import { GoodsIssueRequestSchema, GoodsIssueResponseSchema } from "@zzapi-mes/core";
import type { HubVariables } from "../types.js";
import { withWriteBack } from "./write-back.js";

export function createGoodsIssueRouter(sap: SapClient) {
  const router = new Hono<{ Variables: HubVariables }>();

  router.post("/goods-issue", (c) =>
    withWriteBack(c, {
      route: "/goods-issue",
      schema: GoodsIssueRequestSchema,
      fn: (data) => sap.postGoodsIssue(data, c.get("sapSignal")) as Promise<Record<string, unknown>>,
      responseSchema: GoodsIssueResponseSchema,
      errorField: "orderid",
    }),
  );

  return router;
}
