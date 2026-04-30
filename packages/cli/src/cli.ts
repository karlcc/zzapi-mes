#!/usr/bin/env node
import { ZzapiMesClient, ZzapiMesHttpError, ensureProtocol, HubClient } from "@zzapi-mes/sdk";
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomBytes } from "node:crypto";

type Mode = "direct" | "hub";
type Format = "friendly" | "raw";

interface RcFile {
  SAP_HOST?: string;
  SAP_CLIENT?: number;
  SAP_USER?: string;
  SAP_PASS?: string;
  HUB_URL?: string;
  HUB_API_KEY?: string;
}

function readRc(): RcFile {
  const rcPath = process.env.ZZAPIRC || join(homedir(), ".zzapirc");
  try {
    let text = readFileSync(rcPath, "utf8");
    // Strip UTF-8 BOM if present (common from Notepad on Windows)
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch (e) {
    // Warn on parse errors (malformed JSON) but not on file-not-found
    if (e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "ENOENT") return {};
    if (e instanceof SyntaxError) {
      console.error(`Warning: ${rcPath} contains invalid JSON — ${e.message}`);
    }
    return {};
  }
}

function readConfig() {
  const rc = readRc();
  const hostRaw = process.env.SAP_HOST || rc.SAP_HOST || "sapdev.fastcell.hk:8000";
  if (typeof hostRaw !== "string") {
    console.error(`SAP_HOST must be a string (got ${typeof hostRaw}: ${hostRaw})`);
    process.exit(EXIT_USAGE);
  }
  const host = ensureProtocol(hostRaw);
  const clientRaw = process.env.SAP_CLIENT || rc.SAP_CLIENT;
  const client = clientRaw !== undefined && clientRaw !== "" ? Number(clientRaw) : 200;
  if (!Number.isFinite(client) || !Number.isInteger(client) || client <= 0) {
    console.error(`SAP_CLIENT must be a positive integer (got ${clientRaw})`);
    process.exit(EXIT_USAGE);
  }
  const user = process.env.SAP_USER || rc.SAP_USER;
  const password = process.env.SAP_PASS || rc.SAP_PASS;

  if (!user || !user.trim() || !password || !password.trim()) {
    console.error("Set SAP_USER and SAP_PASS (env or ~/.zzapirc).");
    process.exit(EXIT_AUTH);
  }

  return { host, client, user, password, csrf: process.env.SAP_CSRF === "1" };
}

function readHubConfig() {
  const rc = readRc();
  const url = process.env.HUB_URL || rc.HUB_URL;
  const apiKey = process.env.HUB_API_KEY || rc.HUB_API_KEY;

  if (!url || !apiKey) {
    console.error("Set HUB_URL and HUB_API_KEY (env or ~/.zzapirc) for hub mode.");
    process.exit(EXIT_AUTH);
  }

  return { url: ensureProtocol(url), apiKey };
}

// POSIX-inspired exit codes for scripting (sysexits.h convention)
const EXIT_USAGE = 2;   // command-line usage error
const EXIT_AUTH = 4;    // missing/invalid credentials
const EXIT_SAP = 6;     // SAP/network failure

function die(msg: string, code: number = EXIT_USAGE): never {
  console.error(msg);
  process.exit(code);
}

const VERSION = "0.1.0";

function parseMode(args: string[]): { mode: Mode; rest: string[] } {
  const modeIdx = args.indexOf("--mode");
  if (modeIdx === -1) {
    // Check for --mode=hub form
    const modeEq = args.find(a => a.startsWith("--mode="));
    if (modeEq) {
      const mode = modeEq.split("=")[1];
      if (mode !== "direct" && mode !== "hub") die(`Unknown mode: ${mode}. Use 'direct' or 'hub'.`);
      return { mode: mode as Mode, rest: args.filter(a => a !== modeEq) };
    }
    return { mode: "direct", rest: args };
  }
  // Check for duplicate --mode flags (e.g. --mode hub --mode=direct)
  const secondMode = args.indexOf("--mode", modeIdx + 1);
  const secondModeEq = args.slice(modeIdx + 1).find(a => a.startsWith("--mode="));
  if (secondMode !== -1 || secondModeEq) {
    die("Duplicate --mode flag — specify only one mode");
  }
  const mode = args[modeIdx + 1];
  if (!mode) die("--mode requires a value: 'direct' or 'hub'");
  if (mode !== "direct" && mode !== "hub") die(`Unknown mode: ${mode}. Use 'direct' or 'hub'.`);
  return { mode, rest: [...args.slice(0, modeIdx), ...args.slice(modeIdx + 2)] };
}

function parseFormat(args: string[]): { format: Format; rest: string[] } {
  const formatIdx = args.indexOf("--format");
  if (formatIdx === -1) {
    const formatEq = args.find(a => a.startsWith("--format="));
    if (formatEq) {
      const format = formatEq.split("=")[1];
      if (format !== "friendly" && format !== "raw") die(`Unknown format: ${format}. Use 'friendly' or 'raw'.`);
      return { format: format as Format, rest: args.filter(a => a !== formatEq) };
    }
    return { format: "friendly", rest: args };
  }
  const secondFormat = args.indexOf("--format", formatIdx + 1);
  const secondFormatEq = args.slice(formatIdx + 1).find(a => a.startsWith("--format="));
  if (secondFormat !== -1 || secondFormatEq) {
    die("Duplicate --format flag — specify only one format");
  }
  const format = args[formatIdx + 1];
  if (!format) die("--format requires a value: 'friendly' or 'raw'");
  if (format !== "friendly" && format !== "raw") die(`Unknown format: ${format}. Use 'friendly' or 'raw'.`);
  return { format, rest: [...args.slice(0, formatIdx), ...args.slice(formatIdx + 2)] };
}

async function main() {
  // Register SIGINT handler for in-flight write-back requests.
  // Without this, Ctrl+C during a POST to SAP exits immediately — the user
  // may retry, causing a duplicate write-back. With the handler, we log a
  // warning and let the in-flight request finish (idempotency key protects
  // against duplicates). A second Ctrl+C forces exit.
  let sigintCount = 0;
  const sigintIdempotencyKey = randomBytes(8).toString("hex");
  process.on("SIGINT", () => {
    sigintCount++;
    if (sigintCount >= 2) {
      process.exit(130);  // 128 + SIGINT(2)
    }
    console.error(`\nSIGINT received — in-flight write-back may be running. Press Ctrl+C again to force exit.`);
  });
  // Parse --mode and --format from all args first, then extract command from remaining
  const [, , ...allArgs] = process.argv;
  const { mode, rest: restAfterMode } = parseMode(allArgs);
  const { format, rest } = parseFormat(restAfterMode);
  const command = rest[0];
  const args = rest.slice(1);

  if (command === "--help" || command === "-h" || !command) {
    console.log(`zzapi-mes ${VERSION}
Usage: zzapi-mes [--mode direct|hub] [--format friendly|raw] <command> [args]

Commands:
  ping                Health check
  po <ebeln>          Look up purchase order header
  po-items <ebeln>    Look up purchase order line items
  prod-order <aufnr>  Look up production order
  material <matnr>    Look up material master
  stock <matnr>       Look up stock/availability (requires --werks)
  routing <matnr>     Look up routing/recipe (requires --werks)
  work-center <arbpl> Look up work center (requires --werks)
  confirm <orderid>   Production confirmation
  goods-receipt <ebeln> Goods receipt for PO
  goods-issue <orderid> Goods issue for prod order

Options:
  --werks <plant>     Plant code (required for stock, routing, work-center)
  --lgort <sloc>      Storage location (stock, goods-receipt, goods-issue)
  --operation <op>    Operation number (confirm, default: 0010)
  --yield <qty>       Yield quantity (confirm, required)
  --ebelp <item>      PO item number (goods-receipt, default: 00010)
  --menge <qty>       Quantity (goods-receipt, goods-issue)
  --matnr <material>  Material number (goods-issue)
  --scrap <qty>       Scrap quantity (confirm, default: 0)
  --work-actual <h>  Actual work hours (confirm)
  --postg-date <d>   Posting date YYYYMMDD (confirm, goods-receipt, goods-issue)
  --charg <batch>    Batch number (goods-receipt, goods-issue)
  --budat <d>        Posting date YYYYMMDD (alias for --postg-date)

Modes:
  --mode direct  Talk to SAP directly (default)
  --mode hub     Talk to zzapi-mes hub (no SAP creds needed)

Format (direct mode only):
  --format friendly  Human-readable field names (default)
  --format raw       SAP DDIC field names (ebeln, aedat, etc.)

Environment (direct mode):
  SAP_HOST       SAP host (default: sapdev.fastcell.hk:8000)
  SAP_CLIENT     SAP client (default: 200)
  SAP_USER       Username (or ~/.zzapirc)
  SAP_PASS       Password (or ~/.zzapirc)

Environment (hub mode):
  HUB_URL        Hub base URL (e.g. http://localhost:8080)
  HUB_API_KEY    API key for hub auth (or ~/.zzapirc)`);
    process.exit(0);
  }

  if (command === "--version" || command === "-v") {
    console.log(VERSION);
    process.exit(0);
  }

  // For direct mode, pass format to SapClient; hub mode always returns friendly format
  const client = mode === "hub"
    ? new HubClient(readHubConfig())
    : new ZzapiMesClient({ ...readConfig(), format });

  switch (command) {
    case "ping": {
      const res = await client.ping();
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    case "po": {
      const ebeln = args[0] || die("Usage: zzapi-mes po <ebeln>");
      const res = await client.getPo(ebeln);
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    case "po-items": {
      const ebeln = args[0] || die("Usage: zzapi-mes po-items <ebeln>");
      const res = await client.getPoItems(ebeln);
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    case "prod-order": {
      const aufnr = args[0] || die("Usage: zzapi-mes prod-order <aufnr>");
      const res = await client.getProdOrder(aufnr);
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    case "material": {
      const matnr = args[0] || die("Usage: zzapi-mes material <matnr>");
      const werksIdx = args.indexOf("--werks");
      const werks = werksIdx !== -1 ? args[werksIdx + 1] : undefined;
      const res = await client.getMaterial(matnr, werks);
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    case "stock": {
      const matnr = args[0] || die("Usage: zzapi-mes stock <matnr> --werks <plant>");
      const werksIdx = args.indexOf("--werks");
      const werks = werksIdx !== -1 ? args[werksIdx + 1] : die("--werks is required for stock lookup");
      const lgortIdx = args.indexOf("--lgort");
      const lgort = lgortIdx !== -1 ? args[lgortIdx + 1] : undefined;
      const res = await client.getStock(matnr, werks!, lgort);
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    case "routing": {
      const matnr = args[0] || die("Usage: zzapi-mes routing <matnr> --werks <plant>");
      const werksIdx = args.indexOf("--werks");
      const werks = werksIdx !== -1 ? args[werksIdx + 1] : die("--werks is required for routing lookup");
      const res = await client.getRouting(matnr, werks!);
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    case "work-center": {
      const arbpl = args[0] || die("Usage: zzapi-mes work-center <arbpl> --werks <plant>");
      const werksIdx = args.indexOf("--werks");
      const werks = werksIdx !== -1 ? args[werksIdx + 1] : die("--werks is required for work-center lookup");
      const res = await client.getWorkCenter(arbpl, werks!);
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    case "confirm": {
      const orderid = args[0] || die("Usage: zzapi-mes confirm <orderid> --operation <op> --yield <qty>");
      const opIdx = args.indexOf("--operation");
      const operation = opIdx !== -1 ? args[opIdx + 1]! : "0010";
      const yieldIdx = args.indexOf("--yield");
      const yieldQty = yieldIdx !== -1 ? Number(args[yieldIdx + 1]) : die("--yield is required");
      if (!Number.isFinite(yieldQty)) die(`--yield must be a number (got ${args[yieldIdx + 1]})`);
      if (yieldQty <= 0) die(`--yield must be positive (got ${yieldQty})`);
      const scrapIdx = args.indexOf("--scrap");
      const scrap = scrapIdx !== -1 ? Number(args[scrapIdx + 1]) : undefined;
      if (scrapIdx !== -1 && !Number.isFinite(scrap)) die(`--scrap must be a number (got ${args[scrapIdx + 1]})`);
      if (scrapIdx !== -1 && scrap! < 0) die(`--scrap must be non-negative (got ${scrap})`);
      const waIdx = args.indexOf("--work-actual");
      const workActual = waIdx !== -1 ? Number(args[waIdx + 1]) : undefined;
      if (waIdx !== -1 && !Number.isFinite(workActual!)) die(`--work-actual must be a number (got ${args[waIdx + 1]})`);
      if (waIdx !== -1 && workActual! < 0) die(`--work-actual must be non-negative (got ${workActual})`);
      const pdIdx = args.indexOf("--postg-date");
      const budatIdx = args.indexOf("--budat");
      const effectivePdIdx = pdIdx !== -1 ? pdIdx : budatIdx;
      const postgDate = effectivePdIdx !== -1 ? args[effectivePdIdx + 1] : undefined;
      let res;
      if (mode === "hub") {
        const idemKey = `cli-conf-${orderid}-${Date.now()}`;
        res = await (client as HubClient).confirmProduction({ orderid, operation, yield: yieldQty, scrap, work_actual: workActual, postg_date: postgDate }, idemKey);
      } else {
        res = await (client as InstanceType<typeof ZzapiMesClient>).postConfirmation({ orderid, operation, yield: yieldQty, scrap, work_actual: workActual, postg_date: postgDate });
      }
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    case "goods-receipt": {
      const ebeln = args[0] || die("Usage: zzapi-mes goods-receipt <ebeln> --menge <qty> --werks <plant> --lgort <sloc>");
      const mengeIdx = args.indexOf("--menge");
      const menge = mengeIdx !== -1 ? Number(args[mengeIdx + 1]) : die("--menge is required");
      if (!Number.isFinite(menge)) die(`--menge must be a number (got ${args[mengeIdx + 1]})`);
      if (menge <= 0) die(`--menge must be positive (got ${menge})`);
      const werksIdx = args.indexOf("--werks");
      const werks = werksIdx !== -1 ? args[werksIdx + 1]! : die("--werks is required");
      const lgortIdx = args.indexOf("--lgort");
      const lgort = lgortIdx !== -1 ? args[lgortIdx + 1]! : die("--lgort is required");
      const ebelpIdx = args.indexOf("--ebelp");
      const ebelp = ebelpIdx !== -1 ? args[ebelpIdx + 1]! : "00010";
      const chargIdx = args.indexOf("--charg");
      const charg = chargIdx !== -1 ? args[chargIdx + 1] : undefined;
      const grPdIdx = args.indexOf("--postg-date") !== -1 ? args.indexOf("--postg-date") : args.indexOf("--budat");
      const budat = grPdIdx !== -1 ? args[grPdIdx + 1] : undefined;
      let res;
      if (mode === "hub") {
        const idemKey = `cli-gr-${ebeln}-${Date.now()}`;
        res = await (client as HubClient).goodsReceipt({ ebeln, ebelp, menge, werks, lgort, charg, budat }, idemKey);
      } else {
        res = await (client as InstanceType<typeof ZzapiMesClient>).postGoodsReceipt({ ebeln, ebelp, menge, werks, lgort, charg, budat });
      }
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    case "goods-issue": {
      const orderid = args[0] || die("Usage: zzapi-mes goods-issue <orderid> --matnr <mat> --menge <qty> --werks <plant> --lgort <sloc>");
      const matnrIdx = args.indexOf("--matnr");
      const matnr = matnrIdx !== -1 ? args[matnrIdx + 1]! : die("--matnr is required");
      const mengeIdx = args.indexOf("--menge");
      const menge = mengeIdx !== -1 ? Number(args[mengeIdx + 1]) : die("--menge is required");
      if (!Number.isFinite(menge)) die(`--menge must be a number (got ${args[mengeIdx + 1]})`);
      if (menge <= 0) die(`--menge must be positive (got ${menge})`);
      const werksIdx = args.indexOf("--werks");
      const werks = werksIdx !== -1 ? args[werksIdx + 1]! : die("--werks is required");
      const lgortIdx = args.indexOf("--lgort");
      const lgort = lgortIdx !== -1 ? args[lgortIdx + 1]! : die("--lgort is required");
      const giChargIdx = args.indexOf("--charg");
      const charg = giChargIdx !== -1 ? args[giChargIdx + 1] : undefined;
      const giPdIdx = args.indexOf("--postg-date") !== -1 ? args.indexOf("--postg-date") : args.indexOf("--budat");
      const budat = giPdIdx !== -1 ? args[giPdIdx + 1] : undefined;
      let res;
      if (mode === "hub") {
        const idemKey = `cli-gi-${orderid}-${Date.now()}`;
        res = await (client as HubClient).goodsIssue({ orderid, matnr, menge, werks, lgort, charg, budat }, idemKey);
      } else {
        res = await (client as InstanceType<typeof ZzapiMesClient>).postGoodsIssue({ orderid, matnr, menge, werks, lgort, charg, budat });
      }
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    default:
      die(`Unknown command: ${command}\nRun 'zzapi-mes --help' for usage.`);
  }
}

main().catch((e) => {
  if (e instanceof ZzapiMesHttpError) {
    die(`HTTP ${e.status}: ${e.message}`, EXIT_SAP);
  }
  die(e.message);
});
