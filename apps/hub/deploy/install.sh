#!/usr/bin/env bash
# install.sh — install zzapi-mes hub on a Linux host
# Run from the repo root:  bash apps/hub/deploy/install.sh
#
# Prerequisites:
#   - Node 20+ installed at /usr/bin/node
#   - sudo privileges
#
# What this does:
#   1. Builds the project if dist/ is missing
#   2. Creates the zzapi-mes system user if missing
#   3. Copies hub dist + node_modules to /opt/zzapi-mes-hub
#   4. Runs DB migration
#   5. Installs the env file if none exists (mode 600, root:zzapi-mes)
#   6. Symlinks admin CLI to /usr/local/bin
#   7. Installs and enables the systemd unit

set -euo pipefail

# --- Rollback state ---
_ROLLBACK_DIST_BACKUP=""
_ROLLBACK_NM_BACKUP=""

cleanup_on_exit() {
  # If a backup was taken and we're exiting due to an error (ERR trap),
  # restore the backup. On success, the backup is removed in the normal
  # flow (after rsync succeeds).
  if [ -n "$_ROLLBACK_DIST_BACKUP" ] && [ -d "$_ROLLBACK_DIST_BACKUP" ]; then
    echo "Restoring dist backup due to failure..." >&2
    sudo rm -rf "$INSTALL_DIR/dist"
    sudo mv "$_ROLLBACK_DIST_BACKUP" "$INSTALL_DIR/dist"
    _ROLLBACK_DIST_BACKUP=""
  fi
  if [ -n "$_ROLLBACK_NM_BACKUP" ] && [ -d "$_ROLLBACK_NM_BACKUP" ]; then
    echo "Restoring node_modules backup due to failure..." >&2
    sudo rm -rf "$INSTALL_DIR/node_modules"
    sudo mv "$_ROLLBACK_NM_BACKUP" "$INSTALL_DIR/node_modules"
    _ROLLBACK_NM_BACKUP=""
  fi
}

trap cleanup_on_exit ERR
trap 'echo "Interrupted — cleaning up..." >&2; cleanup_on_exit; exit 130' INT TERM

