#!/usr/bin/env node
import { ZzapiMesClient, ZzapiMesHttpError, ensureProtocol, HubClient } from "@zzapi-mes/sdk";
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

type Mode = "direct" | "hub";

interface RcFile {
  SAP_HOST?: string;
  SAP_CLIENT?: number;
  SAP_USER?: string;
  SAP_PASS?: string;
  HUB_URL?: string;
  HUB_API_KEY?: string;
}

function readRc(): RcFile {
  const rcPath = join(homedir(), ".zzapirc");
  try {
    return JSON.parse(readFileSync(rcPath, "utf8"));
  } catch {
    return {};
  }
}

function readConfig() {
  const rc = readRc();
  const host = ensureProtocol(process.env.SAP_HOST || rc.SAP_HOST || "sapdev.fastcell.hk:8000");
  const client = Number(process.env.SAP_CLIENT || rc.SAP_CLIENT) || 200;
  const user = process.env.SAP_USER || rc.SAP_USER;
  const password = process.env.SAP_PASS || rc.SAP_PASS;

  if (!user || !password) {
    console.error("Set SAP_USER and SAP_PASS (env or ~/.zzapirc).");
    process.exit(1);
  }

  return { host, client, user, password };
}

function readHubConfig() {
  const rc = readRc();
  const url = process.env.HUB_URL || rc.HUB_URL;
  const apiKey = process.env.HUB_API_KEY || rc.HUB_API_KEY;

  if (!url || !apiKey) {
    console.error("Set HUB_URL and HUB_API_KEY (env or ~/.zzapirc) for hub mode.");
    process.exit(1);
  }

  return { url: ensureProtocol(url), apiKey };
}

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
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
  const mode = args[modeIdx + 1];
  if (mode !== "direct" && mode !== "hub") die(`Unknown mode: ${mode}. Use 'direct' or 'hub'.`);
  return { mode, rest: [...args.slice(0, modeIdx), ...args.slice(modeIdx + 2)] };
}

async function main() {
  const [,, command, ...rawArgs] = process.argv;
  const { mode, rest: args } = parseMode(rawArgs);

  if (command === "--help" || command === "-h" || !command) {
    console.log(`zzapi-mes ${VERSION}
Usage: zzapi-mes [--mode direct|hub] <command> [args]

Commands:
  ping           Health check
  po <ebeln>     Look up purchase order

Modes:
  --mode direct  Talk to SAP directly (default)
  --mode hub     Talk to zzapi-mes hub (no SAP creds needed)

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

  const client = mode === "hub" ? new HubClient(readHubConfig()) : new ZzapiMesClient(readConfig());

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
    default:
      die(`Unknown command: ${command}\nRun 'zzapi-mes --help' for usage.`);
  }
}

main().catch((e) => {
  if (e instanceof ZzapiMesHttpError) {
    die(`HTTP ${e.status}: ${e.message}`);
  }
  die(e.message);
});
