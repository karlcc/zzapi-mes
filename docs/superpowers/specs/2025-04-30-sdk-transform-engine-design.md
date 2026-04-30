# SDK Transform Engine Design

**Date:** 2025-04-30  
**Scope:** Move transform engine from hub to `@zzapi-mes/core`, enable human-readable responses in direct mode, apply to SDK and CLI  
**Status:** Design approved, ready for implementation

## Problem

The transform engine (SAP DDIC → human-readable field names) currently lives in `apps/hub/src/transform/`. This means:
- **Direct mode (`SapClient`)** returns cryptic SAP field names: `{ ebeln, aedat, lifnr }`
- **Hub mode** returns human-readable names: `{ purchaseOrderNumber, createdAt, vendorNumber }`

Users expect consistent, readable responses regardless of connection mode.

## Solution

Move transform engine to `packages/core/` and make **friendly format the default** for all SDK/CLI usage. Hub continues to support `?format=raw` query param for API consumers needing raw SAP format.

## Design

### 1. Transform Engine Relocation

```
packages/core/src/
├── transform/
│   ├── index.ts       # Export transformResponse, parseTransformOpts, formatIsoDate
│   ├── mappings.ts    # ENTITY_MAPPINGS, ROUTE_ENTITY_MAP, ROUTE_LINKS
│   └── transform.ts   # transformEntity, mapObject (moved from apps/hub/)
├── index.ts           # SapClient updated: friendly format default
└── hub-client.ts      # HubClient updated: friendly format default
```

Apps/hub changes:
```
apps/hub/src/routes/sap-call.ts
- Change: import { transformResponse } from "@zzapi-mes/core/transform";
```

### 2. SapClient Changes (Direct Mode)

```ts
export interface SapClientConfig {
  host: string;
  client: number;
  user: string;
  password: string;
  timeout?: number;
  csrf?: boolean;
  /** Response format - defaults to 'friendly' */
  format?: 'friendly' | 'raw';
}
```

Each GET method applies transform based on `this.format`:

```ts
async getPo(ebeln: string): Promise<PoResponse> {
  const raw = await this.request<RawPoResponse>({ path: "/sap/bc/zzapi/mes/handler", params: { ebeln } });
  return this.format === 'raw' ? raw : transformEntity(raw, ENTITY_MAPPINGS.po);
}
```

### 3. HubClient Changes

Currently returns raw SAP response from hub. Update to:
- Parse hub's `{ data, _links, _source? }` envelope
- Return `data` (already transformed by hub) as the response

```ts
// Hub returns: { data: { purchaseOrderNumber, ... }, _links: {...} }
// HubClient extracts and returns data directly
async getPo(ebeln: string): Promise<PoResponse> {
  const envelope = await this.request<HubEnvelope<PoResponse>>(`/po/${encodeURIComponent(ebeln)}`);
  return envelope.data; // Already friendly from hub
}
```

### 4. CLI Changes

Both `--mode direct` and `--mode hub` output friendly format by default:

```bash
# Direct mode - now outputs friendly names
zzapi-mes po 3010000608
# { "purchaseOrderNumber": "3010000608", "createdAt": "2017-03-06", ... }

# Hub mode - already friendly (unchanged)
zzapi-mes --mode hub po 3010000608

# Raw output via flag
zzapi-mes --format raw po 3010000608
# { "ebeln": "3010000608", "aedat": "20170306", ... }
```

Add CLI flag:
```
--format <friendly|raw>    Response format (default: friendly)
```

### 5. TypeScript Types

Create dual types for raw vs friendly:

```ts
// Raw SAP DDIC format (legacy)
export interface PoResponseRaw {
  ebeln: string;
  aedat: string;
  lifnr: string;
  // ...
}

// Human-readable format (default)
export interface PoResponse {
  purchaseOrderNumber: string;
  createdAt: string;  // YYYY-MM-DD
  vendorNumber: string;
  // ...
}
```

Export both from core. SDK methods return `PoResponse` (friendly) by default.

### 6. Backward Compatibility

**Breaking change acceptable** — early development, no production users.

Users needing raw format can opt-in:
```ts
const client = new SapClient({ ..., format: 'raw' });
```

## Files to Modify

### Core Package
1. `packages/core/src/transform/mappings.ts` - COPY from apps/hub/src/transform/mappings.ts
2. `packages/core/src/transform/transform.ts` - COPY from apps/hub/src/transform/transform.ts
3. `packages/core/src/transform/index.ts` - NEW export barrel
4. `packages/core/src/index.ts` - Add transform imports, update SapClient
5. `packages/core/src/hub-client.ts` - Update to unwrap hub envelope
6. `packages/core/package.json` - Verify exports for transform subpath

### Hub App
7. `apps/hub/src/routes/sap-call.ts` - Import transform from core
8. `apps/hub/src/transform/` - DELETE (or keep as re-exports during migration)

### SDK Package
9. `packages/sdk/src/index.ts` - Re-export friendly types (already does `export * from core`)

### CLI Package
10. `packages/cli/src/index.ts` - Add --format flag, pass to client config
11. `packages/cli/src/config.ts` - Update to support format option

### Examples
12. `examples/direct-mode/*.ts` - Update to show friendly format, remove raw field notes
13. `examples/direct-mode/README.md` - Update documentation

### Documentation
14. `README.md` - Update SDK usage examples to show friendly format
15. Obsidian notes - Update any references to raw SAP field names

## Testing

1. Unit tests in `packages/core/src/test/` for transform functions
2. Update existing hub transform tests to import from new location
3. CLI tests verify `--format raw` returns SAP DDIC format
4. Smoke tests updated to expect friendly field names

## Dependencies

No new dependencies. Transform engine uses only:
- Native TypeScript/JavaScript
- Existing Zod schemas (unchanged)

## Migration Notes

1. Copy files first (preserve git history via `git mv` if possible)
2. Update imports in hub
3. Update SapClient to apply transform
4. Update HubClient to unwrap envelope
5. Update CLI
6. Update examples and docs
7. Delete old hub transform files
8. Run full test suite
