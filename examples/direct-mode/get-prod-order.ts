/**
 * Example: Fetch Production Order Details
 * Run: pnpm tsx get-prod-order.ts [AUFNR]
 */
import "dotenv/config";
import { SapClient } from "@zzapi-mes/sdk";

const client = new SapClient({
  host: process.env.SAP_HOST || "http://sapdev.fastcell.hk:8000",
  client: Number(process.env.SAP_CLIENT || 200),
  user: process.env.SAP_USER!,
  password: process.env.SAP_PASS!,
});

/** Pad production order number to 12 characters */
function padAufnr(aufnr: string): string {
  return aufnr.padStart(12, "0");
}

async function main() {
  const aufnr = padAufnr(process.argv[2] || "1000001");

  try {
    const order = await client.getProdOrder(aufnr);
    console.log(`Production Order ${aufnr}:`);
    console.log(JSON.stringify(order, null, 2));
  } catch (err) {
    console.error(`Failed to fetch production order ${aufnr}:`, err);
    process.exit(1);
  }
}

main();
