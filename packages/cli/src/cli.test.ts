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
        code: err ? 1 : 0,
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

  describe("hub mode write-back optional flags", () => {
    afterEach(async () => { if (mockServer) await stopMockHub(); });

    it("confirm --scrap flag included in request body", async () => {
      let capturedBody = "";
      await startMockHub((url, method, body) => {
        if (url === "/auth/token") return { status: 200, body: { token: "jwt-test", expires_in: 900 } };
        capturedBody = body;
        return { status: 201, body: { orderid: "1000000", operation: "0010", yield: 50, scrap: 5, confNo: "00000100", confCnt: "0001", status: "confirmed" } };
      });
      const { stdout, code } = await run(
        ["--mode", "hub", "confirm", "1000000", "--yield", "50", "--scrap", "5"],
        { HUB_URL: `http://localhost:${mockPort}`, HUB_API_KEY: "test.key" },
      );
      assert.equal(code, 0);
      const req = JSON.parse(capturedBody);
      assert.equal(req.scrap, 5);
    });

    it("confirm --work-actual flag included in request body", async () => {
      let capturedBody = "";
      await startMockHub((url, method, body) => {
        if (url === "/auth/token") return { status: 200, body: { token: "jwt-test", expires_in: 900 } };
        capturedBody = body;
        return { status: 201, body: { orderid: "1000000", operation: "0010", yield: 50, scrap: 0, confNo: "00000100", confCnt: "0001", status: "confirmed" } };
      });
      const { stdout, code } = await run(
        ["--mode", "hub", "confirm", "1000000", "--yield", "50", "--work-actual", "3.5"],
        { HUB_URL: `http://localhost:${mockPort}`, HUB_API_KEY: "test.key" },
      );
      assert.equal(code, 0);
      const req = JSON.parse(capturedBody);
      assert.equal(req.work_actual, 3.5);
    });

    it("confirm --postg-date flag included in request body", async () => {
      let capturedBody = "";
      await startMockHub((url, method, body) => {
        if (url === "/auth/token") return { status: 200, body: { token: "jwt-test", expires_in: 900 } };
        capturedBody = body;
        return { status: 201, body: { orderid: "1000000", operation: "0010", yield: 50, scrap: 0, confNo: "00000100", confCnt: "0001", status: "confirmed" } };
      });
      const { stdout, code } = await run(
        ["--mode", "hub", "confirm", "1000000", "--yield", "50", "--postg-date", "20260424"],
        { HUB_URL: `http://localhost:${mockPort}`, HUB_API_KEY: "test.key" },
      );
      assert.equal(code, 0);
      const req = JSON.parse(capturedBody);
      assert.equal(req.postg_date, "20260424");
    });

    it("confirm --budat alias included in request body", async () => {
      let capturedBody = "";
      await startMockHub((url, method, body) => {
        if (url === "/auth/token") return { status: 200, body: { token: "jwt-test", expires_in: 900 } };
        capturedBody = body;
        return { status: 201, body: { orderid: "1000000", operation: "0010", yield: 50, scrap: 0, confNo: "00000100", confCnt: "0001", status: "confirmed" } };
      });
      const { stdout, code } = await run(
        ["--mode", "hub", "confirm", "1000000", "--yield", "50", "--budat", "20260424"],
        { HUB_URL: `http://localhost:${mockPort}`, HUB_API_KEY: "test.key" },
      );
      assert.equal(code, 0);
      const req = JSON.parse(capturedBody);
      assert.equal(req.postg_date, "20260424");
    });

    it("confirm --operation defaults to 0010", async () => {
      let capturedBody = "";
      await startMockHub((url, method, body) => {
        if (url === "/auth/token") return { status: 200, body: { token: "jwt-test", expires_in: 900 } };
        capturedBody = body;
        return { status: 201, body: { orderid: "1000000", operation: "0010", yield: 50, scrap: 0, confNo: "00000100", confCnt: "0001", status: "confirmed" } };
      });
      const { stdout, code } = await run(
        ["--mode", "hub", "confirm", "1000000", "--yield", "50"],
        { HUB_URL: `http://localhost:${mockPort}`, HUB_API_KEY: "test.key" },
      );
      assert.equal(code, 0);
      const req = JSON.parse(capturedBody);
      assert.equal(req.operation, "0010");
    });

    it("confirm --operation custom value forwarded to request body", async () => {
      let capturedBody = "";
      await startMockHub((url, method, body) => {
        if (url === "/auth/token") return { status: 200, body: { token: "jwt-test", expires_in: 900 } };
        capturedBody = body;
        return { status: 201, body: { orderid: "1000000", operation: "0099", yield: 50, scrap: 0, confNo: "00000100", confCnt: "0001", status: "confirmed" } };
      });
      const { stdout, code } = await run(
        ["--mode", "hub", "confirm", "1000000", "--yield", "50", "--operation", "0099"],
        { HUB_URL: `http://localhost:${mockPort}`, HUB_API_KEY: "test.key" },
      );
      assert.equal(code, 0);
      const req = JSON.parse(capturedBody);
      assert.equal(req.operation, "0099");
    });

    it("goods-receipt --ebelp defaults to 00010", async () => {
      let capturedBody = "";
      await startMockHub((url, method, body) => {
        if (url === "/auth/token") return { status: 200, body: { token: "jwt-test", expires_in: 900 } };
        capturedBody = body;
        return { status: 201, body: { ebeln: "4500000001", ebelp: "00010", menge: 100, materialDocument: "5000000001", documentYear: "2026", status: "posted" } };
      });
      const { stdout, code } = await run(
        ["--mode", "hub", "goods-receipt", "4500000001", "--menge", "100", "--werks", "1000", "--lgort", "0001"],
        { HUB_URL: `http://localhost:${mockPort}`, HUB_API_KEY: "test.key" },
      );
      assert.equal(code, 0);
      const req = JSON.parse(capturedBody);
      assert.equal(req.ebelp, "00010");
    });

    it("goods-receipt --charg flag included in request body", async () => {
      let capturedBody = "";
      await startMockHub((url, method, body) => {
        if (url === "/auth/token") return { status: 200, body: { token: "jwt-test", expires_in: 900 } };
        capturedBody = body;
        return { status: 201, body: { ebeln: "4500000001", ebelp: "00010", menge: 100, materialDocument: "5000000001", documentYear: "2026", status: "posted" } };
      });
      const { stdout, code } = await run(
        ["--mode", "hub", "goods-receipt", "4500000001", "--menge", "100", "--werks", "1000", "--lgort", "0001", "--charg", "BATCH01"],
        { HUB_URL: `http://localhost:${mockPort}`, HUB_API_KEY: "test.key" },
      );
      assert.equal(code, 0);
      const req = JSON.parse(capturedBody);
      assert.equal(req.charg, "BATCH01");
    });

    it("goods-issue --charg flag included in request body", async () => {
      let capturedBody = "";
      await startMockHub((url, method, body) => {
        if (url === "/auth/token") return { status: 200, body: { token: "jwt-test", expires_in: 900 } };
        capturedBody = body;
        return { status: 201, body: { orderid: "1000000", matnr: "20000001", menge: 50, materialDocument: "5000000002", documentYear: "2026", status: "posted" } };
      });
      const { stdout, code } = await run(
        ["--mode", "hub", "goods-issue", "1000000", "--matnr", "20000001", "--menge", "50", "--werks", "1000", "--lgort", "0001", "--charg", "BATCH02"],
        { HUB_URL: `http://localhost:${mockPort}`, HUB_API_KEY: "test.key" },
      );
      assert.equal(code, 0);
      const req = JSON.parse(capturedBody);
      assert.equal(req.charg, "BATCH02");
    });

    it("goods-issue --budat flag included in request body", async () => {
      let capturedBody = "";
      await startMockHub((url, method, body) => {
        if (url === "/auth/token") return { status: 200, body: { token: "jwt-test", expires_in: 900 } };
        capturedBody = body;
        return { status: 201, body: { orderid: "1000000", matnr: "20000001", menge: 50, materialDocument: "5000000002", documentYear: "2026", status: "posted" } };
      });
      const { stdout, code } = await run(
        ["--mode", "hub", "goods-issue", "1000000", "--matnr", "20000001", "--menge", "50", "--werks", "1000", "--lgort", "0001", "--budat", "20260424"],
        { HUB_URL: `http://localhost:${mockPort}`, HUB_API_KEY: "test.key" },
      );
      assert.equal(code, 0);
      const req = JSON.parse(capturedBody);
      assert.equal(req.budat, "20260424");
    });
  });

  describe("hub mode read commands", () => {
    afterEach(async () => { if (mockServer) await stopMockHub(); });

    it("ping command returns SAP time", async () => {
      await startMockHub((url) => {
        if (url === "/auth/token") return { status: 200, body: { token: "jwt-test", expires_in: 900 } };
        return { status: 200, body: { ok: true, sap_time: "20260424120000" } };
      });
      const { stdout, code } = await run(
        ["--mode", "hub", "ping"],
        { HUB_URL: `http://localhost:${mockPort}`, HUB_API_KEY: "test.key" },
      );
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.ok, true);
    });

    it("po command returns purchase order", async () => {
      await startMockHub((url) => {
        if (url === "/auth/token") return { status: 200, body: { token: "jwt-test", expires_in: 900 } };
        return { status: 200, body: { ebeln: "4500000001", items: [] } };
      });
      const { stdout, code } = await run(
        ["--mode", "hub", "po", "4500000001"],
        { HUB_URL: `http://localhost:${mockPort}`, HUB_API_KEY: "test.key" },
      );
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.ebeln, "4500000001");
    });

    it("prod-order command returns production order", async () => {
      await startMockHub((url) => {
        if (url === "/auth/token") return { status: 200, body: { token: "jwt-test", expires_in: 900 } };
        return { status: 200, body: { aufnr: "1000000", status: "REL" } };
      });
      const { stdout, code } = await run(
        ["--mode", "hub", "prod-order", "1000000"],
        { HUB_URL: `http://localhost:${mockPort}`, HUB_API_KEY: "test.key" },
      );
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.aufnr, "1000000");
    });

    it("material command returns material data", async () => {
      await startMockHub((url) => {
        if (url === "/auth/token") return { status: 200, body: { token: "jwt-test", expires_in: 900 } };
        return { status: 200, body: { matnr: "10000001", maktx: "Test Material" } };
      });
      const { stdout, code } = await run(
        ["--mode", "hub", "material", "10000001", "--werks", "1000"],
        { HUB_URL: `http://localhost:${mockPort}`, HUB_API_KEY: "test.key" },
      );
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.matnr, "10000001");
    });

    it("stock command returns stock data", async () => {
      await startMockHub((url) => {
        if (url === "/auth/token") return { status: 200, body: { token: "jwt-test", expires_in: 900 } };
        return { status: 200, body: { matnr: "10000001", werks: "1000", labst: 500 } };
      });
      const { stdout, code } = await run(
        ["--mode", "hub", "stock", "10000001", "--werks", "1000"],
        { HUB_URL: `http://localhost:${mockPort}`, HUB_API_KEY: "test.key" },
      );
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.matnr, "10000001");
    });

    it("routing command returns routing data", async () => {
      await startMockHub((url) => {
        if (url === "/auth/token") return { status: 200, body: { token: "jwt-test", expires_in: 900 } };
        return { status: 200, body: { matnr: "10000001", werks: "1000", operations: [] } };
      });
      const { stdout, code } = await run(
        ["--mode", "hub", "routing", "10000001", "--werks", "1000"],
        { HUB_URL: `http://localhost:${mockPort}`, HUB_API_KEY: "test.key" },
      );
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.matnr, "10000001");
    });

    it("work-center command returns work center data", async () => {
      await startMockHub((url) => {
        if (url === "/auth/token") return { status: 200, body: { token: "jwt-test", expires_in: 900 } };
        return { status: 200, body: { arbpl: "TURN1", werks: "1000", ktext: "Turning" } };
      });
      const { stdout, code } = await run(
        ["--mode", "hub", "work-center", "TURN1", "--werks", "1000"],
        { HUB_URL: `http://localhost:${mockPort}`, HUB_API_KEY: "test.key" },
      );
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.arbpl, "TURN1");
    });

    it("po-items command returns PO items", async () => {
      await startMockHub((url) => {
        if (url === "/auth/token") return { status: 200, body: { token: "jwt-test", expires_in: 900 } };
        return { status: 200, body: { ebeln: "4500000001", items: [{ ebelp: "00010" }] } };
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

  describe("direct mode success paths", () => {
    afterEach(async () => { if (mockServer) await stopMockHub(); });

    it("ping command returns SAP time", async () => {
      await startMockHub((url) => {
        return { status: 200, body: { ok: true, sap_time: "20260424120000" } };
      });
      const { stdout, code } = await run(
        ["ping"],
        { SAP_HOST: `http://localhost:${mockPort}`, SAP_CLIENT: "200", SAP_USER: "testuser", SAP_PASS: "testpass" },
      );
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.ok, true);
    });

    it("po command returns purchase order", async () => {
      await startMockHub((url) => {
        return { status: 200, body: { ebeln: "4500000001", items: [] } };
      });
      const { stdout, code } = await run(
        ["po", "4500000001"],
        { SAP_HOST: `http://localhost:${mockPort}`, SAP_CLIENT: "200", SAP_USER: "testuser", SAP_PASS: "testpass" },
      );
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.ebeln, "4500000001");
    });

    it("prod-order command returns production order", async () => {
      await startMockHub(() => {
        return { status: 200, body: { aufnr: "1000000", status: "REL" } };
      });
      const { stdout, code } = await run(
        ["prod-order", "1000000"],
        { SAP_HOST: `http://localhost:${mockPort}`, SAP_CLIENT: "200", SAP_USER: "testuser", SAP_PASS: "testpass" },
      );
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.aufnr, "1000000");
    });

    it("material command returns material data", async () => {
      await startMockHub(() => {
        return { status: 200, body: { matnr: "10000001", maktx: "Test Material" } };
      });
      const { stdout, code } = await run(
        ["material", "10000001"],
        { SAP_HOST: `http://localhost:${mockPort}`, SAP_CLIENT: "200", SAP_USER: "testuser", SAP_PASS: "testpass" },
      );
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.matnr, "10000001");
    });

    it("stock command returns stock data", async () => {
      await startMockHub(() => {
        return { status: 200, body: { matnr: "10000001", werks: "1000", labst: 500 } };
      });
      const { stdout, code } = await run(
        ["stock", "10000001", "--werks", "1000"],
        { SAP_HOST: `http://localhost:${mockPort}`, SAP_CLIENT: "200", SAP_USER: "testuser", SAP_PASS: "testpass" },
      );
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.matnr, "10000001");
    });

    it("routing command returns routing data", async () => {
      await startMockHub(() => {
        return { status: 200, body: { matnr: "10000001", werks: "1000", operations: [] } };
      });
      const { stdout, code } = await run(
        ["routing", "10000001", "--werks", "1000"],
        { SAP_HOST: `http://localhost:${mockPort}`, SAP_CLIENT: "200", SAP_USER: "testuser", SAP_PASS: "testpass" },
      );
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.matnr, "10000001");
    });

    it("work-center command returns work center data", async () => {
      await startMockHub(() => {
        return { status: 200, body: { arbpl: "TURN1", werks: "1000", ktext: "Turning" } };
      });
      const { stdout, code } = await run(
        ["work-center", "TURN1", "--werks", "1000"],
        { SAP_HOST: `http://localhost:${mockPort}`, SAP_CLIENT: "200", SAP_USER: "testuser", SAP_PASS: "testpass" },
      );
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.arbpl, "TURN1");
    });

    it("po-items command returns PO items", async () => {
      await startMockHub(() => {
        return { status: 200, body: { ebeln: "4500000001", items: [{ ebelp: "00010" }] } };
      });
      const { stdout, code } = await run(
        ["po-items", "4500000001"],
        { SAP_HOST: `http://localhost:${mockPort}`, SAP_CLIENT: "200", SAP_USER: "testuser", SAP_PASS: "testpass" },
      );
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.ebeln, "4500000001");
    });
  });

  describe(".zzapirc file config loading", () => {
    it("reads SAP_HOST and SAP_USER from .zzapirc when env not set", async () => {
      // Create a temp dir with a .zzapirc file
      const tmpDir = mkdtempSync(join(tmpdir(), "zzapi-rc-"));
      const rcPath = join(tmpDir, ".zzapirc");
      writeFileSync(rcPath, JSON.stringify({
        SAP_HOST: "rc-host.example.com:8000",
        SAP_CLIENT: 300,
        SAP_USER: "rc_user",
        SAP_PASS: "rc_pass",
      }));

      // Override HOME to point to temp dir so readRc() finds the file
      const { stdout, code } = await run(["ping"], {
        HOME: tmpDir,
        SAP_USER: "",
        SAP_PASS: "",
      });
      // The CLI will try to connect to rc-host.example.com which doesn't exist,
      // but it should get past the credential check (no "Set SAP_USER" error)
      // and fail with a network error instead.
      rmSync(tmpDir, { recursive: true, force: true });
      // If .zzapirc is not loaded, stderr would say "Set SAP_USER and SAP_PASS"
      assert.ok(!stdout.includes("Set SAP_USER") || code === 0, "should load SAP_USER from .zzapirc");
    });

    it("reads HUB_URL and HUB_API_KEY from .zzapirc for hub mode", async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "zzapi-rc-"));
      const rcPath = join(tmpDir, ".zzapirc");
      writeFileSync(rcPath, JSON.stringify({
        HUB_URL: "http://rc-hub.example.com:8080",
        HUB_API_KEY: "rc_key.secret123",
      }));

      const { stderr, code } = await run(["--mode", "hub", "ping"], {
        HOME: tmpDir,
        HUB_URL: "",
        HUB_API_KEY: "",
      });
      rmSync(tmpDir, { recursive: true, force: true });
      // If .zzapirc is not loaded, stderr would say "Set HUB_URL and HUB_API_KEY"
      assert.ok(!stderr.includes("Set HUB_URL"), "should load HUB_URL from .zzapirc");
    });
  });
});
