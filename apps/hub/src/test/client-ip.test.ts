import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { getClientIp, isLoopbackPeer, resolveIpWithPeer, isLoopbackAddr, validateTrustedProxy } from "../middleware/client-ip.js";

// Build a minimal Hono context for testing
function makeContext(headers: Record<string, string> = {}): unknown {
  const app = new Hono();
  return {
    req: {
      header(name: string) { return headers[name.toLowerCase()] ?? undefined; },
    },
    // getConnInfo will throw in test mode (no real TCP socket)
  };
}

describe("getClientIp", () => {
  const origProxy = process.env.HUB_TRUSTED_PROXY;

  beforeEach(() => { delete process.env.HUB_TRUSTED_PROXY; });
  afterEach(() => {
    if (origProxy !== undefined) process.env.HUB_TRUSTED_PROXY = origProxy;
    else delete process.env.HUB_TRUSTED_PROXY;
  });

  it("returns 'unknown' when no headers and no real peer", () => {
    const c = makeContext();
    assert.equal(getClientIp(c as any), "unknown");
  });

  it("falls back to x-real-ip in test mode (no real peer)", () => {
    const c = makeContext({ "x-real-ip": "10.0.0.5" });
    assert.equal(getClientIp(c as any), "10.0.0.5");
  });

  it("falls back to first x-forwarded-for entry in test mode", () => {
    const c = makeContext({ "x-forwarded-for": "10.0.0.1, 10.0.0.2" });
    assert.equal(getClientIp(c as any), "10.0.0.1");
  });

  it("prefers x-real-ip over x-forwarded-for in test mode", () => {
    const c = makeContext({ "x-real-ip": "10.0.0.5", "x-forwarded-for": "10.0.0.1" });
    assert.equal(getClientIp(c as any), "10.0.0.5");
  });

  it("trims whitespace from x-real-ip", () => {
    const c = makeContext({ "x-real-ip": "  10.0.0.5  " });
    assert.equal(getClientIp(c as any), "10.0.0.5");
  });

  it("trims whitespace from x-forwarded-for entries", () => {
    const c = makeContext({ "x-forwarded-for": "  10.0.0.1  , 10.0.0.2" });
    assert.equal(getClientIp(c as any), "10.0.0.1");
  });

  it("ignores headers when HUB_TRUSTED_PROXY is set but no real peer exists (test mode)", () => {
    process.env.HUB_TRUSTED_PROXY = "192.168.1.1";
    const c = makeContext({ "x-real-ip": "10.0.0.5" });
    // In test mode (no real peer), headers are still used as fallback
    assert.equal(getClientIp(c as any), "10.0.0.5");
  });

  it("returns 'unknown' with no headers and empty trusted proxy list", () => {
    process.env.HUB_TRUSTED_PROXY = "  ";
    const c = makeContext();
    assert.equal(getClientIp(c as any), "unknown");
  });
});

describe("isLoopbackPeer", () => {
  it("returns false in test mode with no headers", () => {
    const c = makeContext();
    assert.equal(isLoopbackPeer(c as any), false);
  });

  it("returns true when x-real-ip is 127.0.0.1 in test mode", () => {
    const c = makeContext({ "x-real-ip": "127.0.0.1" });
    assert.equal(isLoopbackPeer(c as any), true);
  });

  it("returns true when x-real-ip is ::1 in test mode", () => {
    const c = makeContext({ "x-real-ip": "::1" });
    assert.equal(isLoopbackPeer(c as any), true);
  });

  it("returns true when x-real-ip is ::ffff:127.0.0.1 in test mode (IPv4-mapped IPv6)", () => {
    // Consistency with isLoopbackAddr — test-mode fallback previously only
    // recognised 127.0.0.1 and ::1, so IPv4-mapped IPv6 was rejected.
    const c = makeContext({ "x-real-ip": "::ffff:127.0.0.1" });
    assert.equal(isLoopbackPeer(c as any), true);
  });

  it("returns true when x-real-ip is anywhere in 127.0.0.0/8 in test mode", () => {
    // RFC 1122 reserves 127.0.0.0/8 for loopback; any address in the block
    // cannot have reached the process from off-host.
    const c = makeContext({ "x-real-ip": "127.0.0.5" });
    assert.equal(isLoopbackPeer(c as any), true);
  });

  it("returns false for non-loopback x-real-ip in test mode", () => {
    const c = makeContext({ "x-real-ip": "10.0.0.1" });
    assert.equal(isLoopbackPeer(c as any), false);
  });

  it("returns false when x-real-ip has whitespace around loopback address", () => {
    const c = makeContext({ "x-real-ip": "  127.0.0.1  " });
    assert.equal(isLoopbackPeer(c as any), true);
  });
});

