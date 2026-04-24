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

echo "=== Clearing old repo on $HOST ==="
ssh $HOST "powershell -Command \"Remove-Item -Recurse -Force '$REMOTE_DIR' -ErrorAction SilentlyContinue; Write-Output 'Cleared'\""

echo "=== Copying repo to $HOST ==="
REPO_ROOT="$(git rev-parse --show-toplevel)"
# Use trailing slash carefully: scp -r <src>/ <dest> copies contents;
# without trailing slash, copies the directory itself. Use the explicit
# form to avoid ambiguity across OpenSSH versions.
scp -r "$REPO_ROOT" "$HOST:$REMOTE_DIR"

echo "=== Installing dependencies and building on $HOST ==="
ssh $HOST "powershell -Command \"\$env:CI='true'; Set-Location '$REMOTE_DIR'; pnpm install 2>&1 | Select-Object -Last 3; pnpm build 2>&1 | Select-Object -Last 3\""

echo "=== Running DB migration on $HOST ==="
ssh $HOST "powershell -Command \"\$env:HUB_DB_PATH='C:\var\zzapi-mes-hub\hub.db'; node '$REMOTE_DIR/apps/hub/dist/scripts/migrate.js' 2>&1\""

echo "=== Starting service on $HOST ==="
ssh $HOST "powershell -Command \"& '$NSSM' start $SERVICE 2>&1\""
wait_for_service start 15 || true

echo "=== Verifying healthz ==="
ssh $HOST "powershell -Command \"(Invoke-WebRequest -Uri 'http://localhost:8080/healthz' -UseBasicParsing).Content\""

echo ""
echo "Update complete. Hub is running on $HOST."
