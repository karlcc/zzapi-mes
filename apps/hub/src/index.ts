import { serve } from "@hono/node-server";
import { createApp } from "./server.js";
import { pruneAuditLog, evictIdempotencyKeys } from "./db/index.js";

const port = Number(process.env.HUB_PORT) || 8080;
const { app, db } = createApp();

// Startup maintenance: prune stale audit rows and idempotency keys.
// HUB_AUDIT_RETENTION_DAYS (default 90) controls audit pruning.
// Idempotency keys older than 5 minutes (300s) are evicted.
const auditRetentionDays = Number(process.env.HUB_AUDIT_RETENTION_DAYS) || 90;
const auditPruned = pruneAuditLog(db, auditRetentionDays);
const idemEvicted = evictIdempotencyKeys(db, 300);
console.log(`Startup maintenance: pruned ${auditPruned} audit rows (>${auditRetentionDays}d), evicted ${idemEvicted} idempotency keys (>300s)`);

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`zzapi-mes hub listening on :${info.port}`);
});

// Graceful shutdown: stop accepting new connections, drain in-flight,
// close DB, then exit. Force-exit after 10s if drain hangs.
let shuttingDown = false;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("Shutting down...");
  server.close(() => {
    try { db.close(); } catch { /* ignore if already closed */ }
    console.log("Server closed.");
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
