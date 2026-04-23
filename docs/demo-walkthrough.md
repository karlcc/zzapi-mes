# Demo Walkthrough: ICF REST Handlers on sapdev

## TL;DR

Deploy all 11 ABAP ICF handlers on SAP via SE24 + SICF, verify with curl. No SE80, no BSP. Repeat the same two-step pattern (create class → register in SICF) for each handler.

## Prerequisites

- Access to `msi-1` (SAP GUI for Windows via Parsec/RDP), or macOS SAP GUI for Java
- SAP logon to `sapdev` client 200
- SICF authorization (or Basis admin to register first service)
- Terminal with curl access to `sapdev.fastcell.hk:8000`
- Credentials: set `SAP_USER` and `SAP_PASS` env vars (or pass via `-u` flag)

---

## Handler 1: Ping (health check)

### Step 1 — Create class in SE24

1. Transaction **SE24**
2. Class name: `ZCL_ZZAPI_MES_PING`
3. Click **Create**
4. Description: `ZZAPI MES ping handler`
5. In **Interfaces** tab → add `IF_HTTP_EXTENSION`
6. In **Methods** tab → double-click `IF_HTTP_EXTENSION~HANDLE_REQUEST`
7. Paste the code from `abap/ZCL_ZZAPI_MES_PING.abap`
8. **Activate** (Ctrl+F3) — create transport if prompted

### Step 2 — Register in SICF

