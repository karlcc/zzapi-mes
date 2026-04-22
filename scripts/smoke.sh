#!/usr/bin/env bash
# smoke.sh — curl round-trip tests for zzapi-mes ICF handlers
# Run after deploying both handlers to sapdev.
#
# Usage: SAP_USER=api_user2 SAP_PASS='Pt@2026' bash scripts/smoke.sh
#   or:  bash scripts/smoke.sh  (uses defaults below)

set -euo pipefail

SAP_USER="${SAP_USER:-api_user2}"
SAP_PASS="${SAP_PASS:-Pt@2026}"
SAP_HOST="sapdev.fastcell.hk:8000"
SAP_CLIENT="200"
BASE="http://${SAP_USER}:${SAP_PASS}@${SAP_HOST}"

pass=0
fail=0

check() {
  local label="$1" url="$2" expect_status="$3" expect_body="$4"
  local actual
  actual=$(curl -s -o /tmp/smoke_body -w "%{http_code}" "${url}&sap-client=${SAP_CLIENT}")
  local body
  body=$(cat /tmp/smoke_body)

  if [[ "$actual" == "$expect_status" ]]; then
    if [[ -z "$expect_body" ]] || echo "$body" | grep -q "$expect_body"; then
      echo "  PASS  ${label}  (${actual})"
      ((pass++))
    else
      echo "  FAIL  ${label}  status OK (${actual}) but body mismatch"
      echo "        expected substring: ${expect_body}"
      echo "        got: ${body}"
      ((fail++))
    fi
  else
    echo "  FAIL  ${label}  expected ${expect_status}, got ${actual}"
    echo "        body: ${body}"
    ((fail++))
  fi
}

echo "=== zzapi-mes smoke tests ==="
echo "  SAP host: ${SAP_HOST}"
echo "  SAP user: ${SAP_USER}"
echo ""

echo "-- Ping handler --"
check "ping returns ok" \
  "${BASE}/sap/bc/zzapi_mes_ping" \
  "200" \
  '"ok":true'

echo ""
echo "-- PO handler --"
check "PO 3010000608 returns ebeln" \
  "${BASE}/sap/bc/zzapi_mes?ebeln=3010000608" \
  "200" \
  '"ebeln"'

check "PO 9999999999 returns 404" \
  "${BASE}/sap/bc/zzapi_mes?ebeln=9999999999" \
  "404" \
  '"error"'

check "POST rejected with 405" \
  "${BASE}/sap/bc/zzapi_mes?ebeln=3010000608" \
  "405" \
  '"error"'

echo ""
echo "=== Results: ${pass} passed, ${fail} failed ==="
exit $fail
