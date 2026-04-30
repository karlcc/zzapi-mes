# SDK Transform Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move transform engine from hub to `@zzapi-mes/core`, enable human-readable responses in direct mode (SapClient) as default, apply to SDK and CLI.

**Architecture:** Transform logic (field mappings, date formatting) moves to `packages/core/src/transform/`. SapClient applies transform locally after SAP response. HubClient unwraps hub envelope and returns data directly. Both return friendly format by default. CLI adds `--format` flag.

**Tech Stack:** TypeScript, pnpm workspaces, native Node.js fetch, no new dependencies.

---

## File Structure Overview

**New/Modified in packages/core:**
- `packages/core/src/transform/index.ts` (NEW) - export barrel
- `packages/core/src/transform/mappings.ts` (COPY from hub) - field name mappings
- `packages/core/src/transform/transform.ts` (COPY from hub) - transform functions
- `packages/core/src/transform/transform.test.ts` (COPY from hub) - unit tests
- `packages/core/src/index.ts` (MODIFY) - SapClient applies transform
- `packages/core/src/hub-client.ts` (MODIFY) - unwrap hub envelope
- `packages/core/package.json` (MODIFY) - add exports for transform subpath

**Modified in apps/hub:**
- `apps/hub/src/routes/sap-call.ts` (MODIFY) - import from core instead of local
- `apps/hub/src/transform/` (DELETE after migration) - or keep as re-exports

**Modified in packages/cli:**
- `packages/cli/src/index.ts` (MODIFY) - add --format flag
- `packages/cli/src/config.ts` (MODIFY) - add format option

**Modified in examples:**
- `examples/direct-mode/*.ts` (MODIFY) - update to show friendly format
- `examples/direct-mode/README.md` (MODIFY) - document friendly output

**Modified in docs:**
- `README.md` (MODIFY) - SDK usage examples with friendly format
- Obsidian notes (MODIFY) - update references to raw SAP fields

---

## Task 1: Copy Transform Engine to Core Package

**Files:**
- Create: `packages/core/src/transform/mappings.ts`
- Create: `packages/core/src/transform/transform.ts`
- Create: `packages/core/src/transform/transform.test.ts`
- Create: `packages/core/src/transform/index.ts`

**Step 1: Copy mappings.ts from hub to core**

```bash
# Run from repo root
cp apps/hub/src/transform/mappings.ts packages/core/src/transform/mappings.ts
```

**Step 2: Copy transform.ts from hub to core**

```bash
cp apps/hub/src/transform/transform.ts packages/core/src/transform/transform.ts
```

**Step 3: Copy transform.test.ts from hub to core**

```bash
cp apps/hub/src/transform/transform.test.ts packages/core/src/transform/transform.test.ts
# Update import paths in the test file
sed -i '' 's|../transform/transform|../transform|g' packages/core/src/transform/transform.test.ts
sed -i '' 's|../transform/mappings|./mappings|g' packages/core/src/transform/transform.test.ts
```

**Step 4: Create transform/index.ts export barrel**

```typescript
// packages/core/src/transform/index.ts
export {
  transformResponse,
  transformEntity,
  parseTransformOpts,
  formatIsoDate,
  mapObject,
  type TransformOptions,
} from "./transform.js";

export {
  ENTITY_MAPPINGS,
  ROUTE_ENTITY_MAP,
  ROUTE_LINKS,
  type FieldMapping,
  type EntityMapping,
} from "./mappings.js";
```

**Step 5: Update core package.json exports**

```json
// Add to packages/core/package.json
{
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./transform": {
      "types": "./dist/transform/index.d.ts",
      "default": "./dist/transform/index.js"
    }
  }
}
```

**Step 6: Run core tests to verify transform works**

```bash
cd packages/core
pnpm test
# Expected: transform tests pass (originally from hub)
```

**Step 7: Commit**

```bash
git add packages/core/src/transform/
git add packages/core/package.json
git commit -m "feat: copy transform engine to @zzapi-mes/core"
```

---

## Task 2: Update SapClient to Apply Transform

**Files:**
- Modify: `packages/core/src/index.ts`

**Step 1: Add transform imports and Format type**

