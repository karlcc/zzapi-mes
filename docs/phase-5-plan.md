# Phase 5 — MES Business Endpoints

> Status: **shipped**, 2026-04-23. All ABAP handlers, hub routes, SDK methods, CLI commands, and tests implemented. Prerequisite for live testing: Phase 1 (SICF deployment on sapdev).

## TL;DR

Phase 4 hardened the hub for production. Phase 5 adds new MES business endpoints
— the actual data the factory floor needs beyond PO header lookups. Each endpoint
follows the existing pattern: ABAP ICF handler → OpenAPI spec → zod codegen →
hub route + scope → smoke test.

Read-only endpoints come first (zero risk to SAP data), then write-back endpoints
with idempotency and audit safeguards.

## Current Endpoints

| SICF Path | Hub Path | Operation | ABAP Class |
|---|---|---|---|
| `/sap/bc/zzapi/mes/ping` | `/ping` | Health check | `ZCL_ZZAPI_MES_PING` |
| `/sap/bc/zzapi/mes/handler` | `/po/:ebeln` | PO header lookup | `ZCL_ZZAPI_MES_HANDLER` |

## Implemented Endpoints

### Phase 5A — Read-Only (SAP → MES, zero risk) — SHIPPED

| # | Endpoint | SICF Path | Hub Path | SAP Tables | BAPI | Key Fields | Description |
|---|---|---|---|---|---|---|---|
| 1 | Production order | `/sap/bc/zzapi/mes/prod_order` | `/prod-order/:aufnr` | AUFK, AFKO, AFPO, AFVC, AFVV, RESB | `BAPI_PRODORD_GET_DETAIL` | aufnr, auart, werks, matnr, gamng/gsmng, gstrp/gltrp, vornr | Order header + operations + component reservations. MES cannot operate without this. |
| 2 | Material master | `/sap/bc/zzapi/mes/material` | `/material/:matnr` | MARA, MARC, MAKT | `BAPI_MATERIAL_GET_ALL` | matnr, mtart, meins, werks, maktx | Material info for scan validation, UoM, descriptions |
| 3 | Stock / availability | `/sap/bc/zzapi/mes/stock` | `/stock/:matnr` | MARD, MCHB | `BAPI_MATERIAL_AVAILABILITY` | matnr, werks, lgort, charg, clabs, avail_qty | ATP check — required before starting operations |
| 4 | Routing / recipe | `/sap/bc/zzapi/mes/routing` | `/routing/:matnr` | PLKO, PLPO, PLMZ, MAPL | `BAPI_ROUTING_GETDETAIL` | plnnr, plnal, vornr, arbpl, ltxa1, vgwrt | Operation sequence + standard times for dispatching |
| 5 | Work center | `/sap/bc/zzapi/mes/wc` | `/work-center/:arbpl` | CRHD, CRCA, CRCO | Direct table read (no standard BAPI) | arbpl, werks, kapid, kostl, steus | Capacity + cost center for scheduling |
| 6 | PO line items | `/sap/bc/zzapi/mes/po_items` | `/po/:ebeln/items` | EKPO, EKET | — | ebelp, matnr, menge, meins, eindt | Extends existing PO header with item detail |

### Phase 5B — Write-Back (MES → SAP, transactional) — SHIPPED

| # | Endpoint | SICF Path | Hub Path | SAP BAPI | Movement | Key Input | Description |
|---|---|---|---|---|---|---|---|
| 7 | Production confirmation | `/sap/bc/zzapi/mes/conf` | `/confirmation` (POST) | `BAPI_PRODORDCONF_CREATE_TT` | — | orderid, operation, yield, scrap, work_actual, postg_date | Report yield/scrap/labor. Triggers backflush GI. |
| 8 | Goods receipt (prod order) | `/sap/bc/zzapi/mes/gr` | `/goods-receipt` (POST) | `BAPI_GOODSMVT_CREATE` | 101 | material, plant, stge_loc, batch, entry_qnt, orderid, mvt_ind='F' | Receive finished good into inventory |
| 9 | Goods issue (consumption) | `/sap/bc/zzapi/mes/gi` | `/goods-issue` (POST) | `BAPI_GOODSMVT_CREATE` | 261 | material, plant, stge_loc, batch, entry_qnt, orderid, mvt_ind='E' | Consume components — check backflush indicator first (AFVC-MGVRG) |

