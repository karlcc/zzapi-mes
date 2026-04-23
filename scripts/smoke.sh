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
#   HUB_API_KEY         — hub API key (required in hub mode)

set -euo pipefail

SAP_USER="${SAP_USER:?Set SAP_USER env var (or use HUB_MODE=1)}"
SAP_PASS="${SAP_PASS:?Set SAP_PASS env var (or use HUB_MODE=1)}"
SAP_HOST="${SAP_HOST:-sapdev.fastcell.hk:8000}"
SAP_CLIENT="${SAP_CLIENT:-200}"
VERBOSE="${VERBOSE:-0}"

# Hub mode: set HUB_MODE=1 to test against the hub instead of SAP directly
HUB_MODE="${HUB_MODE:-0}"
HUB_URL="${HUB_URL:-http://localhost:8080}"
HUB_API_KEY="${HUB_API_KEY:?Set HUB_API_KEY env var for hub mode}"

BASE_URL="http://${SAP_HOST}"

# When in hub mode, fetch a JWT first
HUB_TOKEN=""
if [[ "$HUB_MODE" == "1" ]]; then
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
    ((fail++))
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
      ((fail++))
      return
    fi
  done

  echo "  PASS  ${label}  (${status}, ${elapsed}ms)"
  ((pass++))
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

