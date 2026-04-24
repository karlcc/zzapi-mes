import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";

const ENTRY = "dist/index.js";

/** Track spawned children so afterEach can kill orphans on test failure. */
const spawned: ChildProcess[] = [];

afterEach(() => {
  for (const child of spawned) {
    try { child.kill("SIGKILL"); } catch {}
  }
  spawned.length = 0;
});

function runWithEnv(env: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", [ENTRY], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    spawned.push(child);
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, 10_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      const idx = spawned.indexOf(child);
      if (idx !== -1) spawned.splice(idx, 1);
      resolve({ code, stderr });
    });
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

describe("maintenance boot blocking", () => {
  it("server starts listening before setImmediate maintenance runs", async () => {
    // The server should be accepting connections before the pruneAuditLog
    // setImmediate callback fires, so first requests are not blocked.
    // We verify this by spawning the hub and checking that the listening
    // message appears before the maintenance message in combined output.
    const tmpDir = await import("node:fs/promises").then((fs) => fs.mkdtemp("/tmp/zzapi-maint-"));
    const child = spawn("node", [ENTRY], {
      env: {
        ...process.env,
        HUB_JWT_SECRET: "at-least-16-chars-long",
        HUB_JWT_TTL_SECONDS: "900",
        SAP_HOST: "sapdev.test:8000",
        SAP_CLIENT: "200",
        SAP_USER: "u",
        SAP_PASS: "p",
        HUB_DB_PATH: `${tmpDir}/hub.db`,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    spawned.push(child);

    const output = await new Promise<string>((resolve) => {
      let buf = "";
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(buf); }, 10_000);
      // Hub logs "listening on" to stdout, "Startup maintenance" to stdout
      const append = (d: Buffer) => {
        buf += d.toString();
        if (buf.includes("listening on") && buf.includes("Startup maintenance")) {
          clearTimeout(timer);
          child.kill("SIGTERM");
        }
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      child.on("close", () => { clearTimeout(timer); resolve(buf); });
    });

    const listenIdx = output.indexOf("listening on");
    const maintIdx = output.indexOf("Startup maintenance");
    assert.ok(listenIdx >= 0, `expected "listening on" in output, got: ${output.slice(0, 200)}`);
    // Maintenance may not run if SIGTERM arrives first, but if it did run,
    // it must appear after the listening message (not before).
    if (maintIdx >= 0) {
      assert.ok(listenIdx < maintIdx, `"listening on" should appear before "Startup maintenance" — got listenIdx=${listenIdx}, maintIdx=${maintIdx}`);
    }
  });
});
