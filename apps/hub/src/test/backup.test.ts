import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

const BACKUP_SH = join(__dirname, "..", "..", "deploy", "backup.sh");

function runBackup(env: Record<string, string>): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = execFile("bash", [BACKUP_SH], {
      env: { ...process.env, ...env },
      timeout: 10000,
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

describe("backup.sh", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "zzapi-backup-"));
    dbPath = join(tmpDir, "hub.db");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a gzipped backup of a valid database", async () => {
    // Create a real SQLite DB
    const db = new Database(dbPath);
    db.exec("CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)");
    db.exec("INSERT INTO test (name) VALUES ('hello')");
    db.close();

    const backupDir = join(tmpDir, "backups");
    const { stdout, code } = await runBackup({
      HUB_DB: dbPath,
      HUB_BACKUP_DIR: backupDir,
      HUB_BACKUP_RETAIN_DAYS: "30",
    });
    assert.equal(code, 0, `backup failed: ${stdout}`);
    assert.ok(stdout.includes("backup complete"), `unexpected output: ${stdout}`);

    // Verify .gz file exists
    const files = readdirSync(backupDir).filter(f => f.endsWith(".db.gz"));
    assert.equal(files.length, 1, "should produce exactly one .gz backup");
  });

  it("exits with error when database file does not exist", async () => {
    const backupDir = join(tmpDir, "backups");
    const { stderr, code } = await runBackup({
      HUB_DB: join(tmpDir, "nonexistent.db"),
      HUB_BACKUP_DIR: backupDir,
      HUB_BACKUP_RETAIN_DAYS: "30",
    });
    assert.notEqual(code, 0, "should fail on missing DB file");
    assert.ok(stderr.includes("not found"), `should mention missing file: ${stderr}`);
  });

  it("exits with error when RETAIN_DAYS is non-numeric", async () => {
    const db = new Database(dbPath);
    db.exec("CREATE TABLE test (id INTEGER PRIMARY KEY)");
    db.close();

    const backupDir = join(tmpDir, "backups");
    const { stderr, code } = await runBackup({
      HUB_DB: dbPath,
      HUB_BACKUP_DIR: backupDir,
      HUB_BACKUP_RETAIN_DAYS: "abc",
    });
    assert.notEqual(code, 0, "should fail on non-numeric RETAIN_DAYS");
    assert.ok(stderr.includes("positive integer"), `should mention validation: ${stderr}`);
  });

  it("exits with error when RETAIN_DAYS is zero", async () => {
    const db = new Database(dbPath);
    db.exec("CREATE TABLE test (id INTEGER PRIMARY KEY)");
    db.close();

    const backupDir = join(tmpDir, "backups");
    const { stderr, code } = await runBackup({
      HUB_DB: dbPath,
      HUB_BACKUP_DIR: backupDir,
      HUB_BACKUP_RETAIN_DAYS: "0",
    });
    assert.notEqual(code, 0, "should fail on RETAIN_DAYS=0");
    assert.ok(stderr.includes("positive integer"), `should mention validation: ${stderr}`);
  });

  it("exits with error when sqlite3 is not in PATH", async () => {
    const db = new Database(dbPath);
    db.exec("CREATE TABLE test (id INTEGER PRIMARY KEY)");
    db.close();

    const backupDir = join(tmpDir, "backups");
    // Minimal PATH: /bin has bash but not sqlite3 (which is in /usr/bin on macOS)
    const { stderr, code } = await runBackup({
      HUB_DB: dbPath,
      HUB_BACKUP_DIR: backupDir,
      HUB_BACKUP_RETAIN_DAYS: "30",
      PATH: "/bin",
    });
    assert.notEqual(code, 0, "should fail when sqlite3 not found");
    assert.ok(stderr.includes("not found"), `should mention not found: ${stderr}`);
  });

  it("cleanup trap removes partial backup files on script failure", async () => {
    // Create a valid DB, then trigger failure after the trap is set by
    // making gzip unavailable (the trap is installed before gzip runs).
    // With set -e, missing gzip will cause the script to exit, firing the trap.
    const db = new Database(dbPath);
    db.exec("CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)");
    db.exec("INSERT INTO test (name) VALUES ('hello')");
    db.close();

    const backupDir = join(tmpDir, "backups");

    // PATH must have sqlite3 but NOT gzip
    const { code, stderr } = await runBackup({
      HUB_DB: dbPath,
      HUB_BACKUP_DIR: backupDir,
      HUB_BACKUP_RETAIN_DAYS: "30",
      PATH: "/usr/bin:/bin",  // has sqlite3 on macOS but no gzip in /usr/bin alone
    });
    // gzip is in /usr/bin on macOS, so this PATH has both. Let's use a
    // wrapper that removes gzip instead.
    // Actually, simplest: create a PATH with sqlite3 but not gzip.
    // On macOS: sqlite3=/usr/bin, gzip=/usr/bin. Can't separate them.
    // Alternative: use a wrapper script that makes gzip fail.
    const wrapperDir = join(tmpDir, "bin");
    mkdirSync(wrapperDir, { recursive: true });
    writeFileSync(join(wrapperDir, "gzip"), `#!/bin/bash
echo "gzip intentionally disabled" >&2
exit 1
`, { mode: 0o755 });
    // Put wrapper BEFORE /usr/bin so gzip fails but sqlite3 still works
    const { code: code2, stderr: stderr2 } = await runBackup({
      HUB_DB: dbPath,
      HUB_BACKUP_DIR: backupDir,
      HUB_BACKUP_RETAIN_DAYS: "30",
      PATH: `${wrapperDir}:/usr/bin:/bin`,
    });
    assert.notEqual(code2, 0, "should fail when gzip fails");
    // The cleanup trap should remove the partial .db file (sqlite3 .backup
    // produced it, but gzip failed, so .db should be cleaned up)
    const remaining = readdirSync(backupDir).filter(f => f.endsWith(".db") || f.endsWith(".db.gz"));
    assert.equal(remaining.length, 0, `cleanup trap should remove partial files, found: ${remaining.join(", ")}`);
  });
});
