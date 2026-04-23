import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const ENTRY = "dist/index.js";

function runServer(envOverrides: Record<string, string>): Promise<{ stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const child = spawn("node", [ENTRY], {
      env: { ...process.env, ...envOverrides },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("close", (code) => resolve({ stderr, exitCode: code }));
    // Force-kill after 5s if still running (server started successfully)
    const timer = setTimeout(() => { child.kill("SIGTERM"); }, 5000);
    child.on("close", () => { clearTimeout(timer); });
  });
}

describe("index.ts startup validation", () => {
  it("rejects HUB_PORT <= 0", async () => {
    const { stderr, exitCode } = await runServer({ HUB_PORT: "0" });
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes("HUB_PORT"), `expected HUB_PORT in stderr, got: ${stderr}`);
  });

  it("rejects negative HUB_PORT", async () => {
    const { stderr, exitCode } = await runServer({ HUB_PORT: "-1" });
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes("HUB_PORT"), `expected HUB_PORT in stderr, got: ${stderr}`);
  });

  it("rejects HUB_AUDIT_RETENTION_DAYS <= 0 (after server binds)", async () => {
    const { exitCode } = await runServer({
      HUB_PORT: "18089", // valid port, allows server to start
      HUB_AUDIT_RETENTION_DAYS: "0",
    });
    assert.equal(exitCode, 1);
  });
});
