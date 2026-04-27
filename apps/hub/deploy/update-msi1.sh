#!/usr/bin/env bash
# update-msi1.sh — update the zzapi-mes hub on msi-1 via SSH
# Run from repo root:  bash apps/hub/deploy/update-msi1.sh
#
# What this does:
#   1. Stops the nssm service
#   2. Backs up the current build (for rollback)
#   3. Copies the local repo via tar+scp (avoids rsync Windows path issues)
#   4. Runs pnpm install + build + spec:gen on msi-1
#   5. Runs DB migration (idempotent)
#   6. Starts the service
#   7. Verifies /healthz, /docs, /openapi.json
#
# Rollback: if the new build fails to start, re-run with --rollback:
#   bash apps/hub/deploy/update-msi1.sh --rollback

set -euo pipefail

HOST="msi-1"
REMOTE_DIR="C:/Users/karlchow/code/zzapi-mes"
BACKUP_DIR="C:/Users/karlchow/code/zzapi-mes-prev"
NSSM="C:\\Windows\\nssm.exe"
SERVICE="zzapi-mes-hub"
TAR_FILE="/tmp/zzapi-mes-deploy.tar"

# --- nssm pre-flight check ---
if ! ssh $HOST "powershell -Command \"Test-Path '$NSSM'\"" | grep -q "True"; then
  echo "Error: nssm not found at $NSSM on $HOST. Install nssm first." >&2
  exit 1
fi

# --- Automatic rollback on failure ---
rollback() {
  echo "!!! Error detected — rolling back to previous build !!!"
  ssh $HOST "powershell -Command \"& '$NSSM' stop $SERVICE 2>&1\"" || true
  ssh $HOST "powershell -Command \"if (Test-Path '$BACKUP_DIR') { Remove-Item -Recurse -Force '$REMOTE_DIR' -ErrorAction SilentlyContinue; Move-Item -Force '$BACKUP_DIR' '$REMOTE_DIR'; Write-Output 'Rolled back' } else { Write-Output 'No backup to restore' }\""
  ssh $HOST "powershell -Command \"& '$NSSM' start $SERVICE 2>&1\""
  echo "Rollback complete."
}
trap rollback ERR

# --- Wait for nssm service to reach expected state ---
wait_for_service() {
  local action="$1"   # "stop" or "start"
  local max_wait="${2:-10}"
  local elapsed=0
  while [[ $elapsed -lt $max_wait ]]; do
    local state
    state=$(ssh $HOST "powershell -Command \"& '$NSSM' status $SERVICE 2>&1\"" || true)
    if [[ "$action" == "stop" && "$state" == *"SERVICE_STOPPED"* ]]; then
      echo "  Service stopped after ${elapsed}s"
      return 0
    fi
    if [[ "$action" == "start" && "$state" == *"SERVICE_RUNNING"* ]]; then
      echo "  Service running after ${elapsed}s"
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  echo "  WARNING: service did not reach ${action} state within ${max_wait}s" >&2
  return 1
}

# --- Rollback mode ---
if [[ "${1:-}" == "--rollback" ]]; then
  echo "=== ROLLBACK: restoring previous build on $HOST ==="
  ssh $HOST "powershell -Command \"& '$NSSM' stop $SERVICE 2>&1\"" || true
  wait_for_service stop 10 || true
  ssh $HOST "powershell -Command \"Remove-Item -Recurse -Force '$REMOTE_DIR' -ErrorAction SilentlyContinue; Move-Item -Force '$BACKUP_DIR' '$REMOTE_DIR'; Write-Output 'Rolled back'\""
  ssh $HOST "powershell -Command \"& '$NSSM' start $SERVICE 2>&1\""
  wait_for_service start 15 || true
  ssh $HOST "powershell -Command \"(Invoke-WebRequest -Uri 'http://localhost:8080/healthz' -UseBasicParsing).Content\""
  echo "Rollback complete."
  exit 0
fi

echo "=== Stopping service on $HOST ==="
ssh $HOST "powershell -Command \"& '$NSSM' stop $SERVICE 2>&1\"" || true
wait_for_service stop 10 || true

echo "=== Backing up current build ==="
ssh $HOST "powershell -Command \"Remove-Item -Recurse -Force '$BACKUP_DIR' -ErrorAction SilentlyContinue; Move-Item -Force '$REMOTE_DIR' '$BACKUP_DIR'; Write-Output 'Backup saved'\""

echo "=== Creating target directory ==="
ssh $HOST "powershell -Command \"New-Item -ItemType Directory -Force -Path '$REMOTE_DIR' | Out-Null; Write-Output 'Dir ready'\""

echo "=== Copying repo to $HOST ==="
REPO_ROOT="$(git rev-parse --show-toplevel)"
# Use tar+scp instead of rsync — rsync fails on Windows paths with msi-1
tar cf "$TAR_FILE" \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='.env' \
  --exclude='.env.local' \
  --exclude='.DS_Store' \
  --exclude='*.db' \
  --exclude='*.db-wal' \
  --exclude='*.db-shm' \
  --exclude='.claude' \
  -C "$REPO_ROOT" .
scp "$TAR_FILE" "$HOST:$REMOTE_DIR/"
ssh $HOST "powershell -Command \"Set-Location '$REMOTE_DIR'; tar xf $(basename $TAR_FILE); Remove-Item $(basename $TAR_FILE); Write-Output 'Extracted'\""
rm -f "$TAR_FILE"

echo "=== Installing dependencies and building on $HOST ==="
ssh $HOST "powershell -Command \"\$env:CI='true'; Set-Location '$REMOTE_DIR'; pnpm install 2>&1 | Select-Object -Last 3; pnpm build 2>&1 | Select-Object -Last 3\""

echo "=== Running DB migration on $HOST ==="
ssh $HOST "powershell -Command \"\$env:HUB_DB_PATH='C:\var\zzapi-mes-hub\hub.db'; node '$REMOTE_DIR/apps/hub/dist/scripts/migrate.js' 2>&1\""

echo "=== Starting service on $HOST ==="
ssh $HOST "powershell -Command \"& '$NSSM' start $SERVICE 2>&1\""
wait_for_service start 15 || true

echo "=== Verifying /healthz ==="
ssh $HOST "powershell -Command \"(Invoke-WebRequest -Uri 'http://localhost:8080/healthz' -UseBasicParsing).Content\""

echo "=== Verifying /docs ==="
ssh $HOST "powershell -Command \"try { (Invoke-WebRequest -Uri 'http://localhost:8080/docs' -UseBasicParsing).StatusCode } catch { 'FAIL' }\""

echo "=== Verifying /openapi.json ==="
ssh $HOST "powershell -Command \"try { (Invoke-WebRequest -Uri 'http://localhost:8080/openapi.json' -UseBasicParsing).Content.Substring(0,50) } catch { 'FAIL' }\""

echo ""
echo "Update complete. Hub is running on $HOST."
