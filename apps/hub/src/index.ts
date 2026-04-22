import { serve } from "@hono/node-server";
import { createApp } from "./server.js";

const port = Number(process.env.HUB_PORT) || 8080;
const app = createApp();

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`zzapi-mes hub listening on :${info.port}`);
});
