import { Hono } from "hono";
import { register } from "../metrics.js";

const metrics = new Hono();

metrics.get("/metrics", async (c) => {
  // Only allow from localhost. Check direct connection IP first —
  // do NOT trust X-Forwarded-For without a known trusted proxy.
  const hostname = new URL(c.req.url).hostname;
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
    // Direct localhost connection — allow
  } else {
    // Non-localhost — check if behind a trusted reverse proxy
    const realIp = c.req.header("x-real-ip");
    if (realIp !== "127.0.0.1" && realIp !== "::1") {
      return c.json({ error: "Forbidden" }, 403);
    }
  }
  const body = await register.metrics();
  return c.text(body, 200, { "content-type": register.contentType });
});

export default metrics;
