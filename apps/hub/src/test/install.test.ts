import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";

const INSTALL_SH = join(__dirname, "..", "..", "deploy", "install.sh");

function runInstall(env: Record<string, string>): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = execFile("bash", [INSTALL_SH], {
      env: { ...process.env, ...env },
      timeout: 5000,
    }, (err, stdout, stderr) => {
      resolve({
        stdout: stdout?.trim() ?? "",
        stderr: stderr?.trim() ?? "",
        code: typeof err?.code === "number" ? err.code : (err ? 1 : 0),
      });
    });
    proc.on("error", () => {});
  });
}

describe("install.sh Node version guard", () => {
  it("exits with error when node is not in PATH", async () => {
    // Use PATH with bash, sed, etc. but no node
    const { code } = await runInstall({ PATH: "/bin:/usr/bin" });
    assert.notEqual(code, 0, "should fail when node not found");
  });
});

describe("install.sh pnpm pre-flight check", () => {
  it("exits with error when pnpm is not in PATH", async () => {
    // Create a minimal PATH that has node (so version guard passes) but NOT pnpm.
    // On CI (ubuntu), pnpm is a corepack shim in the same dir as node, so we
    // must explicitly exclude it by using a temp dir with a node symlink only.
    const nodeBin = require("node:path").dirname(require("node:child_process").execSync("which node").toString().trim());
    const fs = require("node:fs");
    const os = require("node:os");
    const tmpDir = fs.mkdtempSync(require("node:path").join(os.tmpdir(), "install-test-"));
    // Symlink node only (no pnpm shim)
    fs.symlinkSync(require("node:path").join(nodeBin, "node"), require("node:path").join(tmpDir, "node"));
    const { stderr, code } = await runInstall({ PATH: `${tmpDir}:/bin:/usr/bin` });
    try {
      assert.notEqual(code, 0, "should fail when pnpm not found");
      assert.ok(stderr.includes("pnpm"), `should mention pnpm: ${stderr}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
