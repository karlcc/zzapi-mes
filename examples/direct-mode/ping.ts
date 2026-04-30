/**
 * Example: Basic connectivity check
 * Run: pnpm ping
 */
import "dotenv/config";
import { SapClient } from "@zzapi-mes/sdk";

// Initialize client with direct SAP connection
const client = new SapClient({
  host: process.env.SAP_HOST || "http://sapdev.fastcell.hk:8000",
  client: Number(process.env.SAP_CLIENT || 200),
  user: process.env.SAP_USER!,
  password: process.env.SAP_PASS!,
});

async function main() {
  try {
    const pong = await client.ping();
    console.log("SAP is reachable:", pong);
  } catch (err) {
    console.error("Ping failed:", err);
    process.exit(1);
  }
}

main();
