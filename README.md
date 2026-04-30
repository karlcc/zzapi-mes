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

### Direct mode (SAP Basic Auth)

```ts
import { ZzapiMesClient } from "@zzapi-mes/sdk";

const client = new ZzapiMesClient({
  host: "http://sapdev.fastcell.hk:8000",
  client: 200,
  user: process.env.SAP_USER!,
  password: process.env.SAP_PASS!,
});

const pong = await client.ping();
// { ok: true, sap_time: "20260422163000" }

const po = await client.getPo("3010000608");
// { purchaseOrderNumber: "3010000608", createdAt: "2017-03-06", vendorNumber: "0000500340", deliveryDate: "2017-06-30" }

// SAP IDs must be 18-char padded (add leading zeros)
const mat = await client.getMaterial("000000000100000001");
// { materialNumber: "000000000100000001", description: "ATOS Software Upgr51", ... }

// Use format: "raw" for original SAP DDIC field names
const rawClient = new ZzapiMesClient({
  host: "http://sapdev.fastcell.hk:8000",
  client: 200,
  user: process.env.SAP_USER!,
  password: process.env.SAP_PASS!,
  format: "raw", // returns { ebeln, aedat, ... }
});
```

### Hub mode (API key, no SAP creds on client)

```ts
import { HubClient } from "@zzapi-mes/sdk";

const hub = new HubClient({
  hubUrl: process.env.HUB_URL!,       // e.g. http://100.103.147.52:8080
  apiKey: process.env.HUB_API_KEY!,   // from zzapi-mes-hub-admin keys create
});

const pong = await hub.ping();
const po = await hub.getPo("3010000608");
const mat = await hub.getMaterial("000000000100000001");
const stock = await hub.getStock("000000000100000001", { werks: "1000" });
```

## CLI Usage

> **SAP ID padding**: SAP expects 18-character internal IDs. Use `000000000100000001` (not `10000001`) for materials, `000001001234` for production orders, etc. PO numbers like `3010000608` are already the correct length.

```bash
# Hub mode via ~/.zzapirc (HUB_URL + HUB_API_KEY auto-loaded)
zzapi-mes --mode hub ping
zzapi-mes --mode hub po 3010000608
zzapi-mes --mode hub material 000000000100000001
zzapi-mes --mode hub stock 000000000100000001 --werks 1000
zzapi-mes --mode hub routing 000000000100920000 --werks 1000
zzapi-mes --mode hub work-center TURN1 --werks 1000

# Direct mode (SAP Basic Auth, reads SAP_USER/SAP_PASS from env or ~/.zzapirc)
zzapi-mes ping
zzapi-mes po 3010000608
zzapi-mes material 000000000100000001

# Direct mode with raw SAP field names
zzapi-mes --format raw po 3010000608
# { "ebeln": "3010000608", "aedat": "20170306", ... }

# Default format is friendly (human-readable field names)
zzapi-mes --format friendly po 3010000608
# { "purchaseOrderNumber": "3010000608", "createdAt": "2017-03-06", ... }
```

`~/.zzapirc` example:

```json
{
  "SAP_HOST": "sapdev.fastcell.hk:8000",
  "SAP_CLIENT": 200,
  "SAP_USER": "your_user",
  "SAP_PASS": "your_password",
  "HUB_URL": "http://100.103.147.52:8080",
  "HUB_API_KEY": "your-api-key"
}
```

## Commands

| Command | Description |
|---|---|
| `pnpm build` | Compile all TypeScript packages |
| `pnpm test` | Run unit tests (746 passing: 159 core + 545 hub + 42 CLI) |
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

### Linux / macOS

1. Build and start the hub:

