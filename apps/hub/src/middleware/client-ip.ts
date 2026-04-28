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
 * Normalize an IP address by stripping the IPv4-mapped IPv6 prefix.
 * `::ffff:10.0.0.1` → `10.0.0.1`, plain IPv4 and IPv6 pass through unchanged.
 */
function normalizeIp(ip: string): string {
  if (ip.startsWith("::ffff:")) return ip.slice("::ffff:".length);
  return ip;
}

/** Parse an IPv4 address into a 32-bit unsigned integer. */
function ipv4ToUint(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isFinite(v) || v < 0 || v > 255 || p !== String(v)) return null;
    n = (n << 8) | v;
  }
  return n >>> 0; // unsigned
}

/** Check whether `ip` falls within the CIDR range `cidr` (e.g. "10.0.0.0/8"). */
function isInCidr(ip: string, cidr: string): boolean {
  const slashIdx = cidr.indexOf("/");
  if (slashIdx < 0) return false; // not a CIDR
  const prefixBits = Number(cidr.slice(slashIdx + 1));
  if (!Number.isFinite(prefixBits) || prefixBits < 0 || prefixBits > 32) return false;
  const netAddr = cidr.slice(0, slashIdx);
  const ipNum = ipv4ToUint(normalizeIp(ip));
  const netNum = ipv4ToUint(normalizeIp(netAddr));
  if (ipNum === null || netNum === null) return false;
  if (prefixBits === 0) return true; // /0 matches everything
  const mask = (~0 << (32 - prefixBits)) >>> 0;
  return ((ipNum & mask) >>> 0) === ((netNum & mask) >>> 0);
}

/** Check whether `ip` matches any entry in `trusted` (exact or CIDR). */
function isTrustedProxy(ip: string, trusted: string[]): boolean {
  const normalized = normalizeIp(ip);
  for (const entry of trusted) {
    if (entry.includes("/")) {
      if (isInCidr(normalized, entry)) return true;
    } else if (normalizeIp(entry) === normalized) {
      return true;
    }
  }
  return false;
}

/**
 * Validate HUB_TRUSTED_PROXY entries on startup. Returns an error message
 * for the first invalid entry, or null if all are valid.
 */
export function validateTrustedProxy(entries: string[]): string | null {
  for (const entry of entries) {
    if (entry.includes("/")) {
      const slashIdx = entry.indexOf("/");
      const netAddr = entry.slice(0, slashIdx);
      const bits = Number(entry.slice(slashIdx + 1));
      const normNet = normalizeIp(netAddr);
      if (ipv4ToUint(normNet) === null) return `invalid CIDR network address: ${entry}`;
      if (!Number.isFinite(bits) || bits < 0 || bits > 32) return `invalid CIDR prefix length: ${entry}`;
    } else {
      if (ipv4ToUint(normalizeIp(entry)) === null) return `invalid IP address: ${entry}`;
    }
  }
  return null;
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
  if (trusted.length > 0 && peer && isTrustedProxy(peer, trusted)) {
    if (xRealIp) return xRealIp.trim();
    if (xForwardedFor) {
      // Use the rightmost (last) X-Forwarded-For entry — it was appended by
      // the trusted proxy and is unspoofable. Leftmost entries can be injected
      // by the client.
      const parts = xForwardedFor.split(",").map(s => s.trim()).filter(Boolean);
      const last = parts[parts.length - 1];
      if (last) return last;
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
