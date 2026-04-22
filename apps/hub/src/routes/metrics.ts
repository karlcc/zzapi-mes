import { Hono } from "hono";
import { register } from "../metrics.js";

const metrics = new Hono();

metrics.get("/metrics", async (c) => {
  // Only allow from localhost
  const addr = c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip");
  if (addr && addr !== "127.0.0.1" && addr !== "::1") {
    return c.json({ error: "Forbidden" }, 403);
  }
  // When no reverse proxy, check request target hostname
  if (!addr) {
    const hostname = new URL(c.req.url).hostname;
    if (hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "::1") {
      return c.json({ error: "Forbidden" }, 403);
    }
  }
  const body = await register.metrics();
  return c.text(body, 200, { "content-type": register.contentType });
});

export default metrics;