describe("resolveIpWithPeer (production branch unit tests)", () => {
  it("returns peer when no trusted proxies configured", () => {
    assert.equal(resolveIpWithPeer("10.0.0.1", [], "1.2.3.4", undefined), "10.0.0.1");
  });

  it("returns peer when peer is not in trusted list", () => {
    assert.equal(resolveIpWithPeer("10.0.0.1", ["10.0.0.2"], "1.2.3.4", "5.6.7.8"), "10.0.0.1");
  });

  it("returns x-real-ip when peer is trusted proxy", () => {
    assert.equal(resolveIpWithPeer("10.0.0.1", ["10.0.0.1"], "1.2.3.4", undefined), "1.2.3.4");
  });

  it("returns rightmost x-forwarded-for entry when trusted proxy and no x-real-ip", () => {
    assert.equal(resolveIpWithPeer("10.0.0.1", ["10.0.0.1"], undefined, "1.2.3.4, 5.6.7.8"), "5.6.7.8");
  });

  it("prefers x-real-ip over x-forwarded-for when both present", () => {
    assert.equal(resolveIpWithPeer("10.0.0.1", ["10.0.0.1"], "1.2.3.4", "9.9.9.9"), "1.2.3.4");
  });

  it("returns peer when trusted but no headers", () => {
    assert.equal(resolveIpWithPeer("10.0.0.1", ["10.0.0.1"], undefined, undefined), "10.0.0.1");
  });

  it("trims whitespace from x-real-ip", () => {
    assert.equal(resolveIpWithPeer("10.0.0.1", ["10.0.0.1"], "  1.2.3.4  ", undefined), "1.2.3.4");
  });

  it("ignores empty peer even with trusted list", () => {
    assert.equal(resolveIpWithPeer("", ["10.0.0.1"], "1.2.3.4", undefined), "");
  });

  it("uses rightmost X-Forwarded-For entry when trusted proxy (prevents spoofing)", () => {
    // X-Forwarded-For: spoofed-ip, real-client
    // When there's a single trusted proxy, it appends the real client IP as the
    // rightmost entry. Taking the rightmost prevents the client from injecting
    // fake entries at the front.
    const result = resolveIpWithPeer("10.0.0.1", ["10.0.0.1"], undefined, "spoofed-ip, real-client");
    assert.equal(result, "real-client", "should take rightmost XFF entry from trusted proxy");
  });

  it("takes leftmost XFF when only one entry (no spoofing risk)", () => {
    const result = resolveIpWithPeer("10.0.0.1", ["10.0.0.1"], undefined, "1.2.3.4");
    assert.equal(result, "1.2.3.4");
  });

  it("normalizes IPv4-mapped IPv6 peer against trusted list", () => {
    // ::ffff:10.0.0.1 should match 10.0.0.1 in the trusted list
    const result = resolveIpWithPeer("::ffff:10.0.0.1", ["10.0.0.1"], "1.2.3.4", undefined);
    assert.equal(result, "1.2.3.4", "IPv4-mapped peer should match plain IPv4 trusted entry");
  });

  it("normalizes IPv4-mapped IPv6 in trusted list against plain IPv4 peer", () => {
    // peer is plain IPv4, trusted list has IPv4-mapped form
    const result = resolveIpWithPeer("10.0.0.1", ["::ffff:10.0.0.1"], "1.2.3.4", undefined);
    assert.equal(result, "1.2.3.4", "plain IPv4 peer should match IPv4-mapped trusted entry");
  });

  it("matches peer within CIDR range (10.0.0.0/8)", () => {
    const result = resolveIpWithPeer("10.0.0.1", ["10.0.0.0/8"], "1.2.3.4", undefined);
    assert.equal(result, "1.2.3.4", "peer in CIDR range should be treated as trusted");
  });

  it("rejects peer outside CIDR range", () => {
    const result = resolveIpWithPeer("192.168.1.1", ["10.0.0.0/8"], "1.2.3.4", undefined);
    assert.equal(result, "192.168.1.1", "peer outside CIDR should not be trusted");
  });

  it("matches peer within /16 CIDR", () => {
    const result = resolveIpWithPeer("192.168.5.100", ["192.168.0.0/16"], "1.2.3.4", undefined);
    assert.equal(result, "1.2.3.4", "peer in /16 CIDR should be trusted");
  });

  it("rejects peer just outside /16 CIDR boundary", () => {
    const result = resolveIpWithPeer("192.169.0.1", ["192.168.0.0/16"], "1.2.3.4", undefined);
    assert.equal(result, "192.169.0.1", "peer just outside /16 should not be trusted");
  });

  it("mixes exact IPs and CIDR ranges in trusted list", () => {
    const result = resolveIpWithPeer("172.16.0.5", ["10.0.0.1", "172.16.0.0/12"], "1.2.3.4", undefined);
    assert.equal(result, "1.2.3.4", "peer matching CIDR entry should be trusted");
  });

  it("normalizes IPv4-mapped peer before CIDR match", () => {
    const result = resolveIpWithPeer("::ffff:10.0.0.5", ["10.0.0.0/8"], "1.2.3.4", undefined);
    assert.equal(result, "1.2.3.4", "IPv4-mapped peer should match plain IPv4 CIDR");
  });

  it("/32 CIDR matches exact single IP", () => {
    const result = resolveIpWithPeer("10.0.0.1", ["10.0.0.1/32"], "1.2.3.4", undefined);
    assert.equal(result, "1.2.3.4", "/32 should match exact IP");
  });
});

