# Direct Mode SDK Examples

These examples demonstrate using `@zzapi-mes/sdk` for **direct SAP ICF connection** (bypassing the hub).

> **Human-readable format by default:** Direct mode now returns friendly field names
> (e.g., `purchaseOrderNumber`, `createdAt`, `vendorNumber`) — just like the hub.
> For raw SAP DDIC format (`ebeln`, `aedat`, `lifnr`), pass `format: 'raw'` to SapClient.

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

## SAP Field Names

Both direct mode and hub mode return **human-readable field names** by default:

| Field | Friendly Format (default) | Raw SAP DDIC |
|-------|---------------------------|--------------|
| PO number | `purchaseOrderNumber` | `ebeln` |
| Created date | `createdAt` (YYYY-MM-DD) | `aedat` (YYYYMMDD) |
| Vendor | `vendorNumber` | `lifnr` |

To get raw SAP format, pass `format: 'raw'` to SapClient or use `?format=raw` on the hub.

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

## How It Works

Both direct and hub mode apply a transform engine that converts SAP DDIC field names to human-readable format:

```
┌─────────────┐     ┌───────────────┐     ┌─────────────┐
│   Client    │────▶│  SapClient    │────▶│     SAP     │
│  (SDK/CLI)  │     │ (transform)   │     │  (raw DDIC) │
└─────────────┘     └───────────────┘     └─────────────┘
                          ↓
               ebeln → purchaseOrderNumber
               aedat → createdAt (YYYY-MM-DD)
```

The transform engine lives in `@zzapi-mes/core` and is applied by both `SapClient` (direct mode) and the hub server.

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
