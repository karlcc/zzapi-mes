import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
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

describe("install.sh rollback on failure", () => {
  it("has ERR trap that calls cleanup_on_exit", () => {
    const content = readFileSync(INSTALL_SH, "utf-8");
    assert.match(content, /trap cleanup_on_exit ERR/, "must trap ERR for rollback");
    assert.match(content, /trap.*cleanup_on_exit.*INT TERM/, "must trap INT/TERM for rollback on interrupt");
    assert.match(content, /_ROLLBACK_DIST_BACKUP/, "must declare rollback backup variable");
    assert.match(content, /_ROLLBACK_NM_BACKUP/, "must declare node_modules rollback variable");
  });

  it("backs up existing dist/ before rsync --delete", () => {
    const content = readFileSync(INSTALL_SH, "utf-8");
    // Must move existing dist before the destructive rsync --delete
    const backupIdx = content.indexOf("_ROLLBACK_DIST_BACKUP=");
    const rsyncIdx = content.indexOf("rsync -a --delete");
    assert.ok(backupIdx > 0, "must set backup variable");
    assert.ok(rsyncIdx > 0, "must have rsync --delete");
    assert.ok(backupIdx < rsyncIdx, "backup must happen before rsync --delete");
  });

  it("clears rollback backup after successful rsync", () => {
    const content = readFileSync(INSTALL_SH, "utf-8");
    assert.match(content, /_ROLLBACK_DIST_BACKUP=""/, "must clear backup variable on success");
    assert.match(content, /rm -rf.*_ROLLBACK_DIST_BACKUP/, "must remove backup dir on success");
  });

  it("cleanup_on_exit restores backup when rollback variable is set", () => {
    const content = readFileSync(INSTALL_SH, "utf-8");
    // The cleanup function must check the variable and mv back
    assert.match(content, /mv.*_ROLLBACK_DIST_BACKUP.*dist/, "must restore dist backup in cleanup");
    assert.match(content, /mv.*_ROLLBACK_NM_BACKUP.*node_modules/, "must restore node_modules backup in cleanup");
  });
});
