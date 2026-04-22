# Demo Walkthrough: ICF REST Handlers on sapdev

## TL;DR

Two-step SAP-side deployment: create ABAP classes in SE24, register in SICF, verify with curl. No SE80, no BSP.

## Prerequisites

- Access to `msi-1` (SAP GUI for Windows via Parsec/RDP), or macOS SAP GUI for Java
- SAP logon to `sapdev` client 200
- SICF authorization (or Basis admin to register first service)
- Terminal with curl access to `sapdev.fastcell.hk:8000`
- Credentials: `api_user2` / `Pt@2026`

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
3. Right-click `bc` → **Create Sub-Element**
4. Name: `zzapi_mes_ping`
5. Switch to **Handler List** tab
6. Enter: `ZCL_ZZAPI_MES_PING`
7. **Save** (Ctrl+S)
8. Right-click the `zzapi_mes_ping` node → **Activate Service**

### Step 3 — Test with curl

```bash
curl -u api_user2:Pt@2026 \
  "http://sapdev.fastcell.hk:8000/sap/bc/zzapi_mes_ping?sap-client=200"
```

**Expected response:**

```json
{"ok":true,"sap_time":"20260422163000"}
```

If you see this, ICF handler registration is working. Move to Handler 2.

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
2. Navigate tree: `/default_host/sap/bc/`
3. Right-click `bc` → **Create Sub-Element**
4. Name: `zzapi_mes`
5. Switch to **Handler List** tab
6. Enter: `ZCL_ZZAPI_MES_HANDLER`
7. **Save** (Ctrl+S)
8. Right-click the `zzapi_mes` node → **Activate Service**

### Step 3 — Test with curl

```bash
# PO that exists in the system
curl -u api_user2:Pt@2026 \
  "http://sapdev.fastcell.hk:8000/sap/bc/zzapi_mes?ebeln=3010000608&sap-client=200"
```

**Expected response (must match BSP output):**

```json
{"ebeln":"3010000608","aedat":"20170306","lifnr":"0000500340","eindt":"20170630"}
```

```bash
# PO that does NOT exist — expect 404
curl -u api_user2:Pt@2026 \
  "http://sapdev.fastcell.hk:8000/sap/bc/zzapi_mes?ebeln=9999999999&sap-client=200"
```

**Expected:**

```json
{"error":"PO not found"}
```

```bash
# POST should be rejected — expect 405
curl -u api_user2:Pt@2026 -X POST \
  "http://sapdev.fastcell.hk:8000/sap/bc/zzapi_mes?ebeln=3010000608&sap-client=200"
```

**Expected:**

```json
{"error":"Method not allowed"}
```

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| 404 from curl | Service node not activated in SICF | Right-click node → Activate Service |
| 401/403 | Wrong credentials or ICF auth settings | Check user/pass; verify ICF node auth is set to "Standard" |
| 500 internal error | ABAP dump in handler | Check ST22 for runtime errors; verify ZMES001 and ZZ_CL_JSON exist |
| Empty response | Handler class not assigned in SICF | Handler List tab must list the class name exactly |
| `sy-subrc` always 4 | Wrong client — forgot `sap-client=200` | Add `&sap-client=200` to URL |
| BSP-style URL encoding blob | You're hitting the old BSP path | Use `/sap/bc/zzapi_mes` not `/sap/bc/bsp/sap/...` |

---

## After the Demo

Once both curl tests pass:

1. Copy the activated ABAP source from SE24 back into `abap/` in the repo (diff against what's there to catch any SAP-side edits)
2. Run `pnpm smoke` to verify against the full test script
3. Commit everything
4. Move to Phase 2: OpenAPI spec + SDK + CLI
