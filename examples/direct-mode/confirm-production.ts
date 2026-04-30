/**
 * Example: Post a Production Order Confirmation
 * Requires CSRF token handling (enabled by default for POSTs)
 * Run: pnpm tsx confirm-production.ts [AUFNR] [YIELD_QTY]
 */
import "dotenv/config";
import { SapClient, type ConfirmationRequest } from "@zzapi-mes/sdk";

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

async function main() {
  const aufnr = padAufnr(process.argv[2] || "1000001");
  const yieldQty = Number(process.argv[3] || 10);

  const request: ConfirmationRequest = {
    orderId: aufnr,
    operationNumber: "0010", // Default first operation
    workCenter: "ASSEMBLY01",
    yieldQuantity: yieldQty,
    unitOfMeasure: "EA",
    postingDate: new Date().toISOString().split("T")[0].replace(/-/g, ""), // YYYYMMDD
    // Optional fields:
    // scrapQuantity: 0,
    // activity1: 60, // Labor time in minutes
    // fin_conf: "X", // Final confirmation indicator
  };

  try {
    const result = await client.postConfirmation(request);
    console.log("Confirmation posted successfully:");
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error("Failed to post confirmation:", err);
    process.exit(1);
  }
}

main();
