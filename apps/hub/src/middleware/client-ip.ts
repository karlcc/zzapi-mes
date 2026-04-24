import type { Context } from "hono";

/**
 * Resolve the client IP in a trusted-proxy-aware way.
 *
 * Production path (behind @hono/node-server):
 *   getConnInfo() returns the real TCP peer address.
 *   - If HUB_TRUSTED_PROXY is unset, returns the peer directly.
 *     Headers like x-real-ip / x-forwarded-for are IGNORED — any client
 *     could set them and bypass per-IP rate limits or localhost checks.
 *   - If HUB_TRUSTED_PROXY is set to a comma-separated list of IPs and the
 *     peer matches, x-real-ip (preferred) or the first x-forwarded-for
 *     entry is used instead.
 *
 * Test/fallback path (no real TCP socket):
 *   When getConnInfo() throws (e.g. app.fetch() in tests), falls back to
 *   x-real-ip / x-forwarded-for so test assertions continue to work.
 */
export function getClientIp(c: Context): string {
  const trusted = (process.env.HUB_TRUSTED_PROXY ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  let peer = "";
  let hasRealPeer = false;
  try {
    const { getConnInfo } = require("@hono/node-server/conninfo") as { getConnInfo: (c: Context) => { remote: { address: string } } };
    peer = getConnInfo(c).remote.address ?? "";
    hasRealPeer = true;
  } catch {
    /* No real TCP socket — fall through to headers */
  }

  if (hasRealPeer) {
    return resolveIpWithPeer(peer, trusted, c.req.header("x-real-ip"), c.req.header("x-forwarded-for"));
  }

  // No real peer (test mode) — resolve from headers as fallback
  const realIp = c.req.header("x-real-ip");
  if (realIp) return realIp.trim();
  const fwd = c.req.header("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  return "unknown";
}

/**
 * Pure resolver used by the production branch of `getClientIp`. Exported for
 * unit testing the trusted-proxy logic without a real TCP socket.
 */
export function resolveIpWithPeer(
  peer: string,
  trusted: string[],
  xRealIp: string | undefined,
  xForwardedFor: string | undefined,
): string {
  if (trusted.length > 0 && peer && trusted.includes(peer)) {
    if (xRealIp) return xRealIp.trim();
    if (xForwardedFor) {
      const first = xForwardedFor.split(",")[0]?.trim();
      if (first) return first;
    }
  }
  return peer;
}

/**
 * Loopback check on an arbitrary address string. Exported for unit testing.
 *
 * Per RFC 1122 §3.2.1.3, the entire 127.0.0.0/8 block is reserved for
 * loopback — any address in that range cannot have reached the process
 * from off-host. The IPv4-mapped IPv6 equivalent (::ffff:127.0.0.0/104)
 * is treated the same.
 */
export function isLoopbackAddr(addr: string): boolean {
  if (!addr) return false;
  if (addr === "::1") return true;
  // Strip IPv4-mapped IPv6 prefix if present, then fall through to IPv4 check.
  const v4 = addr.startsWith("::ffff:") ? addr.slice("::ffff:".length) : addr;
  // Match 127.x.y.z where each octet is 0-255.
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v4);
  if (!m) return false;
  return [m[1], m[2], m[3]].every(s => {
    const n = Number(s);
    return n >= 0 && n <= 255;
  });
}

/** True if the direct TCP peer is a loopback address. Not spoofable. */
export function isLoopbackPeer(c: Context): boolean {
  try {
    const { getConnInfo } = require("@hono/node-server/conninfo") as { getConnInfo: (c: Context) => { remote: { address: string } } };
    const addr = getConnInfo(c).remote.address ?? "";
    return isLoopbackAddr(addr);
  } catch {
    // No real socket (test mode) — fall back to header check.
    // Delegate to isLoopbackAddr so test-mode coverage matches production:
    // 127.0.0.0/8 and ::ffff:127.0.0.0/104 are both recognised.
    const realIp = c.req.header("x-real-ip");
    if (realIp) return isLoopbackAddr(realIp.trim());
    return false;
  }
}
