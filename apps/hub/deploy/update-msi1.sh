#!/usr/bin/env bash
# update-msi1.sh — update the zzapi-mes hub on msi-1 via SSH
# Run from repo root:  bash apps/hub/deploy/update-msi1.sh
#
# What this does:
#   1. Stops the nssm service
#   2. Clears the old repo on msi-1
#   3. Copies the local repo via scp
#   4. Runs pnpm install + build on msi-1
#   5. Runs DB migration (idempotent)
#   6. Starts the service
#   7. Verifies healthz

set -euo pipefail

HOST="msi-1"
REMOTE_DIR="C:/Users/karlchow/code/zzapi-mes"
NSSM="C:\\Windows\\nssm.exe"
SERVICE="zzapi-mes-hub"

echo "=== Stopping service on $HOST ==="
ssh $HOST "powershell -Command \"& '$NSSM' stop $SERVICE 2>&1\"" || true
sleep 1

echo "=== Clearing old repo on $HOST ==="
ssh $HOST "powershell -Command \"Remove-Item -Recurse -Force '$REMOTE_DIR' -ErrorAction SilentlyContinue; Write-Output 'Cleared'\""

echo "=== Copying repo to $HOST ==="
scp -r "$(git rev-parse --show-toplevel)/" "$HOST:$REMOTE_DIR/"

echo "=== Installing dependencies and building on $HOST ==="
ssh $HOST "powershell -Command \"\$env:CI='true'; Set-Location '$REMOTE_DIR'; pnpm install 2>&1 | Select-Object -Last 3; pnpm build 2>&1 | Select-Object -Last 3\""

echo "=== Running DB migration on $HOST ==="
ssh $HOST "powershell -Command \"\$env:HUB_DB_PATH='C:\var\zzapi-mes-hub\hub.db'; node '$REMOTE_DIR/apps/hub/dist/scripts/migrate.js' 2>&1\""

echo "=== Starting service on $HOST ==="
ssh $HOST "powershell -Command \"& '$NSSM' start $SERVICE 2>&1\""
sleep 3

echo "=== Verifying healthz ==="
ssh $HOST "powershell -Command \"(Invoke-WebRequest -Uri 'http://localhost:8080/healthz' -UseBasicParsing).Content\""

echo ""
echo "Update complete. Hub is running on $HOST."
