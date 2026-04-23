#!/usr/bin/env bash
# update-msi1.sh — update the zzapi-mes hub on msi-1 via SSH
# Run from repo root:  bash apps/hub/deploy/update-msi1.sh
#
# What this does:
#   1. Backs up the current build (for rollback)
#   2. Stops the nssm service
#   3. Clears the old repo on msi-1
#   4. Copies the local repo via scp
#   5. Runs pnpm install + build on msi-1
#   6. Runs DB migration (idempotent)
#   7. Starts the service
#   8. Verifies healthz
#
# Rollback: if the new build fails to start, re-run with --rollback:
#   bash apps/hub/deploy/update-msi1.sh --rollback

set -euo pipefail

HOST="msi-1"
REMOTE_DIR="C:/Users/karlchow/code/zzapi-mes"
BACKUP_DIR="C:/Users/karlchow/code/zzapi-mes-prev"
NSSM="C:\\Windows\\nssm.exe"
SERVICE="zzapi-mes-hub"

# --- Rollback mode ---
if [[ "${1:-}" == "--rollback" ]]; then
  echo "=== ROLLBACK: restoring previous build on $HOST ==="
  ssh $HOST "powershell -Command \"& '$NSSM' stop $SERVICE 2>&1\"" || true
  sleep 1
  ssh $HOST "powershell -Command \"Remove-Item -Recurse -Force '$REMOTE_DIR' -ErrorAction SilentlyContinue; Move-Item -Force '$BACKUP_DIR' '$REMOTE_DIR'; Write-Output 'Rolled back'\""
  ssh $HOST "powershell -Command \"& '$NSSM' start $SERVICE 2>&1\""
  sleep 3
  ssh $HOST "powershell -Command \"(Invoke-WebRequest -Uri 'http://localhost:8080/healthz' -UseBasicParsing).Content\""
  echo "Rollback complete."
  exit 0
fi

echo "=== Stopping service on $HOST ==="
ssh $HOST "powershell -Command \"& '$NSSM' stop $SERVICE 2>&1\"" || true
sleep 1

echo "=== Backing up current build ==="
ssh $HOST "powershell -Command \"Remove-Item -Recurse -Force '$BACKUP_DIR' -ErrorAction SilentlyContinue; Move-Item -Force '$REMOTE_DIR' '$BACKUP_DIR'; Write-Output 'Backup saved'\""

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