```typescript
// Add near top of packages/core/src/index.ts
import {
  transformEntity,
  ENTITY_MAPPINGS,
  type FieldMapping,
  type EntityMapping,
} from "./transform/index.js";

export type Format = "friendly" | "raw";
```

**Step 2: Update SapClientConfig interface**

```typescript
// In SapClientConfig interface, add:
export interface SapClientConfig {
  host: string;
  client: number;
  user: string;
  password: string;
  timeout?: number;
  csrf?: boolean;
  /** Response format - defaults to 'friendly' for human-readable field names */
  format?: Format;
  onRequest?: (ctx: { url: string; method: string }) => void;
  onResponse?: (ctx: { url: string; status: number; durationMs: number }) => void;
}
```

**Step 3: Update SapClient class to store format and apply transform**

```typescript
// In SapClient constructor, add:
private format: Format;

constructor(config: SapClientConfig) {
  // ... existing validation ...
  this.format = config.format ?? "friendly";
  // ... rest of constructor ...
}

// Helper method to apply transform
private applyTransform<T>(raw: unknown, entityKey: string): T {
  if (this.format === "raw") {
    return raw as T;
  }
  const mapping = ENTITY_MAPPINGS[entityKey];
  if (!mapping) {
    return raw as T;
  }
  return transformEntity(raw as Record<string, unknown>, mapping) as T;
}
```

**Step 4: Update getPo to apply transform**

```typescript
async getPo(ebeln: string, opts?: { signal?: AbortSignal }): Promise<PoResponse> {
  const raw = await this.request<Record<string, unknown>>({
    path: "/sap/bc/zzapi/mes/handler",
    params: { ebeln },
    signal: opts?.signal,
  });
  return this.applyTransform<PoResponse>(raw, "po");
}
```

**Step 5: Update getMaterial to apply transform**

```typescript
async getMaterial(matnr: string, werks?: string, opts?: { signal?: AbortSignal }): Promise<MaterialResponse> {
  const params: Record<string, string> = { matnr };
  if (werks) params.werks = werks;
  const raw = await this.request<Record<string, unknown>>({
    path: "/sap/bc/zzapi/mes/material",
    params,
    signal: opts?.signal,
  });
  return this.applyTransform<MaterialResponse>(raw, "material");
}
```

**Step 6: Update getStock to apply transform**

```typescript
async getStock(matnr: string, werks: string, lgort?: string, opts?: { signal?: AbortSignal }): Promise<StockResponse> {
  const params: Record<string, string> = { matnr, werks };
  if (lgort) params.lgort = lgort;
  const raw = await this.request<Record<string, unknown>>({
    path: "/sap/bc/zzapi/mes/stock",
    params,
    signal: opts?.signal,
  });
  return this.applyTransform<StockResponse>(raw, "stock");
}
```

**Step 7: Update getProdOrder to apply transform**

```typescript
async getProdOrder(aufnr: string, opts?: { signal?: AbortSignal }): Promise<ProdOrderResponse> {
  const raw = await this.request<Record<string, unknown>>({
    path: "/sap/bc/zzapi/mes/prod_order",
    params: { aufnr },
    signal: opts?.signal,
  });
  return this.applyTransform<ProdOrderResponse>(raw, "prodOrder");
}
```

**Step 8: Update getPoItems to apply transform**

```typescript
async getPoItems(ebeln: string, opts?: { signal?: AbortSignal }): Promise<PoItemsResponse> {
  const raw = await this.request<Record<string, unknown>>({
    path: "/sap/bc/zzapi/mes/po_items",
    params: { ebeln },
    signal: opts?.signal,
  });
  return this.applyTransform<PoItemsResponse>(raw, "poItems");
}
```

**Step 9: Update getRouting to apply transform**

```typescript
async getRouting(matnr: string, werks: string, opts?: { signal?: AbortSignal }): Promise<RoutingResponse> {
  const raw = await this.request<Record<string, unknown>>({
    path: "/sap/bc/zzapi/mes/routing",
    params: { matnr, werks },
    signal: opts?.signal,
  });
  return this.applyTransform<RoutingResponse>(raw, "routing");
}
```

**Step 10: Update getWorkCenter to apply transform**

