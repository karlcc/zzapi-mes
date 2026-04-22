#!/usr/bin/env bash
# smoke.sh — curl round-trip tests for zzapi-mes ICF handlers
# Run after deploying both handlers to sapdev.
#
# Usage:  SAP_USER=api_user2 SAP_PASS='Pt@2026' bash scripts/smoke.sh
#         bash scripts/smoke.sh                    (uses defaults below)
#         VERBOSE=1 bash scripts/smoke.sh          (show response bodies)

set -euo pipefail

SAP_USER="${SAP_USER:-api_user2}"
SAP_PASS="${SAP_PASS:-Pt@2026}"
SAP_HOST="${SAP_HOST:-sapdev.fastcell.hk:8000}"
SAP_CLIENT="${SAP_CLIENT:-200}"
VERBOSE="${VERBOSE:-0}"

BASE_URL="http://${SAP_HOST}"

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
  # Remaining args: pairs of (jq_path, expected_value) for body assertions

  local t0 status body elapsed tmpf
  t0=${EPOCHREALTIME//./}

  # Build full URL — use ? for first param, & for subsequent
  local sep="?"
  if [[ "$url" == *"?"* ]]; then sep="&"; fi
  local full_url="${url}${sep}sap-client=${SAP_CLIENT}"

  local curl_args=(-s -u "${SAP_USER}:${SAP_PASS}")
  if [[ "$method" != "GET" ]]; then curl_args+=(-X "$method"); fi

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
  while [[ $# -ge 2 ]]; do
    local jq_path="$1" expected_val="$2"; shift 2
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
echo "  SAP host:   ${SAP_HOST}"
echo "  SAP client: ${SAP_CLIENT}"
echo "  SAP user:   ${SAP_USER}"
echo ""

echo "-- Ping handler --"
check "ping returns ok=true" \
  "${BASE_URL}/sap/bc/zzapi_mes_ping" \
  "200" GET \
  ".ok" "true"

check "POST to ping rejected with 405" \
  "${BASE_URL}/sap/bc/zzapi_mes_ping" \
  "405" POST \
  ".error" "Method not allowed"

echo ""
echo "-- PO handler --"
check "PO 3010000608 returns ebeln" \
  "${BASE_URL}/sap/bc/zzapi_mes?ebeln=3010000608" \
  "200" GET \
  ".ebeln" "3010000608"

check "PO 9999999999 returns 404 with error" \
  "${BASE_URL}/sap/bc/zzapi_mes?ebeln=9999999999" \
  "404" GET \
  ".error" "PO not found"

check "POST rejected with 405" \
  "${BASE_URL}/sap/bc/zzapi_mes?ebeln=3010000608" \
  "405" POST \
  ".error" "Method not allowed"

echo ""
echo "=== Results: ${pass} passed, ${fail} failed ==="
exit $fail
