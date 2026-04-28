import { Hono } from "hono";
import type { SapClient } from "@zzapi-mes/core";
import { GoodsReceiptRequestSchema, GoodsReceiptResponseSchema } from "@zzapi-mes/core";
import type { HubVariables } from "../types.js";
import { withWriteBack } from "./write-back.js";

export function createGoodsReceiptRouter(sap: SapClient) {
  const router = new Hono<{ Variables: HubVariables }>();

  router.post("/goods-receipt", (c) =>
    withWriteBack(c, {
      route: "/goods-receipt",
      schema: GoodsReceiptRequestSchema,
      fn: (data) => sap.postGoodsReceipt(data) as Promise<Record<string, unknown>>,
      responseSchema: GoodsReceiptResponseSchema,
      errorField: "ebeln",
    }),
  );

  return router;
}
