import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

const ENTRY = join(__dirname, "..", "index.js");

function baseEnv(overrides: Record<string, string>, dbPath: string): Record<string, string> {
  return {
    ...process.env,
    HUB_JWT_SECRET: "test-secret-at-least-16-chars",
    HUB_DB_PATH: dbPath,
    SAP_HOST: "sap.test:8000",
    SAP_CLIENT: "200",
    SAP_USER: "test",
    SAP_PASS: "test",
    ...overrides,
  };
}

function run(env: Record<string, string>): Promise<{ stderr: string; code: number }> {
  return new Promise((resolve) => {
    const tmp = mkdtempSync(join(tmpdir(), "hub-startup-"));
    const dbDir = join(tmp, "db");
    mkdirSync(dbDir, { recursive: true });
    const dbPath = join(dbDir, "test.db");
    const proc = spawn("node", [ENTRY], {
      env: baseEnv(env, dbPath),
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

/** Spawn the hub and wait for it to start listening. Returns the process + output helpers. */
function spawnHub(envOverrides: Record<string, string> = {}): Promise<{ proc: ChildProcess; stdout: string; stderr: string; dbPath: string; tmpDir: string }> {
  const tmpDir = mkdtempSync(join(tmpdir(), "hub-sigterm-"));
  const dbDir = join(tmpDir, "db");
  mkdirSync(dbDir, { recursive: true });
  const dbPath = join(dbDir, "test.db");

  return new Promise((resolve, reject) => {
    const proc = spawn("node", [ENTRY], {
      env: baseEnv(envOverrides, dbPath),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("hub did not start listening within 10s"));
    }, 10_000);

    // Wait for "listening" message on stdout
    const check = (d: Buffer) => {
      stdout += d.toString();
      if (stdout.includes("listening")) {
        clearTimeout(timeout);
        proc.stdout.off("data", check);
        resolve({ proc, stdout, stderr, dbPath, tmpDir });
      }
    };
    proc.stdout.on("data", check);
    proc.on("error", (err) => { clearTimeout(timeout); reject(err); });
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

  it("rejects SAP_TIMEOUT=0 with exit 1", async () => {
    const { stderr, code } = await run({ SAP_TIMEOUT: "0" });
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

  it("rejects HUB_PORT=8080.5 (float) with exit 1", async () => {
    const { stderr, code } = await run({ HUB_PORT: "8080.5" });
    assert.notEqual(code, 0);
    assert.ok(stderr.includes("HUB_PORT"), `stderr should mention HUB_PORT: ${stderr}`);
  });

  it("rejects HUB_AUDIT_RETENTION_DAYS=90.7 (float) with exit 1", async () => {
    const { stderr, code } = await run({ HUB_AUDIT_RETENTION_DAYS: "90.7" });
    assert.notEqual(code, 0);
    assert.ok(stderr.includes("HUB_AUDIT_RETENTION_DAYS"), `stderr should mention HUB_AUDIT_RETENTION_DAYS: ${stderr}`);
  });

  it("rejects HUB_JWT_TTL_SECONDS=900.5 (float) with exit 1", async () => {
    const { stderr, code } = await run({ HUB_JWT_TTL_SECONDS: "900.5" });
    assert.notEqual(code, 0);
    assert.ok(stderr.includes("HUB_JWT_TTL_SECONDS"), `stderr should mention HUB_JWT_TTL_SECONDS: ${stderr}`);
  });

  it("rejects HUB_CORS_ORIGIN with javascript: scheme", async () => {
    const { stderr, code } = await run({ HUB_CORS_ORIGIN: "javascript:alert(1)" });
    assert.notEqual(code, 0);
    assert.ok(stderr.includes("dangerous scheme"), `stderr should mention dangerous scheme: ${stderr}`);
  });

  it("rejects HUB_CORS_ORIGIN with data: scheme", async () => {
    const { stderr, code } = await run({ HUB_CORS_ORIGIN: "data:text/html,<script>alert(1)</script>" });
    assert.notEqual(code, 0);
    assert.ok(stderr.includes("dangerous scheme"), `stderr should mention dangerous scheme: ${stderr}`);
  });
});

describe("Graceful shutdown", () => {
  it("handles double SIGTERM without crashing", async () => {
    const { proc, tmpDir } = await spawnHub();
    // First SIGTERM triggers graceful shutdown
    proc.kill("SIGTERM");
    // Second SIGTERM arrives while shuttingDown=true — should be ignored (not crash)
    proc.kill("SIGTERM");
    const code = await new Promise<number>((resolve) => {
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve(-1);
      }, 10_000);
      proc.on("close", (c) => { clearTimeout(timer); resolve(c ?? 1); });
    });
    assert.equal(code, 0, "should exit cleanly after graceful shutdown");
    // Cleanup handled by OS since tmpDir is in /tmp
  });

  it("handles SIGINT (Ctrl+C) gracefully", async () => {
    const { proc, tmpDir } = await spawnHub();
    proc.kill("SIGINT");
    const code = await new Promise<number>((resolve) => {
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve(-1);
      }, 10_000);
      proc.on("close", (c) => { clearTimeout(timer); resolve(c ?? 1); });
    });
    assert.equal(code, 0, "should exit cleanly after SIGINT");
  });
});

describe("Boot maintenance", () => {
  it("runs pruneAuditLog + evictIdempotencyKeys on startup", async () => {
    // Create a DB with stale audit + idempotency rows
    const tmpDir = mkdtempSync(join(tmpdir(), "hub-maint-"));
    const dbDir = join(tmpDir, "db");
    mkdirSync(dbDir, { recursive: true });
    const dbPath = join(dbDir, "test.db");

    const db = new Database(dbPath);
    const { runMigrations } = await import("../db/index.js");
    runMigrations(db);
    // Insert a stale audit row (created_at is epoch seconds, older than 90 days default)
    const staleEpoch = Math.floor(Date.now() / 1000) - 91 * 86400;
    db.prepare("INSERT INTO audit_log (req_id, key_id, method, path, sap_status, sap_duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("stale-req", "key1", "GET", "/ping", 200, 50, staleEpoch);
    // Insert a stale idempotency key (created_at is epoch seconds, older than 300s)
    const staleIdemEpoch = Math.floor(Date.now() / 1000) - 600;
    db.prepare("INSERT INTO idempotency_keys (key, key_id, path, body_hash, status, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("stale-key", "key1", "/confirmation", "abc123", 201, staleIdemEpoch);
    db.close();

    // Spawn the hub with this DB
    const proc = spawn("node", [ENTRY], {
      env: baseEnv({}, dbPath),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });

    // Wait for startup maintenance log line
    const maintenanceLogged = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve(false);
      }, 10_000);
      const check = (d: Buffer) => {
        stdout += d.toString();
        if (stdout.includes("Startup maintenance")) {
          clearTimeout(timer);
          proc.stdout.off("data", check);
          resolve(true);
        }
      };
      proc.stdout.on("data", check);
    });

    // Clean up the hub process
    proc.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { proc.kill("SIGKILL"); resolve(); }, 5000);
      proc.on("close", () => { clearTimeout(timer); resolve(); });
    });

    assert.ok(maintenanceLogged, "should log 'Startup maintenance' on boot");
    assert.ok(stdout.includes("pruned 1 audit rows"), `should prune 1 stale audit row: ${stdout}`);
    assert.ok(stdout.includes("evicted 1 idempotency keys"), `should evict 1 stale idempotency key: ${stdout}`);
  });
});
