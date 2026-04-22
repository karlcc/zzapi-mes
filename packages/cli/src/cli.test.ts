import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

const CLI = join(__dirname, "..", "dist", "cli.js");

function run(args: string[], env?: Record<string, string>): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = execFile("node", [CLI, ...args], {
      env: { ...process.env, ...env },
      timeout: 5000,
    }, (err, stdout, stderr) => {
      resolve({
        stdout: stdout?.trim() ?? "",
        stderr: stderr?.trim() ?? "",
        code: err ? 1 : 0,
      });
    });
    proc.on("error", () => {});
  });
}

describe("CLI", () => {
  describe("--help", () => {
    it("prints usage", async () => {
      const { stdout, code } = await run(["--help"]);
      assert.equal(code, 0);
      assert.ok(stdout.includes("ping"));
      assert.ok(stdout.includes("po"));
      assert.ok(stdout.includes("--mode"));
    });
  });

  describe("--version", () => {
    it("prints version", async () => {
      const { stdout, code } = await run(["--version"]);
      assert.equal(code, 0);
      assert.match(stdout, /^0\.1\.0$/);
    });
  });

  describe("unknown command", () => {
    it("exits with error", async () => {
      const { stderr, code } = await run(["bogus"], {
        SAP_USER: "u", SAP_PASS: "p",
      });
      assert.notEqual(code, 0);
      assert.ok(stderr.includes("Unknown command"));
    });
  });

  describe("--mode flag", () => {
    it("rejects unknown mode", async () => {
      const { stderr, code } = await run(["--mode", "vpn", "ping"], {
        SAP_USER: "u", SAP_PASS: "p",
      });
      assert.notEqual(code, 0);
      assert.ok(stderr.includes("Unknown mode"));
    });

    it("accepts --mode=hub form and requires hub config", async () => {
      const { stderr, code } = await run(["--mode=hub", "ping"]);
      assert.notEqual(code, 0);
      assert.ok(stderr.includes("HUB_URL"));
    });
  });

  describe("direct mode (missing creds)", () => {
    it("exits if SAP_USER/SAP_PASS not set", async () => {
      const { stderr, code } = await run(["ping"], {
        SAP_USER: "", SAP_PASS: "",
      });
      assert.notEqual(code, 0);
      assert.ok(stderr.includes("SAP_USER") || stderr.includes("SAP_PASS"));
    });
  });

  describe("hub mode (missing creds)", () => {
    it("exits if HUB_URL/HUB_API_KEY not set", async () => {
      const { stderr, code } = await run(["--mode", "hub", "ping"]);
      assert.notEqual(code, 0);
      assert.ok(stderr.includes("HUB_URL"));
    });
  });

  describe("po command", () => {
    it("exits if ebeln not provided", async () => {
      const { stderr, code } = await run(["po"], {
        SAP_USER: "u", SAP_PASS: "p",
      });
      assert.notEqual(code, 0);
      assert.ok(stderr.includes("ebeln") || stderr.includes("Usage"));
    });
  });
});
