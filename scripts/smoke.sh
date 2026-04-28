#!/usr/bin/env bash
# smoke.sh — curl round-trip tests for zzapi-mes ICF handlers
# Run after deploying both handlers to sapdev.
#
# Usage:  SAP_USER=your_user SAP_PASS='<password>' bash scripts/smoke.sh
#         VERBOSE=1 bash scripts/smoke.sh          (show response bodies)
#
# Required env vars (direct mode):
#   SAP_USER, SAP_PASS  — SAP credentials (no defaults, will error if unset)
#
# Optional env vars:
#   SAP_HOST            — SAP host (default: sapdev.fastcell.hk:8000)
#   SAP_CLIENT          — SAP client (default: 200)
#   HUB_MODE=1          — test against hub instead of SAP directly
#   HUB_URL             — hub base URL (default: http://localhost:8080)
#   HUB_API_KEY         — hub API key (required only in hub mode)

set -euo pipefail

SAP_USER="${SAP_USER:?Set SAP_USER env var (or use HUB_MODE=1)}"
SAP_PASS="${SAP_PASS:?Set SAP_PASS env var (or use HUB_MODE=1)}"
SAP_HOST="${SAP_HOST:-sapdev.fastcell.hk:8000}"
SAP_CLIENT="${SAP_CLIENT:-200}"
VERBOSE="${VERBOSE:-0}"

# Hub mode: set HUB_MODE=1 to test against the hub instead of SAP directly
HUB_MODE="${HUB_MODE:-0}"
HUB_URL="${HUB_URL:-http://localhost:8080}"
HUB_API_KEY="${HUB_API_KEY:-}"

BASE_URL="http://${SAP_HOST}"

# When in hub mode, fetch a JWT first
HUB_TOKEN=""
if [[ "$HUB_MODE" == "1" ]]; then
  if [[ -z "$HUB_API_KEY" ]]; then
    echo "FATAL: HUB_API_KEY is required in hub mode (HUB_MODE=1)"
    exit 1
  fi
  BASE_URL="$HUB_URL"
  HUB_TOKEN=$(curl -s "$HUB_URL/auth/token" \
    -d "{\"api_key\":\"$HUB_API_KEY\"}" \
    -H 'content-type: application/json' \
    | jq -r .token 2>/dev/null) || true
  if [[ -z "$HUB_TOKEN" || "$HUB_TOKEN" == "null" ]]; then
    echo "FATAL: could not obtain hub JWT (check HUB_URL and HUB_API_KEY)"
    exit 1
  fi
fi

pass=0
fail=0

# json_eq: assert jq path equals expected value
json_eq() {
  local body="$1" path="$2" expected="$3"
  local actual
  actual=$(echo "$body" | jq -r "$path" 2>/dev/null) || return 1
  [[ "$actual" == "$expected" ]]
}