**Note on GR + confirmation**: `BAPI_PRODORDCONF_CREATE_TT` can auto-generate goods movements (backflush). Only post separate GR/GI for non-backflushed operations. Check `AFVC-MGVRG` before posting a separate GI.

## Priority Rationale

```
Reads first → MES cannot report what it cannot read.
5A-1 Production order → foundational (MES needs to know what to build)
5A-2 Material master  → scan validation on every screen
5A-3 Stock/ATP        → required before starting operations
5A-4 Routing          → operation sequence for dispatching
5A-5 Work center      → capacity for scheduling
5A-6 PO items         → extends existing PO handler (low risk)
5B-1 Confirmation     → primary write-back, enables real-time tracking
5B-2 Goods receipt    → usually paired with confirmation
5B-3 Goods issue      → often backflushed; manual posting for staging
```

## Implementation Pattern (per endpoint)

Each endpoint follows the same recipe established in Phases 0–4:

```
1. Write ABAP class (ZCL_ZZAPI_MES_*) implementing IF_HTTP_EXTENSION
2. Add SICF node under /sap/bc/zzapi/mes/* (Phase 1 deployment step)
3. Update spec/openapi.yaml with new path + schemas
4. Run pnpm spec:gen to regenerate zod schemas
5. Add hub route (apps/hub/src/routes/*.ts) with scope guard
6. Add method to SapClient + HubClient in @zzapi-mes/core
7. Add CLI command in @zzapi-mes/cli
8. Add check to scripts/smoke.sh
9. Write unit + integration tests
```

## ABAP Handler Template

New handlers follow the established pattern from `ZCL_ZZAPI_MES_HANDLER`:

```abap
CLASS zcl_zzapi_mes_<name> DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES if_http_extension.
ENDCLASS.

CLASS zcl_zzapi_mes_<name> IMPLEMENTATION.
  METHOD if_http_extension~handle_request.
    DATA: lv_method TYPE string.
    lv_method = server->request->get_header_field( '~request_method' ).
    CASE lv_method.
      WHEN 'GET'.
        " Read query params via server->request->get_form_field( '...' )
        " Query SAP tables / call BAPI
        " Serialize via ZZ_CL_JSON (camelCase mode) or hand-roll JSON
        server->response->set_status( code = 200 reason = 'OK' ).
        server->response->set_content_type( 'application/json' ).
        server->response->set_cdata( lv_json ).
      WHEN 'POST'.
        " For write-back endpoints:
        " 1. Parse JSON body from server->request->get_cdata( )
        " 2. Call BAPI
        " 3. Check BAPI return messages
        " 4. COMMIT or ROLLBACK
        " 5. Return result JSON
      WHEN OTHERS.
        server->response->set_status( code = 405 reason = 'Method Not Allowed' ).
        server->response->set_content_type( 'application/json' ).
        server->response->set_cdata( '{"error":"Method not allowed"}' ).
    ENDCASE.
  ENDMETHOD.
ENDCLASS.
```

Key constraints (from CLAUDE.md):
- Reuse existing SAP artifacts (structures, serializers like `ZZ_CL_JSON`).
- Keep JSON output byte-identical to existing BSP pages where applicable.
- Use `CASE lv_method` dispatch; unmatched verbs return 405 with JSON error.
- Naming: `ZCL_ZZAPI_MES_*`, SICF at `/sap/bc/zzapi/mes/*`.
- All BAPIs listed are available on SAP_BASIS 700 (ECC 6.0).

## Write-Back Safety (Phase 5B)

Goods receipt, goods issue, and production confirmation are POST endpoints that modify SAP data.
Additional safeguards required:

1. **SAP-side**: BAPI calls wrapped in `BAPI_TRANSACTION_COMMIT` with `wait = abap_true`
   on success, `BAPI_TRANSACTION_ROLLBACK` on failure. Return BAPI return messages in JSON.
2. **Hub-side**: New scopes `conf`, `gr`, `gi` separate from read scopes (`ping`, `po`, `prod_order`, etc.).
3. **Idempotency**: POST body must include a client-generated `idempotency_key`.
   Hub stores recent keys in SQLite to reject duplicates within a 5-min window.
