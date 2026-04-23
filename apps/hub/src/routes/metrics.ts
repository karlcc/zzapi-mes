import { Hono } from "hono";
import { register } from "../metrics.js";
import { isLoopbackPeer, getClientIp } from "../middleware/client-ip.js";

const metrics = new Hono();

metrics.get("/metrics", async (c) => {
  // Only allow from localhost. The direct TCP peer address is NOT spoofable;
  // the previous URL-hostname check was bypassable via a crafted Host header.
  // If a trusted reverse proxy sits in front (HUB_TRUSTED_PROXY), the
  // resolved client IP must also be loopback.
  if (!isLoopbackPeer(c)) {
    const clientIp = getClientIp(c);
    if (clientIp !== "127.0.0.1" && clientIp !== "::1") {
      return c.json({ error: "Forbidden" }, 403);
    }
  }
  const body = await register.metrics();
  return c.text(body, 200, { "content-type": register.contentType });
});

export default metrics;
