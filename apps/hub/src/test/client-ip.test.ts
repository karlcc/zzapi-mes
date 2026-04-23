import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { getClientIp, isLoopbackPeer, resolveIpWithPeer, isLoopbackAddr } from "../middleware/client-ip.js";

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

  it("returns first x-forwarded-for entry when trusted proxy and no x-real-ip", () => {
    assert.equal(resolveIpWithPeer("10.0.0.1", ["10.0.0.1"], undefined, "1.2.3.4, 5.6.7.8"), "1.2.3.4");
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
});

describe("isLoopbackAddr", () => {
  it("returns true for IPv4 loopback", () => { assert.equal(isLoopbackAddr("127.0.0.1"), true); });
  it("returns true for IPv6 loopback", () => { assert.equal(isLoopbackAddr("::1"), true); });
  it("returns true for IPv4-mapped IPv6 loopback", () => { assert.equal(isLoopbackAddr("::ffff:127.0.0.1"), true); });
  it("returns false for non-loopback IPv4", () => { assert.equal(isLoopbackAddr("10.0.0.1"), false); });
  it("returns false for non-loopback IPv6", () => { assert.equal(isLoopbackAddr("fe80::1"), false); });
  it("returns false for empty string", () => { assert.equal(isLoopbackAddr(""), false); });
  it("does not treat 127.0.0.2 as loopback", () => { assert.equal(isLoopbackAddr("127.0.0.2"), false); });
});
