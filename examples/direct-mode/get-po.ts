/**
 * Example: Fetch a Purchase Order
 * Run: pnpm po 3010000608
 */
import "dotenv/config";
import { SapClient } from "@zzapi-mes/sdk";

const client = new SapClient({
  host: process.env.SAP_HOST || "http://sapdev.fastcell.hk:8000",
  client: Number(process.env.SAP_CLIENT || 200),
  user: process.env.SAP_USER!,
  password: process.env.SAP_PASS!,
});

async function main() {
  const poNumber = process.argv[2] || "3010000608";

  try {
    const po = await client.getPo(poNumber);
    console.log(`PO ${poNumber}:`, JSON.stringify(po, null, 2));
  } catch (err) {
    console.error(`Failed to fetch PO ${poNumber}:`, err);
    process.exit(1);
  }
}

main();