4. **Audit log**: Write-back requests logged with full request body in hub DB
   table `audit_log(id, req_id, key_id, method, path, body, sap_status, created_at)`.
5. **Rate limit**: Lower default for write-back (e.g. 10 req/min vs 60 for reads).
6. **Backflush guard**: Before posting GI, check `AFVC-MGVRG` — if backflush is active,
   the confirmation already handles component consumption. Reject duplicate GI with 409.

## PR Slicing

| # | PR title | Scope |
|---|---|---|
| 1 | `feat(abap+spec): production order lookup endpoint` | 5A-1: ABAP handler + OpenAPI path + zod schemas |
| 2 | `feat(abap+spec): material master endpoint` | 5A-2 |
| 3 | `feat(abap+spec): stock/availability endpoint` | 5A-3 |
| 4 | `feat(hub+core): wire Phase 5A read endpoints through hub, SDK, CLI` | Hub routes, SapClient methods, CLI commands for 5A-1–3 |
| 5 | `feat(abap+spec): routing + work center + PO items endpoints` | 5A-4–6 (lower priority, batched) |
| 6 | `feat(hub+core): wire remaining 5A endpoints + idempotency infra` | Hub routes for 5A-4–6, idempotency_keys + audit_log tables |
| 7 | `feat(abap+hub): production confirmation POST endpoint` | 5B-1: BAPI_PRODORDCONF_CREATE_TT + hub POST route |
| 8 | `feat(abap+hub): goods receipt POST endpoint` | 5B-2: BAPI_GOODSMVT_CREATE (101) |
| 9 | `feat(abap+hub): goods issue POST endpoint` | 5B-3: BAPI_GOODSMVT_CREATE (261) + backflush guard |

PRs 1–3 are ABAP+spec only (no hub changes until PR 4 wires them).
PR 6 establishes the write-back safety infrastructure before PRs 7–9.

## DB Schema Additions

```sql
-- For write-back idempotency
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key       TEXT PRIMARY KEY,
  key_id    TEXT NOT NULL,
  path      TEXT NOT NULL,
  status    INTEGER NOT NULL,
  body_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- For write-back audit log
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  req_id      TEXT NOT NULL,
  key_id      TEXT NOT NULL,
  method      TEXT NOT NULL,
  path        TEXT NOT NULL,
  body        TEXT,
  sap_status  INTEGER,
  created_at  INTEGER NOT NULL
);
```

## Open Decisions

- **Production order depth**: Header only (AUFK+AFKO), or include operations (AFVV via CAUFV join) and reservations (RESB)? Recommendation: include operations + components — MES needs them for confirmations and kitting.
- **Material master view scope**: MARA (general) + MARC (plant) + MAKT (description). Skip MARD (storage) — covered by stock endpoint.
- **JSON serializer for complex structures**: `ZZ_CL_JSON` handles flat structures; for nested (prod order = header + operations array + components array), need custom JSON assembly or a new ABAP helper. Investigate before PR 1.
- **Goods receipt variant**: Start with production order GR (movement 101, mvt_ind='F'). PO GR (mvt_ind='B') can follow later.
- **BAPI authorization**: The SAP API user may lack permissions for `BAPI_GOODSMVT_CREATE`, `BAPI_PRODORDCONF_CREATE_TT`. Check with Basis before starting Phase 5B.
- **Production order list vs. detail**: `BAPI_PRODORD_GET_LIST` (search by plant/status/material) + `BAPI_PRODORD_GET_DETAIL` (single order). Start with detail only; add list endpoint if needed.

## Blockers

- **Phase 1 SICF deployment** — no new endpoints can be tested against live SAP until ping + PO handlers are verified on sapdev.
- **ZZ_CL_JSON limitations** — nested JSON (header + array of items/operations) may need custom assembler. Investigate first.
- **BAPI authorization** — write-back endpoints need specific SAP roles. Coordinate with Basis.

## Cross-Refs

- Vault: `5️⃣-Projects/GitHub/zzapi-mes/zzapi-mes-review-2026-04-22.md`
- `docs/demo-walkthrough.md` — SICF deployment procedure
- `docs/phase-4-plan.md` — operability hardening (shipped)
- `spec/openapi.yaml` — current API contract
- `abap/ZCL_ZZAPI_MES_HANDLER.abap` — reference handler implementation