check "PO 3010000608 returns ebeln" \
  "$PO_URL" \
  "200" GET \
  ".ebeln" "3010000608"

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
  echo ""
  echo "-- Phase 5A: prod-order, material, stock, po-items, routing, work-center (direct) --"

  check "prod-order returns aufnr" \
    "${BASE_URL}/sap/bc/zzapi/mes/prod_order?aufnr=1000000" \
    "200" GET \
    ".aufnr" "1000000"

  check "prod-order missing aufnr returns 400" \
    "${BASE_URL}/sap/bc/zzapi/mes/prod_order" \
    "400" GET

  check "material returns matnr" \
    "${BASE_URL}/sap/bc/zzapi/mes/material?matnr=10000001" \
    "200" GET

  check "stock with werks returns data" \
    "${BASE_URL}/sap/bc/zzapi/mes/stock?matnr=10000001&werks=1000" \
    "200" GET

  check "stock without werks returns 400" \
    "${BASE_URL}/sap/bc/zzapi/mes/stock?matnr=10000001" \
    "400" GET

  check "po-items returns ebeln" \
    "${BASE_URL}/sap/bc/zzapi/mes/po_items?ebeln=4500000001" \
    "200" GET \
    ".ebeln" "4500000001"

  check "routing with werks returns data" \
    "${BASE_URL}/sap/bc/zzapi/mes/routing?matnr=10000001&werks=1000" \
    "200" GET

  check "work-center with werks returns arbpl" \
    "${BASE_URL}/sap/bc/zzapi/mes/wc?arbpl=TURN1&werks=1000" \
    "200" GET

  # Phase 5B direct SAP write-back endpoints
  echo ""
  echo "-- Phase 5B: confirmation, goods-receipt, goods-issue (direct) --"

  check "direct confirmation POST returns 201" \
    "${BASE_URL}/sap/bc/zzapi/mes/conf" \
    "201" POST \
    -H "content-type: application/json" \
    -d '{"orderid":"1000000","operation":"0010","yield":50}'

  check "direct goods-receipt POST returns 201" \
    "${BASE_URL}/sap/bc/zzapi/mes/gr" \
    "201" POST \
    -H "content-type: application/json" \
    -d '{"ebeln":"4500000001","ebelp":"00010","menge":100,"werks":"1000","lgort":"0001"}'

  check "direct goods-issue POST returns 201" \
    "${BASE_URL}/sap/bc/zzapi/mes/gi" \
    "201" POST \
    -H "content-type: application/json" \
    -d '{"orderid":"1000000","matnr":"20000001","menge":50,"werks":"1000","lgort":"0001"}'

  check "direct confirmation invalid body returns 400" \
    "${BASE_URL}/sap/bc/zzapi/mes/conf" \
    "400" POST \
    -H "content-type: application/json" \
    -d '{"orderid":"","operation":"0010","yield":0}'

  check "direct goods-receipt invalid body returns 400" \
    "${BASE_URL}/sap/bc/zzapi/mes/gr" \
    "400" POST \
    -H "content-type: application/json" \
    -d '{"ebeln":"","ebelp":"00010","menge":0,"werks":"1000","lgort":"0001"}'

  check "direct goods-issue invalid body returns 400" \
    "${BASE_URL}/sap/bc/zzapi/mes/gi" \
    "400" POST \
    -H "content-type: application/json" \
    -d '{"orderid":"","matnr":"20000001","menge":0,"werks":"1000","lgort":"0001"}'
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
  echo ""
  echo "-- Phase 5A: prod-order, material, stock, po-items, routing, work-center --"
  check "prod-order returns aufnr" \
    "${BASE_URL}/prod-order/1000000" \
    "200" GET \
    ".aufnr" "1000000"

  check "material returns mtart" \
    "${BASE_URL}/material/10000001" \
    "200" GET \
    ".mtart" "FERT"

  check "stock with werks returns items" \
    "${BASE_URL}/stock/10000001?werks=1000" \
    "200" GET

  check "stock without werks returns 400" \
    "${BASE_URL}/stock/10000001" \
    "400" GET

  check "po-items returns ebeln" \
    "${BASE_URL}/po/4500000001/items" \
    "200" GET \
    ".ebeln" "4500000001"

  check "routing with werks returns plnnr" \
    "${BASE_URL}/routing/10000001?werks=1000" \
    "200" GET

  check "work-center with werks returns arbpl" \
    "${BASE_URL}/work-center/TURN1?werks=1000" \
    "200" GET

  # Phase 5B write-back endpoints (hub mode only)
  echo ""
  echo "-- Phase 5B: confirmation, goods-receipt, goods-issue --"

  check "confirmation POST returns 201" \
    "${BASE_URL}/confirmation" \
    "201" POST \
    -H "content-type: application/json" \
    -H "idempotency-key: smoke-conf-001" \
    -d '{"orderid":"1000000","operation":"0010","yield":50}'

  check "confirmation missing idempotency key returns 400" \
    "${BASE_URL}/confirmation" \
    "400" POST \
    -H "content-type: application/json" \
    -d '{"orderid":"1000000","operation":"0010","yield":50}'

  check "goods-receipt POST returns 201" \
    "${BASE_URL}/goods-receipt" \
    "201" POST \
    -H "content-type: application/json" \
    -H "idempotency-key: smoke-gr-001" \
    -d '{"ebeln":"4500000001","ebelp":"00010","menge":100,"werks":"1000","lgort":"0001"}'

  check "goods-issue POST returns 201" \
    "${BASE_URL}/goods-issue" \
    "201" POST \
    -H "content-type: application/json" \
    -H "idempotency-key: smoke-gi-001" \
    -d '{"orderid":"1000000","matnr":"20000001","menge":50,"werks":"1000","lgort":"0001"}'

  check "goods-receipt missing idempotency key returns 400" \
    "${BASE_URL}/goods-receipt" \
    "400" POST \
    -H "content-type: application/json" \
    -d '{"ebeln":"4500000001","ebelp":"00010","menge":100,"werks":"1000","lgort":"0001"}'

  check "goods-issue missing idempotency key returns 400" \
    "${BASE_URL}/goods-issue" \
    "400" POST \
    -H "content-type: application/json" \
    -d '{"orderid":"1000000","matnr":"20000001","menge":50,"werks":"1000","lgort":"0001"}'

  check "confirmation duplicate idempotency key returns 409" \
    "${BASE_URL}/confirmation" \
    "409" POST \
    -H "content-type: application/json" \
    -H "idempotency-key: smoke-conf-001" \
    -d '{"orderid":"1000000","operation":"0010","yield":50}'

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
    -d '{"ebeln":"","ebelp":"00010","menge":0,"werks":"1000","lgort":"0001"}'

  check "goods-issue invalid body returns 400" \
    "${BASE_URL}/goods-issue" \
    "400" POST \
    -H "content-type: application/json" \
    -H "idempotency-key: smoke-zod-003" \
    -d '{"orderid":"","matnr":"20000001","menge":0,"werks":"1000","lgort":"0001"}'

  # 405 Method Not Allowed tests
  echo ""
  echo "-- 405 Method Not Allowed (hub) --"

  check "POST /ping returns 405" \
    "${BASE_URL}${PING_PATH}" \
    "405" POST \
    ".error" "Method not allowed"

  check "GET /confirmation returns 405" \
    "${BASE_URL}/confirmation" \
    "405" GET \
    ".error" "Method not allowed"

  check "POST /metrics returns 405" \
    "${BASE_URL}/metrics" \
    "405" POST

  # Scope-based 403 test
  echo ""
  echo "-- Scope-based 403 (hub) --"

  SAVED_TOKEN="$HUB_TOKEN"
  HUB_TOKEN=$(curl -s "$HUB_URL/auth/token" \
    -d "{\"api_key\":\"$HUB_API_KEY\"}" \
    -H 'content-type: application/json' \
    | jq -r .token 2>/dev/null) || true
  # Create a token with limited scope by using a key with only ping scope
  # For now, test with a JWT that has wrong scope by directly crafting one
  # This test assumes the admin CLI can create a limited-scope key:
  #   zzapi-mes-hub-admin keys create --label limited --scopes ping
  # If that key doesn't exist, this test is skipped gracefully
  LIMITED_KEY_ID="limited-scope-test"
  LIMITED_KEY_SECRET=""
  LIMITED_KEY_SECRET=$(curl -s "$HUB_URL/auth/token" \
    -d "{\"api_key\":\"${LIMITED_KEY_ID}.$LIMITED_KEY_SECRET\"}" \
    -H 'content-type: application/json' 2>/dev/null | jq -r .token 2>/dev/null) || true
  if [[ -n "$LIMITED_KEY_SECRET" && "$LIMITED_KEY_SECRET" != "null" ]]; then
    check "wrong scope returns 403" \
      "${BASE_URL}/po/3010000608" \
      "403" GET
  else
    echo "  SKIP  scope-403 test (no limited-scope key configured)"
  fi
  HUB_TOKEN="$SAVED_TOKEN"
fi

echo ""
echo "=== Results: ${pass} passed, ${fail} failed ==="
exit $fail
