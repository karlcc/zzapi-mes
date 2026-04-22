import { serve } from "@hono/node-server";
import { createApp } from "./server.js";

const port = Number(process.env.HUB_PORT) || 8080;
const { app, db } = createApp();

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`zzapi-mes hub listening on :${info.port}`);
});

function shutdown() {
  console.log("Shutting down...");
  server.close(() => {
    try { db.close(); } catch { /* ignore if already closed */ }
    console.log("Server closed.");
    process.exit(0);
  });
  // Force exit after 10s if drain hangs
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
