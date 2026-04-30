/**
 * Example: Fetch Routing/Recipe for a Material
 * Run: pnpm tsx get-routing.ts [MATNR] [WERKS]
 */
import "dotenv/config";
import { SapClient } from "@zzapi-mes/sdk";

const client = new SapClient({
  host: process.env.SAP_HOST || "http://sapdev.fastcell.hk:8000",
  client: Number(process.env.SAP_CLIENT || 200),
  user: process.env.SAP_USER!,
  password: process.env.SAP_PASS!,
});

/** Pad material number to 18 characters */
function padMatnr(matnr: string): string {
  return matnr.padStart(18, "0");
}

async function main() {
  const matnr = padMatnr(process.argv[2] || "100000001");
  const werks = process.argv[3] || "1000";

  try {
    const routing = await client.getRouting(matnr, werks);
    console.log(`Routing for ${matnr} at plant ${werks}:`);
    console.log(JSON.stringify(routing, null, 2));
  } catch (err) {
    console.error(`Failed to fetch routing:`, err);
    process.exit(1);
  }
}

main();
