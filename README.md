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

With the hub (Phase 3):

```
MES client ──(API key)──▶ Hub POST /auth/token ──▶ JWT (15 min)
MES client ──(JWT)──────▶ Hub GET /ping, /po/:ebeln, /prod-order/:aufnr, … ──▶ SAP ICF (Basic Auth)
MES client ──(JWT)──────▶ Hub POST /confirmation, /goods-receipt, /goods-issue ──▶ SAP ICF (Basic Auth)
```

## Phase Roadmap

| Phase | Scope | Status |
|---|---|---|
| 0 | Repo init, ABAP source mirrors, demo walkthrough | Done |
| 1 | Deploy handlers on sapdev, curl round-trip verified | Done (ping + handler live, 9 additional read/write handlers queued in SE24/SICF) |
| 2 | OpenAPI spec, Node SDK (`@zzapi-mes/sdk`), CLI (`@zzapi-mes/cli`) | Done |
| 3 | Node hub (`apps/hub`) with bearer tokens, SAP auth abstracted | Done |
| 4 | Persistent API keys (SQLite+argon2id), admin CLI, request ID, structured logs, /metrics, rate limiting, spec codegen, e2e tests | Done |
| 5 | MES business endpoints: PO items, material, stock, routing, work centers, production confirmations, goods receipt, goods issue | Done |

## Repo Layout

```
abap/            ABAP class sources (mirrored from SE24)
spec/            OpenAPI 3.0 contract
packages/core/   @zzapi-mes/core — SapClient, Zod schemas, HubClient
packages/sdk/    @zzapi-mes/sdk — re-exports core (back-compat)
packages/cli/    @zzapi-mes/cli — CLI with --mode direct|hub
apps/hub/        @zzapi-mes/hub — Hono server, JWT auth, SAP proxy
scripts/         Smoke tests
docs/            Walkthroughs
```

## Quick Start (Phase 1 — Demo)

1. Follow `docs/demo-walkthrough.md` to deploy both handlers on sapdev via SE24 + SICF
2. Run smoke test:

```bash
SAP_USER=<your_user> SAP_PASS='<your_password>' pnpm smoke
```

3. Verify two endpoints respond:
   - `GET /sap/bc/zzapi/mes/ping` → `{"ok":true,"sap_time":"..."}`
   - `GET /sap/bc/zzapi/mes/handler?ebeln=3010000608` → PO JSON matching BSP output

## SDK Usage

```ts
import { ZzapiMesClient } from "@zzapi-mes/sdk";

const client = new ZzapiMesClient({
  host: "http://sapdev.fastcell.hk:8000",
  client: 200,
  user: process.env.SAP_USER!,
  password: process.env.SAP_PASS!,
  timeout: 30000, // optional, default 30s
});

const pong = await client.ping();
// { ok: true, sap_time: "20260422163000" }

const po = await client.getPo("3010000608");
// { ebeln: "3010000608", aedat: "20170306", lifnr: "0000500340", eindt: "20170630" }
```

## CLI Usage

```bash
# Direct mode (default) — talks to SAP with Basic Auth
SAP_USER=<your_user> SAP_PASS='<your_password>' npx zzapi-mes ping
SAP_USER=<your_user> SAP_PASS='<your_password>' npx zzapi-mes po 3010000608

# Hub mode — talks to the hub with API key, no SAP creds needed
HUB_URL=http://localhost:8080 HUB_API_KEY=my-key npx zzapi-mes --mode hub ping
HUB_URL=http://localhost:8080 HUB_API_KEY=my-key npx zzapi-mes --mode hub po 3010000608

# Or via ~/.zzapirc
echo '{"SAP_USER":"<your_user>","SAP_PASS":"<your_password>"}' > ~/.zzapirc
npx zzapi-mes ping
```

## Commands

| Command | Description |
|---|---|
| `pnpm build` | Compile all TypeScript packages |
| `pnpm test` | Run unit tests (732 passing: 175 core + 494 hub + 63 CLI) |
| `pnpm smoke` | Curl round-trip tests against sapdev |
| `pnpm spec:gen` | Regenerate `packages/core/src/generated/schemas.ts` from OpenAPI spec |

## Endpoints

| Handler | SICF Path | Method | Description |
|---|---|---|---|
| `ZCL_ZZAPI_MES_PING` | `/sap/bc/zzapi/mes/ping` | GET | Health check |
| `ZCL_ZZAPI_MES_HANDLER` | `/sap/bc/zzapi/mes/handler` | GET | PO info by ebeln |
| `ZCL_ZZAPI_MES_PROD_ORDER` | `/sap/bc/zzapi/mes/prod_order` | GET | Production order detail |
| `ZCL_ZZAPI_MES_MATERIAL` | `/sap/bc/zzapi/mes/material` | GET | Material master |
| `ZCL_ZZAPI_MES_STOCK` | `/sap/bc/zzapi/mes/stock` | GET | Stock / availability |
| `ZCL_ZZAPI_MES_PO_ITEMS` | `/sap/bc/zzapi/mes/po_items` | GET | PO line items |
| `ZCL_ZZAPI_MES_ROUTING` | `/sap/bc/zzapi/mes/routing` | GET | Routing / recipe |
| `ZCL_ZZAPI_MES_WC` | `/sap/bc/zzapi/mes/wc` | GET | Work center |
| `ZCL_ZZAPI_MES_CONF` | `/sap/bc/zzapi/mes/conf` | POST | Production confirmation |
| `ZCL_ZZAPI_MES_GR` | `/sap/bc/zzapi/mes/gr` | POST | Goods receipt for PO |
| `ZCL_ZZAPI_MES_GI` | `/sap/bc/zzapi/mes/gi` | POST | Goods issue for prod order |

