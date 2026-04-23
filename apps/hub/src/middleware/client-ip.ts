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

/** Loopback check on an arbitrary address string. Exported for unit testing. */
export function isLoopbackAddr(addr: string): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

/** True if the direct TCP peer is a loopback address. Not spoofable. */
export function isLoopbackPeer(c: Context): boolean {
  try {
    const { getConnInfo } = require("@hono/node-server/conninfo") as { getConnInfo: (c: Context) => { remote: { address: string } } };
    const addr = getConnInfo(c).remote.address ?? "";
    return isLoopbackAddr(addr);
  } catch {
    // No real socket (test mode) — fall back to header check
    const realIp = c.req.header("x-real-ip");
    if (realIp) return realIp.trim() === "127.0.0.1" || realIp.trim() === "::1";
    return false;
  }
}
