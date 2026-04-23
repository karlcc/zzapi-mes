import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const ENTRY = "dist/index.js";

function runWithEnv(env: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", [ENTRY], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, 10_000);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stderr }); });
  });
}

describe("index.ts startup validation", () => {
  it("rejects HUB_PORT <= 0", async () => {
    const { code, stderr } = await runWithEnv({ HUB_PORT: "0" });
    assert.equal(code, 1, "should exit with code 1 for HUB_PORT=0");
    assert.ok(stderr.includes("HUB_PORT"), `stderr should mention HUB_PORT, got: ${stderr}`);
  });

  it("rejects negative HUB_PORT", async () => {
    const { code, stderr } = await runWithEnv({ HUB_PORT: "-1" });
    assert.equal(code, 1, "should exit with code 1 for HUB_PORT=-1");
    assert.ok(stderr.includes("HUB_PORT"), `stderr should mention HUB_PORT, got: ${stderr}`);
  });

  it("rejects HUB_AUDIT_RETENTION_DAYS=0", async () => {
    const tmpDir = await import("node:fs/promises").then((fs) => fs.mkdtemp("/tmp/zzapi-startup-"));
    const { code, stderr } = await runWithEnv({
      HUB_JWT_SECRET: "at-least-16-chars-long",
      HUB_JWT_TTL_SECONDS: "900",
      SAP_HOST: "sapdev.test:8000",
      SAP_CLIENT: "200",
      SAP_USER: "u",
      SAP_PASS: "p",
      HUB_AUDIT_RETENTION_DAYS: "0",
      HUB_DB_PATH: `${tmpDir}/hub.db`,
    });
    assert.equal(code, 1, "should exit with code 1 for HUB_AUDIT_RETENTION_DAYS=0");
    assert.ok(stderr.includes("HUB_AUDIT_RETENTION_DAYS"), `stderr should mention HUB_AUDIT_RETENTION_DAYS, got: ${stderr}`);
  });
});