```typescript
async getWorkCenter(arbpl: string, werks: string, opts?: { signal?: AbortSignal }): Promise<WorkCenterResponse> {
  const raw = await this.request<Record<string, unknown>>({
    path: "/sap/bc/zzapi/mes/wc",
    params: { arbpl, werks },
    signal: opts?.signal,
  });
  return this.applyTransform<WorkCenterResponse>(raw, "workCenter");
}
```

**Step 11: ping returns unchanged (no transform needed)**

```typescript
// ping method unchanged - returns simple {ok, sap_time} object
async ping(signal?: AbortSignal): Promise<PingResponse> {
  return this.request<PingResponse>({ path: "/sap/bc/zzapi/mes/ping", signal });
}
```

**Step 12: Run core tests**

```bash
pnpm --filter @zzapi-mes/core test
# Expected: all tests pass
```

**Step 13: Commit**

```bash
git add packages/core/src/index.ts
git commit -m "feat: SapClient applies friendly transform by default"
```

---

## Task 3: Update HubClient to Unwrap Hub Envelope

**Files:**
- Modify: `packages/core/src/hub-client.ts`

**Step 1: Add hub envelope type**

```typescript
// Add to packages/core/src/hub-client.ts
interface HubEnvelope<T> {
  data: T;
  _links?: Record<string, string>;
  _source?: unknown;
}
```

**Step 2: Update getPo to unwrap envelope**

```typescript
async getPo(ebeln: string): Promise<PoResponse> {
  const envelope = await this.request<HubEnvelope<PoResponse>>(`/po/${encodeURIComponent(ebeln)}`);
  return envelope.data;
}
```

**Step 3: Update getMaterial to unwrap envelope**

```typescript
async getMaterial(matnr: string, werks?: string): Promise<MaterialResponse> {
  const query = werks ? `?werks=${encodeURIComponent(werks)}` : "";
  const envelope = await this.request<HubEnvelope<MaterialResponse>>(`/material/${encodeURIComponent(matnr)}${query}`);
  return envelope.data;
}
```

**Step 4: Update getStock to unwrap envelope**

```typescript
async getStock(matnr: string, werks: string, lgort?: string): Promise<StockResponse> {
  const params = new URLSearchParams({ werks });
  if (lgort) params.set("lgort", lgort);
  const envelope = await this.request<HubEnvelope<StockResponse>>(`/stock/${encodeURIComponent(matnr)}?${params}`);
  return envelope.data;
}
```

**Step 5: Update getProdOrder to unwrap envelope**

```typescript
async getProdOrder(aufnr: string): Promise<ProdOrderResponse> {
  const envelope = await this.request<HubEnvelope<ProdOrderResponse>>(`/prod-order/${encodeURIComponent(aufnr)}`);
  return envelope.data;
}
```

**Step 6: Update getPoItems to unwrap envelope**

```typescript
async getPoItems(ebeln: string): Promise<PoItemsResponse> {
  const envelope = await this.request<HubEnvelope<PoItemsResponse>>(`/po/${encodeURIComponent(ebeln)}/items`);
  return envelope.data;
}
```

**Step 7: Update getRouting to unwrap envelope**

```typescript
async getRouting(matnr: string, werks: string): Promise<RoutingResponse> {
  const params = new URLSearchParams({ werks });
  const envelope = await this.request<HubEnvelope<RoutingResponse>>(`/routing/${encodeURIComponent(matnr)}?${params}`);
  return envelope.data;
}
```

**Step 8: Update getWorkCenter to unwrap envelope**

```typescript
async getWorkCenter(arbpl: string, werks: string): Promise<WorkCenterResponse> {
  const params = new URLSearchParams({ werks });
  const envelope = await this.request<HubEnvelope<WorkCenterResponse>>(`/work-center/${encodeURIComponent(arbpl)}?${params}`);
  return envelope.data;
}
```

**Step 9: ping returns unchanged**

```typescript
// ping unchanged - hub returns {ok, sap_time} directly, not wrapped
async ping(): Promise<PingResponse> {
  return this.request<PingResponse>("/ping");
}
```

**Step 10: Run core tests**

