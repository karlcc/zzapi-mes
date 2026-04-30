/**
 * Example: Fetch a Purchase Order
 * Run: pnpm tsx get-po.ts 3010000608
 *
 * Output (friendly format by default):
 *   {
 *     "purchaseOrderNumber": "3010000608",
 *     "createdAt": "2017-03-06",
 *     "vendorNumber": "0000500340",
 *     "deliveryDate": "2017-06-30"
 *   }
 */
import "dotenv/config";
import { SapClient } from "@zzapi-mes/sdk";

// SapClient returns human-readable field names by default
// Use format: 'raw' for original SAP DDIC field names (ebeln, aedat, lifnr, eindt)
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
    console.log(`PO ${poNumber} (friendly format):`);
    console.log(JSON.stringify(po, null, 2));
  } catch (err) {
    console.error(`Failed to fetch PO ${poNumber}:`, err);
    process.exit(1);
  }
}

main();
