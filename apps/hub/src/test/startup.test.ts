import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";

const ENTRY = join(__dirname, "..", "index.js");

function run(env: Record<string, string>): Promise<{ stderr: string; code: number }> {
  return new Promise((resolve) => {
    const tmp = mkdtempSync(join(tmpdir(), "hub-startup-"));
    const dbDir = join(tmp, "db");
    mkdirSync(dbDir, { recursive: true });
    const proc = spawn("node", [ENTRY], {
      env: {
        ...process.env,
        HUB_JWT_SECRET: "test-secret-at-least-16-chars",
        HUB_DB_PATH: join(dbDir, "test.db"),
        SAP_HOST: "sap.test:8000",
        SAP_CLIENT: "200",
        SAP_USER: "test",
        SAP_PASS: "test",
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    const timer = setTimeout(() => proc.kill("SIGKILL"), 10_000);
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stderr, code: code ?? 1 });
    });
    proc.on("error", () => resolve({ stderr: "spawn error", code: 1 }));
  });
}

describe("Hub startup validation", () => {
  it("rejects HUB_PORT=0 with exit 1", async () => {
    const { stderr, code } = await run({ HUB_PORT: "0" });
    assert.notEqual(code, 0, "should exit non-zero for HUB_PORT=0");
    assert.ok(stderr.includes("HUB_PORT"), `stderr should mention HUB_PORT: ${stderr}`);
  });

  it("rejects HUB_PORT=-1 with exit 1", async () => {
    const { stderr, code } = await run({ HUB_PORT: "-1" });
    assert.notEqual(code, 0);
    assert.ok(stderr.includes("HUB_PORT"), `stderr should mention HUB_PORT: ${stderr}`);
  });

  it("rejects HUB_AUDIT_RETENTION_DAYS=0 with exit 1", async () => {
    const { stderr, code } = await run({ HUB_AUDIT_RETENTION_DAYS: "0" });
    assert.notEqual(code, 0);
    assert.ok(stderr.includes("HUB_AUDIT_RETENTION_DAYS"), `stderr should mention HUB_AUDIT_RETENTION_DAYS: ${stderr}`);
  });

  it("rejects HUB_JWT_TTL_SECONDS=0 with exit 1", async () => {
    const { stderr, code } = await run({ HUB_JWT_TTL_SECONDS: "0" });
    assert.notEqual(code, 0);
    assert.ok(stderr.includes("HUB_JWT_TTL_SECONDS"), `stderr should mention HUB_JWT_TTL_SECONDS: ${stderr}`);
  });

  it("rejects HUB_JWT_TTL_SECONDS=30 with exit 1", async () => {
    const { stderr, code } = await run({ HUB_JWT_TTL_SECONDS: "30" });
    assert.notEqual(code, 0);
    assert.ok(stderr.includes("HUB_JWT_TTL_SECONDS"), `stderr should mention HUB_JWT_TTL_SECONDS: ${stderr}`);
  });

  it("rejects SAP_CLIENT=0 with exit 1", async () => {
    const { stderr, code } = await run({ SAP_CLIENT: "0" });
    assert.notEqual(code, 0);
    assert.ok(stderr.includes("SAP_CLIENT"), `stderr should mention SAP_CLIENT: ${stderr}`);
  });

  it("rejects SAP_CLIENT=-1 with exit 1", async () => {
    const { stderr, code } = await run({ SAP_CLIENT: "-1" });
    assert.notEqual(code, 0);
    assert.ok(stderr.includes("SAP_CLIENT"), `stderr should mention SAP_CLIENT: ${stderr}`);
  });

  it("rejects HUB_PORT=NaN (non-numeric) with exit 1", async () => {
    const { stderr, code } = await run({ HUB_PORT: "abc" });
    assert.notEqual(code, 0);
    assert.ok(stderr.includes("HUB_PORT"), `stderr should mention HUB_PORT: ${stderr}`);
  });

  it("rejects HUB_JWT_TTL_SECONDS=NaN (non-numeric) with exit 1", async () => {
    const { stderr, code } = await run({ HUB_JWT_TTL_SECONDS: "abc" });
    assert.notEqual(code, 0);
    assert.ok(stderr.includes("HUB_JWT_TTL_SECONDS"), `stderr should mention HUB_JWT_TTL_SECONDS: ${stderr}`);
  });

  it("rejects HUB_AUDIT_RETENTION_DAYS=NaN (non-numeric) with exit 1", async () => {
    const { stderr, code } = await run({ HUB_AUDIT_RETENTION_DAYS: "abc" });
    assert.notEqual(code, 0);
    assert.ok(stderr.includes("HUB_AUDIT_RETENTION_DAYS"), `stderr should mention HUB_AUDIT_RETENTION_DAYS: ${stderr}`);
  });

  it("rejects SAP_CLIENT=NaN (non-numeric) with exit 1", async () => {
    const { stderr, code } = await run({ SAP_CLIENT: "abc" });
    assert.notEqual(code, 0);
    assert.ok(stderr.includes("SAP_CLIENT"), `stderr should mention SAP_CLIENT: ${stderr}`);
  });

  it("rejects SAP_TIMEOUT=NaN (non-numeric) with exit 1", async () => {
    const { stderr, code } = await run({ SAP_TIMEOUT: "abc" });
    assert.notEqual(code, 0);
    assert.ok(stderr.includes("SAP_TIMEOUT"), `stderr should mention SAP_TIMEOUT: ${stderr}`);
  });

  it("rejects SAP_TIMEOUT=-1 with exit 1", async () => {
    const { stderr, code } = await run({ SAP_TIMEOUT: "-1" });
    assert.notEqual(code, 0);
    assert.ok(stderr.includes("SAP_TIMEOUT"), `stderr should mention SAP_TIMEOUT: ${stderr}`);
  });

  it("rejects missing HUB_JWT_SECRET with exit 1", async () => {
    const { stderr, code } = await run({ HUB_JWT_SECRET: "" });
    assert.notEqual(code, 0);
    assert.ok(stderr.includes("HUB_JWT_SECRET"), `stderr should mention HUB_JWT_SECRET: ${stderr}`);
  });

  it("rejects HUB_JWT_SECRET too short (<16 chars) with exit 1", async () => {
    const { stderr, code } = await run({ HUB_JWT_SECRET: "short" });
    assert.notEqual(code, 0);
    assert.ok(stderr.includes("HUB_JWT_SECRET"), `stderr should mention HUB_JWT_SECRET: ${stderr}`);
  });
});
