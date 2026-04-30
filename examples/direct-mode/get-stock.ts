/**
 * Example: Check Stock/Availability
 * Run: pnpm tsx get-stock.ts [MATNR] [WERKS] [LGORT]
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
  const lgort = process.argv[4]; // optional storage location

  try {
    const stock = await client.getStock(matnr, werks, lgort);
    console.log(`Stock for ${matnr} at plant ${werks}${lgort ? ` / sloc ${lgort}` : ""}:`);
    console.log(JSON.stringify(stock, null, 2));
  } catch (err) {
    console.error(`Failed to fetch stock:`, err);
    process.exit(1);
  }
}

main();
