import { serve } from "@hono/node-server";
import { createApp } from "./server.js";
import { pruneAuditLog, evictIdempotencyKeys } from "./db/index.js";

const port = process.env.HUB_PORT !== undefined && process.env.HUB_PORT !== ""
  ? Number(process.env.HUB_PORT)
  : 8080;
if (!Number.isFinite(port) || port <= 0) {
  console.error(`HUB_PORT must be a positive integer (got ${process.env.HUB_PORT})`);
  process.exit(1);
}
const { app, db } = createApp();

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`zzapi-mes hub listening on :${info.port}`);
});

// Startup maintenance runs AFTER the server is listening so readiness is
// not blocked by potentially slow DELETE scans on large audit tables.
// HUB_AUDIT_RETENTION_DAYS (default 90) controls audit pruning.
// Idempotency keys older than 5 minutes (300s) are evicted.
setImmediate(() => {
  try {
    const auditRetentionDays = process.env.HUB_AUDIT_RETENTION_DAYS !== undefined && process.env.HUB_AUDIT_RETENTION_DAYS !== ""
      ? Number(process.env.HUB_AUDIT_RETENTION_DAYS)
      : 90;
    if (!Number.isFinite(auditRetentionDays) || auditRetentionDays <= 0) {
      console.error(`HUB_AUDIT_RETENTION_DAYS must be a positive integer (got ${process.env.HUB_AUDIT_RETENTION_DAYS}). Would prune all audit rows.`);
      process.exit(1);
    }
    const auditPruned = pruneAuditLog(db, auditRetentionDays);
    const idemEvicted = evictIdempotencyKeys(db, 300);
    console.log(`Startup maintenance: pruned ${auditPruned} audit rows (>${auditRetentionDays}d), evicted ${idemEvicted} idempotency keys (>300s)`);
  } catch (err) {
    console.error("Startup maintenance failed:", err);
  }
});

// Last-resort process handlers. These log the error and trigger graceful
// shutdown — better than a silent process death leaving the port bound.
process.on("uncaughtException", (err) => {
  console.error("uncaughtException:", err);
  shutdown();
});
process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection:", reason);
  shutdown();
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
