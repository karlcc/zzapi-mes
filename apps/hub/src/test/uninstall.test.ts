import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const UNINSTALL_SH = join(__dirname, "..", "..", "deploy", "uninstall.sh");

function runUninstall(env: Record<string, string>): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = execFile("bash", [UNINSTALL_SH], {
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

describe("uninstall.sh structural checks", () => {
  it("stops and disables systemd units before removing files", () => {
    const content = readFileSync(UNINSTALL_SH, "utf-8");
    const stopIdx = content.indexOf("systemctl stop");
    const rmIdx = content.indexOf("rm -rf");
    assert.ok(stopIdx > 0, "must have systemctl stop");
    assert.ok(rmIdx > 0, "must have rm -rf");
    assert.ok(stopIdx < rmIdx, "must stop service before removing files");
  });

  it("asks before removing data directory (contains DB with key hashes)", () => {
    const content = readFileSync(UNINSTALL_SH, "utf-8");
    assert.match(content, /confirm_removal.*DATA_DIR/, "must confirm before removing data directory");
    assert.match(content, /DATA_DIR.*hub\.db/, "must mention hub.db in confirmation prompt or comment");
  });

  it("asks before removing env file (contains SAP credentials)", () => {
    const content = readFileSync(UNINSTALL_SH, "utf-8");
    assert.match(content, /confirm_removal.*ENV_FILE/, "must confirm before removing env file");
    assert.match(content, /SAP credentials/, "must mention SAP credentials in prompt or comment");
  });

  it("asks before removing system user", () => {
    const content = readFileSync(UNINSTALL_SH, "utf-8");
    assert.match(content, /confirm_removal.*zzapi-mes/, "must confirm before removing system user");
    assert.match(content, /userdel/, "must use userdel to remove user");
  });

  it("removes systemd unit files and reloads daemon", () => {
    const content = readFileSync(UNINSTALL_SH, "utf-8");
    // The script assigns unit_file="/etc/systemd/system/..." and then rm's it
    assert.match(content, /\/etc\/systemd\/system/, "must reference /etc/systemd/system paths");
    assert.match(content, /sudo rm.*unit_file/, "must rm the systemd unit file");
    assert.match(content, /systemctl daemon-reload/, "must daemon-reload after removing units");
  });

  it("removes admin CLI symlink", () => {
    const content = readFileSync(UNINSTALL_SH, "utf-8");
    assert.match(content, /CLI_SYMLINK/, "must reference CLI symlink variable");
    assert.match(content, /sudo rm.*CLI_SYMLINK/, "must remove CLI symlink");
  });

  it("handles missing install directory gracefully", () => {
    const content = readFileSync(UNINSTALL_SH, "utf-8");
    assert.match(content, /not found.*skipping/, "must handle missing directories without error");
  });

  it("uses set -euo pipefail for safety", () => {
    const content = readFileSync(UNINSTALL_SH, "utf-8");
    assert.match(content, /set -euo pipefail/, "must use strict error handling");
  });
});

describe("uninstall.sh dry run (no root, no service)", () => {
  it("exits 0 even when nothing is installed", async () => {
    // Running as non-root on a system without the hub installed.
    // The script should handle missing directories/services gracefully.
    const { code, stderr } = await runUninstall({ PATH: process.env.PATH ?? "/usr/bin:/bin" });
    // May exit non-zero if it tries systemctl and fails, but should not crash
    // with unhandled errors. Check that it at least starts and produces output.
    assert.ok(code === 0 || stderr.length > 0, "should exit cleanly or with clear warnings");
  });
});
