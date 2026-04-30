/**
 * Example: Post a Goods Receipt against a Purchase Order
 * Requires CSRF token handling (enabled by default for POSTs)
 * Run: pnpm tsx goods-receipt.ts [EBELN] [EBELP] [QUANTITY]
 */
import "dotenv/config";
import { SapClient, type GoodsReceiptRequest } from "@zzapi-mes/sdk";

const client = new SapClient({
  host: process.env.SAP_HOST || "http://sapdev.fastcell.hk:8000",
  client: Number(process.env.SAP_CLIENT || 200),
  user: process.env.SAP_USER!,
  password: process.env.SAP_PASS!,
  csrf: true, // Required for POST requests
});

/** Pad PO number to 10 characters */
function padEbeln(ebeln: string): string {
  return ebeln.padStart(10, "0");
}

/** Pad PO line item to 5 characters */
function padEbelp(ebelp: string): string {
  return ebelp.padStart(5, "0");
}

async function main() {
  const ebeln = padEbeln(process.argv[2] || "3010000608");
  const ebelp = padEbelp(process.argv[3] || "00010");
  const quantity = Number(process.argv[4] || 10);

  const request: GoodsReceiptRequest = {
    purchaseOrder: ebeln,
    poLineItem: ebelp,
    quantity: quantity,
    unitOfMeasure: "EA",
    postingDate: new Date().toISOString().split("T")[0].replace(/-/g, ""), // YYYYMMDD
    // Optional fields:
    // storageLocation: "0001",
    // batch: "BATCH001",
  };

  try {
    const result = await client.postGoodsReceipt(request);
    console.log("Goods receipt posted successfully:");
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error("Failed to post goods receipt:", err);
    process.exit(1);
  }
}

main();
