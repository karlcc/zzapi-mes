#!/usr/bin/env node
import { ZzapiMesClient, ZzapiMesHttpError, ensureProtocol } from "@zzapi-mes/sdk";
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

interface RcFile {
  SAP_HOST?: string;
  SAP_CLIENT?: number;
  SAP_USER?: string;
  SAP_PASS?: string;
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

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const VERSION = "0.1.0";

async function main() {
  const [,, command, ...args] = process.argv;

  if (command === "--help" || command === "-h" || !command) {
    console.log(`zzapi-mes ${VERSION}
Usage: zzapi-mes <command> [args]

Commands:
  ping           Health check
  po <ebeln>     Look up purchase order

Environment:
  SAP_HOST       SAP host (default: sapdev.fastcell.hk:8000)
  SAP_CLIENT     SAP client (default: 200)
  SAP_USER       Username (or ~/.zzapirc)
  SAP_PASS       Password (or ~/.zzapirc)`);
    process.exit(0);
  }

  if (command === "--version" || command === "-v") {
    console.log(VERSION);
    process.exit(0);
  }

  const client = new ZzapiMesClient(readConfig());

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
