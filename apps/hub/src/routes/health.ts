import { Hono } from "hono";
import type { HubVariables } from "../types.js";

const health = new Hono<{ Variables: HubVariables }>();

/** Cached SAP reachability result (refreshed every 30s). */
let sapCache: { ok: boolean; checkedAt: number; error?: string } | null = null;
const SAP_CACHE_TTL_MS = 30_000;
/** In-flight SAP ping promise for concurrent-request dedup. Multiple requests
 *  arriving while the cache is stale all share the same pending ping instead of
 *  each triggering a separate SAP call. */
let sapPingInFlight: Promise<{ ok: boolean; error?: string }> | null = null;
const SAP_PING_TIMEOUT_MS = Number.isFinite(Number(process.env.SAP_PING_TIMEOUT_MS)) && Number.isInteger(Number(process.env.SAP_PING_TIMEOUT_MS)) && Number(process.env.SAP_PING_TIMEOUT_MS) > 0
  ? Number(process.env.SAP_PING_TIMEOUT_MS)
  : 5_000;

/** Reset SAP health cache (for test isolation). */
export function _resetSapHealthCacheForTest(): void {
  sapCache = null;
  sapPingInFlight = null;
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
    db.prepare("INSERT OR REPLACE INTO _healthz_write_check (id) VALUES (1)").run();
    db.prepare("DELETE FROM _healthz_write_check WHERE id = 1").run();
  } catch {
    return c.json({ ok: false, error: "database not writable" }, 503);
  }

  // Optional SAP reachability check via ?check=sap
  const check = c.req.query("check");
  if (check !== undefined && check !== "sap") {
    return c.json({ error: `Unknown check parameter: "${check}". Supported: sap` }, 400);
  }
  if (check === "sap") {
    const now = Date.now();
    if (sapCache && now - sapCache.checkedAt < SAP_CACHE_TTL_MS) {
      if (!sapCache.ok) {
        return c.json({ ok: false, error: sapCache.error }, 503);
      }
      return c.json({ ok: true, sap: "reachable" });
    }

    // Ping SAP with timeout — dedup concurrent requests via in-flight promise
    const sap = c.get("sap");
    if (!sap) {
      return c.json({ ok: false, error: "SAP client not configured" }, 503);
    }

    // If a ping is already in flight, reuse it instead of firing another
    if (!sapPingInFlight) {
      sapPingInFlight = (async () => {
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
            return { ok: true };
          } finally {
            clearTimeout(timer);
          }
        } catch {
          return { ok: false, error: "SAP unreachable" as string | undefined };
        }
      })();
    }

    const result = await sapPingInFlight;
    // Clear in-flight reference so future requests after cache expiry start a new ping
    sapPingInFlight = null;

    const checkedAt = Date.now();
    if (result.ok) {
      sapCache = { ok: true, checkedAt };
      return c.json({ ok: true, sap: "reachable" });
    }
    sapCache = { ok: false, checkedAt, error: result.error };
    return c.json({ ok: false, error: result.error }, 503);
  }

  return c.json({ ok: true });
});

export default health;