# --- Node version guard ---
NODE_MAJOR=$(node --version 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/')
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Error: Node 20+ required (found $(node --version 2>/dev/null || 'none'))" >&2
  exit 1
fi

# --- pnpm pre-flight check ---
if ! command -v pnpm >/dev/null 2>&1; then
  echo "Error: pnpm is required but not found in PATH. Install via: npm install -g pnpm" >&2
  exit 1
fi

# --- rsync pre-flight check ---
if ! command -v rsync >/dev/null 2>&1; then
  echo "Error: rsync is required but not found in PATH. Install via your package manager (e.g. apt install rsync)" >&2
  exit 1
fi

INSTALL_DIR="/opt/zzapi-mes-hub"
DATA_DIR="/var/lib/zzapi-mes-hub"
ENV_FILE="/etc/zzapi-mes-hub.env"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# --- 1. Build if needed (runs as invoking user) ---
if [ ! -d "$REPO_ROOT/apps/hub/dist" ]; then
  echo "Building project..."
  (cd "$REPO_ROOT" && pnpm build)
fi

# --- 2. Ensure service user exists ---
if ! id -u zzapi-mes >/dev/null 2>&1; then
  echo "Creating system user zzapi-mes..."
  sudo useradd --system --no-create-home --shell /usr/sbin/nologin zzapi-mes
fi

# --- 3. Copy to install dir ---
echo "Installing to $INSTALL_DIR..."
sudo mkdir -p "$INSTALL_DIR"

# Back up existing dist/ before rsync --delete to allow rollback on failure.
# If there is no existing installation, there is nothing to back up.
if [ -d "$INSTALL_DIR/dist" ]; then
  _ROLLBACK_DIST_BACKUP="$INSTALL_DIR/dist.rollback.$$"
  echo "Backing up existing dist/ to $_ROLLBACK_DIST_BACKUP..."
  sudo mv "$INSTALL_DIR/dist" "$_ROLLBACK_DIST_BACKUP"
fi
if [ -d "$INSTALL_DIR/node_modules" ]; then
  _ROLLBACK_NM_BACKUP="$INSTALL_DIR/node_modules.rollback.$$"
  echo "Backing up existing node_modules/ to $_ROLLBACK_NM_BACKUP..."
  sudo mv "$INSTALL_DIR/node_modules" "$_ROLLBACK_NM_BACKUP"
fi

sudo rsync -a --delete --chown=root:zzapi-mes "$REPO_ROOT/apps/hub/dist/" "$INSTALL_DIR/dist/"

# dist rsync succeeded — clear rollback flag and remove backup
if [ -n "$_ROLLBACK_DIST_BACKUP" ] && [ -d "$_ROLLBACK_DIST_BACKUP" ]; then
  sudo rm -rf "$_ROLLBACK_DIST_BACKUP"
  _ROLLBACK_DIST_BACKUP=""
fi

# Copy node_modules needed at runtime
if [ -d "$REPO_ROOT/apps/hub/node_modules" ]; then
  sudo rsync -a "$REPO_ROOT/apps/hub/node_modules/" "$INSTALL_DIR/node_modules/"
else
  echo "Installing production dependencies..."
  (cd "$REPO_ROOT" && pnpm install --frozen-lockfile)
  sudo rsync -a "$REPO_ROOT/apps/hub/node_modules/" "$INSTALL_DIR/node_modules/"
  # Also need core's node_modules (zod)
  sudo rsync -a "$REPO_ROOT/packages/core/node_modules/" "$INSTALL_DIR/node_modules/"
  sudo rsync -a "$REPO_ROOT/packages/core/dist/" "$INSTALL_DIR/node_modules/@zzapi-mes/core/dist/"
fi

# node_modules rsync succeeded — clear rollback flag and remove backup
if [ -n "$_ROLLBACK_NM_BACKUP" ] && [ -d "$_ROLLBACK_NM_BACKUP" ]; then
  sudo rm -rf "$_ROLLBACK_NM_BACKUP"
  _ROLLBACK_NM_BACKUP=""
fi

# --- 4. DB migration ---
echo "Setting up data directory..."
sudo mkdir -p "$DATA_DIR"
sudo chown zzapi-mes:zzapi-mes "$DATA_DIR"
# Restrict DB directory to owner only — contains API key hashes
sudo chmod 700 "$DATA_DIR"
echo "Running DB migration..."
sudo -u zzapi-mes node "$INSTALL_DIR/dist/scripts/migrate.js"

# --- 5. Env file ---
if [ ! -f "$ENV_FILE" ]; then
  echo "Installing example env file to $ENV_FILE"
  sudo cp "$SCRIPT_DIR/zzapi-mes-hub.env.example" "$ENV_FILE"
  sudo chown zzapi-mes:zzapi-mes "$ENV_FILE"
  sudo chmod 600 "$ENV_FILE"
  echo "!! Edit $ENV_FILE with your values before starting the service !!"
else
  echo "Env file $ENV_FILE already exists — not overwriting"
fi

# --- 6. Admin CLI symlink ---
echo "Installing admin CLI..."
sudo ln -sf "$INSTALL_DIR/dist/admin/cli.js" /usr/local/bin/zzapi-mes-hub-admin
sudo chmod +x "$INSTALL_DIR/dist/admin/cli.js"

# --- 7. Systemd unit ---
if ! command -v systemctl >/dev/null 2>&1; then
  echo "Error: systemctl not found. This script requires systemd. Install via your package manager or use Docker instead." >&2
  exit 1
fi
echo "Installing systemd unit..."
sudo cp "$SCRIPT_DIR/zzapi-mes-hub.service" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable zzapi-mes-hub

echo ""
echo "Done. Next steps:"
echo "  1. Edit $ENV_FILE with your values"
echo "  2. Create an API key:  zzapi-mes-hub-admin keys create --label first --scopes ping,po,prod_order,material,stock,routing,work_center,conf,gr,gi"
echo "  3. Start the hub:  sudo systemctl start zzapi-mes-hub"
echo "  4. Check status:   sudo systemctl status zzapi-mes-hub"
echo ""
echo "To view logs:"
echo "  journalctl -u zzapi-mes-hub -f"
