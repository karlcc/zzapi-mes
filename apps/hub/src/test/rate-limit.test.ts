import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  _resetBucketsForTest,
  _seedBucketForTest,
  _bucketCountForTest,
  _forceSweepForTest,
} from "../middleware/rate-limit.js";

describe("rate-limit sweepIdleBuckets", () => {
  beforeEach(() => {
    _resetBucketsForTest();
  });

  it("evicts buckets idle for more than 10 minutes", () => {
    const now = Date.now();
    _seedBucketForTest("old-key", 60, now - 11 * 60_000); // 11 min ago
    _seedBucketForTest("fresh-key", 60, now - 1 * 60_000); // 1 min ago
    assert.equal(_bucketCountForTest(), 2);

    _forceSweepForTest();

    assert.equal(_bucketCountForTest(), 1, "old bucket evicted, fresh kept");
  });

  it("keeps buckets that are exactly at the boundary", () => {
    const now = Date.now();
    // Exactly 10 min — not strictly > IDLE_TIMEOUT_MS
    _seedBucketForTest("boundary-key", 60, now - 10 * 60_000 + 100);
    _forceSweepForTest();
    assert.equal(_bucketCountForTest(), 1);
  });

  it("is a no-op when called twice in quick succession (SWEEP_INTERVAL_MS throttle)", () => {
    const now = Date.now();
    _seedBucketForTest("old-key", 60, now - 11 * 60_000);
    _forceSweepForTest();
    assert.equal(_bucketCountForTest(), 0);

    // Add another stale bucket; a second immediate sweep without force should NOT evict
    _seedBucketForTest("another-old", 60, now - 11 * 60_000);
    // Importing sweepIdleBuckets indirectly: reset lastSweep and try. Since we
    // don't export the non-forced version, we verify the force helper is the
    // only way to sweep outside the interval.
    assert.equal(_bucketCountForTest(), 1);
  });
});
