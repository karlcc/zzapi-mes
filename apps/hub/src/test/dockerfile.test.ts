import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DOCKERFILE = join(__dirname, "..", "..", "..", "..", "Dockerfile");

describe("Dockerfile", () => {
  it("runs pnpm prune in CI mode so non-interactive builds do not abort", () => {
    const dockerfile = readFileSync(DOCKERFILE, "utf8");

    assert.match(dockerfile, /RUN\s+CI=true\s+pnpm\s+prune\s+--prod/);
  });
});
