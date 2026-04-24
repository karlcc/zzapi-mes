import { Hono } from "hono";
import type { SapClient } from "@zzapi-mes/core";
import { ConfirmationRequestSchema, ConfirmationResponseSchema } from "@zzapi-mes/core";
import type { HubVariables } from "../types.js";
import { withWriteBack } from "./write-back.js";

export function createConfirmationRouter(sap: SapClient) {
  const router = new Hono<{ Variables: HubVariables }>();

  router.post("/confirmation", (c) =>
    withWriteBack(c, {
      route: "/confirmation",
      schema: ConfirmationRequestSchema,
      fn: (data) => sap.postConfirmation(data) as Promise<Record<string, unknown>>,
      responseSchema: ConfirmationResponseSchema,
      errorField: "orderid",
    }),
  );

  return router;
}
