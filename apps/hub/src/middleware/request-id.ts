import { createMiddleware } from "hono/factory";
import { randomUUID } from "node:crypto";
import type { HubVariables } from "../types.js";

const REQ_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** Attach a request ID: echo `x-request-id` if valid, else generate UUID. */
export const requestId = createMiddleware<{ Variables: HubVariables }>(async (c, next) => {
  const incoming = c.req.header("x-request-id");
  const reqId = incoming && REQ_ID_RE.test(incoming) ? incoming : randomUUID();
  c.set("reqId", reqId);
  c.header("x-request-id", reqId);
  await next();
});