```bash
pnpm --filter @zzapi-mes/core test
# Expected: all tests pass
```

**Step 11: Commit**

```bash
git add packages/core/src/hub-client.ts
git commit -m "feat: HubClient unwraps envelope and returns friendly data"
```

---

## Task 4: Update Hub to Import Transform from Core

**Files:**
- Modify: `apps/hub/src/routes/sap-call.ts`
- Modify: `apps/hub/src/transform/transform.ts` (optional - keep as re-export)
- Modify: `apps/hub/src/transform/mappings.ts` (optional - keep as re-export)

**Step 1: Update sap-call.ts to import from core**

```typescript
// Replace in apps/hub/src/routes/sap-call.ts:
// OLD: import { transformResponse, parseTransformOpts } from "../transform/transform.js";
// NEW:
import { transformResponse, parseTransformOpts } from "@zzapi-mes/core/transform";
```

**Step 2: Run hub build to verify imports work**

```bash
pnpm --filter @zzapi-mes/hub build
# Expected: builds successfully
```

**Step 3: Run hub tests**

```bash
pnpm --filter @zzapi-mes/hub test
# Expected: all tests pass (using core's transform)
```

**Step 4: Commit**

```bash
git add apps/hub/src/routes/sap-call.ts
git commit -m "refactor: hub imports transform from @zzapi-mes/core"
```

---

## Task 5: Update CLI with --format Flag

**Files:**
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/src/config.ts` (or wherever CLI config is defined)

**Step 1: Read current CLI structure**

```bash
head -50 packages/cli/src/index.ts
```

**Step 2: Add --format flag to CLI**

```typescript
// In packages/cli/src/index.ts where flags are defined
// Add:
.option("--format <format>", "Response format: friendly (default) or raw", "friendly")
```

**Step 3: Pass format to SapClient**

```typescript
// When creating SapClient in direct mode:
const client = new SapClient({
  host: config.host,
  client: config.client,
  user: config.user,
  password: config.password,
  format: options.format as "friendly" | "raw", // from CLI flag
});
```

**Step 4: Run CLI tests**

```bash
pnpm --filter @zzapi-mes/cli test
# Expected: tests pass
```

**Step 5: Commit**

```bash
git add packages/cli/src/
git commit -m "feat: CLI --format flag for raw/friendly output"
```

---

## Task 6: Update Examples

**Files:**
- Modify: `examples/direct-mode/ping.ts`
- Modify: `examples/direct-mode/get-po.ts`
- Modify: `examples/direct-mode/get-material.ts`
- Modify: `examples/direct-mode/get-stock.ts`
- Modify: `examples/direct-mode/get-prod-order.ts`
- Modify: `examples/direct-mode/get-routing.ts`
- Modify: `examples/direct-mode/get-work-center.ts`
- Modify: `examples/direct-mode/README.md`

**Step 1: Update ping.ts output message**

```typescript
// examples/direct-mode/ping.ts
// Update console.log to show friendly format context:
console.log("SAP is reachable (friendly format):", pong);
```

**Step 2: Update get-po.ts to show friendly output**

```typescript
// examples/direct-mode/get-po.ts
// Update console.log:
console.log(`PO ${poNumber} (friendly format):`);
console.log(JSON.stringify(po, null, 2));
// Example output: { purchaseOrderNumber: "...", createdAt: "2017-03-06", ... }
```

**Step 3: Update examples README.md**

```markdown
# Remove notes about "cryptic SAP field names" and "raw DDIC format"
# Add:

All examples return human-readable field names by default:
- `purchaseOrderNumber` instead of `ebeln`
- `createdAt` (YYYY-MM-DD) instead of `aedat` (YYYYMMDD)
- `vendorNumber` instead of `lifnr`

For raw SAP format, use `format: 'raw'` in SapClient config.
```

**Step 4: Test one example**

```bash
cd examples/direct-mode
pnpm exec tsx get-po.ts 3010000608
# Expected: { purchaseOrderNumber: "3010000608", createdAt: "2017-03-06", ... }
```

**Step 5: Commit**

```bash
git add examples/direct-mode/
git commit -m "docs: update examples for friendly format by default"
```

---

## Task 7: Update Root README.md

**Files:**
- Modify: `README.md`

**Step 1: Update SDK Usage section**

```markdown
### Direct mode (SAP Basic Auth)

