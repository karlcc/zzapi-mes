import { Hono } from "hono";
import type { HubVariables } from "../types.js";
import type Database from "better-sqlite3";

const health = new Hono<{ Variables: HubVariables }>();

health.get("/healthz", (c) => {
  const db = c.get("db") as Database.Database | undefined;
  try {
    db!.prepare("SELECT 1").get();
  } catch {
    return c.json({ ok: false, error: "database unreachable" }, 503);
  }
  return c.json({ ok: true });
});

export default health;
