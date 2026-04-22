import { Hono } from "hono";
import type { SapClient } from "@zzapi-mes/core";
import { ZzapiMesHttpError } from "@zzapi-mes/core";

export function createPingRouter(sap: SapClient) {
  const router = new Hono();

  router.get("/ping", async (c) => {
    try {
      const result = await sap.ping();
      return c.json(result);
    } catch (err) {
      if (err instanceof ZzapiMesHttpError) {
        return c.json({ error: err.message }, err.status as 404 | 405 | 500);
      }
      return c.json({ error: "Internal proxy error" }, 502);
    }
  });

  return router;
}