1. Transaction **SICF**
2. Navigate tree: `/default_host/sap/bc/`
3. Right-click `zzapi` → **Create Sub-Element** (or `bc` if `zzapi` doesn't exist yet)
4. Name: `ping` (under `/default_host/sap/bc/zzapi/mes/`)
5. Switch to **Handler List** tab
6. Enter: `ZCL_ZZAPI_MES_PING`
7. **Save** (Ctrl+S)
8. Right-click the `ping` node → **Activate Service**

### Step 3 — Test with curl

```bash
curl -u "$SAP_USER:$SAP_PASS" \
  "http://sapdev.fastcell.hk:8000/sap/bc/zzapi/mes/ping?sap-client=200"
```

**Expected response:**

```json
{"ok":true,"sap_time":"20260422163000"}
```

```bash
# POST should be rejected — expect 405
curl -u "$SAP_USER:$SAP_PASS" -X POST \
  "http://sapdev.fastcell.hk:8000/sap/bc/zzapi/mes/ping?sap-client=200"
```

**Expected:**

```json
{"error":"Method not allowed"}
```

If you see both responses, ICF handler registration is working. Move to Handler 2.

---

## Handler 2: PO Info (ZMES001 clone)

### Step 1 — Create class in SE24

1. Transaction **SE24**
2. Class name: `ZCL_ZZAPI_MES_HANDLER`
3. Click **Create**
4. Description: `ZZAPI MES PO info handler`
5. In **Interfaces** tab → add `IF_HTTP_EXTENSION`
6. In **Methods** tab → double-click `IF_HTTP_EXTENSION~HANDLE_REQUEST`
7. Paste the code from `abap/ZCL_ZZAPI_MES_HANDLER.abap`
8. **Activate** (Ctrl+F3) — create transport if prompted

> **Dependencies**: This handler requires `ZMES001` structure and `ZZ_CL_JSON` class — both already exist on sapdev.

### Step 2 — Register in SICF

1. Transaction **SICF**
2. Navigate tree: `/default_host/sap/bc/zzapi/mes/`
3. Right-click `mes` → **Create Sub-Element**
4. Name: `handler`
5. Switch to **Handler List** tab
6. Enter: `ZCL_ZZAPI_MES_HANDLER`
7. **Save** (Ctrl+S)
8. Right-click the `handler` node → **Activate Service**

### Step 3 — Test with curl

```bash
# PO that exists in the system
curl -u "$SAP_USER:$SAP_PASS" \
  "http://sapdev.fastcell.hk:8000/sap/bc/zzapi/mes/handler?ebeln=3010000608&sap-client=200"
```

**Expected response (must match BSP output):**

```json
{"ebeln":"3010000608","aedat":"20170306","lifnr":"0000500340","eindt":"20170630"}
```

```bash
# PO that does NOT exist — expect 404
curl -u "$SAP_USER:$SAP_PASS" \
  "http://sapdev.fastcell.hk:8000/sap/bc/zzapi/mes/handler?ebeln=9999999999&sap-client=200"
```

**Expected:**

```json
{"error":"PO not found"}
```

```bash
# POST should be rejected — expect 405
curl -u "$SAP_USER:$SAP_PASS" -X POST \
  "http://sapdev.fastcell.hk:8000/sap/bc/zzapi/mes/handler?ebeln=3010000608&sap-client=200"
```

**Expected:**

```json
{"error":"Method not allowed"}
```

---

## Phase 5A: Read-only Handlers (6 endpoints)

Each handler follows the **same two-step pattern** as above. The table below lists all remaining read-only handlers:

| # | Class | SICF Node | Source File | Endpoint | Key Params |
|---|-------|-----------|-------------|----------|------------|
| 3 | `ZCL_ZZAPI_MES_PROD_ORDER` | `prod_order` | `abap/ZCL_ZZAPI_MES_PROD_ORDER.abap` | `/sap/bc/zzapi/mes/prod_order` | `aufnr` |
| 4 | `ZCL_ZZAPI_MES_MATERIAL` | `material` | `abap/ZCL_ZZAPI_MES_MATERIAL.abap` | `/sap/bc/zzapi/mes/material` | `matnr`, `werks` |
| 5 | `ZCL_ZZAPI_MES_STOCK` | `stock` | `abap/ZCL_ZZAPI_MES_STOCK.abap` | `/sap/bc/zzapi/mes/stock` | `matnr`, `werks`, `lgort` |
| 6 | `ZCL_ZZAPI_MES_PO_ITEMS` | `po_items` | `abap/ZCL_ZZAPI_MES_PO_ITEMS.abap` | `/sap/bc/zzapi/mes/po_items` | `ebeln` |
| 7 | `ZCL_ZZAPI_MES_ROUTING` | `routing` | `abap/ZCL_ZZAPI_MES_ROUTING.abap` | `/sap/bc/zzapi/mes/routing` | `matnr`, `werks` |
| 8 | `ZCL_ZZAPI_MES_WC` | `wc` | `abap/ZCL_ZZAPI_MES_WC.abap` | `/sap/bc/zzapi/mes/wc` | `arbpl`, `werks` |

### Deployment steps (repeat for each):

1. **SE24**: Create class → add `IF_HTTP_EXTENSION` → paste code from `abap/` file → Activate
2. **SICF**: Navigate to `/default_host/sap/bc/zzapi/mes/` → Create Sub-Element with node name from table → Handler List tab → enter class name → Save → Activate Service
3. **curl**: Test with Basic Auth, e.g.:

```bash
# Production order
curl -u "$SAP_USER:$SAP_PASS" \
  "http://sapdev.fastcell.hk:8000/sap/bc/zzapi/mes/prod_order?aufnr=1000000&sap-client=200"

# Material
curl -u "$SAP_USER:$SAP_PASS" \
  "http://sapdev.fastcell.hk:8000/sap/bc/zzapi/mes/material?matnr=100000&werks=1000&sap-client=200"

# Stock
curl -u "$SAP_USER:$SAP_PASS" \
  "http://sapdev.fastcell.hk:8000/sap/bc/zzapi/mes/stock?matnr=100000&werks=1000&sap-client=200"

# PO items
curl -u "$SAP_USER:$SAP_PASS" \
  "http://sapdev.fastcell.hk:8000/sap/bc/zzapi/mes/po_items?ebeln=3010000608&sap-client=200"

# Routing
curl -u "$SAP_USER:$SAP_PASS" \
  "http://sapdev.fastcell.hk:8000/sap/bc/zzapi/mes/routing?matnr=100000&werks=1000&sap-client=200"

# Work center
curl -u "$SAP_USER:$SAP_PASS" \
  "http://sapdev.fastcell.hk:8000/sap/bc/zzapi/mes/wc?arbpl=1000&werks=1000&sap-client=200"
```

> **Note**: Use actual values from your SAP system. The example values above may not exist in your DEV client.

---

## Phase 5B: Write-back Handlers (3 endpoints)

These handlers call SAP BAPIs and support POST only. They require the helper include `ZIZZAPI_MES_EXTRACT_FORMS` (deploy first).

### Helper: Deploy `ZIZZAPI_MES_EXTRACT_FORMS`

This ABAP include contains shared form routines used by the write-back handlers.

1. Transaction **SE38** (or SE80)
2. Program name: `ZIZZAPI_MES_EXTRACT_FORMS`
3. Click **Create**
4. Paste the code from `abap/ZIZZAPI_MES_EXTRACT_FORMS.abap`
5. **Activate**

### Write-back Handler Table

| # | Class | SICF Node | Source File | Endpoint | BAPI Called |
|---|-------|-----------|-------------|----------|-------------|
| 9 | `ZCL_ZZAPI_MES_CONF` | `conf` | `abap/ZCL_ZZAPI_MES_CONF.abap` | `/sap/bc/zzapi/mes/conf` | `BAPI_PRODORDCONF_CREATE_TT` |
| 10 | `ZCL_ZZAPI_MES_GR` | `gr` | `abap/ZCL_ZZAPI_MES_GR.abap` | `/sap/bc/zzapi/mes/gr` | `BAPI_GOODSMVT_CREATE` (mvt 101) |
| 11 | `ZCL_ZZAPI_MES_GI` | `gi` | `abap/ZIZZAPI_MES_GI.abap` | `/sap/bc/zzapi/mes/gi` | `BAPI_GOODSMVT_CREATE` (mvt 261) |

### Deployment steps (repeat for each):

1. **SE24**: Create class → add `IF_HTTP_EXTENSION` → paste code → Activate
2. **SICF**: Navigate to `/default_host/sap/bc/zzapi/mes/` → Create Sub-Element → Handler List → enter class name → Save → Activate
3. **curl**: Test with POST + JSON body, e.g.:

```bash
# Confirmation
curl -u "$SAP_USER:$SAP_PASS" -X POST \
  -H "Content-Type: application/json" \
  -d '{"aufnr":"1000000","conf_type":"","plant":"1000","work_center":"","fin_conf":"","postg":"","yield":10,"scrap":0,"rework":0,"emp_id":"","cost_center":"","ov_conf":""}' \
  "http://sapdev.fastcell.hk:8000/sap/bc/zzapi/mes/conf?sap-client=200"

# Goods receipt
curl -u "$SAP_USER:$SAP_PASS" -X POST \
  -H "Content-Type: application/json" \
  -d '{"aufnr":"1000000","material":"100000","plant":"1000","qty":10,"uom":"EA"}' \
  "http://sapdev.fastcell.hk:8000/sap/bc/zzapi/mes/gr?sap-client=200"

# Goods issue
curl -u "$SAP_USER:$SAP_PASS" -X POST \
  -H "Content-Type: application/json" \
  -d '{"aufnr":"1000000","material":"100000","plant":"1000","qty":10,"uom":"EA"}' \
  "http://sapdev.fastcell.hk:8000/sap/bc/zzapi/mes/gi?sap-client=200"
```

> **Note**: Write-back handlers require appropriate SAP authorizations for the BAPIs. Coordinate with Basis team if you get authorization errors.

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| 404 from curl | Service node not activated in SICF | Right-click node → Activate Service |
| 401/403 | Wrong credentials or ICF auth settings | Check user/pass; verify ICF node auth is set to "Standard" |
| 405 on GET | Handler class not assigned in SICF (ICF default returns 405) | Handler List tab must list the class name exactly |
| 500 internal error | ABAP dump in handler | Check ST22 for runtime errors; verify dependencies (ZMES001, ZZ_CL_JSON) |
| Empty response | Handler class not assigned in SICF | Handler List tab must list the class name exactly |
| `sy-subrc` always 4 | Wrong client — forgot `sap-client=200` | Add `&sap-client=200` to URL |
| BSP-style URL encoding blob | You're hitting the old BSP path | Use `/sap/bc/zzapi/mes/*` not `/sap/bc/bsp/sap/...` |
| BAPI authorization error | User lacks BAPI roles | Coordinate with Basis for `BAPI_PRODORDCONF_CREATE_TT` / `BAPI_GOODSMVT_CREATE` roles |

---

## Deployment Checklist

| # | Class / Include | SICF Node | Deployed? |
|---|-----------------|-----------|-----------|
| 1 | `ZCL_ZZAPI_MES_PING` | `ping` | ☐ |
| 2 | `ZCL_ZZAPI_MES_HANDLER` | `handler` | ☐ |
| 3 | `ZCL_ZZAPI_MES_PROD_ORDER` | `prod_order` | ☐ |
| 4 | `ZCL_ZZAPI_MES_MATERIAL` | `material` | ☐ |
| 5 | `ZCL_ZZAPI_MES_STOCK` | `stock` | ☐ |
| 6 | `ZCL_ZZAPI_MES_PO_ITEMS` | `po_items` | ☐ |
| 7 | `ZCL_ZZAPI_MES_ROUTING` | `routing` | ☐ |
| 8 | `ZCL_ZZAPI_MES_WC` | `wc` | ☐ |
| 9 | `ZIZZAPI_MES_EXTRACT_FORMS` | (include, no SICF) | ☐ |
| 10 | `ZCL_ZZAPI_MES_CONF` | `conf` | ☐ |
| 11 | `ZCL_ZZAPI_MES_GR` | `gr` | ☐ |
| 12 | `ZCL_ZZAPI_MES_GI` | `gi` | ☐ |

---

## After the Demo

Once all curl tests pass:

1. Copy the activated ABAP source from SE24 back into `abap/` in the repo (diff against what's there to catch any SAP-side edits)
2. Run `SAP_USER=... SAP_PASS=... pnpm smoke` to verify against the full test script
3. Commit everything
4. Move to Phase 2: OpenAPI spec + SDK + CLI
