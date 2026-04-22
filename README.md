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
MES client ──(JWT)──────▶ Hub GET /ping, /po/:ebeln ──▶ SAP ICF (Basic Auth)
```

## Phase Roadmap

| Phase | Scope | Status |
|---|---|---|
| 0 | Repo init, ABAP source mirrors, demo walkthrough | Done |
| 1 | Deploy handlers on sapdev, curl round-trip verified | Pending (SAP GUI) |
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
SAP_USER=api_user2 SAP_PASS='Pt@2026' pnpm smoke
```

3. Verify two endpoints respond:
   - `GET /sap/bc/zzapi_mes_ping` → `{"ok":true,"sap_time":"..."}`
   - `GET /sap/bc/zzapi_mes?ebeln=3010000608` → PO JSON matching BSP output

## SDK Usage

```ts
import { ZzapiMesClient } from "@zzapi-mes/sdk";

const client = new ZzapiMesClient({
  host: "http://sapdev.fastcell.hk:8000",
  client: 200,
  user: "api_user2",
  password: "Pt@2026",
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
SAP_USER=api_user2 SAP_PASS='Pt@2026' npx zzapi-mes ping
SAP_USER=api_user2 SAP_PASS='Pt@2026' npx zzapi-mes po 3010000608

# Hub mode — talks to the hub with API key, no SAP creds needed
HUB_URL=http://localhost:8080 HUB_API_KEY=my-key npx zzapi-mes --mode hub ping
HUB_URL=http://localhost:8080 HUB_API_KEY=my-key npx zzapi-mes --mode hub po 3010000608

# Or via ~/.zzapirc
echo '{"SAP_USER":"api_user2","SAP_PASS":"Pt@2026"}' > ~/.zzapirc
npx zzapi-mes ping
```

## Commands

| Command | Description |
|---|---|
| `pnpm build` | Compile all TypeScript packages |
| `pnpm test` | Run unit tests (mocked fetch) |
| `pnpm smoke` | Curl round-trip tests against sapdev |

## Endpoints

| Handler | SICF Path | Method | Description |
|---|---|---|---|
| `ZCL_ZZAPI_MES_PING` | `/sap/bc/zzapi_mes_ping` | GET | Health check |
| `ZCL_ZZAPI_MES_HANDLER` | `/sap/bc/zzapi_mes` | GET | PO info by ebeln |
| `ZCL_ZZAPI_MES_PROD_ORDER` | `/sap/bc/zzapi_mes_prod_order` | GET | Production order detail |
| `ZCL_ZZAPI_MES_MATERIAL` | `/sap/bc/zzapi_mes_material` | GET | Material master |
| `ZCL_ZZAPI_MES_STOCK` | `/sap/bc/zzapi_mes_stock` | GET | Stock / availability |
| `ZCL_ZZAPI_MES_PO_ITEMS` | `/sap/bc/zzapi_mes_po_items` | GET | PO line items |
| `ZCL_ZZAPI_MES_ROUTING` | `/sap/bc/zzapi_mes_routing` | GET | Routing / recipe |
| `ZCL_ZZAPI_MES_WC` | `/sap/bc/zzapi_mes_wc` | GET | Work center |
| `ZCL_ZZAPI_MES_CONF` | `/sap/bc/zzapi_mes_conf` | POST | Production confirmation |
| `ZCL_ZZAPI_MES_GR` | `/sap/bc/zzapi_mes_gr` | POST | Goods receipt for PO |
| `ZCL_ZZAPI_MES_GI` | `/sap/bc/zzapi_mes_gi` | POST | Goods issue for prod order |

### Hub Write-Back Endpoints (Phase 5B)

| Path | Method | Scope | Description |
|---|---|---|---|
| `/confirmation` | POST | `conf` | Production order confirmation |
| `/goods-receipt` | POST | `gr` | Goods receipt for PO |
| `/goods-issue` | POST | `gi` | Goods issue for production order |

All write-back endpoints require an `Idempotency-Key` header for deduplication.

## Hub Quick Start

1. Build and start the hub:

```bash
pnpm build
HUB_JWT_SECRET=random-secret \
  SAP_HOST=sapdev.fastcell.hk:8000 SAP_CLIENT=200 \
  SAP_USER=api_user2 SAP_PASS='Pt@2026' \
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
curl -H "authorization: Bearer $TOKEN" localhost:8080/ping
curl -H "authorization: Bearer $TOKEN" localhost:8080/po/3010000608
curl localhost:8080/healthz
curl localhost:8080/metrics
```

4. Deploy as systemd unit — see `apps/hub/deploy/`.

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

### Rotating HUB_JWT_SECRET

Changing `HUB_JWT_SECRET` invalidates all outstanding JWTs. Clients will get 401 and must re-authenticate with their API key. Steps:

1. Update `HUB_JWT_SECRET` in `/etc/zzapi-mes-hub.env`
2. `sudo systemctl restart zzapi-mes-hub`

### Metrics

Scrape `GET /metrics` from Prometheus (localhost-only by default). Key counters:

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
