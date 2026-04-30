/**
 * Example: Fetch Work Center Details
 * Run: pnpm tsx get-work-center.ts [ARBPL] [WERKS]
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
  const arbpl = process.argv[2] || "ASSEMBLY01";
  const werks = process.argv[3] || "1000";

  try {
    const wc = await client.getWorkCenter(arbpl, werks);
    console.log(`Work Center ${arbpl} at plant ${werks}:`);
    console.log(JSON.stringify(wc, null, 2));
  } catch (err) {
    console.error(`Failed to fetch work center:`, err);
    process.exit(1);
  }
}

main();
