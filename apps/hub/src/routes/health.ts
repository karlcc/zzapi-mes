import { Hono } from "hono";
import type { HubVariables } from "../types.js";

const health = new Hono<{ Variables: HubVariables }>();

/** Cached SAP reachability result (refreshed every 30s). */
let sapCache: { ok: boolean; checkedAt: number; error?: string } | null = null;
const SAP_CACHE_TTL_MS = 30_000;
const SAP_PING_TIMEOUT_MS = 5_000;

/** Reset SAP health cache (for test isolation). */
export function _resetSapHealthCacheForTest(): void {
  sapCache = null;
}

/** Set the SAP health cache directly (for test isolation). */
export function _setSapCacheForTest(cache: { ok: boolean; checkedAt: number; error?: string } | null): void {
  sapCache = cache;
}

/** Get the SAP health cache (for test assertions). */
export function _getSapCacheForTest(): { ok: boolean; checkedAt: number; error?: string } | null {
  return sapCache;
}

health.get("/healthz", async (c) => {
  const db = c.get("db");
  if (!db) {
    return c.json({ ok: false, error: "database unreachable" }, 503);
  }
  try {
    db.prepare("SELECT 1").get();
  } catch {
    return c.json({ ok: false, error: "database unreachable" }, 503);
  }

  // Verify DB is writable — a read-only filesystem or full disk would pass
  // the SELECT check above but cause silent failures on write-back routes.
  try {
    db.prepare("CREATE TABLE IF NOT EXISTS _healthz_write_check (id INTEGER PRIMARY KEY)").run();
    db.prepare("INSERT INTO _healthz_write_check (id) VALUES (1)").run();
    db.prepare("DELETE FROM _healthz_write_check WHERE id = 1").run();
  } catch {
    return c.json({ ok: false, error: "database not writable" }, 503);
  }

  // Optional SAP reachability check via ?check=sap
  const check = c.req.query("check");
  if (check === "sap") {
    const now = Date.now();
    if (sapCache && now - sapCache.checkedAt < SAP_CACHE_TTL_MS) {
      if (!sapCache.ok) {
        return c.json({ ok: false, error: sapCache.error }, 503);
      }
      return c.json({ ok: true, sap: "reachable" });
    }

    // Ping SAP with timeout
    const sap = c.get("sap");
    if (!sap) {
      return c.json({ ok: false, error: "SAP client not configured" }, 503);
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SAP_PING_TIMEOUT_MS);
      try {
        await Promise.race([
          sap.ping(),
          new Promise((_, reject) =>
            controller.signal.addEventListener("abort", () => reject(new Error("timeout"))),
          ),
        ]);
        sapCache = { ok: true, checkedAt: now };
        return c.json({ ok: true, sap: "reachable" });
      } finally {
        clearTimeout(timer);
      }
    } catch {
      sapCache = { ok: false, checkedAt: now, error: "SAP unreachable" };
      return c.json({ ok: false, error: "SAP unreachable" }, 503);
    }
  }

  return c.json({ ok: true });
});

export default health;