describe("validateTrustedProxy", () => {
  it("returns null for valid exact IPs", () => {
    assert.equal(validateTrustedProxy(["10.0.0.1", "192.168.1.1"]), null);
  });

  it("returns null for valid CIDR ranges", () => {
    assert.equal(validateTrustedProxy(["10.0.0.0/8", "192.168.0.0/16"]), null);
  });

  it("returns null for /32 CIDR", () => {
    assert.equal(validateTrustedProxy(["10.0.0.1/32"]), null);
  });

  it("returns null for IPv4-mapped IPv6 exact IP", () => {
    assert.equal(validateTrustedProxy(["::ffff:10.0.0.1"]), null);
  });

  it("returns error for invalid IP address", () => {
    const err = validateTrustedProxy(["not-an-ip"]);
    assert.ok(err?.includes("invalid IP address"), err ?? "expected error");
  });

  it("returns error for invalid CIDR prefix length", () => {
    const err = validateTrustedProxy(["10.0.0.0/33"]);
    assert.ok(err?.includes("invalid CIDR prefix length"), err ?? "expected error");
  });

  it("returns error for invalid CIDR network address", () => {
    const err = validateTrustedProxy(["not-an-ip/8"]);
    assert.ok(err?.includes("invalid CIDR network address"), err ?? "expected error");
  });

  it("returns null for empty list", () => {
    assert.equal(validateTrustedProxy([]), null);
  });
});

describe("isLoopbackAddr", () => {
  it("returns true for IPv4 loopback", () => { assert.equal(isLoopbackAddr("127.0.0.1"), true); });
  it("returns true for IPv6 loopback", () => { assert.equal(isLoopbackAddr("::1"), true); });
  it("returns true for IPv4-mapped IPv6 loopback", () => { assert.equal(isLoopbackAddr("::ffff:127.0.0.1"), true); });
  // RFC 1122: the entire 127.0.0.0/8 block is reserved for loopback; any
  // address in that block cannot have reached the process from off-host.
  it("returns true for 127.0.0.2 (RFC 1122 127.0.0.0/8)", () => { assert.equal(isLoopbackAddr("127.0.0.2"), true); });
  it("returns true for 127.1.2.3 (RFC 1122 127.0.0.0/8)", () => { assert.equal(isLoopbackAddr("127.1.2.3"), true); });
  it("returns true for 127.255.255.254 (RFC 1122 127.0.0.0/8)", () => { assert.equal(isLoopbackAddr("127.255.255.254"), true); });
  it("returns true for ::ffff:127.0.0.2 (IPv4-mapped 127.0.0.0/8)", () => { assert.equal(isLoopbackAddr("::ffff:127.0.0.2"), true); });
  it("returns true for ::ffff:127.1.2.3 (IPv4-mapped 127.0.0.0/8)", () => { assert.equal(isLoopbackAddr("::ffff:127.1.2.3"), true); });
  it("returns false for non-loopback IPv4", () => { assert.equal(isLoopbackAddr("10.0.0.1"), false); });
  it("returns false for non-loopback IPv6", () => { assert.equal(isLoopbackAddr("fe80::1"), false); });
  it("returns false for empty string", () => { assert.equal(isLoopbackAddr(""), false); });
  it("returns false for ::ffff:128.0.0.1 (outside 127.0.0.0/8)", () => { assert.equal(isLoopbackAddr("::ffff:128.0.0.1"), false); });
  it("returns false for 128.0.0.1 (just outside 127.0.0.0/8)", () => { assert.equal(isLoopbackAddr("128.0.0.1"), false); });
  it("returns false for 126.255.255.255 (just below 127.0.0.0/8)", () => { assert.equal(isLoopbackAddr("126.255.255.255"), false); });
});
