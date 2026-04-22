# zzapi-mes

SAP ICF REST handler SDK + CLI for MES integration on SAP_BASIS 700.

## TL;DR

Strategy D (ICF Handler) replaces BSP pages for new SAP API endpoints. ABAP classes implement `IF_HTTP_EXTENSION`, registered via SICF — no SE80, no page attributes, no flow logic. Clean REST URLs, curl-testable.

## Architecture

```
Client (curl / SDK / CLI)
  │
  │  Basic Auth
  ▼
SAP ICF → ZCL_ZZAPI_MES_HANDLER → JSON response
```

Phase 3 adds a Node hub in front that holds SAP credentials and issues bearer tokens to clients — SAP stays untouched.

## Phase Roadmap

| Phase | Scope | Status |
|---|---|---|
| 0 | Repo init, ABAP source mirrors, demo walkthrough | Done |
| 1 | Deploy handlers on sapdev, curl round-trip verified | Pending (SAP GUI) |
| 2 | OpenAPI spec, Node SDK (`@zzapi-mes/sdk`), CLI (`@zzapi-mes/cli`) | Pending |
| 3 | Node hub (`apps/hub`) with bearer tokens, SAP auth abstracted | Deferred |

## Repo Layout

```
abap/          ABAP class sources (mirrored from SE24)
spec/          OpenAPI contract (phase 2)
packages/sdk/  Node SDK (phase 2)
packages/cli/  CLI tool (phase 2)
apps/          Hub service (phase 3, empty)
scripts/       Smoke tests
docs/          Walkthroughs
```

## Quick Start (Phase 1 — Demo)

1. Follow `docs/demo-walkthrough.md` to deploy both handlers on sapdev via SE24 + SICF
2. Run smoke test:

```bash
SAP_USER=api_user2 SAP_PASS='Pt@2026' pnpm smoke
```

3. Verify two endpoints respond:
   - `GET /sap/bc/zzapi_mes_ping` → `{"ok":true,"sap_time":"..."}`
   - `GET /sap/bc/zzapi_mes?ebeln=3010000608` → PO JSON matching BSP output

## Endpoints

| Handler | SICF Path | Method | Description |
|---|---|---|---|
| `ZCL_ZZAPI_MES_PING` | `/sap/bc/zzapi_mes_ping` | GET | Health check |
| `ZCL_ZZAPI_MES_HANDLER` | `/sap/bc/zzapi_mes` | GET | PO info by ebeln |