### Hub Read Endpoints (Phase 5A)

| Path | Method | Scope | Description |
|---|---|---|---|
| `/ping` | GET | `ping` | Health check |
| `/po/:ebeln` | GET | `po` | PO info |
| `/prod-order/:aufnr` | GET | `prod_order` | Production order detail |
| `/material/:matnr` | GET | `material` | Material master |
| `/stock/:matnr` | GET | `stock` | Stock / availability |
| `/po/:ebeln/items` | GET | `po` | PO line items |
| `/routing/:matnr` | GET | `routing` | Routing / recipe |
| `/work-center/:arbpl` | GET | `work_center` | Work center |

### Hub Write-Back Endpoints (Phase 5B)

| Path | Method | Scope | Description |
|---|---|---|---|
| `/confirmation` | POST | `conf` | Production order confirmation |
| `/goods-receipt` | POST | `gr` | Goods receipt for PO |
| `/goods-issue` | POST | `gi` | Goods issue for production order |

All write-back endpoints require an `Idempotency-Key` header for deduplication. 429 responses include a `Retry-After` header.

## Hub Quick Start

1. Build and start the hub:

```bash
pnpm build
HUB_JWT_SECRET=random-secret \
  SAP_HOST=sapdev.fastcell.hk:8000 SAP_CLIENT=200 \
  SAP_USER=<your_user> SAP_PASS='<your_password>' \
  pnpm --filter @zzapi-mes/hub start
```

2. Create an API key (plaintext printed once, save it):

```bash
pnpm --filter @zzapi-mes/hub migrate  # first run only
API_KEY=$(node apps/hub/dist/admin/cli.js keys create --label local-dev --scopes ping,po,prod_order,material,stock,routing,work_center,conf,gr,gi)
```

3. Get a token and test:

```bash
TOKEN=$(curl -s localhost:8080/auth/token \
  -d "{\"api_key\":\"$API_KEY\"}" -H 'content-type: application/json' | jq -r .token)

# Read endpoints
curl -H "authorization: Bearer $TOKEN" localhost:8080/ping
curl -H "authorization: Bearer $TOKEN" localhost:8080/po/3010000608
curl -H "authorization: Bearer $TOKEN" localhost:8080/prod-order/1000000
curl -H "authorization: Bearer $TOKEN" localhost:8080/material/10000001
curl -H "authorization: Bearer $TOKEN" "localhost:8080/stock/10000001?werks=1000"
curl -H "authorization: Bearer $TOKEN" localhost:8080/po/4500000001/items
curl -H "authorization: Bearer $TOKEN" "localhost:8080/routing/10000001?werks=1000"
curl -H "authorization: Bearer $TOKEN" "localhost:8080/work-center/TURN1?werks=1000"

# Write-back endpoints (require idempotency key)
curl -H "authorization: Bearer $TOKEN" -H "idempotency-key: conf-001" \
  -H "content-type: application/json" \
  -d '{"orderid":"1000000","operation":"0010","yield":50}' \
  localhost:8080/confirmation
curl -H "authorization: Bearer $TOKEN" -H "idempotency-key: gr-001" \
  -H "content-type: application/json" \
  -d '{"ebeln":"4500000001","ebelp":"00010","menge":100,"werks":"1000","lgort":"0001"}' \
  localhost:8080/goods-receipt
curl -H "authorization: Bearer $TOKEN" -H "idempotency-key: gi-001" \
  -H "content-type: application/json" \
  -d '{"orderid":"1000000","matnr":"20000001","menge":50,"werks":"1000","lgort":"0001"}' \
  localhost:8080/goods-issue

curl localhost:8080/healthz
curl localhost:8080/metrics
```

4. Deploy as systemd unit — see `apps/hub/deploy/`. For Windows, see `docs/deploy-msi1.md`.

## Operating the Hub

### Key Management

```bash
# Create a key (plaintext printed once — save it)
zzapi-mes-hub-admin keys create --label prod-mes --scopes ping,po,prod_order,material,stock,routing,work_center,conf,gr,gi

# List all keys
zzapi-mes-hub-admin keys list

# Revoke a key (immediately invalidates outstanding JWTs from that key)
zzapi-mes-hub-admin keys revoke <key_id>
```

### Audit & Retention

```bash
# Prune audit log entries older than N days
zzapi-mes-hub-admin audit prune --days 90

# Evict stale idempotency keys older than N seconds
zzapi-mes-hub-admin idempotency evict --max-age-seconds 86400
```

The hub runs both operations automatically on startup (configurable via `HUB_AUDIT_RETENTION_DAYS`).

### Rotating HUB_JWT_SECRET

Changing `HUB_JWT_SECRET` invalidates all outstanding JWTs. Clients will get 401 and must re-authenticate with their API key. Steps:

1. Update `HUB_JWT_SECRET` in `/etc/zzapi-mes-hub.env`
2. `sudo systemctl restart zzapi-mes-hub`

### Metrics

Scrape `GET /metrics` from Prometheus (localhost-only by default). Key counters and histograms:

- `zzapi_hub_requests_total{route,status,key_id}`
- `zzapi_hub_request_duration_seconds{route}`
- `zzapi_hub_sap_duration_seconds{route}`

### Structured Logs

The hub writes JSON lines to stdout (captured by journald):

```bash
journalctl -u zzapi-mes-hub -f
```

Each line includes `req_id`, `key_id`, `method`, `path`, `status`, `latency_ms`.

### systemd LoadCredential (alternative to plaintext env)

For systemd 250+, you can store secrets encrypted on disk instead of plaintext env files. See the commented `LoadCredential=` section in `zzapi-mes-hub.service`.
