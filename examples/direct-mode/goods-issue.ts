/**
 * Example: Post a Goods Issue for a Production Order
 * Requires CSRF token handling (enabled by default for POSTs)
 * Run: pnpm tsx goods-issue.ts [AUFNR] [MATNR] [QUANTITY]
 */
import "dotenv/config";
import { SapClient, type GoodsIssueRequest } from "@zzapi-mes/sdk";

const client = new SapClient({
  host: process.env.SAP_HOST || "http://sapdev.fastcell.hk:8000",
  client: Number(process.env.SAP_CLIENT || 200),
  user: process.env.SAP_USER!,
  password: process.env.SAP_PASS!,
  csrf: true, // Required for POST requests
});

/** Pad production order number to 12 characters */
function padAufnr(aufnr: string): string {
  return aufnr.padStart(12, "0");
}

/** Pad material number to 18 characters */
function padMatnr(matnr: string): string {
  return matnr.padStart(18, "0");
}

async function main() {
  const aufnr = padAufnr(process.argv[2] || "1000001");
  const matnr = padMatnr(process.argv[3] || "100000001");
  const quantity = Number(process.argv[4] || 10);

  const request: GoodsIssueRequest = {
    orderId: aufnr,
    material: matnr,
    quantity: quantity,
    unitOfMeasure: "EA",
    postingDate: new Date().toISOString().split("T")[0].replace(/-/g, ""), // YYYYMMDD
    // Optional fields:
    // plant: "1000",
    // storageLocation: "0001",
    // batch: "BATCH001",
    // reservation: "",
    // reservationItem: "",
  };

  try {
    const result = await client.postGoodsIssue(request);
    console.log("Goods issue posted successfully:");
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error("Failed to post goods issue:", err);
    process.exit(1);
  }
}

main();
