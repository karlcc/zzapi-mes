# Direct Mode SDK Examples

These examples demonstrate using `@zzapi-mes/sdk` for **direct SAP ICF connection** (bypassing the hub).

> **Important:** Direct mode returns **raw SAP DDIC format** (cryptic field names like `ebeln`, `aedat`, `lifnr`).  
> For **human-readable format** (e.g., `purchaseOrderNumber`, `createdAt`, `vendorNumber`), use the **hub** instead:
> ```ts
> import { HubClient } from "@zzapi-mes/sdk";
> const client = new HubClient({ url: "http://hub:8080", apiKey: "..." });
> ```

## Setup

From the **workspace root**:

```bash
cd /Users/karlchow/Desktop/code/zzapi-mes
pnpm install        # installs dependencies for all packages + examples
```

Copy and edit the environment file:

```bash
cd examples/direct-mode
cp .env.example .env
# Edit .env with your SAP credentials
```

## Running Examples

All commands run from `examples/direct-mode/`:

```bash
cd /Users/karlchow/Desktop/code/zzapi-mes/examples/direct-mode

# Simple commands (no env prefix needed - .env is loaded automatically)
pnpm exec tsx ping.ts
pnpm exec tsx get-po.ts 3010000608
pnpm exec tsx get-material.ts 100000001
pnpm exec tsx get-stock.ts 100000001 1000
pnpm exec tsx get-prod-order.ts 1000001
pnpm exec tsx get-routing.ts 100000001 1000
pnpm exec tsx get-work-center.ts ASSEMBLY01 1000

# POST operations (require CSRF token handling, enabled in examples)
pnpm exec tsx confirm-production.ts 1000001 10
pnpm exec tsx goods-receipt.ts 3010000608 00010 10
pnpm exec tsx goods-issue.ts 1000001 100000001 10
```

Or use the package.json scripts:

```bash
pnpm exec tsx ping.ts          # or: pnpm tsx ping.ts (from repo root with filter)
```

## SAP Field Names (Direct vs. Hub)

| Mode | Field Names | Example |
|------|-------------|---------|
| **Direct** (these examples) | Raw SAP DDIC (`ebeln`, `aedat`, `lifnr`) | `{ ebeln: "3010000608", aedat: "20170306", lifnr: "0000500340" }` |
| **Hub** | Human-readable (`purchaseOrderNumber`, `createdAt`, `vendorNumber`) | `{ purchaseOrderNumber: "3010000608", createdAt: "2017-03-06", vendorNumber: "0000500340" }` |

Use `?format=raw` on the hub to get raw SAP format, or use these direct mode examples for direct SAP connection.

## SAP ID Formatting

| Entity | Format | Example | Helper Function |
|--------|--------|---------|-----------------|
| Material (MATNR) | 18 chars, zero-padded | `000000000100000001` | `padMatnr()` |
| Production Order (AUFNR) | 12 chars, zero-padded | `000000001000` | `padAufnr()` |
| Purchase Order (EBELN) | 10 chars, zero-padded | `0030100065` | `padEbeln()` |
| PO Line Item (EBELP) | 5 chars, zero-padded | `00010` | `padEbelp()` |

## Available Scripts

| Script | Command | Description |
|--------|---------|-------------|
| `pnpm exec tsx ping.ts` | Health check | SAP connectivity test |
| `pnpm exec tsx get-po.ts [EBELN]` | Read PO | Purchase order lookup |
| `pnpm exec tsx get-material.ts [MATNR] [WERKS]` | Read material | Material master data |
| `pnpm exec tsx get-stock.ts [MATNR] [WERKS] [LGORT]` | Read stock | Inventory query |
| `pnpm exec tsx get-prod-order.ts [AUFNR]` | Read order | Production order |
| `pnpm exec tsx get-routing.ts [MATNR] [WERKS]` | Read routing | Recipe/routing |
| `pnpm exec tsx get-work-center.ts [ARBPL] [WERKS]` | Read WC | Work center details |
| `pnpm exec tsx confirm-production.ts [AUFNR] [QTY]` | Write | Post confirmation |
| `pnpm exec tsx goods-receipt.ts [EBELN] [EBELP] [QTY]` | Write | Post goods receipt |
| `pnpm exec tsx goods-issue.ts [AUFNR] [MATNR] [QTY]` | Write | Post goods issue |

## Why No Friendly Format in Direct Mode?

The **human-readable field mapping** is implemented in the **hub**, not in the SDK's direct mode:

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Client    │────▶│    Hub      │────▶│     SAP     │
│             │     │ (transform) │     │  (raw DDIC) │
└─────────────┘     └─────────────┘     └─────────────┘
                         ↓
              ebeln → purchaseOrderNumber
              aedat → createdAt (YYYY-MM-DD)
```

**Direct mode connects straight to SAP** — no transform layer. The SDK (`SapClient`) is a thin wrapper over HTTP Basic Auth + JSON parsing.

**To add friendly format to direct mode**, you would need to:

1. **Port the transform engine** from `apps/hub/src/transform/` into `@zzapi-mes/core`
2. **Map field names** using `ENTITY_MAPPINGS` from `apps/hub/src/transform/mappings.ts`
3. **Convert dates** from `YYYYMMDD` → `YYYY-MM-DD`
4. **Optionally** expose a `format: "friendly" | "raw"` option in `SapClientConfig`

**Recommended approach:** Use `HubClient` instead of `SapClient` if you need human-readable responses. The hub handles JWT auth, rate limiting, idempotency, **and** response transformation.

## Troubleshooting

**"Command tsx not found"**
→ Ensure you're in `examples/direct-mode/` and ran `pnpm install` from workspace root.

**502 error with "text/html" content-type**
→ Invalid SAP credentials. Check `SAP_USER`/`SAP_PASS` in your `.env` file.

## CSRF Token Handling

All POST examples (`confirm-production.ts`, `goods-receipt.ts`, `goods-issue.ts`) enable CSRF handling:

```typescript
const client = new SapClient({
  host: process.env.SAP_HOST!,
  client: Number(process.env.SAP_CLIENT),
  user: process.env.SAP_USER!,
  password: process.env.SAP_PASS!,
  csrf: true,  // Required for POST requests
});
```

The SDK automatically fetches and caches the CSRF token before the first POST, retrying once if SAP returns 403 (expired token).

## Environment Variables

Create a `.env` file (see `.env.example`):

```bash
SAP_HOST=http://sapdev.fastcell.hk:8000
SAP_CLIENT=200
SAP_USER=your_username
SAP_PASS=your_password
```

Each example automatically loads `.env` via `import "dotenv/config"`.
