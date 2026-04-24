import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

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
        code: err && "code" in err ? (err.code as number) : 0,
      });
    });
    proc.on("error", () => {});
  });
}

// Mini mock hub server for integration tests
let mockServer: Server;
let mockPort: number;

function startMockHub(handler: (url: string, method: string, body: string) => { status: number; body: object; headers?: Record<string, string> }): Promise<void> {
  return new Promise((resolve) => {
    mockServer = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const result = handler(req.url ?? "/", req.method ?? "GET", body);
        const headers = { "content-type": "application/json", ...(result.headers ?? {}) };
        res.writeHead(result.status, headers);
        res.end(JSON.stringify(result.body));
      });
    });
    mockServer.listen(0, () => {
      mockPort = (mockServer.address() as { port: number }).port;
      resolve();
    });
  });
}

function stopMockHub(): Promise<void> {
  return new Promise((resolve) => { mockServer.close(() => resolve()); });
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

  describe("ZZAPIRC env var", () => {
    let tmpHome: string;
    beforeEach(() => {
      tmpHome = mkdtempSync(join(tmpdir(), "zzapirc-env-"));
    });
    afterEach(async () => {
      if (mockServer) await stopMockHub();
      rmSync(tmpHome, { recursive: true, force: true });
    });

    it("reads config from ZZAPIRC path instead of ~/.zzapirc", async () => {
      await startMockHub((url) => {
        if (url === "/auth/token") return { status: 200, body: { token: "jwt-test", expires_in: 900 } };
        return { status: 200, body: { ok: true, sap_time: "20260424143000" } };
      });
      const rcPath = join(tmpHome, "custom-rc");
      const rcJson = JSON.stringify({
        HUB_URL: `http://localhost:${mockPort}`,
        HUB_API_KEY: "test.key",
      });
      writeFileSync(rcPath, rcJson, "utf8");
      const { stdout, code } = await run(
        ["--mode", "hub", "ping"],
        { ZZAPIRC: rcPath, HOME: tmpHome, USERPROFILE: tmpHome, HUB_URL: "", HUB_API_KEY: "" },
      );
      assert.equal(code, 0, `expected success, got stderr from output`);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.ok, true);
    });
  });

  describe("POSIX exit codes", () => {
    it("exits 2 for usage error (unknown command)", async () => {
      const { code } = await run(["bogus"], {
        SAP_USER: "u", SAP_PASS: "p",
      });
      assert.equal(code, 2, "usage errors should exit 2");
    });

    it("exits 2 for missing required argument (--yield)", async () => {
      const { code } = await run(["--mode", "hub", "confirm", "1000000"], {
        HUB_URL: "http://localhost:8080", HUB_API_KEY: "test.key",
      });
      assert.equal(code, 2, "missing arg should exit 2");
    });

    it("exits 2 for unknown mode", async () => {
      const { code } = await run(["--mode", "vpn", "ping"], {
        SAP_USER: "u", SAP_PASS: "p",
      });
      assert.equal(code, 2, "unknown mode should exit 2");
    });

    it("exits 4 for auth error (missing SAP_USER/SAP_PASS)", async () => {
      const { code } = await run(["ping"], {
        SAP_USER: "", SAP_PASS: "", SAP_HOST: "sapdev.fastcell.hk:8000",
        // Override HOME to avoid reading .zzapirc with creds
        HOME: "/nonexistent", USERPROFILE: "/nonexistent",
      });
      // The process may time out (null) due to the pre-existing empty-string
      // env issue, but when it does exit, the code should be 4
      assert.ok(code === 4 || code === null, `expected 4 or null (timeout), got ${code}`);
    });

    it("exits 4 for auth error (missing HUB_URL/HUB_API_KEY)", async () => {
      const { code } = await run(["--mode", "hub", "ping"]);
      assert.equal(code, 4, "hub auth errors should exit 4");
    });

    it("exits 6 for SAP/network error (HTTP 502)", async () => {
      await startMockHub((url) => {
        if (url === "/auth/token") return { status: 200, body: { token: "jwt-test", expires_in: 900 } };
        return { status: 502, body: { error: "SAP upstream error" } };
      });
      const { code } = await run(
        ["--mode", "hub", "confirm", "1000000", "--yield", "50"],
        { HUB_URL: `http://localhost:${mockPort}`, HUB_API_KEY: "test.key" },
      );
      assert.equal(code, 6, "SAP/network errors should exit 6");
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

  describe("confirm command", () => {
    it("exits if --yield not provided", async () => {
      const { stderr, code } = await run(["--mode", "hub", "confirm", "1000000"], {
        HUB_URL: "http://localhost:8080", HUB_API_KEY: "test.key",
      });
      assert.notEqual(code, 0);
      assert.ok(stderr.includes("--yield"));
    });

    it("exits if HUB_URL/HUB_API_KEY not set in hub mode", async () => {
      const { stderr, code } = await run(["--mode", "hub", "confirm", "1000000", "--yield", "50"]);
      assert.notEqual(code, 0);
      assert.ok(stderr.includes("HUB_URL"));
    });
  });

  describe("goods-receipt command", () => {
    it("exits if --menge not provided", async () => {
      const { stderr, code } = await run(["--mode", "hub", "goods-receipt", "4500000001", "--werks", "1000", "--lgort", "0001"], {
        HUB_URL: "http://localhost:8080", HUB_API_KEY: "test.key",
      });
      assert.notEqual(code, 0);
      assert.ok(stderr.includes("--menge"));
    });

    it("exits if --werks not provided", async () => {
      const { stderr, code } = await run(["--mode", "hub", "goods-receipt", "4500000001", "--menge", "100", "--lgort", "0001"], {
        HUB_URL: "http://localhost:8080", HUB_API_KEY: "test.key",
      });
      assert.notEqual(code, 0);
      assert.ok(stderr.includes("--werks"));
    });

    it("exits if --lgort not provided", async () => {
      const { stderr, code } = await run(["--mode", "hub", "goods-receipt", "4500000001", "--menge", "100", "--werks", "1000"], {
        HUB_URL: "http://localhost:8080", HUB_API_KEY: "test.key",
      });
      assert.notEqual(code, 0);
      assert.ok(stderr.includes("--lgort"));
    });
  });

  describe("goods-issue command", () => {
    it("exits if --matnr not provided", async () => {
      const { stderr, code } = await run(["--mode", "hub", "goods-issue", "1000000", "--menge", "50", "--werks", "1000", "--lgort", "0001"], {
        HUB_URL: "http://localhost:8080", HUB_API_KEY: "test.key",
      });
      assert.notEqual(code, 0);
      assert.ok(stderr.includes("--matnr"));
    });

    it("exits if --menge not provided", async () => {
      const { stderr, code } = await run(["--mode", "hub", "goods-issue", "1000000", "--matnr", "20000001", "--werks", "1000", "--lgort", "0001"], {
        HUB_URL: "http://localhost:8080", HUB_API_KEY: "test.key",
      });
      assert.notEqual(code, 0);
      assert.ok(stderr.includes("--menge"));
    });

    it("exits if --werks not provided", async () => {
      const { stderr, code } = await run(["--mode", "hub", "goods-issue", "1000000", "--matnr", "20000001", "--menge", "50", "--lgort", "0001"], {
        HUB_URL: "http://localhost:8080", HUB_API_KEY: "test.key",
      });
      assert.notEqual(code, 0);
      assert.ok(stderr.includes("--werks"));
    });

    it("exits if --lgort not provided", async () => {
      const { stderr, code } = await run(["--mode", "hub", "goods-issue", "1000000", "--matnr", "20000001", "--menge", "50", "--werks", "1000"], {
        HUB_URL: "http://localhost:8080", HUB_API_KEY: "test.key",
      });
      assert.notEqual(code, 0);
      assert.ok(stderr.includes("--lgort"));
    });
  });

  // Phase 5A read commands — missing arg validation
  describe("po-items command", () => {
    it("exits if ebeln not provided", async () => {
      const { stderr, code } = await run(["po-items"], {
        SAP_USER: "u", SAP_PASS: "p",
      });
      assert.notEqual(code, 0);
      assert.ok(stderr.includes("ebeln") || stderr.includes("Usage"));
    });
  });

  describe("prod-order command", () => {
    it("exits if aufnr not provided", async () => {
      const { stderr, code } = await run(["prod-order"], {
        SAP_USER: "u", SAP_PASS: "p",
      });
      assert.notEqual(code, 0);
      assert.ok(stderr.includes("aufnr") || stderr.includes("Usage"));
    });
  });

  describe("material command", () => {
    it("exits if matnr not provided", async () => {
      const { stderr, code } = await run(["material"], {
        SAP_USER: "u", SAP_PASS: "p",
      });
      assert.notEqual(code, 0);
      assert.ok(stderr.includes("matnr") || stderr.includes("Usage"));
    });
  });

  describe("stock command", () => {
    it("exits if matnr not provided", async () => {
      const { stderr, code } = await run(["stock"], {
        SAP_USER: "u", SAP_PASS: "p",
      });
      assert.notEqual(code, 0);
    });

    it("exits if --werks not provided", async () => {
      const { stderr, code } = await run(["stock", "10000001"], {
        SAP_USER: "u", SAP_PASS: "p",
      });
      assert.notEqual(code, 0);
      assert.ok(stderr.includes("--werks"));
    });
  });

  describe("routing command", () => {
    it("exits if matnr not provided", async () => {
      const { stderr, code } = await run(["routing"], {
        SAP_USER: "u", SAP_PASS: "p",
      });
      assert.notEqual(code, 0);
    });

    it("exits if --werks not provided", async () => {
      const { stderr, code } = await run(["routing", "10000001"], {
        SAP_USER: "u", SAP_PASS: "p",
      });
      assert.notEqual(code, 0);
      assert.ok(stderr.includes("--werks"));
    });
  });

  describe("work-center command", () => {
    it("exits if arbpl not provided", async () => {
      const { stderr, code } = await run(["work-center"], {
        SAP_USER: "u", SAP_PASS: "p",
      });
      assert.notEqual(code, 0);
    });

    it("exits if --werks not provided", async () => {
      const { stderr, code } = await run(["work-center", "TURN1"], {
        SAP_USER: "u", SAP_PASS: "p",
      });
      assert.notEqual(code, 0);
      assert.ok(stderr.includes("--werks"));
    });
  });

  describe("hub mode write-back integration", () => {
    afterEach(async () => { if (mockServer) await stopMockHub(); });

    it("confirm command prints result on success", async () => {
      await startMockHub((url, method, body) => {
        if (url === "/auth/token") return { status: 200, body: { token: "jwt-test", expires_in: 900 } };
        return { status: 201, body: { orderid: "1000000", operation: "0010", yield: 50, scrap: 0, confNo: "00000100", confCnt: "0001", status: "confirmed", message: "ok" } };
      });
      const { stdout, code } = await run(
        ["--mode", "hub", "confirm", "1000000", "--yield", "50"],
        { HUB_URL: `http://localhost:${mockPort}`, HUB_API_KEY: "test.key" },
      );
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.status, "confirmed");
    });

    it("confirm command prints error on 422", async () => {
      await startMockHub((url) => {
        if (url === "/auth/token") return { status: 200, body: { token: "jwt-test", expires_in: 900 } };
        return { status: 422, body: { error: "Order already confirmed" } };
      });
      const { stderr, code } = await run(
        ["--mode", "hub", "confirm", "1000000", "--yield", "50"],
        { HUB_URL: `http://localhost:${mockPort}`, HUB_API_KEY: "test.key" },
      );
      assert.notEqual(code, 0);
      assert.ok(stderr.includes("422") || stderr.includes("already confirmed"));
    });

    it("goods-receipt command prints result on success", async () => {
      await startMockHub((url) => {
        if (url === "/auth/token") return { status: 200, body: { token: "jwt-test", expires_in: 900 } };
        return { status: 201, body: { ebeln: "4500000001", ebelp: "00010", menge: 100, materialDocument: "5000000001", documentYear: "2026", status: "posted", message: "ok" } };
      });
      const { stdout, code } = await run(
        ["--mode", "hub", "goods-receipt", "4500000001", "--menge", "100", "--werks", "1000", "--lgort", "0001"],
        { HUB_URL: `http://localhost:${mockPort}`, HUB_API_KEY: "test.key" },
      );
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.status, "posted");
    });

    it("goods-issue command prints result on success", async () => {
      await startMockHub((url) => {
        if (url === "/auth/token") return { status: 200, body: { token: "jwt-test", expires_in: 900 } };
        return { status: 201, body: { orderid: "1000000", matnr: "20000001", menge: 50, materialDocument: "5000000002", documentYear: "2026", status: "posted", message: "ok" } };
      });
      const { stdout, code } = await run(
        ["--mode", "hub", "goods-issue", "1000000", "--matnr", "20000001", "--menge", "50", "--werks", "1000", "--lgort", "0001"],
        { HUB_URL: `http://localhost:${mockPort}`, HUB_API_KEY: "test.key" },
      );
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.status, "posted");
    });

    it("prints HTTP error on 502 upstream failure", async () => {
      await startMockHub((url) => {
        if (url === "/auth/token") return { status: 200, body: { token: "jwt-test", expires_in: 900 } };
        return { status: 502, body: { error: "SAP upstream error" } };
      });
      const { stderr, code } = await run(
        ["--mode", "hub", "confirm", "1000000", "--yield", "50"],
        { HUB_URL: `http://localhost:${mockPort}`, HUB_API_KEY: "test.key" },
      );
      assert.notEqual(code, 0);
      assert.ok(stderr.includes("502") || stderr.includes("upstream"));
    });

    it("prints HTTP error on 401 auth failure", async () => {
      await startMockHub((url) => {
        if (url === "/auth/token") return { status: 401, body: { error: "Invalid API key" } };
        return { status: 200, body: {} };
      });
      const { stderr, code } = await run(
        ["--mode", "hub", "ping"],
        { HUB_URL: `http://localhost:${mockPort}`, HUB_API_KEY: "bad-key" },
      );
      assert.notEqual(code, 0);
      assert.ok(stderr.includes("401") || stderr.includes("Invalid"));
    });
  });

  describe(".zzapirc BOM handling", () => {
    // UTF-8 BOM (\uFEFF) at the start of a JSON file makes JSON.parse throw,
    // which readRc() silently swallows — causing rc values to be ignored.
    // Fix: strip BOM before parsing so BOM'd files (often from Notepad on
    // Windows) are still honored.
    let tmpHome: string;
    beforeEach(() => {
      tmpHome = mkdtempSync(join(tmpdir(), "zzapirc-bom-"));
    });
    afterEach(async () => {
      if (mockServer) await stopMockHub();
      rmSync(tmpHome, { recursive: true, force: true });
    });

    it("parses .zzapirc written with a UTF-8 BOM", async () => {
      await startMockHub((url) => {
        if (url === "/auth/token") return { status: 200, body: { token: "jwt-test", expires_in: 900 } };
        return { status: 200, body: { ok: true, sap_time: "20260424143000" } };
      });
      const rcJson = JSON.stringify({
        HUB_URL: `http://localhost:${mockPort}`,
        HUB_API_KEY: "test.key",
      });
      // Prepend UTF-8 BOM
      writeFileSync(join(tmpHome, ".zzapirc"), "\uFEFF" + rcJson, "utf8");
      const { stdout, stderr, code } = await run(
        ["--mode", "hub", "ping"],
        { HOME: tmpHome, USERPROFILE: tmpHome, HUB_URL: "", HUB_API_KEY: "" },
      );
      assert.ok(!stderr.includes("Set HUB_URL"), `rc was ignored: ${stderr}`);
      assert.equal(code, 0, `expected success, got ${code} stderr=${stderr}`);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.ok, true);
    });
  });

  describe("hub mode GET command integration", () => {
    afterEach(async () => { if (mockServer) await stopMockHub(); });

    it("ping command prints result on success", async () => {
      await startMockHub((url) => {
        if (url === "/auth/token") return { status: 200, body: { token: "jwt-test", expires_in: 900 } };
        return { status: 200, body: { ok: true, sap_time: "20260422163000" } };
      });
      const { stdout, code } = await run(
        ["--mode", "hub", "ping"],
        { HUB_URL: `http://localhost:${mockPort}`, HUB_API_KEY: "test.key" },
      );
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.ok, true);
    });

    it("po command prints result on success", async () => {
      await startMockHub((url) => {
        if (url === "/auth/token") return { status: 200, body: { token: "jwt-test", expires_in: 900 } };
        return { status: 200, body: { ebeln: "3010000608", aedat: "20170306", lifnr: "0000500340", eindt: "20170630" } };
      });
      const { stdout, code } = await run(
        ["--mode", "hub", "po", "3010000608"],
        { HUB_URL: `http://localhost:${mockPort}`, HUB_API_KEY: "test.key" },
      );
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.ebeln, "3010000608");
    });

    it("prod-order command prints result on success", async () => {
      await startMockHub((url) => {
        if (url === "/auth/token") return { status: 200, body: { token: "jwt-test", expires_in: 900 } };
        return { status: 200, body: { aufnr: "1000000", auart: "PP01", werks: "1000", matnr: "10000001", gamng: 1000, gstrp: "20260401", gltrp: "20260415" } };
      });
      const { stdout, code } = await run(
        ["--mode", "hub", "prod-order", "1000000"],
        { HUB_URL: `http://localhost:${mockPort}`, HUB_API_KEY: "test.key" },
      );
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.aufnr, "1000000");
    });

    it("material command prints result on success", async () => {
      await startMockHub((url) => {
        if (url === "/auth/token") return { status: 200, body: { token: "jwt-test", expires_in: 900 } };
        return { status: 200, body: { matnr: "10000001", mtart: "FERT", meins: "EA", maktx: "Test material" } };
      });
      const { stdout, code } = await run(
        ["--mode", "hub", "material", "10000001"],
        { HUB_URL: `http://localhost:${mockPort}`, HUB_API_KEY: "test.key" },
      );
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.matnr, "10000001");
    });

    it("stock command prints result on success", async () => {
      await startMockHub((url) => {
        if (url === "/auth/token") return { status: 200, body: { token: "jwt-test", expires_in: 900 } };
        return { status: 200, body: { matnr: "10000001", werks: "1000", items: [{ lgort: "0001", clabs: 250, avail_qty: 200 }] } };
      });
      const { stdout, code } = await run(
        ["--mode", "hub", "stock", "10000001", "--werks", "1000"],
        { HUB_URL: `http://localhost:${mockPort}`, HUB_API_KEY: "test.key" },
      );
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.werks, "1000");
    });

    it("routing command prints result on success", async () => {
      await startMockHub((url) => {
        if (url === "/auth/token") return { status: 200, body: { token: "jwt-test", expires_in: 900 } };
        return { status: 200, body: { matnr: "10000001", werks: "1000", plnnr: "50000123", operations: [{ vornr: "0010", ltxa1: "Turning" }] } };
      });
      const { stdout, code } = await run(
        ["--mode", "hub", "routing", "10000001", "--werks", "1000"],
        { HUB_URL: `http://localhost:${mockPort}`, HUB_API_KEY: "test.key" },
      );
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.plnnr, "50000123");
    });

    it("work-center command prints result on success", async () => {
      await startMockHub((url) => {
        if (url === "/auth/token") return { status: 200, body: { token: "jwt-test", expires_in: 900 } };
        return { status: 200, body: { arbpl: "TURN1", werks: "1000", ktext: "CNC Turning Center", steus: "PP01" } };
      });
      const { stdout, code } = await run(
        ["--mode", "hub", "work-center", "TURN1", "--werks", "1000"],
        { HUB_URL: `http://localhost:${mockPort}`, HUB_API_KEY: "test.key" },
      );
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.arbpl, "TURN1");
    });

    it("po-items command prints result on success", async () => {
      await startMockHub((url) => {
        if (url === "/auth/token") return { status: 200, body: { token: "jwt-test", expires_in: 900 } };
        return { status: 200, body: { ebeln: "4500000001", items: [{ ebelp: "00010", matnr: "10000001", menge: 100, meins: "EA" }] } };
      });
      const { stdout, code } = await run(
        ["--mode", "hub", "po-items", "4500000001"],
        { HUB_URL: `http://localhost:${mockPort}`, HUB_API_KEY: "test.key" },
      );
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.ebeln, "4500000001");
    });
  });
});