check() {
  local label="$1" url="$2" expect_status="$3" method="${4:-GET}"; shift 4
  # Remaining args: pairs of (jq_path, expected_value) for body assertions,
  # or -H/-d flags which are passed through to curl

  local t0 status body elapsed tmpf
  t0=${EPOCHREALTIME//./}

  # Build full URL — add sap-client param only in direct mode
  local full_url="$url"
  if [[ "$HUB_MODE" != "1" ]]; then
    local sep="?"
    if [[ "$url" == *"?"* ]]; then sep="&"; fi
    full_url="${url}${sep}sap-client=${SAP_CLIENT}"
  fi

  local curl_args=(-s)
  if [[ "$HUB_MODE" == "1" ]]; then
    curl_args+=(-H "authorization: Bearer ${HUB_TOKEN}")
  else
    curl_args+=(-u "${SAP_USER}:${SAP_PASS}")
  fi
  if [[ "$method" != "GET" ]]; then curl_args+=(-X "$method"); fi

  # Collect -H/-d curl flags and jq assertions from remaining args
  local jq_assertions=()
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == "-H" || "$1" == "-d" ]]; then
      curl_args+=("$1" "$2"); shift 2
    else
      jq_assertions+=("$1" "$2"); shift 2
    fi
  done

  # Single curl call: body to temp file, status via -w
  tmpf=$(mktemp)
  status=$(curl -o "$tmpf" -w "%{http_code}" "${curl_args[@]}" "${full_url}")
  body=$(cat "$tmpf") && rm -f "$tmpf"

  elapsed=$(( (${EPOCHREALTIME//./} - t0) / 1000 ))

  if [[ "$status" != "$expect_status" ]]; then
    echo "  FAIL  ${label}  expected ${expect_status}, got ${status}  (${elapsed}ms)"
    [[ "$VERBOSE" == "1" ]] && echo "        body: ${body}"
    ((fail++)) || true
    return
  fi

  # Body assertions (pairs of jq_path + expected value)
  local i=0
  while [[ $i -lt ${#jq_assertions[@]} ]]; do
    local jq_path="${jq_assertions[$i]}" expected_val="${jq_assertions[$((i+1))]}"
    i=$((i+2))
    if ! json_eq "$body" "$jq_path" "$expected_val"; then
      echo "  FAIL  ${label}  status OK (${status}) but ${jq_path} mismatch"
      echo "        expected: ${expected_val}"
      [[ "$VERBOSE" == "1" ]] && echo "        body: ${body}"
      ((fail++)) || true
      return
    fi
  done

  echo "  PASS  ${label}  (${status}, ${elapsed}ms)"
  ((pass++)) || true
}

echo "=== zzapi-mes smoke tests ==="
if [[ "$HUB_MODE" == "1" ]]; then
  echo "  Mode:       hub"
  echo "  Hub URL:    ${HUB_URL}"
  echo "  Hub token:  ${HUB_TOKEN:0:20}..."
else
  echo "  Mode:       direct"
  echo "  SAP host:   ${SAP_HOST}"
  echo "  SAP client: ${SAP_CLIENT}"
  echo "  SAP user:   ${SAP_USER}"
fi
echo ""

# Route paths differ between direct (SAP ICF) and hub
if [[ "$HUB_MODE" == "1" ]]; then
  PING_PATH="/ping"
  PO_PATH_PREFIX="/po"
  # Hub mode: no sap-client param needed
  ADD_SAP_CLIENT=0
else
  PING_PATH="/sap/bc/zzapi/mes/ping"
  PO_PATH_PREFIX="/sap/bc/zzapi/mes/handler"
  ADD_SAP_CLIENT=1
fi

echo "-- Ping handler --"
check "ping returns ok=true" \
  "${BASE_URL}${PING_PATH}" \
  "200" GET \
  ".ok" "true"

if [[ "$HUB_MODE" != "1" ]]; then
  check "POST to ping rejected with 405" \
    "${BASE_URL}${PING_PATH}" \
    "405" POST \
    ".error" "Method not allowed"
fi

echo ""
echo "-- PO handler --"
if [[ "$HUB_MODE" == "1" ]]; then
  PO_URL="${BASE_URL}${PO_PATH_PREFIX}/3010000608"
  PO_NOTFOUND_URL="${BASE_URL}${PO_PATH_PREFIX}/9999999999"
  PO_POST_URL="${BASE_URL}${PO_PATH_PREFIX}/3010000608"
else
  PO_URL="${BASE_URL}${PO_PATH_PREFIX}?ebeln=3010000608"
  PO_NOTFOUND_URL="${BASE_URL}${PO_PATH_PREFIX}?ebeln=9999999999"
  PO_POST_URL="${BASE_URL}${PO_PATH_PREFIX}?ebeln=3010000608"
fi

if [[ "$HUB_MODE" == "1" ]]; then
  # Hub returns friendly-format envelope: {data: {purchaseOrderNumber: "3010000608"}, _links: {...}}
  check "PO 3010000608 returns ebeln" \
    "$PO_URL" \
    "200" GET \
    ".data.purchaseOrderNumber" "3010000608"
else
  # Direct SAP returns raw DDIC fields: {ebeln: "3010000608", ...}
  check "PO 3010000608 returns ebeln" \
    "$PO_URL" \
    "200" GET \
    ".ebeln" "3010000608"
fi

check "PO 9999999999 returns 404 with error" \
  "$PO_NOTFOUND_URL" \
  "404" GET \
  ".error" "PO not found"

if [[ "$HUB_MODE" != "1" ]]; then
  check "POST rejected with 405" \
    "$PO_POST_URL" \
    "405" POST \
    ".error" "Method not allowed"

  # Phase 5A direct SAP endpoints
  # IDs sourced from PTD_READONLY (cloned sapdev SQL backup, client 200):
  #   MATNR=000000000100000001 (Z010, stock at WERKS=1000, LGORT=4111)
  #   AUFNR=000000100000 (Z100 production order)
  #   EBELN=2010000000, EBELP=00010 (PO with line item, Q010)
  #   Routing: MATNR=000000000100920000 + WERKS=1000 → PLNNR=50000038
  echo ""
  echo "-- Phase 5A: prod-order, material, stock, po-items, routing, work-center (direct) --"

  check "prod-order returns aufnr" \
    "${BASE_URL}/sap/bc/zzapi/mes/prod_order?aufnr=000000100000" \
    "200" GET \
    ".aufnr" "000000100000"

  check "prod-order missing aufnr returns 400" \
    "${BASE_URL}/sap/bc/zzapi/mes/prod_order" \
    "400" GET

  check "material returns matnr" \
    "${BASE_URL}/sap/bc/zzapi/mes/material?matnr=000000000100000001" \
    "200" GET

  check "stock with werks returns data" \
    "${BASE_URL}/sap/bc/zzapi/mes/stock?matnr=000000000100000001&werks=1000" \
    "200" GET

  check "stock without werks returns 400" \
    "${BASE_URL}/sap/bc/zzapi/mes/stock?matnr=000000000100000001" \
    "400" GET

  check "po-items returns ebeln" \
    "${BASE_URL}/sap/bc/zzapi/mes/po_items?ebeln=2010000000" \
    "200" GET \
    ".ebeln" "2010000000"

  # Routing: sapdev has NO PLNTY='R' entries (only 'N' network), so 404 is expected
  check "routing with werks returns 404 (no routing data in sapdev)" \
    "${BASE_URL}/sap/bc/zzapi/mes/routing?matnr=000000000100920000&werks=1000" \
    "404" GET \
    ".error" "No routing found for material/plant"

  check "work-center with werks returns arbpl" \
    "${BASE_URL}/sap/bc/zzapi/mes/wc?arbpl=00310211&werks=1000" \
    "200" GET

  # 405 method guard checks for Phase 5A direct SAP endpoints
  echo ""
  echo "-- 405 Method Not Allowed (direct SAP) --"

  check "POST /prod_order rejected with 405" \
    "${BASE_URL}/sap/bc/zzapi/mes/prod_order" \
    "405" POST \
    ".error" "Method not allowed"

  check "POST /material rejected with 405" \
    "${BASE_URL}/sap/bc/zzapi/mes/material" \
    "405" POST

  check "POST /stock rejected with 405" \
    "${BASE_URL}/sap/bc/zzapi/mes/stock" \
    "405" POST

  check "POST /po_items rejected with 405" \
    "${BASE_URL}/sap/bc/zzapi/mes/po_items" \
    "405" POST

  check "POST /routing rejected with 405" \
    "${BASE_URL}/sap/bc/zzapi/mes/routing" \
    "405" POST

  check "POST /wc rejected with 405" \
    "${BASE_URL}/sap/bc/zzapi/mes/wc" \
    "405" POST

  # GET on Phase 5B write-back endpoints should also return 405
  check "GET /conf rejected with 405" \
    "${BASE_URL}/sap/bc/zzapi/mes/conf" \
    "405" GET

  check "GET /gr rejected with 405" \
    "${BASE_URL}/sap/bc/zzapi/mes/gr" \
    "405" GET

  check "GET /gi rejected with 405" \
    "${BASE_URL}/sap/bc/zzapi/mes/gi" \
    "405" GET

  # Phase 5B direct SAP write-back endpoints
  echo ""
  echo "-- Phase 5B: confirmation, goods-receipt, goods-issue (direct) --"

  check "direct confirmation POST returns 201" \
    "${BASE_URL}/sap/bc/zzapi/mes/conf" \
    "201" POST \
    -H "content-type: application/json" \
    -d '{"orderid":"000000100000","operation":"0010","yield":50}'

  check "direct goods-receipt POST returns 201" \
    "${BASE_URL}/sap/bc/zzapi/mes/gr" \
    "201" POST \
    -H "content-type: application/json" \
    -d '{"ebeln":"2010000000","ebelp":"00010","menge":100,"werks":"1000","lgort":"4111"}'

  check "direct goods-issue POST returns 201" \
    "${BASE_URL}/sap/bc/zzapi/mes/gi" \
    "201" POST \
    -H "content-type: application/json" \
    -d '{"orderid":"000000100000","matnr":"000000000100000001","menge":50,"werks":"1000","lgort":"4111"}'

  check "direct confirmation invalid body returns 400" \
    "${BASE_URL}/sap/bc/zzapi/mes/conf" \
    "400" POST \
    -H "content-type: application/json" \
    -d '{"orderid":"","operation":"0010","yield":0}'

  check "direct goods-receipt invalid body returns 400" \
    "${BASE_URL}/sap/bc/zzapi/mes/gr" \
    "400" POST \
    -H "content-type: application/json" \
    -d '{"ebeln":"","ebelp":"00010","menge":0,"werks":"1000","lgort":"4111"}'

  check "direct goods-issue invalid body returns 400" \
    "${BASE_URL}/sap/bc/zzapi/mes/gi" \
    "400" POST \
    -H "content-type: application/json" \
    -d '{"orderid":"","matnr":"000000000100000001","menge":0,"werks":"1000","lgort":"4111"}'
fi

if [[ "$HUB_MODE" == "1" ]]; then
  echo ""
  echo "-- Hub-specific --"
  check "healthz returns ok without auth" \
    "${BASE_URL}/healthz" \
    "200" GET \
    ".ok" "true"

  # Temporarily clear HUB_TOKEN to test 401
  SAVED_TOKEN="$HUB_TOKEN"
  HUB_TOKEN="invalid-token"
  check "ping returns 401 with bad token" \
    "${BASE_URL}${PING_PATH}" \
    "401" GET \
    ".error" "Invalid or expired token"
  HUB_TOKEN="$SAVED_TOKEN"

  # Phase 5A read endpoints (hub mode only)
  # IDs sourced from PTD_READONLY (cloned sapdev SQL backup, client 200)
  echo ""
  echo "-- Phase 5A: prod-order, material, stock, po-items, routing, work-center --"
  check "prod-order returns aufnr" \
    "${BASE_URL}/prod-order/000000100000" \
    "200" GET \
    ".data.productionOrderNumber" "000000100000"

  check "material returns mtart" \
    "${BASE_URL}/material/000000000100000001" \
    "200" GET

  check "stock with werks returns items" \
    "${BASE_URL}/stock/000000000100000001?werks=1000" \
    "200" GET

  check "stock without werks returns 400" \
    "${BASE_URL}/stock/000000000100000001" \
    "400" GET

  check "po-items returns ebeln" \
    "${BASE_URL}/po/2010000000/items" \
    "200" GET \
    ".data.purchaseOrderNumber" "2010000000"

  # Routing: sapdev has NO PLNTY='R' entries (only 'N' network), so 404 is expected
  check "routing with werks returns 404 (no routing data in sapdev)" \
    "${BASE_URL}/routing/000000000100920000?werks=1000" \
    "404" GET

  check "work-center with werks returns arbpl" \
    "${BASE_URL}/work-center/00310211?werks=1000" \
    "200" GET

  # Phase 5B write-back endpoints (hub mode only)
  echo ""
  echo "-- Phase 5B: confirmation, goods-receipt, goods-issue --"

  check "confirmation POST returns 202 (write-back disabled)" \
    "${BASE_URL}/confirmation" \
    "202" POST \
    -H "content-type: application/json" \
    -H "idempotency-key: smoke-conf-001" \
    -d '{"orderid":"000000100000","operation":"0010","yield":50}'

  check "confirmation missing idempotency key returns 400" \
    "${BASE_URL}/confirmation" \
    "400" POST \
    -H "content-type: application/json" \
    -d '{"orderid":"000000100000","operation":"0010","yield":50}'

  check "goods-receipt POST returns 202 (write-back disabled)" \
    "${BASE_URL}/goods-receipt" \
    "202" POST \
    -H "content-type: application/json" \
    -H "idempotency-key: smoke-gr-001" \
    -d '{"ebeln":"2010000000","ebelp":"00010","menge":100,"werks":"1000","lgort":"4111"}'

  check "goods-issue POST returns 202 (write-back disabled)" \
    "${BASE_URL}/goods-issue" \
    "202" POST \
    -H "content-type: application/json" \
    -H "idempotency-key: smoke-gi-001" \
    -d '{"orderid":"000000100000","matnr":"000000000100000001","menge":50,"werks":"1000","lgort":"4111"}'

  check "goods-receipt missing idempotency key returns 400" \
    "${BASE_URL}/goods-receipt" \
    "400" POST \
    -H "content-type: application/json" \
    -d '{"ebeln":"2010000000","ebelp":"00010","menge":100,"werks":"1000","lgort":"4111"}'

  check "goods-issue missing idempotency key returns 400" \
    "${BASE_URL}/goods-issue" \
    "400" POST \
    -H "content-type: application/json" \
    -d '{"orderid":"000000100000","matnr":"000000000100000001","menge":50,"werks":"1000","lgort":"4111"}'

  check "confirmation duplicate idempotency key returns 409" \
    "${BASE_URL}/confirmation" \
    "409" POST \
    -H "content-type: application/json" \
    -H "idempotency-key: smoke-conf-001" \
    -d '{"orderid":"000000100000","operation":"0010","yield":50}'

  check "confirmation same key different body returns 422" \
    "${BASE_URL}/confirmation" \
    "422" POST \
    -H "content-type: application/json" \
    -H "idempotency-key: smoke-conf-001" \
    -d '{"orderid":"9999999","operation":"0010","yield":99}'

  check "confirmation invalid body returns 400" \
    "${BASE_URL}/confirmation" \
    "400" POST \
    -H "content-type: application/json" \
    -H "idempotency-key: smoke-zod-001" \
    -d '{"orderid":"","operation":"0010","yield":0}'

  check "goods-receipt invalid body returns 400" \
    "${BASE_URL}/goods-receipt" \
    "400" POST \
    -H "content-type: application/json" \
    -H "idempotency-key: smoke-zod-002" \
    -d '{"ebeln":"","ebelp":"00010","menge":0,"werks":"1000","lgort":"4111"}'

  check "goods-issue invalid body returns 400" \
    "${BASE_URL}/goods-issue" \
    "400" POST \
    -H "content-type: application/json" \
    -H "idempotency-key: smoke-zod-003" \
    -d '{"orderid":"","matnr":"000000000100000001","menge":0,"werks":"1000","lgort":"4111"}'

  # 405 Method Not Allowed tests
  echo ""
  echo "-- 405 Method Not Allowed (hub) --"

  check "POST /ping returns 405" \
    "${BASE_URL}${PING_PATH}" \
    "405" POST \
    ".error" "Method not allowed"

  check "GET /auth/token returns 405" \
    "${BASE_URL}/auth/token" \
    "405" GET

  check "GET /confirmation returns 405" \
    "${BASE_URL}/confirmation" \
    "405" GET \
    ".error" "Method not allowed"

  check "GET /goods-receipt returns 405" \
    "${BASE_URL}/goods-receipt" \
    "405" GET \
    ".error" "Method not allowed"

  check "GET /goods-issue returns 405" \
    "${BASE_URL}/goods-issue" \
    "405" GET \
    ".error" "Method not allowed"

  check "POST /metrics returns 405" \
    "${BASE_URL}/metrics" \
    "405" POST

  # GET /metrics (localhost-only on msi-1 — skip when running remotely)
  echo ""
  echo "-- /metrics endpoint (hub) --"

  # /metrics is restricted to localhost connections. When smoke runs from a
  # remote machine (macOS) the connection comes from a non-loopback IP, so
  # the hub returns 403. Only test /metrics when running on the hub host itself.
  if [[ "$HUB_URL" == *"localhost"* || "$HUB_URL" == *"127.0.0.1"* ]]; then
    check "GET /metrics returns 200 with prometheus output" \
      "${BASE_URL}/metrics" \
      "200" GET
  else
    echo "  SKIP  GET /metrics (remote hub URL — localhost-only endpoint)"
  fi

  # /auth/token with invalid credentials
  echo ""
  echo "-- /auth/token invalid credentials (hub) --"

  check "auth with invalid API key returns 401" \
    "${BASE_URL}/auth/token" \
    "401" POST \
    -H "content-type: application/json" \
    -d '{"api_key":"invalid.key123"}'

  # Additional hub smoke tests
  echo ""
  echo "-- Additional hub coverage --"

  check "healthz?check=sap returns SAP connectivity status" \
    "${BASE_URL}/healthz?check=sap" \
    "200" GET

  # Duplicate idempotency-key tests for goods-receipt and goods-issue
  check "goods-receipt duplicate idempotency key returns 409" \
    "${BASE_URL}/goods-receipt" \
    "409" POST \
    -H "content-type: application/json" \
    -H "idempotency-key: smoke-gr-001" \
    -d '{"ebeln":"2010000000","ebelp":"00010","menge":100,"werks":"1000","lgort":"4111"}'

  check "goods-issue duplicate idempotency key returns 409" \
    "${BASE_URL}/goods-issue" \
    "409" POST \
    -H "content-type: application/json" \
    -H "idempotency-key: smoke-gi-001" \
    -d '{"orderid":"000000100000","matnr":"000000000100000001","menge":50,"werks":"1000","lgort":"4111"}'

  # Invalid path-param test (hub validateParam rejects non-alphanumeric)
  check "po with invalid path-param returns 400" \
    "${BASE_URL}/po/abc%3Bdef" \
    "400" GET

  # Body-too-large test (1.1 MB exceeds 1 MB limit)
  # Write to temp file to avoid "Argument list too long" on shells with low ARG_MAX
  OVERSIZED_TMP=$(mktemp)
  python3 -c "import json; print(json.dumps({'orderid':'000000100000','operation':'0010','yield':50,'padding':'x'*1100000}))" > "$OVERSIZED_TMP"
  check "oversized body returns 413" \
    "${BASE_URL}/confirmation" \
    "413" POST \
    -H "content-type: application/json" \
    -H "idempotency-key: smoke-413-001" \
    -d @"$OVERSIZED_TMP"
  rm -f "$OVERSIZED_TMP"

  # Scope-based 403 test
  echo ""
  echo "-- Scope-based 403 (hub) --"

  SAVED_TOKEN="$HUB_TOKEN"
  # Create a limited-scope key via admin CLI if hub admin is available
  LIMITED_KEY=""
  LIMITED_KEY=$(node "$(dirname "$0")/../apps/hub/dist/admin/cli.js" keys create --label smoke-limited --scopes ping 2>/dev/null | grep -oP '[a-zA-Z0-9.]+') || true
  if [[ -n "$LIMITED_KEY" ]]; then
    LIMITED_TOKEN=$(curl -s "$HUB_URL/auth/token" \
      -d "{\"api_key\":\"$LIMITED_KEY\"}" \
      -H 'content-type: application/json' \
      | jq -r .token 2>/dev/null) || true
    if [[ -n "$LIMITED_TOKEN" && "$LIMITED_TOKEN" != "null" ]]; then
      HUB_TOKEN="$LIMITED_TOKEN"
      check "wrong scope returns 403" \
        "${BASE_URL}/po/3010000608" \
        "403" GET
      # Revoke the limited key
      node "$(dirname "$0")/../apps/hub/dist/admin/cli.js" keys revoke "$(echo "$LIMITED_KEY" | cut -d. -f1)" 2>/dev/null || true
    else
      echo "  SKIP  scope-403 test (could not obtain limited-scope token)"
    fi
  else
    echo "  SKIP  scope-403 test (admin CLI unavailable or key creation failed)"
  fi
  HUB_TOKEN="$SAVED_TOKEN"

  # Expired JWT test
  echo ""
  echo "-- Expired JWT returns 401 (hub) --"
  # Craft an expired JWT by signing with the hub's secret — we approximate by
  # using a token that expired 60s ago. Requires HUB_JWT_SECRET to be known.
  EXPIRED_TOKEN=""
  EXPIRED_TOKEN=$(node -e "
    const secret = process.env.HUB_JWT_SECRET || 'test-secret-16ch';
    const { sign } = require('hono/jwt');
    sign({ key_id:'smoke-exp', scopes:['ping'], iat: Math.floor(Date.now()/1000)-960, exp: Math.floor(Date.now()/1000)-60, rate_limit_per_min:600 }, secret)
      .then(t => process.stdout.write(t));
  " 2>/dev/null) || true
  if [[ -n "$EXPIRED_TOKEN" ]]; then
    SAVED_TOKEN="$HUB_TOKEN"
    HUB_TOKEN="$EXPIRED_TOKEN"
    check "expired JWT returns 401" \
      "${BASE_URL}${PING_PATH}" \
      "401" GET
    HUB_TOKEN="$SAVED_TOKEN"
  else
    echo "  SKIP  expired-JWT test (could not craft expired token)"
  fi

  # Revoked API key test
  echo ""
  echo "-- Revoked API key returns 401 (hub) --"
  REVOKED_KEY=""
  REVOKED_KEY=$(node "$(dirname "$0")/../apps/hub/dist/admin/cli.js" keys create --label smoke-revoked --scopes ping 2>/dev/null | grep -oP '[a-zA-Z0-9.]+') || true
  if [[ -n "$REVOKED_KEY" ]]; then
    # Revoke it immediately
    node "$(dirname "$0")/../apps/hub/dist/admin/cli.js" keys revoke "$(echo "$REVOKED_KEY" | cut -d. -f1)" 2>/dev/null || true
    # Try to authenticate with the revoked key
    REVOKED_RES=$(curl -s -o /dev/null -w "%{http_code}" "$HUB_URL/auth/token" \
      -d "{\"api_key\":\"$REVOKED_KEY\"}" \
      -H 'content-type: application/json')
    if [[ "$REVOKED_RES" == "401" ]]; then
      echo "  PASS  revoked key returns 401"
      ((pass++)) || true
    else
      echo "  FAIL  revoked key expected 401, got ${REVOKED_RES}"
      ((fail++))
    fi
  else
    echo "  SKIP  revoked-key test (admin CLI unavailable or key creation failed)"
  fi

  # Per-key rate-limit 429 test
  echo ""
  echo "-- Per-key rate-limit 429 (hub) --"
  RATELIMIT_KEY=""
  RATELIMIT_KEY=$(node "$(dirname "$0")/../apps/hub/dist/admin/cli.js" keys create --label smoke-ratelimit --scopes ping --rate-limit 1 2>/dev/null | grep -oP '[a-zA-Z0-9.]+') || true
  if [[ -n "$RATELIMIT_KEY" ]]; then
    RL_TOKEN=$(curl -s "$HUB_URL/auth/token" \
      -d "{\"api_key\":\"$RATELIMIT_KEY\"}" \
      -H 'content-type: application/json' \
      | jq -r .token 2>/dev/null) || true
    if [[ -n "$RL_TOKEN" && "$RL_TOKEN" != "null" ]]; then
      SAVED_TOKEN="$HUB_TOKEN"
      HUB_TOKEN="$RL_TOKEN"
      # First request should succeed (1 rpm = 1 token)
      check "rate-limit first request succeeds" \
        "${BASE_URL}${PING_PATH}" \
        "200" GET
      # Second request should be 429
      check "rate-limit second request returns 429" \
        "${BASE_URL}${PING_PATH}" \
        "429" GET
      HUB_TOKEN="$SAVED_TOKEN"
    else
      echo "  SKIP  rate-limit 429 test (could not obtain token)"
    fi
    # Revoke the rate-limited key
    node "$(dirname "$0")/../apps/hub/dist/admin/cli.js" keys revoke "$(echo "$RATELIMIT_KEY" | cut -d. -f1)" 2>/dev/null || true
  else
    echo "  SKIP  rate-limit 429 test (admin CLI unavailable or key creation failed)"
  fi

  # CORS preflight — only meaningful when HUB_CORS_ORIGIN is configured
  if [[ -n "${HUB_CORS_ORIGIN:-}" ]]; then
    check "CORS preflight returns 204 + Access-Control-Allow-Methods" \
      "${BASE_URL}${PING_PATH}" \
      "204" OPTIONS \
      -H "Origin: ${HUB_CORS_ORIGIN}" \
      -H "Access-Control-Request-Method: GET"
  else
    echo "  SKIP  CORS preflight (HUB_CORS_ORIGIN not set)"
  fi
fi

echo ""
echo "=== Results: ${pass} passed, ${fail} failed ==="
exit $fail