```ts
import { SapClient } from "@zzapi-mes/sdk";

const client = new SapClient({
  host: "http://sapdev.fastcell.hk:8000",
  client: 200,
  user: process.env.SAP_USER!,
  password: process.env.SAP_PASS!,
});

const pong = await client.ping();
// { ok: true, sap_time: "20260422163000" }

const po = await client.getPo("3010000608");
// { purchaseOrderNumber: "3010000608", createdAt: "2017-03-06", vendorNumber: "0000500340", deliveryDate: "2017-06-30" }

// For raw SAP format:
const rawClient = new SapClient({ ..., format: "raw" });
// Returns: { ebeln: "...", aedat: "20170306", ... }
```

**Step 2: Update Hub mode section similarly**

**Step 3: Update CLI Usage section to mention --format flag**

```markdown
```bash
# Friendly format (default)
zzapi-mes po 3010000608
# { "purchaseOrderNumber": "...", "createdAt": "..." }

# Raw SAP format
zzapi-mes --format raw po 3010000608
# { "ebeln": "...", "aedat": "20170306" }
```
```

**Step 4: Commit**

```bash
git add README.md
git commit -m "docs: update README for friendly format by default"
```

---

## Task 8: Delete/Deprecate Old Hub Transform Files

**Files:**
- Delete: `apps/hub/src/transform/transform.ts`
- Delete: `apps/hub/src/transform/mappings.ts`
- Delete: `apps/hub/src/transform/transform.test.ts`
- Delete: `apps/hub/src/transform/index.ts` (if exists)

**Alternative (safer): Keep as re-exports during transition**

```typescript
// apps/hub/src/transform/index.ts
export * from "@zzapi-mes/core/transform";
```

**Step 1: Choose approach based on test results**

If all hub tests pass with core imports:
```bash
rm -rf apps/hub/src/transform/
git add -A
git commit -m "refactor: remove hub transform (now in @zzapi-mes/core)"
```

Otherwise, keep re-exports for compatibility.

---

## Task 9: Full Test Suite

**Step 1: Run all tests**

```bash
pnpm test
# Expected: core (159) + hub (545) + CLI (42) = 746 passing
```

**Step 2: Build all packages**

```bash
pnpm build
# Expected: all packages build successfully
```

**Step 3: Smoke test**

```bash
# If SAP is available
pnpm smoke
# Expected: all curl tests pass with friendly format
```

**Step 4: Final commit**

```bash
git commit -m "feat: SDK transform engine - friendly format by default"
```

---

## Spec Coverage Checklist

| Spec Requirement | Task |
|-----------------|------|
| Move transform to packages/core/src/transform/ | Task 1 |
| SapClient applies friendly transform by default | Task 2 |
| SapClient supports format: 'raw' opt-out | Task 2 |
| HubClient unwraps envelope, returns data | Task 3 |
| Hub imports transform from core | Task 4 |
| CLI --format flag | Task 5 |
| Examples updated | Task 6 |
| README.md updated | Task 7 |
| Hub old transform files removed | Task 8 |
| All tests pass | Task 9 |

---

## Notes for Implementer

1. **Types:** Use existing response types from `packages/core/src/generated/schemas.ts`. The transform converts raw SAP response to match these types' friendly field names.

2. **Date handling:** Transform already converts `YYYYMMDD` → `YYYY-MM-DD`. This happens in both direct mode (SapClient) and hub mode.

3. **Nested arrays:** Transform handles nested structures like `storageLocations[]`, `operations[]`, `components[]` via `ENTITY_MAPPINGS[].nested`.

4. **Ping endpoint:** No transform needed - returns simple `{ok, sap_time}` structure.

5. **POST operations:** Transform applies to GET responses. POST request/response bodies already use friendly names in the API spec.

6. **Testing:** The transform.test.ts copied from hub has comprehensive coverage. Core tests verify transform logic. Hub tests verify integration.

7. **Bundle size:** Transform adds ~5KB (mappings are static objects). Acceptable for the usability improvement.