```bash
pnpm build
HUB_JWT_SECRET=change-me-16chars-min \
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

### Windows (msi-1)

1. Build and run (PowerShell):

```powershell
pnpm build
$env:HUB_JWT_SECRET = "change-me-16chars-min"
$env:SAP_HOST = "sapdev.fastcell.hk:8000"
$env:SAP_CLIENT = "200"
$env:SAP_USER = "<your_user>"
$env:SAP_PASS = "<your_password>"
node apps\hub\dist\index.js
```

2. Create an API key:

```powershell
node apps\hub\dist\scripts\migrate.js   # first run only
$env:API_KEY = (node apps\hub\dist\admin\cli.js keys create --label msi1-dev --scopes ping,po,prod_order,material,stock,routing,work_center,conf,gr,gi)
```

3. Get a token and test:

```powershell
$env:TOKEN = (Invoke-RestMethod -Uri http://localhost:8080/auth/token -Method Post -ContentType "application/json" -Body ('{"api_key":"' + $env:API_KEY + '"}')).token

# Read endpoints
Invoke-RestMethod -Headers @{ Authorization = "Bearer $env:TOKEN" } -Uri http://localhost:8080/ping
Invoke-RestMethod -Headers @{ Authorization = "Bearer $env:TOKEN" } -Uri http://localhost:8080/po/3010000608
Invoke-RestMethod -Headers @{ Authorization = "Bearer $env:TOKEN" } -Uri http://localhost:8080/material/10000001
Invoke-RestMethod -Headers @{ Authorization = "Bearer $env:TOKEN" } -Uri "http://localhost:8080/stock/10000001?werks=1000"
Invoke-RestMethod -Headers @{ Authorization = "Bearer $env:TOKEN" } -Uri http://localhost:8080/po/4500000001/items
Invoke-RestMethod -Headers @{ Authorization = "Bearer $env:TOKEN" } -Uri "http://localhost:8080/routing/10000001?werks=1000"
Invoke-RestMethod -Headers @{ Authorization = "Bearer $env:TOKEN" } -Uri "http://localhost:8080/work-center/TURN1?werks=1000"

# Health and metrics (no auth)
Invoke-RestMethod -Uri http://localhost:8080/healthz
Invoke-RestMethod -Uri http://localhost:8080/metrics
```

4. Deploy as Windows service — see `apps/hub/deploy/install.ps1` (automated) or `docs/deploy-msi1.md` (step-by-step with nssm).

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

Changing `HUB_JWT_SECRET` invalidates all outstanding JWTs. Clients will get 401 and must re-authenticate with their API key.

**Linux:**

1. Update `HUB_JWT_SECRET` in `/etc/zzapi-mes-hub.env`
2. `sudo systemctl restart zzapi-mes-hub`

**Windows (nssm):**

1. Update `HUB_JWT_SECRET` in `C:\etc\zzapi-mes-hub.env` or via nssm: `nssm set zzapi-mes-hub AppEnvironmentExtra HUB_JWT_SECRET=<new-secret> ...`
2. `nssm restart zzapi-mes-hub`

### Metrics

Scrape `GET /metrics` from Prometheus (localhost-only by default). Key counters and histograms:

- `zzapi_hub_requests_total{route,status,key_id}`
- `zzapi_hub_request_duration_seconds{route}`
- `zzapi_hub_sap_duration_seconds{route}`

### Structured Logs

The hub writes JSON lines to stdout. Each line includes `req_id`, `key_id`, `method`, `path`, `status`, `latency_ms`.

**Linux:**

```bash
journalctl -u zzapi-mes-hub -f
```

**Windows (nssm):**

```powershell
Get-Content C:\var\zzapi-mes-hub\stdout.log -Tail 50 -Wait
```

### systemd LoadCredential (alternative to plaintext env)

For systemd 250+, you can store secrets encrypted on disk instead of plaintext env files. See the commented `LoadCredential=` section in `zzapi-mes-hub.service`.

### Windows Service (nssm)

The hub runs as a Windows service via [nssm](https://nssm.cc/). Automated install:

```powershell
# From repo root, admin PowerShell
powershell -File apps\hub\deploy\install.ps1
```

Manual nssm commands:

```powershell
# Install
nssm install zzapi-mes-hub "C:\Program Files\nodejs\node.exe" "C:\Users\karlchow\code\zzapi-mes\apps\hub\dist\index.js"
nssm set zzapi-mes-hub AppDirectory "C:\Users\karlchow\code\zzapi-mes\apps\hub"
nssm set zzapi-mes-hub AppStdout "C:\var\zzapi-mes-hub\stdout.log"
nssm set zzapi-mes-hub AppStderr "C:\var\zzapi-mes-hub\stderr.log"
nssm set zzapi-mes-hub AppRotateFiles 1
nssm set zzapi-mes-hub AppRotateBytes 1048576
nssm set zzapi-mes-hub AppEnvironmentExtra "HUB_PORT=8080" "HUB_JWT_SECRET=<secret>" "SAP_HOST=sapdev.fastcell.hk:8000" "SAP_CLIENT=200" "SAP_USER=<user>" "SAP_PASS=<pass>"
nssm set zzapi-mes-hub Start SERVICE_AUTO_START
nssm start zzapi-mes-hub

# Manage
nssm status zzapi-mes-hub
nssm restart zzapi-mes-hub
nssm stop zzapi-mes-hub
```

SQLite backup on Windows uses `apps/hub/deploy/backup.ps1` (requires `sqlite3.exe` in PATH). Schedule via Task Scheduler for automatic rotation.
